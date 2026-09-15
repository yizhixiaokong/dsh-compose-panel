# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Release note.** 0.1.0 was the initial development version and was never
> published; this repository's first public commit is tagged `v0.1.1`. The two
> sections below record what changed between them, so that the fixes are not
> lost.

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
