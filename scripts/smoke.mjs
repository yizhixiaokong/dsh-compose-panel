#!/usr/bin/env node
/**
 * Offline smoke checks for dsh-compose-panel.
 *
 * Nothing here talks to Docker, to DSH, or to the network: the client half is
 * materialized against stub globals and the host half is imported and applied
 * to a stub Cordis context. That is exactly enough to catch the failures that
 * are expensive to reach in a live harness — a factory binding read before its
 * declaration (the `Cannot access 'X' before initialization` boot failure that
 * leaves the whole profile unloadable), a missing or renamed sidebar seat, a
 * route that no longer registers, a stylesheet that is injected but never
 * removed.
 *
 * Run it with `npm test` or `node scripts/smoke.mjs`.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (relative) => readFileSync(join(root, relative), 'utf8')

/** The tab types this package owns, in registration order. */
const EXPECTED_TABS = ['dsh-compose-panel', 'dsh-compose-panel/logs']
/** The sidebar seats this package fills, in registration order. */
const EXPECTED_SEATS = [
	'sidebar.right.pane.tab#dsh-compose-panel',
	'sidebar.right.pane.tab.title#dsh-compose-panel',
	'sidebar.right.pane.tab#dsh-compose-panel/logs',
	'sidebar.right.pane.tab.title#dsh-compose-panel/logs',
]

const failures = []
/**
 * Run one check, record its outcome, and keep going.
 * @param {string} name - what is being asserted, in one line.
 * @param {Function} body - the check; throw to fail.
 */
function check(name, body) {
	try {
		body()
		console.log('  ok    ' + name)
	} catch (error) {
		failures.push(name)
		const message = String((error && error.message) || error)
		console.log('  FAIL  ' + name + '\n        ' + message.split('\n').join('\n        '))
	}
}

/* ------------------------------------------------------------------ *
 * 1. Declaration order inside the client factory.
 *
 * A client bundle is evaluated as one function body: a `const` declared below
 * `apply` is in its temporal dead zone when apply runs, which throws during
 * profile boot and takes every later plugin row down with it. The check is
 * deliberately narrow — the factory's own bindings must all precede apply, and
 * the first binding after apply bounds apply's body.
 * ------------------------------------------------------------------ */
check('client factory declares every binding before apply()', () => {
	const lines = read('lib/client.js').split('\n')
	const applyLine = lines.findIndex((line) => /^\t\tfunction apply\(ctx\)/.test(line))
	assert.ok(applyLine > 0, 'no factory-scope `function apply(ctx)` found in lib/client.js')

	const bindings = []
	lines.forEach((line, index) => {
		const match = /^\t\t(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line)
		if (match) bindings.push({ name: match[1], line: index })
	})
	assert.ok(
		bindings.some((binding) => binding.line < applyLine),
		'the factory scan found no bindings at all — the indentation changed',
	)
	const later = bindings.filter((binding) => binding.line > applyLine)
	// apply() is the last factory binding: nothing below it can be in its TDZ.
	if (later.length === 0) return
	const body = lines.slice(applyLine, later[0].line).join('\n')
	const offenders = later
		.filter((binding) => new RegExp('\\b' + binding.name + '\\b').test(body))
		.map((binding) => binding.name + ' (line ' + (binding.line + 1) + ')')
	assert.deepEqual(offenders, [], 'read before initialization inside apply(): ' + offenders.join(', '))
})

/* ------------------------------------------------------------------ *
 * 2. Materialize the client bundle and apply it to a stub context.
 * ------------------------------------------------------------------ */
/** A React stand-in: only what a registration-time pass can reach. */
function reactStub() {
	return {
		createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
		memo: (component) => component,
		Fragment: Symbol('Fragment'),
		useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
		useEffect: () => {},
		useRef: (initial) => ({ current: initial }),
		useMemo: (factory) => factory(),
		useCallback: (callback) => callback,
	}
}

/**
 * A `document` stand-in that tracks injected `<style>` nodes and their removal.
 * The node closures deliberately capture `head` directly: a disposer must keep
 * working after this stub is uninstalled from the global object.
 */
function documentStub(sheets) {
	const head = {
		appendChild(node) {
			sheets.push(node)
			return node
		},
		removeChild(node) {
			const index = sheets.indexOf(node)
			if (index >= 0) sheets.splice(index, 1)
		},
	}
	return {
		head,
		createElement(tag) {
			const node = { tag, textContent: '' }
			node.remove = () => head.removeChild(node)
			return node
		},
	}
}

/** Load lib/client.js, capturing the entry it hands to the module loader. */
function loadClientEntry() {
	const source = read('lib/client.js')
	const previous = { window: globalThis.window, document: globalThis.document }
	let entry = null
	globalThis.window = { __ModuleLoader__: { load: (value) => { entry = value } } }
	const React = reactStub()
	try {
		const factory = new Function('window', 'module', 'exports', 'require', source + '\n//# smoke\n')
		const module = { exports: {} }
		factory(globalThis.window, module, module.exports, (name) => {
			assert.equal(name, 'react', 'the client bundle may only require("react")')
			return React
		})
	} finally {
		if (previous.window === undefined) delete globalThis.window
		else globalThis.window = previous.window
		if (previous.document === undefined) delete globalThis.document
		else globalThis.document = previous.document
	}
	assert.ok(entry && typeof entry.factory === 'function', 'the bundle never called window.__ModuleLoader__.load()')
	return entry
}

function clientStub() {
	const tabs = []
	const seats = []
	const sheets = []
	const disposers = []
	const slots = {
		inject(name, factory) {
			const dispose = factory()
			return typeof dispose === 'function' ? dispose : () => {}
		},
		register(options, component) {
			seats.push(options.name + '#' + String(options.key ?? options.id ?? ''))
			assert.equal(typeof component, 'function', 'seat ' + options.name + ' got no component')
			return () => {}
		},
	}
	const ctx = {
		get(name) {
			if (name === 'slots') return slots
			if (name === 'sidebarRightTabs') {
				return {
					register(options) {
						tabs.push(options.id)
						return () => {}
					},
				}
			}
			if (name === 'sidebarRight') return { openResource: () => {} }
			return undefined
		},
		effect(body) {
			const dispose = body()
			disposers.push(dispose)
			return () => {}
		},
		on() {
			return () => {}
		},
	}
	return { ctx, tabs, seats, sheets, disposers }
}

check('client bundle applies and fills its seats', () => {
	const entry = loadClientEntry()
	assert.equal(entry.id, 'dsh-compose-panel', 'unexpected module id: ' + String(entry.id))
	const plugin = entry.factory((name) => {
		assert.equal(name, 'react')
		return reactStub()
	})
	assert.equal(plugin.name, 'dsh-compose-panel', 'unexpected plugin name: ' + String(plugin.name))
	assert.deepEqual(plugin.inject, ['slots'], 'the client half must inject the slot registry')

	const harness = clientStub()
	const sheets = []
	globalThis.document = documentStub(sheets)
	try {
		plugin.apply(harness.ctx)
	} finally {
		delete globalThis.document
	}

	assert.deepEqual(harness.tabs, EXPECTED_TABS, 'registered tab types changed')
	assert.deepEqual(harness.seats, EXPECTED_SEATS, 'registered sidebar seats changed')
	assert.equal(sheets.length, 1, 'expected exactly one injected stylesheet, got ' + sheets.length)
	assert.ok(sheets[0].textContent.length > 500, 'the injected stylesheet looks empty')
	assert.ok(sheets[0].textContent.includes('.dcp-logbox'), 'the log viewer styles are missing from the sheet')

	for (const dispose of harness.disposers) {
		if (typeof dispose === 'function') dispose()
	}
	assert.equal(sheets.length, 0, 'the stylesheet outlived the plugin fiber')
})

/* ------------------------------------------------------------------ *
 * 3. The host half registers its route.
 * ------------------------------------------------------------------ */
const hostRoutes = []
const hostName = (await import(pathToFileURL(join(root, 'lib/index.js')).href))
check('host half exposes inject/apply', () => {
	assert.deepEqual(hostName.inject, ['webServer'], 'the host half must inject the web server')
	assert.equal(typeof hostName.apply, 'function', 'no host apply() exported')
})

check('host half registers its HTTP route', () => {
	const labels = []
	hostName.apply({
		webServer: {
			register(route) {
				hostRoutes.push({ route })
				return () => {}
			},
		},
		get: () => undefined,
		effect(body, label) {
			labels.push(String(label || ''))
			body()
			return () => {}
		},
	})
	assert.equal(hostRoutes.length, 1, 'expected exactly one route registration')
	const [entry] = hostRoutes
	assert.equal(entry.route.kind, 'prefix', 'the compose API is a prefix route')
	assert.equal(entry.route.path, '/compose/api', 'unexpected route path: ' + String(entry.route.path))
	assert.equal(typeof entry.route.handler, 'function', 'the route has no handler')
	assert.ok(
		labels.some((label) => label.includes('/compose/api')),
		'the route effect carries no diagnostic label: ' + JSON.stringify(labels),
	)
})

if (failures.length > 0) {
	console.error('\n' + failures.length + ' check(s) failed')
	process.exit(1)
}
console.log('\nall checks passed')
