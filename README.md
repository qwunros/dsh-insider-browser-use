# dsh-insider-browser

A **DeepSeek Harness (dsh) Web** plugin that adds a built-in browser to the right sidebar and exposes it to the agent.

> Community plugin, not an official DeepSeek product.

## Features

- **Browser in the right sidebar** — open the sidebar's start page and pick "Browser". The panel has an address bar and back/forward/reload controls; its picture is the live rendering of a real headless Chrome/Edge instance.
- **Human and agent share it** — click the picture to take over: mouse clicks (including double-click, right-click and drag), wheel, keyboard input and shortcuts (including IME and paste) are mapped into the real browser. The agent can keep operating at the same time; neither side locks the other.
- **Low-latency mirror** — live frames run at about 30fps and are downscaled to the sidebar width, and input batches are written to Chrome in one go instead of waiting for a round-trip per event; a click usually reaches the picture in 20–30ms.
- **Stays awake in the background** — if a new tab or popup pushes the mirrored page into the background, the panel page is made visible and focused again. Chrome only paints visible pages and delays input to hidden ones by several seconds; after recovery, address-bar navigation and human input stay immediate.
- **Conversation links navigate** — clicking a web link in the chat (with the link preference set to the sidebar) opens the browser in the right sidebar and navigates to that address, even when the panel already shows another page.
- **New-tab links are followed** — links using `target="_blank"` or `window.open` open in the mirrored page itself (with a back-history entry) instead of silently opening an invisible tab.
- **Pluggable browser carrier** — by default it spawns its own headless Chrome/Edge, but it can also drive a browser that is **already running** (the Chrome showing the panel, an Electron/desktop shell with a debug port), so no second process is needed and logins are shared. See "Browser carrier" below.
- **More reliable discovery** — besides Program Files it checks the Windows `App Paths` registry, `PATH`, Chrome/Edge Beta/Dev/Canary, Chromium and Brave, and honours `browserPath` / `DSH_BROWSER_PATH`.
- **Agent tools** — after installation the agent gets `browser_*` tools: open a page, read content/source, take screenshots, click, type, press keys, scroll, wait, and navigate history.
- **Automatic reveal** — the first time the agent drives the browser, the right sidebar opens and shows the page.
- **Operation toast** — while the agent operates, the live view shows "dsh is operating the browser" above the page.
- **Virtual cursor** — clicks, typing and scrolling show an animated cursor position (and a click ripple) over the live view.
- **Cookie settings** — Settings → Browser lets you clear the built-in browser's cookies or import cookies from local Chrome / Edge / Firefox (to keep signed-in sessions).

## Install

Chrome or Edge must be installed. Clone the repository, then install this
directory into a dsh Web profile:

```sh
git clone <repository-url>
cd <repository-directory>
dsh plugin --profile web add "<absolute path to this directory>"
```

or install the plugin directory from the Harness Plugins page (recommended). No configuration is required; the browser starts on first agent use.

After installation the cookie page is under **Settings → Browser**, and the right sidebar's **Start** page shows a **Browser** card. Asking the agent to open a page also opens the sidebar automatically.

## Browser carrier

The plugin can use one of two carriers, in this order:

1. **an existing browser** (`attachTo`, or a debug port found automatically);
2. **its own headless Chrome/Edge** (separate profile).

### Attach mode (reuse the panel's browser / Electron)

If a browser runs with a DevTools port, the plugin opens one tab in it and drives that tab — no extra process, and logins are shared:

```sh
# Windows: Chrome 136+ requires a non-default profile for the debug port
"C:\Program Files\Google\Chrome\Application\chrome.exe" \
  --remote-debugging-port=9222 \
  --user-data-dir="%LOCALAPPDATA%\dsh-carrier-profile" \
  "http://127.0.0.1:3080"
```

Then either:

- **do nothing** — the plugin probes 9222 / 9223 / 9333 and attaches to whichever answers; or
- name it explicitly (plugin row config or environment):

```yaml
- id: insider-browser
  config:
    attachTo: 9222        # a port, http://127.0.0.1:9222 or ws://...
```

```sh
set DSH_BROWSER_DEBUG_PORT=9222
set DSH_BROWSER_DEBUG_URL=http://127.0.0.1:9222   # either one
```

Electron and desktop shells work the same way as long as they expose a CDP endpoint. Note that this Web deployment has **no Electron process**: the GUI itself runs in your browser, so only the browser case applies unless you use a desktop/self-hosted shell.

### Attach-mode safety

- The plugin closes **only the tab it opened**; it never closes, quits or restarts that browser.
- It refuses to clear or import cookies into a browser it did not start; set `allowCookieWrites: true` only if touching the real cookie jar is intended.
- Only loopback endpoints are accepted unless `allowRemoteDebugging: true`.
- Disabling the plugin leaves the carrier browser running.

### When no browser can be found

```yaml
- id: insider-browser
  config:
    browserPath: "D:/Portable/Chrome/chrome.exe"   # or DSH_BROWSER_PATH
    browserChannel: chrome|edge|brave|chromium      # optional
    attachTo: 9222                                  # optional, prefer an existing browser
```

`GET /dsh-insider-browser/state` exposes a `diagnostics` field listing the executables that were found (and where), whether the attach target answers, the relevant environment variables, and why the last start failed.

## Development

Requires Node.js >= 22.19 and a local Chrome or Edge installation. There is no
build step.

```sh
node tools/engine-check.mjs --mock     # engine contract, tools, fake CDP
node tools/host-check.mjs              # host wiring
node tools/http-check.mjs              # HTTP/SSE surface
node tools/client-human-check.mjs      # client input and link navigation
node demo/server.mjs                   # optional demo page on http://127.0.0.1:8899
node tools/live-check.mjs              # end-to-end against a running dsh + plugin
node tools/attach-check.mjs            # attach mode: reuse a browser, never close it
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the implementation overview.

## Agent tools

| Tool | Purpose |
|---|---|
| `browser_open` | Open a URL (the sidebar appears and shows the page) |
| `browser_snapshot` | Read numbered interactive elements plus page text |
| `browser_content` | Read page text or HTML |
| `browser_source` | Read the page source |
| `browser_screenshot` | Capture a screenshot as an image (needs image-capable model input) |
| `browser_click` | Click by ref, selector, text, or coordinates |
| `browser_type` | Type text into a field |
| `browser_key` | Press keys (Enter/Tab/Escape/arrows/...) |
| `browser_scroll` | Scroll the page |
| `browser_wait_for` | Wait for text or a selector |
| `browser_back` / `browser_forward` / `browser_reload` | History navigation |
| `browser_close` | Close the built-in browser |

## Data and privacy

- The default carrier uses its own profile at `<DSH_HOME>/insider-browser/profile` (default `C:\Users\<user>\.dsh\insider-browser\profile`); sign-in state stays on this machine.
- In attach mode the page runs inside your own browser. The plugin only drives the tab it opened and does not read or modify your other tabs.
- Cookie import only reads local browser data and writes it into the **local** built-in browser. Cookie values are never sent over the network, logged, or echoed into the conversation.
- Sites that block headless/automation traffic may not render; attach mode, imported cookies, or the system browser are the alternatives.

## Limitations

- No multiple-tab view, downloads, uploads, proxies or extensions in this version; one built-in browser is shared by the whole dsh host.
- The screenshot tool requires the current model to declare image input.
- Attach mode needs a browser started with a DevTools port. A browser opened normally has none (Chrome 136+ refuses to enable it on the default profile), so the window you are already looking at cannot be taken over — restart it with the command above once.
- The sidebar is still a pixel mirror: in attach mode the driven tab is opened and closed together with the plugin, so leave it alone while the plugin is active.
- **Quit Chrome/Edge before importing their cookies**: a running Chrome/Edge holds an exclusive lock on its cookie database, so import reports a readable "database is busy" message (Firefox is unaffected).
- Chrome/Edge import copies the profile into a temporary directory and lets the source browser decrypt it; if the source browser is holding its data or uses an incompatible encryption mode, a readable error is reported.
- The panel is a mirror plus input forwarding: a headless browser has no native context menu, download bar or tab strip. Some shortcuts may be captured by the dsh page first, and copying to the system clipboard depends on the browser clipboard permission (the page selection itself is unaffected on failure).

## License

[MIT](LICENSE).
