# Architecture

`dsh-insider-browser` is a Cordis plugin with two halves:

- **Host half** (`index.mjs` + `src/host/`) runs in the dsh Web host process.
- **Client half** (`client.js`) runs in the dsh Web page and renders the right-sidebar panel.

This document describes how the pieces fit together. It is intentionally
implementation-oriented; see the READMEs for installation and usage.

## Topology

```
dsh Web page
  └── client.js ── SSE / fetch ── Host process
                                    ├── src/host/http.mjs     routes
                                    ├── src/host/engine.mjs   CDP engine
                                    ├── src/host/tools.mjs    browser_* tools
                                    └── src/host/cookies.mjs  cookie import
                                          │
                                          └── headless Chrome/Edge
```

One host process owns **one** headless browser and one mirrored page. Every
session shares it. The browser is started lazily on the first tool call or
panel action and is closed when the plugin is disposed.

## Main files

| Path | Purpose |
| --- | --- |
| `index.mjs` | Host entry: reads config, wires the engine, tools, routes and lifetime effect |
| `src/host/engine.mjs` | Chrome/Edge lifecycle over CDP, one page target, screencast, navigation, DOM actions, human input |
| `src/host/tools.mjs` | The model-facing `browser_*` tools and the system-prompt section |
| `src/host/http.mjs` | Host HTTP surface used by the panel and settings page |
| `src/host/cookies.mjs` | Cookie clearing/import from local Chrome, Edge and Firefox |
| `client.js` | Right-sidebar tab type/body, address bar, screencast, toast, virtual cursor, settings page |
| `cordis.patch.yml` | Bundle patch that mounts the host row |
| `demo/` | Small local page/server used by the live test |

The host code uses only Node built-ins (`node:` imports). The client half only
requires the `react` module that dsh already provides; it is loaded through
`window.__ModuleLoader__`.

## Browser lifecycle

The engine launches the system Chrome or Edge with:

```
--headless=new --remote-debugging-port=0 --user-data-dir=<DSH_HOME>/insider-browser/profile
```

It reads `DevToolsActivePort`, connects to the browser WebSocket, creates one
page target, attaches to it with a flattened session, and keeps that target for
its lifetime. The profile is persistent, so logins survive restarts.

The plugin exposes a small CDP client (no `ws` dependency) with request/response
matching and event subscriptions.

## Browser carrier

The engine has two carriers and picks one at start:

1. **attached** — a Chromium-family browser that is already running with a
   DevTools endpoint. This covers the browser that displays the panel (when it
   was started with `--remote-debugging-port`), an Electron/desktop shell, or a
   browser the plugin itself spawned in an earlier run.
2. **spawned** — the plugin launches its own headless Chrome/Edge with a private
   profile.

Selection order:

- `attachTo` (plugin config) or `DSH_BROWSER_DEBUG_URL` /
  `DSH_BROWSER_DEBUG_PORT` — authoritative. If it does not answer, start fails
  with the real reason instead of silently spawning a second browser.
- otherwise the usual ports (`9222`, `9223`, `9333`, configurable with
  `autoAttachPorts`) are probed; `autoAttach: false` disables this.
- otherwise an executable is located and spawned.

In attach mode the engine opens **one tab** (`Target.createTarget`) in the
carrier's default browser context, so cookies and logins are shared, and
remembers that it must not close the browser: `stop()` closes only that target
and then disconnects. Destructive cookie operations are refused unless
`allowCookieWrites: true`, and only loopback endpoints are accepted unless
`allowRemoteDebugging: true`.

Executable discovery, when spawning, checks in order: `browserPath`,
`DSH_BROWSER_PATH`, the Windows `App Paths` registry (`chrome.exe`,
`msedge.exe`, `brave.exe`, `chromium.exe`), PATH, and the conventional install
directories including Chrome/Edge Beta/Dev/Canary, Chromium and Brave. Probed
paths and the last start error are exposed through `engine.diagnose()`, which
`GET /state` reports as `diagnostics`.

## Live mirror

`Page.startScreencast` produces JPEG frames. The engine:

- acks every frame (ack is required or Chrome stops the cast),
- caps delivery at about 30 fps,
- downscales to at most 960 px wide and encodes at JPEG quality 50,
- broadcasts the base64 JPEG to every SSE subscriber.

The sidebar scales the image to its pane while preserving the viewport aspect
ratio. `browser_screenshot` still captures the full 1280x800 viewport.

Chrome only paints visible pages and delays input dispatch to hidden ones by
several seconds. To keep the mirror usable after another tab opens, the engine:

- enables `Emulation.setFocusEmulationEnabled` on the mirrored page,
- re-asserts it after navigation,
- checks visibility/focus every two seconds and reactivates the page if needed.

## Navigation and new tabs

Normal links navigate the mirrored page and arrive as `Page.frameNavigated` /
`loadEventFired` events. Links with `target="_blank"` or `window.open()` create a
second page target; without handling they would load invisibly while the panel
stayed on the old page. The host enables target discovery, watches for page
targets whose `openerId` is the mirrored target, waits for a usable http(s) URL,
then:

1. navigates the mirrored page to that URL (so Back returns to the old page),
2. closes the now-redundant tab.

Non-http(s) targets (`chrome:`, `data:`, `blob:`, ...) are ignored.

## Human input

The panel sends mouse, wheel, keyboard and IME input to `POST /action` as
batches of raw events. The host validates and clamps them, converts the batch to
CDP `Input.*` commands, and writes the whole batch to the DevTools socket at
once. Commands are processed in order by Chrome, so the page sees the normal
event sequence without a round-trip wait per event.

The panel keeps a focusable transparent textarea over the screencast for key
events, IME composition, paste and copy. Dragging sends the held button on each
move so Chrome treats it as a real drag.

## HTTP surface

All routes are under `/dsh-insider-browser` and are same-origin guarded (loopback
spellings of the same host are accepted):

| Route | Purpose |
| --- | --- |
| `GET /events` | SSE: `hello`, `frame`, `navigation`, `activity`, `cursor`, `log` |
| `GET /state` | JSON status snapshot, including `visible`/`focused` and `diagnostics` (carrier, candidates, attach reachability, last start error) |
| `POST /action` | Panel/settings actions: navigate, history, input, selection, cookies, stop |

Mutations require `Content-Type: application/json`. Cookie values and page text
are never written to logs.

## Cookies

- **Clear**: `Network.clearBrowserCookies` on the built-in browser.
- **Firefox**: copy `cookies.sqlite` from the selected profile and read it with
  `node:sqlite`.
- **Chrome/Edge**: copy the source profile into a temporary directory and let a
  matching temporary browser decrypt its own cookie database via CDP, then map
  the cookies into the built-in browser.

Only counts are logged. Chrome/Edge must be closed while their database is
copied.

## Tests

No build step is required.

```sh
node tools/engine-check.mjs --mock     # engine contract, tools, fake CDP
node tools/host-check.mjs              # host wiring
node tools/http-check.mjs              # HTTP/SSE surface
node tools/client-human-check.mjs      # client input/link-navigation handlers
node demo/server.mjs                   # optional local page on :8899
node tools/live-check.mjs              # end-to-end against a running dsh + plugin
node tools/attach-check.mjs            # attach mode against a real running browser
```

`tools/engine-check.mjs` without `--mock` launches a real Chrome/Edge and
exercises navigation, snapshots, screenshots, input and cookies. It needs an
unrestricted process on Windows because Chrome's IPC is blocked in the agent
sandbox.

## Limits

The mirror displays one page at a time. New tabs opened by the page are followed
in that same view, but there is no tab strip. Downloads, uploads, proxies and
extensions are out of scope. A few sites block headless/automation traffic; the
built-in browser is still a real Chrome/Edge with a persistent profile, and
cookies can be imported to keep a normal login.
