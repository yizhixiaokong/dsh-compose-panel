/**
 * dsh-compose-panel — Host half.
 *
 * Serves one POST route, `/compose/api/list`, over the web carrier. It answers
 * the browser half with the docker compose projects of every DSH workspace:
 *
 *   - containers come from `docker ps -a --format '{{json .}}'`, grouped by the
 *     `com.docker.compose.project.working_dir` label (an absolute directory),
 *     so a workspace holding several subdirectories with their own compose
 *     files yields one group per project instead of one merged list;
 *   - projects Docker already knows but that hold no container come from
 *     `docker compose ls --all --format json` (its `ConfigFiles` are absolute);
 *   - projects never brought up at all come from one bounded `find` per
 *     workspace (depth 4, build/VCS directories pruned), so an untouched
 *     `compose.yaml` still shows up as a project that is not started.
 *
 * The project key is the project DIRECTORY, never the compose project name:
 * `-p`, `COMPOSE_PROJECT_NAME` and `.env` all move the name, and two
 * directories may legitimately share one.
 *
 * Every route is fenced: a request whose Host is neither loopback nor in the
 * web runtime's trusted list, or that a browser marks cross-site, is refused
 * before any command runs.
 *
 * @module dsh-compose-panel
 */

/** Host services this plugin needs before it can mount. */
import { StringDecoder } from 'node:string_decoder'

/** The web carrier is the only hard dependency: without it there is no route. */
export const inject = ['webServer']

/** The one route prefix this plugin owns. */
const ROUTE_PREFIX = '/compose/api'

/** One bounded `find` per workspace: compose file names, build/VCS dirs pruned. */
const FIND_SCRIPT = [
  'find "$1" -maxdepth 4',
  '\\( -name node_modules -o -name .git -o -name vendor -o -name dist -o -name build -o -name target -o -name .venv -o -name venv -o -name __pycache__ -o -name .next -o -name .cache -o -name .tox \\) -prune -o',
  '\\( -name "compose.yml" -o -name "compose.yaml" -o -name "docker-compose.yml" -o -name "docker-compose.yaml" -o -name "compose.*.yml" -o -name "compose.*.yaml" -o -name "docker-compose.*.yml" -o -name "docker-compose.*.yaml" \\) -print',
].join(' ')

/** Maximum bytes accepted for one request body. */
const BODY_LIMIT = 1 << 20

/** Cap on how many containers one project reports (keeps the payload sane). */
const CONTAINER_LIMIT = 200

/**
 * The compose subcommands this plugin may run, and their argv tail. The set is
 * closed on purpose: the browser names one of these keys, never a command.
 */
const ACTIONS = {
  up: ['up', '-d'],
  stop: ['stop'],
  restart: ['restart'],
}

/** Cap on how much of one command's output travels back to the browser. */
const OUTPUT_LIMIT = 4000

/**
 * Accepted compose service names. argv is never shell-interpreted, so this is
 * defense in depth rather than the only guard: it keeps a crafted name from
 * reaching docker's own argument parsing as something that looks like a flag.
 */
const SERVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

/** Bounds for one log session: how many lines to replay, and how much to stream. */
const LOG_TAIL_DEFAULT = 200
const LOG_TAIL_MAX = 5000
const LOG_STREAM_LIMIT = 4 * 1024 * 1024

/** How often the log stream emits a comment frame so dead peers are noticed. */
const LOG_PING_MS = 15000

/**
 * Bound one command's combined output for the wire.
 * @param {unknown} value - the raw text.
 * @param {number} max - the character cap.
 * @returns {string} the bounded text.
 */
function clampText(value, max) {
  const text = String(value || '').trim()
  return text.length > max ? text.slice(0, max) + '…' : text
}

/**
 * Strip every trailing slash but keep the root `/` intact.
 * @param {unknown} value - the path to normalize.
 * @returns {string} the normalized path.
 */
function normPath(value) {
  const text = String(value)
  return text.length > 1 && text.endsWith('/') ? text.replace(/\/+$/, '') : text
}

/**
 * The directory part of a POSIX path.
 * @param {unknown} value - the path to split.
 * @returns {string} the parent directory (or `/`).
 */
function dirName(value) {
  const text = String(value)
  const at = text.lastIndexOf('/')
  return at > 0 ? text.slice(0, at) : '/'
}

/**
 * The last segment of a POSIX path.
 * @param {unknown} value - the path to split.
 * @returns {string} the final segment.
 */
function baseName(value) {
  const text = String(value)
  const at = text.lastIndexOf('/')
  return at === -1 ? text : text.slice(at + 1)
}

/**
 * The first non-empty line of a command's stderr, bounded for the wire.
 * @param {unknown} value - the raw text.
 * @returns {string} one line, at most 300 characters.
 */
function firstLine(value) {
  const text = String(value || '').trim()
  if (text === '') return ''
  const line = text.split('\n')[0]
  return line.length > 300 ? line.slice(0, 300) : line
}

/**
 * Split a comma-separated docker field into trimmed, non-empty parts.
 * @param {unknown} value - the raw field.
 * @returns {string[]} the parts.
 */
function splitList(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

/**
 * Parse docker's comma-joined label string into a plain record.
 * @param {unknown} value - the `Labels` field of one `docker ps` row.
 * @returns {Record<string, string>} the label record.
 */
function parseLabels(value) {
  const out = {}
  for (const part of String(value || '').split(',')) {
    const at = part.indexOf('=')
    if (at > 0) out[part.slice(0, at).trim()] = part.slice(at + 1)
  }
  return out
}

/**
 * Parse `docker ps --format '{{json .}}'` output: one JSON object per line.
 * @param {unknown} text - the command's stdout.
 * @returns {Array<Record<string, string>>} the relevant fields of every row.
 */
function parsePsRows(text) {
  const rows = []
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.charAt(0) !== '{') continue
    let record
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue
    }
    const labels = parseLabels(record.Labels)
    rows.push({
      name: String(record.Names || ''),
      image: String(record.Image || ''),
      state: String(record.State || ''),
      status: String(record.Status || ''),
      ports: String(record.Ports || ''),
      project: String(labels['com.docker.compose.project'] || ''),
      service: String(labels['com.docker.compose.service'] || ''),
      dir: String(labels['com.docker.compose.project.working_dir'] || ''),
      files: String(labels['com.docker.compose.project.config_files'] || ''),
    })
  }
  return rows
}

/**
 * Parse `docker compose ls --all --format json`.
 * @param {unknown} text - the command's stdout.
 * @returns {Array<{ name: string, status: string, files: string[] }>} the projects.
 */
function parseComposeLs(text) {
  const trimmed = String(text || '').trim()
  if (trimmed === '') return []
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.map((entry) => ({
    name: String((entry && entry.Name) || ''),
    status: String((entry && entry.Status) || ''),
    files: splitList(entry && entry.ConfigFiles),
  }))
}

/**
 * Read one request body as UTF-8 text, refusing anything over {@link BODY_LIMIT}.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {Promise<string>} the body text.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - the HTTP status.
 * @param {unknown} body - the JSON body.
 */
function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/**
 * Whether a hostname names this machine's loopback interface.
 * @param {string} hostname - the parsed hostname.
 * @returns {boolean} true for loopback spellings.
 */
function isLoopbackHostname(hostname) {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]'
    || hostname.endsWith('.localhost')
}

/**
 * The route fence: only a same-machine (or explicitly trusted) browser may run
 * this plugin's commands. Mirrors the shipped fence the sidebar routes use.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {readonly string[]} trustedHosts - the web runtime's trusted authorities.
 * @returns {boolean} true when the request may proceed.
 */
function isTrustedRequest(req, trustedHosts) {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) {
    if (trustedHosts.indexOf(hostUrl.hostname) === -1 && trustedHosts.indexOf(host) === -1) return false
  }
  if (String(req.headers['sec-fetch-site'] || '') === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

/**
 * The read-side fence, for the log stream.
 *
 * Browsers send no Origin on a same-origin EventSource, so a missing Origin is
 * the normal shape here and must pass. The rest of the posture is unchanged:
 * loopback peer only, and any forwarding header means the peer is a proxy
 * rather than the user.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {readonly string[]} trustedHosts - the web runtime's trusted authorities.
 * @returns {boolean} true when the request may proceed.
 */
function trustedStreamRequest(req, trustedHosts) {
  const address = req.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') {
    const host = req.headers.host
    if (typeof host !== 'string' || host === '') return false
    let hostname
    try {
      hostname = new URL('http://' + host).hostname
    } catch {
      return false
    }
    if (trustedHosts.indexOf(hostname) === -1 && trustedHosts.indexOf(host) === -1) return false
  }
  if (req.headers.forwarded !== undefined
    || req.headers['x-forwarded-for'] !== undefined
    || req.headers['x-real-ip'] !== undefined) return false
  const origin = req.headers.origin
  const host = req.headers.host
  if (host === undefined) return false
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Mount the plugin: one fenced JSON route over the web carrier.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the host context.
 */
export function apply(ctx) {
  /**
   * The deployment's workspaces as owned JSON (path + title only).
   *
   * Resolved PER CALL, never captured at apply time: `workspaceRegistry`
   * finishes its one-time bootstrap asynchronously, so at profile-boot time
   * `ctx.get('workspaceRegistry')` is still undefined and a captured value
   * would stay undefined for the whole life of the process (the panel then
   * lists no workspace at all).
   * @returns {Array<{ path: string, title: string }>} the workspaces.
   */
  const readWorkspaces = () => {
    const workspaceRegistry = ctx.get('workspaceRegistry')
    if (workspaceRegistry === undefined) return []
    let list
    try {
      list = workspaceRegistry.list()
    } catch {
      return []
    }
    if (!Array.isArray(list)) return []
    const out = []
    for (const workspace of list) {
      const path = workspace && typeof workspace.path === 'string' ? workspace.path : ''
      if (path === '') continue
      out.push({ path: normPath(path), title: String((workspace && workspace.title) || baseName(path)) })
    }
    return out
  }

  /**
   * Run one command to completion and collect its output. The subprocess
   * service is resolved per call for the same activation-order reason as
   * {@link readWorkspaces}.
   * @param {readonly string[]} argv - the exact argv.
   * @param {string} cwd - the working directory.
   * @returns {Promise<{ code: number | null, out: string, err: string }>} the result.
   */
  const run = async (argv, cwd) => {
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined) {
      return { code: null, out: '', err: 'subprocess service is unavailable' }
    }
    let handle
    try {
      handle = subprocess.spawn({
        argv,
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 8 * 1024 * 1024 },
          stderr: { maxBytes: 256 * 1024 },
        },
        graceMs: 20000,
      })
    } catch (error) {
      return { code: null, out: '', err: 'spawn failed: ' + String((error && error.message) || error) }
    }
    let outcome = null
    try {
      outcome = await handle.done
    } catch (error) {
      return { code: null, out: '', err: 'run failed: ' + String((error && error.message) || error) }
    }
    let out = ''
    let err = ''
    try {
      if (handle.collected && handle.collected.stdout) out = String(handle.collected.stdout.readFrom(0).text || '')
    } catch { /* unreadable output is not fatal */ }
    try {
      if (handle.collected && handle.collected.stderr) err = String(handle.collected.stderr.readFrom(0).text || '')
    } catch { /* unreadable output is not fatal */ }
    return { code: outcome ? outcome.exitCode : null, out, err }
  }

  /** Whether `dir` is `root` or lies beneath it. */
  const withinRoot = (dir, root) => dir === root || dir.startsWith(root + '/')

  /** The longest-matching workspace owner of one directory, or null. */
  const ownerOf = (dir, list) => {
    let best = null
    for (const workspace of list) {
      if (withinRoot(dir, workspace.path) && (best === null || workspace.path.length > best.path.length)) {
        best = workspace
      }
    }
    return best
  }

  /**
   * The `list` method: every compose project of the selected workspaces.
   * @param {{ root?: unknown }} payload - the decoded request body.
   * @returns {Promise<Record<string, unknown>>} the value written into the envelope.
   */
  const list = async (payload) => {
    const all = readWorkspaces()
    if (all.length === 0) {
      return { workspaces: [], groups: [], total: 0, outside: 0, standalone: 0, notices: ['没有可用的工作区目录'] }
    }

    const requested = typeof payload.root === 'string' ? normPath(payload.root.trim()) : ''
    let selected = all
    if (requested !== '') {
      const matched = all.filter((workspace) => workspace.path === requested)
      selected = matched.length > 0 ? matched : [{ path: requested, title: baseName(requested) }]
    }

    const baseCwd = selected[0].path
    const psRun = await run(['docker', 'ps', '-a', '--format', '{{json .}}'], baseCwd)
    const lsRun = await run(['docker', 'compose', 'ls', '--all', '--format', 'json'], baseCwd)

    const groups = new Map()
    for (const workspace of selected) {
      groups.set(workspace.path, { root: workspace.path, title: workspace.title, scanError: '', projects: new Map() })
    }
    const ensure = (root, dir) => {
      const group = groups.get(root)
      if (!group.projects.has(dir)) {
        group.projects.set(dir, {
          dir, name: '', status: '', dockerFiles: [], lsFiles: [], scanFiles: [], containers: [],
        })
      }
      return group.projects.get(dir)
    }

    let outside = 0
    let standalone = 0

    for (const row of parsePsRows(psRun.out)) {
      if (row.dir === '') {
        standalone += 1
        continue
      }
      const dir = normPath(row.dir)
      const owner = ownerOf(dir, selected)
      if (owner === null) {
        outside += 1
        continue
      }
      const project = ensure(owner.path, dir)
      if (project.name === '' && row.project !== '') project.name = row.project
      if (project.dockerFiles.length === 0 && row.files !== '') project.dockerFiles = splitList(row.files)
      project.containers.push({
        name: row.name,
        service: row.service,
        state: row.state,
        status: row.status,
        image: row.image,
        ports: row.ports,
      })
    }

    for (const entry of parseComposeLs(lsRun.out)) {
      let chosen = ''
      let owner = null
      for (const file of entry.files) {
        const dir = dirName(normPath(file))
        const candidate = ownerOf(dir, selected)
        if (candidate !== null) {
          chosen = dir
          owner = candidate
          break
        }
      }
      if (owner === null) {
        if (entry.files.length > 0) outside += 1
        continue
      }
      const project = ensure(owner.path, chosen)
      if (project.name === '') project.name = entry.name
      if (project.status === '') project.status = entry.status
      project.lsFiles = entry.files
    }

    for (const workspace of selected) {
      const group = groups.get(workspace.path)
      const scanRun = await run(['sh', '-c', FIND_SCRIPT, 'sh', workspace.path], workspace.path)
      group.scanError = firstLine(scanRun.err)
      for (const line of String(scanRun.out || '').split('\n')) {
        const file = line.trim()
        if (file === '' || file.charAt(0) !== '/') continue
        const dir = normPath(dirName(file))
        if (!withinRoot(dir, workspace.path)) continue
        ensure(workspace.path, dir).scanFiles.push({ path: normPath(file), name: baseName(file) })
      }
    }

    const outGroups = []
    let total = 0
    for (const workspace of selected) {
      const group = groups.get(workspace.path)
      const projects = []
      for (const project of group.projects.values()) {
        let files = []
        const source = project.dockerFiles.length > 0 ? project.dockerFiles : project.lsFiles
        if (source.length > 0) files = source.map((file) => ({ path: normPath(file), name: baseName(file) }))
        else files = project.scanFiles
        const seen = new Set()
        files = files.filter((file) => {
          if (seen.has(file.path)) return false
          seen.add(file.path)
          return true
        })
        const running = project.containers.filter((row) => row.state === 'running').length
        const count = project.containers.length
        const started = running > 0 || /running\(|paused\(/.test(project.status)
        projects.push({
          dir: project.dir,
          rel: project.dir === workspace.path
            ? '.'
            : (project.dir.startsWith(workspace.path + '/') ? project.dir.slice(workspace.path.length + 1) : project.dir),
          name: project.name !== '' ? project.name : baseName(project.dir),
          status: project.status !== '' ? project.status : (count === 0 ? '未启动' : running + '/' + count + ' running'),
          started,
          running,
          total: count,
          files,
          containers: project.containers.slice(0, CONTAINER_LIMIT),
        })
      }
      projects.sort((a, b) => {
        if (a.started !== b.started) return a.started ? -1 : 1
        if (a.total !== b.total) return b.total - a.total
        return a.rel < b.rel ? -1 : (a.rel > b.rel ? 1 : 0)
      })
      total += projects.length
      outGroups.push({ root: workspace.path, title: workspace.title, scanError: group.scanError, projects })
    }
    outGroups.sort((a, b) => (b.projects.length - a.projects.length) || (a.root < b.root ? -1 : 1))

    return {
      workspaces: all,
      groups: outGroups,
      total,
      outside,
      standalone,
      docker: {
        available: psRun.code === 0 || lsRun.code === 0,
        psCode: psRun.code,
        psError: firstLine(psRun.err),
        lsError: firstLine(lsRun.err),
      },
    }
  }

  /**
   * The `action` method: run one allow-listed compose subcommand against one
   * discovered project directory.
   *
   * Everything is re-validated here rather than trusted from the browser: the
   * directory must live inside a registered workspace, every `-f` file must
   * live inside that directory, and the action must be one of {@link ACTIONS}.
   * @param {{ dir?: unknown, files?: unknown, action?: unknown }} payload - the decoded request body.
   * @returns {Promise<Record<string, unknown>>} the exit code and bounded output.
   */
  const runAction = async (payload) => {
    const action = typeof payload.action === 'string' ? payload.action : ''
    const tail = ACTIONS[action]
    if (tail === undefined) throw new Error('未知操作：' + action)
    const dir = typeof payload.dir === 'string' ? normPath(payload.dir.trim()) : ''
    if (dir === '') throw new Error('缺少项目目录')
    const owner = ownerOf(dir, readWorkspaces())
    if (owner === null) throw new Error('项目目录不在任何工作区内：' + dir)
    const service = typeof payload.service === 'string' ? payload.service.trim() : ''
    if (service !== '' && !SERVICE_PATTERN.test(service)) throw new Error('非法的服务名：' + service)
    const files = Array.isArray(payload.files) ? payload.files : []
    const argv = ['docker', 'compose']
    for (const file of files) {
      if (typeof file !== 'string' || file === '') continue
      const path = normPath(file)
      if (!withinRoot(path, dir)) throw new Error('compose 文件不在项目目录内：' + path)
      argv.push('-f', path)
    }
    argv.push(...tail)
    if (service !== '') argv.push(service)
    const result = await run(argv, dir)
    return {
      action,
      dir,
      service,
      code: result.code,
      output: clampText(result.out || result.err, OUTPUT_LIMIT),
    }
  }

  /**
   * The compose files for one project directory when the caller named none.
   *
   * Docker already knows a started project's own ConfigFiles; a project that was
   * never brought up is settled by one shallow scan of the directory.
   * @param {string} dir - the project directory (absolute, already validated).
   * @returns {Promise<string[]>} absolute file paths inside dir.
   */
  const deriveFiles = async (dir) => {
    const files = []
    const push = (candidate) => {
      const path = normPath(candidate)
      if (path !== '' && withinRoot(path, dir) && files.indexOf(path) === -1) files.push(path)
    }
    const lsRun = await run(['docker', 'compose', 'ls', '--all', '--format', 'json'], dir)
    for (const entry of parseComposeLs(lsRun.out)) {
      for (const file of entry.files) push(file)
    }
    if (files.length > 0) return files
    const scanRun = await run([
      'sh', '-c',
      'find "$1" -maxdepth 1 \( -name "compose*.y*ml" -o -name "docker-compose*.y*ml" \) -print',
      'sh', dir,
    ], dir)
    for (const line of String(scanRun.out || '').split('\n')) {
      const path = line.trim()
      if (path.startsWith('/')) push(path)
    }
    return files
  }
  /**
   * Stream one project's (or one service's) logs as Server-Sent Events.
   *
   * SSE rather than a WebSocket: `docker compose logs -f` is one-directional,
   * the browser's EventSource reconnects on its own, and this needs no
   * dependency beyond the subprocess service's raw piped streams.
   * @param {import('node:http').IncomingMessage} req - the GET request.
   * @param {import('node:http').ServerResponse} res - the response to stream into.
   * @param {URL} url - the parsed request URL carrying the query parameters.
   */
  const streamLogs = async (req, res, url) => {
    const dir = normPath(url.searchParams.get('dir') ?? '')
    const service = (url.searchParams.get('service') ?? '').trim()
    const tailRaw = Number(url.searchParams.get('tail') ?? String(LOG_TAIL_DEFAULT))
    const tail = Number.isFinite(tailRaw)
      ? Math.min(Math.max(Math.trunc(tailRaw), 1), LOG_TAIL_MAX)
      : LOG_TAIL_DEFAULT
    const timestamps = url.searchParams.get('timestamps') === '1'
    const reject = (status, message) => {
      writeJson(res, status, { ok: false, error: { code: 'bad-request', message } })
    }
    if (dir === '') return reject(400, '缺少项目目录')
    if (ownerOf(dir, readWorkspaces()) === null) return reject(400, '项目目录不在任何工作区内：' + dir)
    if (service !== '' && !SERVICE_PATTERN.test(service)) return reject(400, '非法的服务名：' + service)
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined) return reject(503, 'subprocess service is unavailable')

    const named = url.searchParams.getAll('file').filter((file) => file !== '')
    const files = named.length > 0 ? named : await deriveFiles(dir)
    const argv = ['docker', 'compose']
    for (const file of files) {
      const path = normPath(file)
      if (!withinRoot(path, dir)) return reject(400, 'compose 文件不在项目目录内：' + path)
      argv.push('-f', path)
    }
    argv.push('logs', '-f', '--tail', String(tail))
    if (timestamps) argv.push('--timestamps')
    if (service !== '') argv.push(service)

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })

    let closed = false
    let sent = 0
    let handle
    let ping = null
    const send = (payload) => {
      if (closed) return
      try {
        res.write('data: ' + JSON.stringify(payload) + '\n\n')
      } catch {
        /* the peer went away; req 'close' will stop us */
      }
    }
    /** Stop everything exactly once: the docker process, the ping, the response. */
    const stop = (endResponse) => {
      if (closed) return
      closed = true
      if (ping !== null) clearInterval(ping)
      if (handle !== undefined) {
        try {
          handle.terminate()
        } catch {
          /* already gone */
        }
      }
      if (endResponse) {
        try {
          res.end()
        } catch {
          /* already ended */
        }
      }
    }

    try {
      handle = subprocess.spawn({
        argv,
        cwd: dir,
        // The browser does not need ANSI recovery: the CLI is asked for plain text.
        env: { ...process.env, NO_COLOR: '1' },
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 5000,
      })
    } catch (error) {
      send({ error: 'spawn failed: ' + String((error && error.message) || error) })
      stop(true)
      return
    }

    send({ open: true, command: 'docker compose ' + argv.slice(2).join(' ') })

    // One decoder per stream: a chunk boundary can split a multi-byte character,
    // and decoding each chunk alone would corrupt it.
    const decoders = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') }
    const forward = (stream, channel) => {
      if (stream === undefined) return
      stream.on('data', (chunk) => {
        if (closed) return
        sent += chunk.length
        if (sent > LOG_STREAM_LIMIT) {
          send({ eof: true, reason: '输出超过 ' + String(Math.round(LOG_STREAM_LIMIT / 1024 / 1024)) + 'MB，已停止' })
          stop(true)
          return
        }
        const text = decoders[channel].write(chunk)
        if (text !== '') send({ [channel]: text })
      })
      stream.on('end', () => {
        if (closed) return
        const text = decoders[channel].end()
        if (text !== '') send({ [channel]: text })
      })
    }
    forward(handle.stdout, 'out')
    forward(handle.stderr, 'err')

    ping = setInterval(() => {
      if (closed) return
      try {
        res.write(': ping\n\n')
      } catch {
        stop(false)
      }
    }, LOG_PING_MS)

    handle.done.then((outcome) => {
      if (closed) return
      send({ eof: true, code: outcome ? outcome.exitCode : null })
      stop(true)
    }, (error) => {
      if (closed) return
      send({ error: 'stream failed: ' + String((error && error.message) || error) })
      stop(true)
    })

    // A closed tab, a reload, or a navigation away must kill docker: `logs -f`
    // never ends on its own.
    req.on('close', () => stop(false))
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      const webRuntime = ctx.get('webRuntime')
      const trustedHosts = webRuntime && Array.isArray(webRuntime.trustedHosts) ? webRuntime.trustedHosts : []
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      const method = url.pathname.startsWith(ROUTE_PREFIX + '/') ? url.pathname.slice(ROUTE_PREFIX.length + 1) : ''
      // The log channel is a GET stream (EventSource cannot POST), so it carries
      // the read-side fence rather than the write-side one.
      if (method === 'logs') {
        if (!trustedStreamRequest(req, trustedHosts)) {
          writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
          return
        }
        streamLogs(req, res, url).catch((error) => {
          if (!res.headersSent) {
            writeJson(res, 500, { ok: false, error: { code: 'internal', message: String((error && error.message) || error) } })
            return
          }
          try {
            res.end()
          } catch {
            /* already ended */
          }
        })
        return
      }
      if (!isTrustedRequest(req, trustedHosts)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      if (method === '' || method.includes('/')) {
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown compose API method' } })
        return
      }
      try {
        const text = await readBody(req)
        let payload = {}
        if (text.trim() !== '') payload = JSON.parse(text)
        if (method === 'action') {
          try {
            const value = await runAction(payload && typeof payload === 'object' ? payload : {})
            writeJson(res, 200, { ok: true, value })
          } catch (error) {
            writeJson(res, 400, {
              ok: false,
              error: { code: 'bad-request', message: String((error && error.message) || error) },
            })
          }
          return
        }
        if (method === 'list') {
          writeJson(res, 200, { ok: true, value: await list(payload && typeof payload === 'object' ? payload : {}) })
          return
        }
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown compose API method "' + method + '"' } })
      } catch (error) {
        writeJson(res, 500, {
          ok: false,
          error: { code: 'internal', message: String((error && error.message) || error) },
        })
      }
    },
  }), 'dsh-compose-panel: /compose/api route')
}
