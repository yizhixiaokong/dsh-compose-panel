# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Release note.** 0.1.0 was the initial development version and was never
> published; this repository's first public commit is tagged `v0.1.1`. The two
> sections below record what changed between them, so that the fixes are not
> lost.

## [Unreleased]

### Changed

- An unreachable tab registry is now an **activation failure**, not a quiet
  `return`. A half that registers nothing looks exactly like a plugin that is
  not installed — which is how the 0.1.7 regression hid — while a thrown error
  is recorded per plugin and rendered. The `inject` gate already guarantees the
  registry at apply time, so reaching this branch means it vanished mid-boot.

## [0.1.2] — 2026-09-23

### Fixed

- **The panel reappears on DSH 0.1.7.** On 0.1.7-rc.2 the whole client half
  registered nothing: no tab, no seat, no chip. The cause was activation order.
  A client half is applied only once every service in its own `inject` list is
  provided, and `sidebarRightTabs` is provided by `dsh-client-ui-sidebar-right`
  from *its* apply — which is gated on seven services (`slots`, `layout`,
  `locale`, `resources`, `sessions`, `uiSession`, `shortcuts`) and therefore
  lands after ours. This plugin declared only `slots`, applied before the
  registry existed, hit its own "registry is not reachable; nothing registered"
  bail-out, and never retried. The half now declares `sidebarRightTabs` as a
  hard dependency, so activation waits for it.
- The guide capsule's entry now carries the `id` its type requires
  (`SidebarRightGuideEntry.id` is non-optional). Plain JS hid the omission.

### Added

- Smoke checks pin both: the client half must gate activation on the tab
  registry, and every guide entry must carry a stable `id` and an `order`.

## [0.1.1] — 2026-09-15

### Added

- Live per-service and per-project **log tabs**, streamed from the host over
  Server-Sent Events: replay size, restart, timestamps, line wrapping and a
  service column for project-wide tabs. Each target keeps its own tab.
- Per-service `up -d` / `restart` / `stop` next to the existing project-level
  actions. Hovering a row now *replaces* its status cell with the actions, so
  the row never changes height.
- Collapsible project groups, and a `🐳 容器` capsule in the sidebar guide.
- A short result banner for every action, dismissed automatically (3s on
  success, 8s on failure).
- Counters for containers found outside every workspace and for containers with
  no compose project label, instead of dropping them silently.

### Changed

- Silently refreshing list: 45s while idle, 8s while something is still
  starting, with the last result reused across tab switches.
- Styling moved onto the harness' own theme tokens (borderless inputs, native
  select chevrons, `bg-module-platform` buttons) so the panel follows light and
  dark mode.
- Status is right-aligned and rows have a fixed height.

### Fixed

- **Boot failure that unloaded every later plugin row**: the log viewer's
  stylesheet was a factory `const` declared *below* `apply`, so apply hit its
  temporal dead zone (`Cannot access 'LOG_CSS' before initialization`). All
  factory bindings now precede `apply`, and `scripts/smoke.mjs` fails the build
  if one moves below it again.
- The panel listed no project at all when the `workspaceRegistry` and
  `subprocess` services were still activating during profile boot; both are now
  resolved per call instead of captured at apply time.
- Row jitter: the action buttons no longer reflow the row under the pointer.
- A project whose compose project name equals its directory rendered its name
  twice.
- Switching sidebar tabs re-ran the whole discovery instead of reusing the last
  result.

## 0.1.0 — 2026-09-14 (development only, never published)

### Added

- First release: one right-sidebar tab listing every docker compose project of
  every DSH workspace, grouped by project directory, with container status and
  project-level `up -d` / `restart` / `stop`.
- Discovery from `docker ps -a`, `docker compose ls --all` and one bounded
  `find` per workspace, so projects that were never started still appear.
- `POST /compose/api/list` and `POST /compose/api/action`, both fenced to
  same-origin loopback requests.

[0.1.1]: https://github.com/yizhixiaokong/dsh-compose-panel/releases/tag/v0.1.1
