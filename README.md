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

- The built-in browser uses its own profile at `<DSH_HOME>/insider-browser/profile` (default `C:\Users\<user>\.dsh\insider-browser\profile`); sign-in state stays on this machine.
- Cookie import only reads local browser data and writes it into the **local** built-in browser. Cookie values are never sent over the network, logged, or echoed into the conversation.
- Sites that block headless/automation traffic may not render; try imported cookies or open the page in the system browser instead.

## Limitations

- No multiple-tab view, downloads, uploads, proxies or extensions in this version; one built-in browser is shared by the whole dsh host.
- The screenshot tool requires the current model to declare image input.
- **Quit Chrome/Edge before importing their cookies**: a running Chrome/Edge holds an exclusive lock on its cookie database, so import reports a readable "database is busy" message (Firefox is unaffected).
- Chrome/Edge import copies the profile into a temporary directory and lets the source browser decrypt it; if the source browser is holding its data or uses an incompatible encryption mode, a readable error is reported.
- The panel is a mirror plus input forwarding: a headless browser has no native context menu, download bar or tab strip. Some shortcuts may be captured by the dsh page first, and copying to the system clipboard depends on the browser clipboard permission (the page selection itself is unaffected on failure).

## License

[MIT](LICENSE).
