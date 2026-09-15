/**
 * Client half of dsh-compose-panel.
 *
 * Registers ONE tab type into DSH's native right sidebar, the same public path
 * the shipped "Files" type and the dsh-better-sidebar tabs use:
 *
 *   - `ctx.sidebarRightTabs.register({ id, kind, title, guide })` declares the
 *     type, so the sidebar's guide page offers a "容器" capsule that opens it;
 *   - `sidebar.right.pane.tab` (keyed by that id) draws the pane body, and
 *     `sidebar.right.pane.tab.title` supplies the chip glyph.
 *
 * Data comes from this package's own Host route (`/compose/api/list`), the same
 * envelope every /sidebar-style JSON route uses: `{ok: true, value}` on
 * success, `{ok: false, error: {code, message}}` on failure.
 *
 * This file is this package's `./client` bundle, in the same factory form every
 * web plugin hands to `window.__ModuleLoader__`: no imports, the bundler-owned
 * `require("react")` seed, and a plain-Cordis plugin exported as
 * `{ name, inject, apply }`.
 */
window.__ModuleLoader__.load({
	id: "dsh-compose-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		/** The implementation id: unique across tab-type registrations, and the slot key. */
		const TAB_ID = "dsh-compose-panel";
		/** The pane kind `openTab` names. */
		const TAB_KIND = "dsh-compose-panel";
		/** Where the guide capsule sits (after Files 10 / Context 20 / Changes 20). */
		const GUIDE_ORDER = 45;
		/** The second type this plugin owns: one service's live logs. */
		const LOGS_ID = "dsh-compose-panel/logs";
		const LOGS_KIND = "compose-logs";
		/** Replay sizes offered in the logs header. */
		const LOG_TAIL_OPTIONS = [100, 200, 500, 2000];
		/** How many lines the logs pane keeps in memory. */
		const LOG_LINE_LIMIT = 2000;
		/**
		 * The log surface's own stylesheet, injected once per client run and owned
		 * by this plugin's fiber. The rest of the panel is inline-styled, but a
		 * per-line :hover and a slim scrollbar need real CSS — and classes keep
		 * 2000 lines cheap to render.
		 */
		const LOG_CSS = [
			".dcp-logbox{overflow:auto;scrollbar-width:thin}",
			".dcp-logbox::-webkit-scrollbar{width:8px;height:8px}",
			".dcp-logbox::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2,rgba(127,127,127,.35));border-radius:4px}",
			".dcp-logbox::-webkit-scrollbar-track{background:transparent}",
			".dcp-log{padding:4px 0}",
			".dcp-log-row{display:flex;align-items:baseline;gap:8px;padding:1px 10px;border-left:2px solid transparent;line-height:18px}",
			// Alternating tint, faint enough to read as a texture rather than a table:
			// consecutive entries (especially wrapped ones) stop merging into one block.
			".dcp-log-row:nth-child(even){background:rgba(127,127,127,.05)}",
			".dcp-log-row:hover{background:rgba(127,127,127,.15)}",
			".dcp-log-row.err{border-left-color:var(--dsw-alias-state-error-primary,#f85149)}",
			".dcp-log-row.warn{border-left-color:var(--dsw-alias-state-warn-label,#d29922)}",
			".dcp-log-ts{flex:none;color:var(--dsw-alias-label-tertiary,rgba(140,140,150,1));opacity:.85;font-variant-numeric:tabular-nums}",
			".dcp-log-svc{flex:none;max-width:88px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}",
			".dcp-log-msg{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word}",
			".dcp-log.nowrap .dcp-log-row{width:max-content;min-width:100%}",
			".dcp-log.nowrap .dcp-log-msg{white-space:pre;word-break:normal}",
			".dcp-log-row.err .dcp-log-msg{color:var(--dsw-alias-state-error-primary,#f85149)}",
			".dcp-log-row.warn .dcp-log-msg{color:var(--dsw-alias-state-warn-label,#d29922)}",
		].join("\n");

		/**
		 * Mid-tone colours for service prefixes: readable on a light page and on a
		 * dark one, unlike a lightness chosen for either.
		 */
		const SVC_PALETTE = [
			"hsl(210 62% 52%)", "hsl(150 45% 42%)", "hsl(275 48% 58%)", "hsl(24 68% 50%)",
			"hsl(340 55% 55%)", "hsl(190 55% 42%)", "hsl(45 65% 42%)", "hsl(100 40% 42%)",
		];

		/** docker's `--timestamps` prefix, and compose's `service-1 | ` prefix. */
		const LOG_TS = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+Z?)\s+/;
		const LOG_SVC = /^([A-Za-z0-9._-]+)\s+\|\s?/;
		/**
		 * The resource scheme the logs tab is addressed by. A resource tab is
		 * deduplicated by (kind, contentId) — NOT by kind alone the way a page tab
		 * is — so encoding the target into the address is what lets several services
		 * hold several tabs, while re-opening one service focuses the tab it already has.
		 */
		const LOGS_SCHEME = "dsh-resource://compose-logs/";
		const LOGS_PATTERN = LOGS_SCHEME + "**";

		/**
		 * The address for one log target. The directory is percent-encoded so the
		 * scheme stays a flat two-segment path; an absent service means the project.
		 * @param {string} dir - the project directory (absolute).
		 * @param {string} service - the service name, or "" for the whole project.
		 * @returns {string} the resource address.
		 */
		function logsAddress(dir, service) {
			const base = LOGS_SCHEME + encodeURIComponent(String(dir || ""));
			return service === "" ? base : base + "/" + encodeURIComponent(String(service));
		}

		/**
		 * Read one log address back into its target.
		 * @param {unknown} address - the tab content id.
		 * @returns {{ dir: string, service: string } | null} the target, or null.
		 */
		function parseLogsAddress(address) {
			const text = String(address || "");
			if (!text.startsWith(LOGS_SCHEME)) return null;
			const rest = text.slice(LOGS_SCHEME.length);
			const slash = rest.indexOf("/");
			try {
				if (slash === -1) return { dir: decodeURIComponent(rest), service: "" };
				return { dir: decodeURIComponent(rest.slice(0, slash)), service: decodeURIComponent(rest.slice(slash + 1)) };
			} catch (error) {
				return null;
			}
		}

		/** The allow-listed project actions this UI may request, keyed by Host action name. */
		const ACTION_LABEL = { up: "启动", restart: "重启", stop: "停止" };

		/**
		 * The identity of one actionable target: a whole project (`service === ""`)
		 * or one of its services. Used for the pending and armed bookkeeping.
		 * @param {{ dir?: string }} project - the project.
		 * @param {string} [service] - the service name, when the target is one service.
		 * @returns {string} a stable key.
		 */
		function targetKey(project, service) {
			return String(project.dir || "") + "|" + String(service || "");
		}

		/** How long a primed 停止 button stays armed before it disarms itself. */
		const CONFIRM_MS = 4000;

		/** How long an action's result banner stays up before retiring itself. */
		const NOTICE_OK_MS = 3000;
		const NOTICE_ERR_MS = 8000;

		/** How long a shown payload still counts as current when a tab returns. */
		const FRESH_MS = 15000;

		/**
		 * The last list payload per workspace root. The pane body is remounted
		 * whenever its tab comes back, and a body that starts from nothing can only
		 * show a spinner — so it starts from this instead and refreshes quietly.
		 */
		const listCache = new Map();

		/** Where this panel caches its own view state (fold map + workspace choice). */
		const PREFS_KEY = "dsh-compose-panel:ui";

		/**
		 * Read the cached view state. Best-effort: a browser without storage, a
		 * disabled/blocked store, or a corrupted value all degrade to "no cache".
		 * @returns {{ root?: string, collapsed?: Record<string, boolean> }} the cached state.
		 */
		function readPrefs() {
			try {
				if (typeof localStorage === "undefined") return {};
				const raw = localStorage.getItem(PREFS_KEY);
				if (raw === null || raw === "") return {};
				const parsed = JSON.parse(raw);
				return parsed && typeof parsed === "object" ? parsed : {};
			} catch (error) {
				return {};
			}
		}

		/**
		 * Write the cached view state. Best-effort, never throws into a render.
		 * @param {{ root: string, collapsed: Record<string, boolean> }} next - the state to cache.
		 */
		function writePrefs(next) {
			try {
				if (typeof localStorage === "undefined") return;
				localStorage.setItem(PREFS_KEY, JSON.stringify(next));
			} catch (error) {
				/* storage full or unavailable: caching is a nicety, not a requirement */
			}
		}

		/** Theme-friendly inline styles: tokens where the product has them, translucent neutrals otherwise. */
		const S = {
			pane: { display: "flex", flexDirection: "column", width: "100%", height: "100%", minHeight: 0, font: "12px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif", color: "inherit" },
			head: { display: "flex", alignItems: "center", gap: "8px", padding: "10px 12px", borderBottom: "1px solid rgba(127,127,127,.28)" },
			title: { fontWeight: 600, fontSize: "13px", flex: "none" },
			count: { flex: "none", fontSize: "11px", lineHeight: "16px", padding: "1px 8px", borderRadius: "999px", border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))", background: "transparent", color: "var(--dsw-alias-label-secondary, inherit)", whiteSpace: "nowrap" },
			spacer: { flex: 1, minWidth: "6px" },
			actions: { display: "flex", alignItems: "center", gap: "6px", flex: "none" },
			selectWrap: { position: "relative", display: "inline-flex", alignItems: "center", flex: "none" },
			select: { appearance: "none", WebkitAppearance: "none", MozAppearance: "none", maxWidth: "152px", height: "26px", boxSizing: "border-box", padding: "0 30px 0 10px", border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))", borderRadius: "6px", background: "var(--dsw-alias-bg-base, transparent)", color: "var(--dsw-alias-label-primary, inherit)", fontSize: "12px", lineHeight: 1, cursor: "pointer" },
			// Same drawn chevron the shipped settings selects use, at the same size
			// and inset — a 9px text ▾ read as a speck next to the product's controls.
			selectCaret: { position: "absolute", right: "10px", top: 0, bottom: 0, display: "flex", alignItems: "center", pointerEvents: "none", color: "var(--dsw-alias-label-secondary, inherit)" },
			selectFocus: { outline: "2px solid var(--dsw-alias-interactive-bg-hover-accent, rgba(77,107,254,.75))", outlineOffset: "-1px" },
			btn: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: "24px", height: "24px", padding: 0, border: "none", borderRadius: "6px", background: "transparent", color: "var(--dsw-alias-label-secondary, inherit)", cursor: "pointer", fontSize: "14px", lineHeight: 1, flex: "none", transition: "background .12s ease, color .12s ease" },
			btnHover: { background: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14))", color: "var(--dsw-alias-label-primary, inherit)" },
			btnActive: { background: "var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.22))", color: "var(--dsw-alias-label-primary, inherit)" },
			btnFocus: { outline: "2px solid var(--dsw-alias-interactive-bg-hover-accent, rgba(77,107,254,.75))", outlineOffset: "-1px" },
			btnMuted: { opacity: .4, cursor: "default" },
			btnDanger: { color: "var(--dsw-alias-state-error-primary, #f85149)" },
			rowActions: { display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "2px", flex: "none" },
			ok: { margin: "4px 0 8px", padding: "8px", borderRadius: "6px", background: "rgba(63,185,80,.12)", border: "1px solid rgba(63,185,80,.4)", color: "#3fb950", wordBreak: "break-word", cursor: "pointer" },
			body: { flex: 1, minHeight: 0, overflow: "auto", padding: "8px 10px 24px" },
			err: { margin: "4px 0 8px", padding: "8px", borderRadius: "6px", background: "rgba(248,81,73,.14)", border: "1px solid rgba(248,81,73,.4)", color: "#f85149", wordBreak: "break-word" },
			warn: { margin: "4px 0 8px", padding: "8px", borderRadius: "6px", background: "rgba(210,153,34,.14)", border: "1px solid rgba(210,153,34,.4)", color: "#d29922", wordBreak: "break-word" },
			note: { margin: "4px 0 8px", color: "var(--dsw-alias-label-tertiary, rgba(140,140,150,1))" },
			empty: { margin: "16px 0", color: "var(--dsw-alias-label-tertiary, rgba(140,140,150,1))", textAlign: "center" },
			ws: { margin: "2px 0 10px" },
			wsHead: { display: "flex", alignItems: "baseline", gap: "7px", padding: "2px 3px 6px" },
			wsTitle: { fontWeight: 600 },
			wsPath: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, rgba(140,140,150,1))" },
			proj: { margin: "0 0 8px", border: "1px solid rgba(127,127,127,.28)", borderRadius: "8px", overflow: "hidden" },
			// The log surface: one monospace block that owns its own scrolling.
			logHead: { flex: "none", display: "flex", alignItems: "center", gap: "6px", padding: "6px 0 8px", minWidth: 0 },
			logTarget: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "12px" },
			logStatus: { flex: "none", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, rgba(140,140,150,1))" },
			logNote: { flex: "none", padding: "0 0 8px", fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-tertiary, rgba(140,140,150,1))" },
			logNoteError: { flex: "none", padding: "0 0 8px", fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-state-error-primary, #f85149)" },
			logBox: { flex: 1, minHeight: 0, overflow: "auto", padding: "8px 0", borderRadius: "8px", background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.08))", fontFamily: "var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)", fontSize: "11px", lineHeight: "16px" },
			logEmpty: { color: "var(--dsw-alias-label-tertiary, rgba(140,140,150,1))" },
			logWrap: { position: "relative", flex: 1, minHeight: 0, display: "flex" },
			logBoxNoWrap: { flex: 1, minHeight: 0, padding: "8px 0", borderRadius: "8px", background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.08))", fontFamily: "var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)", fontSize: "11px" },
			logDot: { width: "6px", height: "6px", borderRadius: "50%", marginRight: "5px", display: "inline-block" },
			logJump: { position: "absolute", right: "12px", bottom: "12px", height: "26px", padding: "0 12px", border: "none", borderRadius: "13px", background: "var(--dsw-alias-bg-layer-3, rgba(96,96,102,.95))", color: "var(--dsw-alias-label-primary-inverted, #fff)", fontSize: "11px", cursor: "pointer", boxShadow: "0 2px 10px rgba(0,0,0,.28)" },
			projHead: { display: "flex", alignItems: "center", gap: "7px", padding: "7px 9px", background: "transparent", cursor: "pointer", userSelect: "none", borderRadius: "7px 7px 0 0" },
			projHeadHover: { background: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1))" },
			dot: { width: "8px", height: "8px", borderRadius: "50%", flex: "none" },
			projName: { flex: "0 1 auto", minWidth: 0, maxWidth: "38%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 },
			projRel: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, rgba(140,140,150,1))" },
			projStat: { flex: "1 1 auto", minWidth: 0, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, rgba(140,140,150,1))" },
			caret: { flex: "none", width: "18px", height: "18px", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "4px", color: "inherit", opacity: .65 },
			caretGlyph: { flex: "none", transition: "transform .12s ease" },
			chip: { display: "inline-flex", alignItems: "center", gap: "4px" },
			chipGlyph: { fontSize: "13px", lineHeight: 1 },
			row: { display: "flex", alignItems: "center", gap: "7px", padding: "5px 9px", borderTop: "1px solid rgba(127,127,127,.18)", cursor: "pointer" },
			sdot: { width: "6px", height: "6px", borderRadius: "50%", flex: "none" },
			svc: { flex: "none", width: "84px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 },
			cname: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--dsw-alias-label-tertiary, rgba(140,140,150,1))" },
			state: { flex: "1 1 auto", minWidth: 0, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "11px", opacity: .85 },
			// The right cell holds either the status or the actions. A fixed height
			// keeps the row exactly as tall either way, so hovering a row no longer
			// nudges the whole list by the difference between text and buttons.
			rightSlot: { flex: "none", width: "124px", minWidth: 0, height: "24px", display: "flex", alignItems: "center", justifyContent: "flex-end" },
			ports: { flex: "none", width: "100px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "right", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, rgba(140,140,150,1))" },
			none: { padding: "6px 9px", borderTop: "1px solid rgba(127,127,127,.18)", color: "var(--dsw-alias-label-tertiary, rgba(140,140,150,1))" },
			files: { padding: "5px 9px", borderTop: "1px solid rgba(127,127,127,.18)", fontSize: "11px", wordBreak: "break-all", color: "var(--dsw-alias-label-tertiary, rgba(140,140,150,1))" },
		};

		/** Green for a running container, neutral grey for anything else. */
		const DOT_ON = { background: "#3fb950" };
		const DOT_OFF = { background: "rgba(139,139,147,1)" };

		/**
		 * Auto-refresh cadence. Compose state changes on a human/agent timescale,
		 * so the idle poll is deliberately slow; a container mid-transition
		 * (created / restarting / health starting) earns the faster one.
		 */
		const REFRESH_IDLE_MS = 45000;
		const REFRESH_BUSY_MS = 8000;

		/** Container states that mean "something is still happening". */
		const TRANSIENT_STATES = { created: 1, restarting: 1, removing: 1, dead: 1, paused: 1 };

		/**
		 * Whether any reported container is mid-transition, so the poll should speed up.
		 * @param {any} data - the last Host payload.
		 * @returns {boolean} true while something is still settling.
		 */
		function isTransitional(data) {
			if (!data || !Array.isArray(data.groups)) return false;
			for (const group of data.groups) {
				const projects = Array.isArray(group.projects) ? group.projects : [];
				for (const project of projects) {
					const containers = Array.isArray(project.containers) ? project.containers : [];
					for (const row of containers) {
						if (TRANSIENT_STATES[row.state] === 1) return true;
						const status = String(row.status || "");
						if (status.indexOf("health: starting") !== -1
							|| status.indexOf("Restarting") !== -1
							|| status.indexOf("Starting") !== -1) return true;
					}
				}
			}
			return false;
		}

		/**
		 * The color of one presence dot.
		 * @param {boolean} on - whether the row is running.
		 * @returns {object} the style fragment.
		 */
		function dotColor(on) {
			return on ? DOT_ON : DOT_OFF;
		}

		/**
		 * Call one Host method and unwrap its envelope.
		 * @param {string} method - the method name.
		 * @param {object} payload - the JSON payload.
		 * @returns {Promise<any>} the unwrapped value.
		 */
		async function callHost(method, payload) {
			let response;
			try {
				response = await fetch("/compose/api/" + method, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload || {}),
				});
			} catch (error) {
				throw new Error((error && error.message) || String(error));
			}
			const parsed = await response.json().catch(() => null);
			if (!response.ok || parsed === null || parsed.ok !== true) {
				const message = parsed && parsed.error && parsed.error.message
					? parsed.error.message
					: "HTTP " + response.status;
				throw new Error(message);
			}
			return parsed.value;
		}

		/**
		 * The plugin body: one native tab type plus its body and chip-title seats.
		 * @param {object} ctx - the client Cordis context.
		 */
		// NOTE: the loader applies this entry as soon as it has the module, and its
		// apply can run before the tail of this factory body has executed. apply may
		// therefore read ONLY declarations above it — a const declared further down
		// is still in its temporal dead zone (that is exactly how a stylesheet
		// constant once broke boot with "Cannot access LOG_CSS before initialization").
		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			const timer = ctx.get("timer");

			// The log viewer's stylesheet: one injected sheet per client run, removed
			// together with this plugin's fiber.
			ctx.effect(() => {
				if (typeof document === "undefined" || document.head === null) return undefined;
				const sheet = document.createElement("style");
				sheet.textContent = LOG_CSS;
				document.head.appendChild(sheet);
				return () => { sheet.remove(); };
			});

			/** Register one seat, downgrading a refusal to a logged no-op. */
			function safeRegister(slotName, options, component) {
				return () => {
					try {
						const dispose = slots.register(Object.assign({ name: slotName }, options), component);
						return typeof dispose === "function" ? dispose : () => {};
					} catch (error) {
						console.error("[compose-panel] slot register failed for " + slotName + ": " + String((error && error.message) || error));
						return () => {};
					}
				};
			}

			/** A poll tick, driven by the product's timer service; re-armed when the cadence changes. */
			function useAutoTick(intervalMs, enabled) {
				const pair = React.useState(0);
				const setTick = pair[1];
				React.useEffect(() => {
					if (!enabled) return undefined;
					if (timer === undefined || typeof timer.interval !== "function") return undefined;
					return timer.interval(() => setTick((value) => value + 1), intervalMs);
				}, [intervalMs, enabled]);
				return pair[0];
			}

			/**
			 * A square icon button with its own hover/press feedback.
			 * @param {object} props - title, onClick, optional disabled, and the glyph.
			 */
			function IconButton(props) {
				const hoverPair = React.useState(false);
				const setHover = hoverPair[1];
				const pressPair = React.useState(false);
				const setPress = pressPair[1];
				const focusPair = React.useState(false);
				const setFocus = focusPair[1];
				const muted = props.disabled === true;
				const style = Object.assign({}, S.btn, muted ? S.btnMuted : null,
					props.danger === true ? S.btnDanger : null,
					props.pressed === true ? S.btnActive : null,
					focusPair[0] ? S.btnFocus : null,
					!muted && hoverPair[0] ? S.btnHover : null, !muted && pressPair[0] ? S.btnActive : null);
				return React.createElement("button", {
					type: "button",
					style: style,
					title: props.title,
					"aria-label": props.title,
					disabled: muted,
					onClick: props.onClick,
					onMouseEnter: () => setHover(true),
					onMouseLeave: () => { setHover(false); setPress(false); },
					onMouseDown: () => setPress(true),
					onMouseUp: () => setPress(false),
					onFocus: () => setFocus(true),
					onBlur: () => setFocus(false),
				}, props.children);
			}

			/**
			 * A select with the native chrome removed and a drawn caret instead.
			 * @param {object} props - value, onChange, plus the option children.
			 */
			function SelectBox(props) {
				const focusPair = React.useState(false);
				const style = Object.assign({}, S.select, focusPair[0] ? S.selectFocus : null);
				return React.createElement("span", { style: S.selectWrap },
					React.createElement("select", {
						style: style,
						value: props.value,
						title: props.title,
						onChange: props.onChange,
						onFocus: () => focusPair[1](true),
						onBlur: () => focusPair[1](false),
					}, props.children),
					React.createElement("span", { style: S.selectCaret, "aria-hidden": "true" },
						React.createElement("svg", {
							width: 12,
							height: 12,
							viewBox: "0 0 12 12",
							fill: "none",
						},
							React.createElement("path", {
								d: "M3 4.5L6 7.5L9 4.5",
								stroke: "currentColor",
								strokeWidth: 1.5,
								strokeLinecap: "round",
								strokeLinejoin: "round",
							}))));
			}

			/** One container row. */
			/**
			 * One service row. Its own actions stay invisible until the pointer (or
			 * keyboard focus) is on the row, and then they replace the ports column
			 * so the row never grows.
			 * @param {object} props - the row plus its pending/armed state and handler.
			 */
			function ContainerRow(props) {
				const row = props.row;
				const running = row.state === "running";
				const hoverPair = React.useState(false);
				const focusPair = React.useState(false);
				const shown = hoverPair[0] || focusPair[0];
				return React.createElement("div", {
					style: S.row,
					tabIndex: 0,
					title: "点击查看该服务日志",
					onClick: () => props.onOpenLogs(),
					onMouseEnter: () => hoverPair[1](true),
					onMouseLeave: () => hoverPair[1](false),
					onFocus: () => focusPair[1](true),
					onBlur: (event) => {
						if (event.currentTarget.contains(event.relatedTarget)) return;
						focusPair[1](false);
					},
				},
					React.createElement("span", { style: Object.assign({}, S.sdot, dotColor(running)) }),
					React.createElement("span", { style: S.svc }, String(row.service || "-")),
					React.createElement("span", { style: S.cname, title: String(row.name || "") }, String(row.name || "")),
					React.createElement("span", { style: S.ports, title: String(row.ports || "") }, String(row.ports || "")),
					// One right-hand cell: the status by default, the actions in its
					// place while the pointer or the keyboard is on this row. Same cell
					// and same right edge, so nothing ever shifts.
					React.createElement("span", { style: S.rightSlot },
						shown
							? React.createElement("span", { style: S.rowActions },
							React.createElement(IconButton, {
								title: "启动该服务（docker compose up -d " + String(row.service || "") + "）",
								disabled: props.busy === true,
								onClick: (event) => { event.stopPropagation(); props.onAction("up"); },
							}, "▶"),
							React.createElement(IconButton, {
								title: "重启该服务（docker compose restart " + String(row.service || "") + "）",
								disabled: props.busy === true,
								onClick: (event) => { event.stopPropagation(); props.onAction("restart"); },
							}, "↻"),
							React.createElement(IconButton, {
								title: props.armed ? "再次点击确认停止该服务" : "停止该服务（docker compose stop " + String(row.service || "") + "）",
								disabled: props.busy === true,
								danger: props.armed === true,
								onClick: (event) => { event.stopPropagation(); props.onAction("stop"); },
							}, "■")
						)
							: React.createElement("span", { style: S.state, title: String(row.status || row.state || "") },
								props.pending ? ACTION_LABEL[props.pending] + " 中…" : String(row.status || row.state || "")))
				);
			}

			/**
			 * One compose project: a clickable header that folds its body away.
			 * @param {object} props - the project plus its fold state and toggle.
			 */
			function Project(props) {
				const project = props.project;
				const containers = Array.isArray(project.containers) ? project.containers : [];
				const files = Array.isArray(project.files) ? project.files : [];
				const folded = props.collapsed === true;
				const hoverPair = React.useState(false);
				const headHover = hoverPair[0];
				const focusPair = React.useState(false);
				const showActions = headHover || focusPair[0];
				const armed = props.armedStop === targetKey(project, "");
				// The relative path only earns its column when it says something the
				// project name does not (a project named after its own directory is
				// the common case, and printing it twice just looks broken).
				const rel = String(project.rel || "");
				const showRel = rel !== "" && rel !== "." && rel !== String(project.name || "");
				const body = [];
				if (!folded) {
					if (containers.length > 0) {
						for (let index = 0; index < containers.length; index += 1) {
							const row = containers[index];
							body.push(React.createElement(ContainerRow, {
								key: "c" + String(index),
								row: row,
								pending: props.pendingOf(row.service),
								busy: props.busy === true,
								armed: props.armedStop === targetKey(project, row.service),
								onAction: (action) => props.onAction(action, row.service),
								onOpenLogs: () => props.onOpenLogs(row.service),
							}));
						}
					} else {
						body.push(React.createElement("div", { key: "none", style: S.none }, "未启动"));
					}
					if (files.length > 0) {
						body.push(React.createElement("div", { key: "files", style: S.files },
							files.map((file) => String(file.name)).join(" · ")));
					}
				}
				return React.createElement("div", { style: S.proj },
					React.createElement("div", {
						style: Object.assign({}, S.projHead, headHover ? S.projHeadHover : null),
						onClick: props.onToggle,
						role: "button",
						tabIndex: 0,
						title: folded ? "展开该项目的服务" : "折叠该项目的服务",
						onMouseEnter: () => hoverPair[1](true),
						onMouseLeave: () => hoverPair[1](false),
						onFocus: () => focusPair[1](true),
						onBlur: (event) => {
							if (event.currentTarget.contains(event.relatedTarget)) return;
							focusPair[1](false);
						},
						onKeyDown: (event) => {
							if (event.key === "Enter" || event.key === " ") {
								event.preventDefault();
								props.onToggle();
							}
						},
					},
						React.createElement("span", { style: S.caret, "aria-hidden": "true" },
							React.createElement("svg", {
								width: 12,
								height: 12,
								viewBox: "0 0 16 16",
								style: Object.assign({}, S.caretGlyph, { transform: folded ? "rotate(0deg)" : "rotate(90deg)" }),
							},
								React.createElement("path", {
									d: "M6 3.4 L10.4 8 L6 12.6",
									fill: "none",
									stroke: "currentColor",
									strokeWidth: 1.9,
									strokeLinecap: "round",
									strokeLinejoin: "round",
								}))),
						React.createElement("span", { style: Object.assign({}, S.dot, dotColor(project.started === true)) }),
						React.createElement("span", { style: S.projName, title: String(project.dir || "") }, String(project.name || "")),
						React.createElement("span", { style: S.projRel, title: showRel ? String(project.dir || "") : "" }, showRel ? rel : ""),
						// One right-hand cell: the status by default, the actions in its
						// place while the pointer or the keyboard is on this row.
						React.createElement("span", { style: S.rightSlot },
							showActions
								? React.createElement("span", { style: S.rowActions },
									React.createElement(IconButton, {
										title: "启动（docker compose up -d）",
										disabled: props.busy === true,
										onClick: (event) => { event.stopPropagation(); props.onAction("up", ""); },
									}, "▶"),
									React.createElement(IconButton, {
										title: "重启（docker compose restart）",
										disabled: props.busy === true,
										onClick: (event) => { event.stopPropagation(); props.onAction("restart", ""); },
									}, "↻"),
									React.createElement(IconButton, {
										title: armed ? "再次点击确认停止" : "停止（docker compose stop）",
										disabled: props.busy === true,
										danger: armed,
										onClick: (event) => { event.stopPropagation(); props.onAction("stop", ""); },
									}, "■")
								)
								: React.createElement("span", { style: S.projStat, title: String(project.status || "") },
									props.pending ? ACTION_LABEL[props.pending] + " 中…" : String(project.status || "")))
					),
					body
				);
			}

			/** One workspace: header plus its projects. */
			function WorkspaceGroup(props) {
				const group = props.group;
				const projects = Array.isArray(group.projects) ? group.projects : [];
				const children = [
					React.createElement("div", { key: "head", style: S.wsHead },
						React.createElement("span", { style: S.wsTitle }, String(group.title || group.root || "")),
						React.createElement("span", { style: S.wsPath, title: String(group.root || "") }, String(group.root || "")),
						React.createElement("span", { style: S.projStat }, String(projects.length) + " 个项目")
					),
				];
				if (projects.length === 0) {
					children.push(React.createElement("div", { key: "none", style: S.note }, "未发现 compose 项目"));
				}
				for (let index = 0; index < projects.length; index += 1) {
					const project = projects[index];
					children.push(React.createElement(Project, {
						key: "p" + String(index),
						project: project,
						collapsed: props.isCollapsed(project),
						onToggle: () => props.onToggle(project),
						pending: props.pendingOf(project, ""),
						pendingOf: (service) => props.pendingOf(project, service),
						busy: props.pending !== null,
						armedStop: props.armedStop,
						onAction: (action, service) => props.onAction(project, action, service),
						onOpenLogs: (service) => props.onOpenLogs(project, service),
					}));
				}
				if (group.scanError) {
					children.push(React.createElement("div", { key: "scanerr", style: S.note }, "扫描警告：" + String(group.scanError)));
				}
				return React.createElement("div", { style: S.ws }, children);
			}

			/** The pane body: fetch, filter, render. */
			function ComposePane(props) {
				// The seat hands the tab's own information down as a prop — the same
				// `useTabInfo` the shipped guide body reads. It is what tells this
				// body when its tab is actually on screen, so returning to the tab
				// refetches instead of showing whatever was true last time.
				const useTabInfo = props && typeof props.useTabInfo === "function" ? props.useTabInfo : null;
				const info = useTabInfo === null ? null : useTabInfo();
				const tabInfo = info && info.tab ? info.tab : null;
				const onScreen = tabInfo === null || tabInfo.visible === undefined ? true : tabInfo.visible === true;
				const rootPair = React.useState(() => {
					const cached = readPrefs();
					return typeof cached.root === "string" ? cached.root : "";
				});
				const root = rootPair[0];
				const setRoot = rootPair[1];
				const cachedList = listCache.get(root || "");
				const dataPair = React.useState(cachedList ? cachedList.value : null);
				const data = dataPair[0];
				const setData = dataPair[1];
				const lastLoadAt = React.useRef(cachedList ? cachedList.at : 0);
				const inFlight = React.useRef(false);
				const errorPair = React.useState("");
				const error = errorPair[0];
				const setError = errorPair[1];
				const busyPair = React.useState(false);
				const busy = busyPair[0];
				const setBusy = busyPair[1];
				const noncePair = React.useState(0);
				const nonce = noncePair[0];
				const setNonce = noncePair[1];
				const collapsedPair = React.useState(() => {
					const cached = readPrefs();
					return cached.collapsed && typeof cached.collapsed === "object" ? cached.collapsed : {};
				});
				const collapsed = collapsedPair[0];
				const setCollapsed = collapsedPair[1];

				/** Cache the two view-state pieces together, so neither write drops the other. */
				const persistUi = (nextRoot, nextCollapsed) => {
					writePrefs({ root: nextRoot, collapsed: nextCollapsed });
				};
				const tick = useAutoTick(isTransitional(data) ? REFRESH_BUSY_MS : REFRESH_IDLE_MS, onScreen);

				/** A project starts folded; only an explicit toggle opens it. */
				const isCollapsed = (project) => {
					const known = collapsed[String(project.dir || "")];
					return known === undefined ? true : known;
				};
				const toggleProject = (project) => {
					const key = String(project.dir || "");
					const next = Object.assign({}, collapsed);
					next[key] = !isCollapsed(project);
					setCollapsed(next);
					persistUi(root, next);
				};

				const pendingPair = React.useState(null);
				const pending = pendingPair[0];
				const setPending = pendingPair[1];
				const noticePair = React.useState(null);
				const notice = noticePair[0];
				const setNotice = noticePair[1];
				const armedPair = React.useState("");
				const armedStop = armedPair[0];
				const setArmedStop = armedPair[1];
				const noticeToken = React.useRef(0);

				/** Drop the current banner and retire any timer still pointed at it. */
				const clearNotice = () => {
					noticeToken.current += 1;
					setNotice(null);
				};

				/**
				 * Show one action result and let it retire itself: a success reads in
				 * a moment, a failure deserves longer. A newer banner bumps the token,
				 * so an older banner's timer can never clear fresher text.
				 */
				const showNotice = (next) => {
					noticeToken.current += 1;
					const token = noticeToken.current;
					setNotice(next);
					const ttl = next.kind === "ok" ? NOTICE_OK_MS : NOTICE_ERR_MS;
					if (timer !== undefined && typeof timer.timeout === "function") {
						timer.timeout(() => {
							if (noticeToken.current === token) setNotice(null);
						}, ttl);
					}
				};

				/** Which action, if any, is pending for one project/service target. */
				const pendingOf = (project, service) => (
					pending !== null
					&& pending.dir === String(project.dir || "")
					&& pending.service === String(service || "")
						? pending.action
						: ""
				);

				/**
				 * Run one action against a whole project (`service === ""`) or one of
				 * its services. 停止 is two-step: the first press only arms that exact
				 * button for {@link CONFIRM_MS}; every other action runs at once.
				 */
				const runAction = (project, action, service) => {
					if (pending !== null) return;
					const dir = String(project.dir || "");
					const name = String(service || "");
					const key = targetKey(project, name);
					if (action === "stop" && armedStop !== key) {
						setArmedStop(key);
						if (timer !== undefined && typeof timer.timeout === "function") {
							timer.timeout(() => setArmedStop(""), CONFIRM_MS);
						}
						return;
					}
					setArmedStop("");
					setPending({ dir: dir, action: action, service: name });
					clearNotice();
					const files = (Array.isArray(project.files) ? project.files : []).map((file) => String(file.path || ""));
					callHost("action", { dir: dir, files: files, action: action, service: name }).then((value) => {
						setPending(null);
						const label = String(project.name || dir) + (name === "" ? "" : " · " + name);
						const code = value && typeof value.code === "number" ? value.code : 0;
						const output = value && value.output ? String(value.output) : "";
						if (code === 0) {
							showNotice({ kind: "ok", text: label + " · " + ACTION_LABEL[action] + " 完成" });
						} else {
							showNotice({
								kind: "err",
								text: label + " · " + ACTION_LABEL[action] + " 退出码 " + String(code) + (output ? "：" + output : ""),
							});
						}
						setNonce((current) => current + 1);
					}, (failure) => {
						setPending(null);
						showNotice({ kind: "err", text: String((failure && failure.message) || failure) });
					});
				};

				/**
				 * One list request. `loud` owns the busy feedback, so a background or
				 * on-return refresh never blanks the panel or flips the header.
				 */
				const fetchList = (loud) => {
					if (inFlight.current) return Promise.resolve();
					inFlight.current = true;
					if (loud) setBusy(true);
					return callHost("list", root ? { root: root } : {}).then((value) => {
						inFlight.current = false;
						setBusy(false);
						setError("");
						setData(value);
						lastLoadAt.current = Date.now();
						listCache.set(root || "", { value: value, at: lastLoadAt.current });
						// A cached workspace may be gone (deleted, unmounted): fall back to
						// auto instead of pinning the panel to a workspace nobody has.
						const known = value && Array.isArray(value.workspaces) ? value.workspaces : [];
						if (root !== "" && !known.some((workspace) => workspace.path === root)) {
							setRoot("");
							persistUi("", collapsed);
						}
					}, (failure) => {
						inFlight.current = false;
						setBusy(false);
						setError(String((failure && failure.message) || failure));
					});
				};

				// First paint, and every workspace switch: the spinner is only for the
				// case with nothing cached to paint meanwhile.
				React.useEffect(() => {
					fetchList(data === null);
				}, [root]);

				// The header's 刷新 button: it owns the feedback.
				React.useEffect(() => {
					if (nonce === 0) return;
					fetchList(true);
				}, [nonce]);

				// The background cadence: silently replaces what is on screen.
				React.useEffect(() => {
					if (tick === 0) return;
					fetchList(false);
				}, [tick]);

				// Returning to this tab is NOT a reload: the panel keeps showing the
				// payload it already has and only goes back for fresh data when what
				// it holds has actually aged past {@link FRESH_MS}.
				React.useEffect(() => {
					if (!onScreen || lastLoadAt.current === 0) return;
					if (Date.now() - lastLoadAt.current < FRESH_MS) return;
					fetchList(false);
				}, [onScreen]);

				/** Clicking a service row opens (or retargets) this session's one logs tab. */
				const openLogs = (project, service) => {
					const sidebarRight = ctx.get("sidebarRight");
					if (sidebarRight === undefined || typeof sidebarRight.openResource !== "function") {
						showNotice({ kind: "err", text: "侧边栏导航不可用，打不开日志页" });
						return;
					}
					try {
						// One address per target: another service gets its own tab, the same
						// service focuses the tab it already has.
						sidebarRight.openResource(logsAddress(String(project.dir || ""), String(service || "")), {
							params: {
								files: (Array.isArray(project.files) ? project.files : []).map((file) => String(file.path || "")),
							},
						});
					} catch (error) {
						showNotice({ kind: "err", text: "打开日志页失败：" + String((error && error.message) || error) });
					}
				};
				const groups = data && Array.isArray(data.groups) ? data.groups : [];
				const workspaces = data && Array.isArray(data.workspaces) ? data.workspaces : [];
				const docker = data && data.docker ? data.docker : null;
				const total = data && typeof data.total === "number" ? data.total : 0;
				const withProjects = groups.filter((group) => group.projects && group.projects.length > 0);
				const visible = root ? groups : (withProjects.length > 0 ? withProjects : groups);

				const actions = [];
				if (workspaces.length > 0) {
					const options = [React.createElement("option", { key: "auto", value: "" }, "自动（有项目的）")];
					for (let index = 0; index < workspaces.length; index += 1) {
						options.push(React.createElement("option", {
							key: "ws" + String(index),
							value: String(workspaces[index].path),
						}, String(workspaces[index].title || workspaces[index].path)));
					}
					actions.push(React.createElement(SelectBox, {
						key: "ws",
						value: root,
						title: "选择工作区",
						onChange: (event) => {
							const next = String(event.target.value);
							setRoot(next);
							persistUi(next, collapsed);
						},
					}, options));
				}
				actions.push(React.createElement(IconButton, {
					key: "refresh",
					title: busy ? "正在刷新…" : "刷新容器状态（不会重启任何容器）",
					disabled: busy,
					onClick: () => setNonce((value) => value + 1),
				}, "↻"));

				const body = [];
				if (notice) {
					body.push(React.createElement("div", {
						key: "notice",
						style: notice.kind === "ok" ? S.ok : S.err,
						title: "点击关闭",
						onClick: clearNotice,
					}, notice.text));
				}
				if (error) body.push(React.createElement("div", { key: "err", style: S.err }, error));
				if (docker && docker.available === false) {
					body.push(React.createElement("div", { key: "docker", style: S.warn },
						"docker 不可用" + (docker.psError ? "：" + String(docker.psError) : "")));
				}
				if (data && data.outside > 0) {
					body.push(React.createElement("div", { key: "outside", style: S.note },
						"另有 " + String(data.outside) + " 个 compose 项目不在任何工作区内"));
				}
				if (data && data.standalone > 0) {
					body.push(React.createElement("div", { key: "standalone", style: S.note },
						"本机另有 " + String(data.standalone) + " 个非 compose 容器"));
				}
				if (data === null && !error) {
					body.push(React.createElement("div", { key: "loading", style: S.empty }, "正在读取容器状态…"));
				} else if (visible.length === 0 && !error) {
					body.push(React.createElement("div", { key: "empty", style: S.empty }, "未发现 compose 项目"));
				}
				for (let index = 0; index < visible.length; index += 1) {
					body.push(React.createElement(WorkspaceGroup, {
						key: "g" + String(index),
						group: visible[index],
						isCollapsed: isCollapsed,
						onToggle: toggleProject,
						pending: pending,
						pendingOf: pendingOf,
						armedStop: armedStop,
						onAction: runAction,
						onOpenLogs: openLogs,
					}));
				}

				return React.createElement("div", { style: S.pane },
					React.createElement("div", { style: S.head },
						React.createElement("span", { style: S.title }, "Docker Compose"),
						React.createElement("span", { style: S.count }, busy ? "刷新中…" : String(total) + " 个项目"),
						React.createElement("div", { style: S.spacer }),
						React.createElement("div", { style: S.actions }, actions)
					),
					React.createElement("div", { style: S.body }, body)
				);
			}

			/**
		 * The SSE URL for one service's log stream.
		 * @param {{ dir?: string, service?: string, files?: unknown }} params - the target.
		 * @param {number} tail - how many lines to replay first.
		 * @param {boolean} timestamps - whether to ask docker for timestamps.
		 * @returns {string} the request URL.
		 */
		function logsUrl(params, tail, timestamps) {
			const query = [];
			const add = (key, value) => { query.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(value))); };
			add("dir", String(params.dir || ""));
			if (params.service) add("service", String(params.service));
			add("tail", String(tail));
			if (timestamps) add("timestamps", "1");
			for (const file of (Array.isArray(params.files) ? params.files : [])) add("file", String(file));
			return "/compose/api/logs?" + query.join("&");
		}




		/**
		 * The stable colour for one service name.
		 * @param {string} name - the compose service name.
		 * @returns {string} a CSS colour.
		 */
		function serviceColor(name) {
			let hash = 0;
			for (let index = 0; index < name.length; index += 1) hash = (hash * 31 + name.charCodeAt(index)) % 997;
			return SVC_PALETTE[hash % SVC_PALETTE.length];
		}

		/**
		 * The severity bucket a line is rendered in.
		 * @param {string} text - the raw line.
		 * @param {string} channel - "out" or "err".
		 * @returns {"" | "warn" | "err"} the bucket.
		 */
		function levelOf(text, channel) {
			if (channel === "err") return "err";
			if (/(^|\s)(error|fatal|panic|exception|traceback|failed)\b/i.test(text)) return "err";
			if (/(^|\s)warn(ing)?\b/i.test(text)) return "warn";
			return "";
		}

		/**
		 * Split one raw log line into the three columns the viewer shows.
		 * @param {string} raw - the line as docker printed it.
		 * @param {string} channel - "out" or "err".
		 * @returns {{ raw: string, ts: string, svc: string, msg: string, level: string, live: boolean }} the row.
		 */
		function parseLogLine(raw, channel) {
			let rest = raw;
			let ts = "";
			const stamp = LOG_TS.exec(rest);
			if (stamp !== null) {
				ts = stamp[1];
				rest = rest.slice(stamp[0].length);
			}
			let svc = "";
			const named = LOG_SVC.exec(rest);
			if (named !== null) {
				svc = named[1];
				rest = rest.slice(named[0].length);
			}
			return { raw: raw, ts: ts, svc: svc, msg: rest, level: levelOf(raw, channel), live: false };
		}

		/** One rendered log row: gutter columns first, message last. */
		const LogRow = React.memo(function LogRow(props) {
			const row = props.row;
			const children = [];
			if (row.ts !== "") children.push(React.createElement("span", { key: "ts", className: "dcp-log-ts" }, row.ts));
			// The prefix is docker own output ("<service> | "). A tab bound to one
			// service already names it in its chip, so that column is opt-in there.
			if (props.showService === true && row.svc !== "") {
				children.push(React.createElement("span", {
					key: "svc",
					className: "dcp-log-svc",
					style: { color: serviceColor(row.svc) },
					title: row.svc,
				}, row.svc));
			}
			children.push(React.createElement("span", { key: "msg", className: "dcp-log-msg" }, row.msg));
			return React.createElement("div", {
				className: row.level === "" ? "dcp-log-row" : "dcp-log-row " + row.level,
			}, children);
		});

		/**
		 * The logs pane: one `docker compose logs -f` stream rendered as a viewer.
		 *
		 * The Host serves it as Server-Sent Events, so reconnection is the browser's
		 * own EventSource behaviour; this component only decides what the target is
		 * and how the text is shown. Changing the target — another service, another
		 * replay size — restarts the stream from scratch.
		 */
		function LogsPane(props) {
			const useTabInfo = props && typeof props.useTabInfo === "function" ? props.useTabInfo : null;
			const info = useTabInfo === null ? null : useTabInfo();
			const tab = info && info.tab ? info.tab : null;
			const nav = tab && tab.navigation ? tab.navigation : null;
			const params = nav && nav.params && typeof nav.params === "object" ? nav.params : {};
			const revision = nav && typeof nav.revision === "number" ? nav.revision : 0;
			// The target IS the address (that is what this tab is); the compose files
			// ride along as navigation params, because a file list does not belong in
			// an address.
			const address = parseLogsAddress(tab ? tab.contentId : "");
			const dir = address === null ? "" : address.dir;
			const service = address === null ? "" : address.service;
			const filesKey = (Array.isArray(params.files) ? params.files : []).map(String).join("|");

			const tailPair = React.useState(LOG_TAIL_OPTIONS[1]);
			const tail = tailPair[0];
			const setTail = tailPair[1];
			const stampPair = React.useState(false);
			const timestamps = stampPair[0];
			const setTimestamps = stampPair[1];
			// A single-service tab hides the prefix by default; a project tab keeps it,
			// because there it is the only thing telling the services apart.
			const svcPair = React.useState(service === "");
			const showService = svcPair[0];
			const setShowService = svcPair[1];
			const wrapPair = React.useState(true);
			const wrap = wrapPair[0];
			const setWrap = wrapPair[1];
			const stuckPair = React.useState(true);
			const stuck = stuckPair[0];
			const setStuck = stuckPair[1];
			const linePair = React.useState([]);
			const lines = linePair[0];
			const setLines = linePair[1];
			const statusPair = React.useState("idle");
			const status = statusPair[0];
			const setStatus = statusPair[1];
			const notePair = React.useState("");
			const note = notePair[0];
			const setNote = notePair[1];
			const boxRef = React.useRef(null);
			const stickRef = React.useRef(true);
			const nextId = React.useRef(0);

			/** Fold one chunk into the line list, keeping a partial last line live. */
			const appendChunk = (chunk, channel) => {
				setLines((current) => {
					const next = current.slice();
					let carry = "";
					const last = next[next.length - 1];
					if (last !== undefined && last.live === true) {
						carry = last.raw;
						next.pop();
					}
					const parts = (carry + chunk).split("\n");
					const liveRaw = parts.pop();
					for (const part of parts) next.push(Object.assign(parseLogLine(part, channel), { id: nextId.current++ }));
					if (liveRaw !== undefined && liveRaw !== "") {
						next.push(Object.assign(parseLogLine(liveRaw, channel), { live: true, id: nextId.current++ }));
					}
					return next.length > LOG_LINE_LIMIT ? next.slice(next.length - LOG_LINE_LIMIT) : next;
				});
			};

			React.useEffect(() => {
				setShowService(service === "");
				if (dir === "") {
					setStatus("idle");
					setNote("在左侧「容器」列表里点一个服务，就能看它的日志。");
					return undefined;
				}
				if (typeof EventSource !== "function") {
					setStatus("error");
					setNote("当前环境没有 EventSource，无法接收日志流。");
					return undefined;
				}
				setStatus("connecting");
				setNote("");
				setLines([]);
				stickRef.current = true;
				setStuck(true);
				const request = { dir: dir, service: service, files: filesKey === "" ? [] : filesKey.split("|") };
				const source = new EventSource(logsUrl(request, tail, timestamps));
				source.onmessage = (event) => {
					let payload = null;
					try {
						payload = JSON.parse(event.data);
					} catch (error) {
						payload = null;
					}
					if (payload === null) return;
					if (payload.open === true) {
						setStatus("streaming");
						return;
					}
					if (payload.error !== undefined) {
						setStatus("error");
						setNote(String(payload.error));
						source.close();
						return;
					}
					if (payload.eof === true) {
						setStatus("ended");
						setNote(payload.reason !== undefined
							? String(payload.reason)
							: ("日志流已结束" + (typeof payload.code === "number" ? "（退出码 " + String(payload.code) + "）" : "")));
						source.close();
						return;
					}
					if (payload.out !== undefined) appendChunk(String(payload.out), "out");
					if (payload.err !== undefined) appendChunk(String(payload.err), "err");
				};
				source.onerror = () => {
					setStatus((current) => (current === "ended" ? current : "connecting"));
					setNote("连接中断，正在重连…");
				};
				return () => {
					try {
						source.close();
					} catch (error) {
						/* already closed */
					}
				};
			}, [dir, service, filesKey, tail, timestamps, revision]);

			React.useEffect(() => {
				const box = boxRef.current;
				if (box === null || stickRef.current !== true) return;
				box.scrollTop = box.scrollHeight;
			}, [lines]);

			const onScroll = () => {
				const box = boxRef.current;
				if (box === null) return;
				const near = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
				stickRef.current = near;
				setStuck((current) => (current === near ? current : near));
			};
			const jumpToLatest = () => {
				stickRef.current = true;
				setStuck(true);
				const box = boxRef.current;
				if (box !== null) box.scrollTop = box.scrollHeight;
			};
			const copyAll = () => {
				const text = lines.map((line) => line.raw).join("\n");
				try {
					Promise.resolve(navigator.clipboard.writeText(text)).then(
						() => setNote("已复制 " + String(lines.length) + " 行"),
						() => setNote("复制失败，请手动选中复制"));
				} catch (error) {
					setNote("复制失败：" + String((error && error.message) || error));
				}
			};

			const tone = status === "streaming" ? "#3fb950"
				: (status === "connecting" ? "#d29922" : (status === "error" ? "#f85149" : "rgba(140,140,150,1)"));
			const statusText = status === "streaming" ? "跟随中"
				: (status === "connecting" ? "连接中" : (status === "ended" ? "已结束" : (status === "error" ? "出错" : "未选择")));

			const head = [
				React.createElement("span", { key: "target", style: S.logTarget, title: dir + (service === "" ? "" : "/" + service) },
					service === "" ? "整个项目" : service),
				React.createElement("span", { key: "status", style: S.logStatus },
					React.createElement("span", { style: Object.assign({}, S.logDot, { background: tone }) }),
					statusText),
				React.createElement(SelectBox, {
					key: "tail",
					value: String(tail),
					title: "起始回放行数",
					onChange: (event) => setTail(Number(event.target.value)),
				}, LOG_TAIL_OPTIONS.map((size) => React.createElement("option", { key: String(size), value: String(size) }, String(size) + " 行"))),
				React.createElement(IconButton, {
					key: "svc",
					title: showService ? "隐藏服务名前缀" : "显示服务名前缀",
					pressed: showService,
					onClick: () => setShowService((value) => !value),
				}, "#"),
				React.createElement(IconButton, { key: "stamp", title: "显示时间戳（--timestamps）", pressed: timestamps, onClick: () => setTimestamps((value) => !value) }, "⏱"),
				React.createElement(IconButton, { key: "wrap", title: wrap ? "关闭自动换行" : "开启自动换行", pressed: wrap, onClick: () => setWrap((value) => !value) }, "⏎"),
				React.createElement(IconButton, { key: "copy", title: "复制全部", onClick: copyAll }, "⧉"),
			];

			const rows = lines.map((line) => React.createElement(LogRow, { key: String(line.id), row: line, showService: showService }));
			if (rows.length === 0) {
				rows.push(React.createElement("div", { key: "empty", className: "dcp-log-msg", style: Object.assign({}, S.logEmpty, { padding: "0 10px" }) },
					status === "connecting" ? "正在连接日志流…" : "（暂无输出）"));
			}

			return React.createElement("div", { style: S.pane },
				React.createElement("div", { style: S.logHead }, head),
				note === "" ? null : React.createElement("div", { style: status === "error" ? S.logNoteError : S.logNote }, note),
				React.createElement("div", { style: S.logWrap },
					React.createElement("div", { ref: boxRef, className: "dcp-logbox", style: wrap ? S.logBox : S.logBoxNoWrap, onScroll: onScroll },
						React.createElement("div", { className: wrap ? "dcp-log" : "dcp-log nowrap" }, rows)),
					stuck ? null : React.createElement("button", {
						type: "button",
						style: S.logJump,
						onClick: jumpToLatest,
					}, "已暂停跟随 · 回到最新")));
		}

		/** The logs chip: a glyph plus which service that tab is following. */
		function LogsTitle(props) {
			const useTabInfo = props && typeof props.useTabInfo === "function" ? props.useTabInfo : null;
			const info = useTabInfo === null ? null : useTabInfo();
			const tab = info && info.tab ? info.tab : null;
			const address = parseLogsAddress(tab ? tab.contentId : "");
			const name = address === null ? "" : address.service;
			return React.createElement("span", { style: S.chip },
				React.createElement("span", { style: S.chipGlyph, "aria-hidden": "true" }, "≡"),
				React.createElement("span", null, name === "" ? "日志" : "日志 · " + name));
		}

		/** The tab chip: the same glyph the guide capsule carries, then the label. */
			function ComposeTitle() {
				return React.createElement("span", { style: S.chip },
					React.createElement("span", { style: S.chipGlyph, "aria-hidden": "true" }, "🐳"),
					React.createElement("span", null, "容器")
				);
			}

			let tabs;
			try {
				tabs = ctx.get("sidebarRightTabs");
			} catch (error) {
				console.error("[compose-panel] sidebarRightTabs unavailable: " + String((error && error.message) || error));
				tabs = undefined;
			}
			if (tabs === undefined || typeof tabs.register !== "function") {
				console.error("[compose-panel] the right sidebar tab registry is not reachable; nothing registered");
				return;
			}

			ctx.effect(() => tabs.register({
				id: TAB_ID,
				kind: TAB_KIND,
				priority: "extension",
				title: () => "容器",
				guide: [{
					order: GUIDE_ORDER,
					title: () => "容器",
					description: () => "Docker Compose 项目与容器",
					icon: () => React.createElement("span", { style: { fontSize: "15px" } }, "🐳"),
				}],
			}));

			ctx.effect(() => slots.inject("sidebar.right.pane.tab", safeRegister(
				"sidebar.right.pane.tab", { key: TAB_ID }, (props) => React.createElement(ComposePane, props || null))));
			ctx.effect(() => slots.inject("sidebar.right.pane.tab.title", safeRegister(
				"sidebar.right.pane.tab.title", { key: TAB_ID }, () => React.createElement(ComposeTitle, null))));

			// The logs tab: a second type this plugin owns, opened by clicking a service
			// row. It is a RESOURCE type, not a page type: a page dedupes by kind within
			// a pane (one logs tab ever), while a resource dedupes by (kind, contentId),
			// so each target keeps its own tab. No guide entry — the list is its door.
			ctx.effect(() => tabs.register({
				id: LOGS_ID,
				kind: LOGS_KIND,
				patterns: [LOGS_PATTERN],
				priority: "extension",
				canOpen: (address) => parseLogsAddress(address) !== null,
				title: (address) => {
					const target = parseLogsAddress(address);
					if (target === null) return "日志";
					return target.service === "" ? "日志 · 整个项目" : "日志 · " + target.service;
				},
			}));
			ctx.effect(() => slots.inject("sidebar.right.pane.tab", safeRegister(
				"sidebar.right.pane.tab", { key: LOGS_ID }, (props) => React.createElement(LogsPane, props || null))));
			ctx.effect(() => slots.inject("sidebar.right.pane.tab.title", safeRegister(
				"sidebar.right.pane.tab.title", { key: LOGS_ID }, (props) => React.createElement(LogsTitle, props || null))));
		}

		module.exports = { name: TAB_ID, inject: ["slots"], apply };
		return module.exports;
	}
});
