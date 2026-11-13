// HTTP surface check for src/host/http.mjs: real node:http server, fake engine.
// Verifies SSE framing, hello/state/action contracts, origin and content-type
// guards without starting Chrome.
import { createServer } from 'node:http'

const disposers = []
const routes = new Map()

function makeEngine() {
  const listeners = new Map()
  const state = {
    running: false,
    starting: false,
    channel: 'chrome',
    executable: 'chrome.exe',
    profileDir: 'C:/tmp/profile',
    viewport: { width: 1280, height: 800 },
    url: 'about:blank',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  }
  const engine = {
    get status() { return { ...state } },
    activity: { active: false },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(fn)
      return () => listeners.get(event)?.delete(fn)
    },
    emit(event, payload) {
      for (const fn of listeners.get(event) ?? []) fn(payload)
    },
    async ensure() { state.running = true },
    async navigate(url) {
      state.url = url
      state.title = 'Example Domain'
      engine.emit('navigation', { url, title: 'Example Domain', loading: false, canGoBack: false, canGoForward: false })
      return { url, title: 'Example Domain' }
    },
    async back() { return { url: state.url, title: state.title } },
    async forward() { return { url: state.url, title: state.title } },
    async reload() { return { url: state.url, title: state.title } },
    async click({ x, y }) { engine.emit('cursor', { x, y, action: 'click' }); return { x, y } },
    async scroll() {},
    async listCookies() { return [{ name: 'a' }, { name: 'b' }] },
    async clearCookies() { return { cleared: true } },
    async setCookies() { return { set: 0, failed: 0, errors: [] } },
    async stop() {},
    log() {},
  }
  return engine
}

const fakeCtx = {
  webServer: {
    getOrigin: () => `http://127.0.0.1:${server.address().port}`,
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
}

const engine = makeEngine()
const { registerRoutes } = await import(new URL('../src/host/http.mjs', import.meta.url).href)

const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname
  const handler = routes.get(pathname) ?? routes.get(pathname.replace(/\/+$/, ''))
  if (!handler) { res.writeHead(404); res.end(); return }
  handler(req, res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = fakeCtx.webServer.getOrigin()
const dispose = registerRoutes(fakeCtx, engine, { reportCookieCount: true })
disposers.push(dispose)

const problems = []
const expect = (condition, message) => { if (!condition) problems.push(message) }
const base = origin

// 1) GET /state
{
  const response = await fetch(`${base}/dsh-insider-browser/state`)
  const body = await response.json()
  expect(response.status === 200, `/state status ${response.status}`)
  expect(body.ok === true, '/state ok')
  expect(body.status && body.status.channel === 'chrome', '/state carries status')
  expect(body.cookieCount === 2, `/state cookieCount ${body.cookieCount}`)
}

// 2) SSE: hello + forwarded engine events
{
  const controller = new AbortController()
  const response = await fetch(`${base}/dsh-insider-browser/events`, { signal: controller.signal })
  expect(response.status === 200, `/events status ${response.status}`)
  expect(String(response.headers.get('content-type')).startsWith('text/event-stream'), '/events content type')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const messages = []
  let buffer = ''
  const readUntil = async (predicate) => {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ value: undefined, done: false }), 100)),
      ])
      if (done) break
      if (value) buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ')) messages.push(JSON.parse(line.slice(6)))
        }
      }
      if (predicate(messages)) return
    }
  }
  await readUntil((list) => list.some((message) => message.type === 'hello'))
  expect(messages.some((message) => message.type === 'hello' && message.status && message.viewport), 'SSE hello payload')
  engine.emit('frame', { data: 'AAAA', seq: 1, viewport: { width: 1280, height: 800 } })
  engine.emit('navigation', { url: 'https://example.com', title: 'Example Domain', loading: false, canGoBack: false, canGoForward: false })
  engine.emit('activity', { active: true, sessionId: 'session-abc', label: 'browser_open' })
  engine.emit('cursor', { x: 10, y: 20, action: 'click' })
  await readUntil((list) => ['frame', 'navigation', 'activity', 'cursor'].every((type) => list.some((message) => message.type === type)))
  for (const type of ['frame', 'navigation', 'activity', 'cursor']) {
    expect(messages.some((message) => message.type === type), `SSE forwarded ${type}`)
  }
  controller.abort()
  try { await reader.cancel() } catch { /* aborted */ }
}

// 3) POST action requires JSON and same origin
{
  const badType = await fetch(`${base}/dsh-insider-browser/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ action: 'status' }),
  })
  expect(badType.status === 415, `text/plain must be 415, got ${badType.status}`)

  const foreign = await fetch(`${base}/dsh-insider-browser/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ action: 'status' }),
  })
  expect(foreign.status === 403, `foreign origin must be 403, got ${foreign.status}`)

  const navigate = await fetch(`${base}/dsh-insider-browser/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ action: 'navigate', url: 'https://example.com' }),
  })
  const navigateBody = await navigate.json()
  expect(navigate.status === 200 && navigateBody.ok === true, `navigate ok: ${JSON.stringify(navigateBody)}`)
  expect(navigateBody.url === 'https://example.com', 'navigate returns url')

  const unknown = await fetch(`${base}/dsh-insider-browser/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ action: 'nope' }),
  })
  const unknownBody = await unknown.json()
  expect(unknown.status === 200 && unknownBody.ok === false && /unknown action/.test(unknownBody.error), 'unknown action reports ok:false')

  const clear = await fetch(`${base}/dsh-insider-browser/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'clearCookies' }),
  })
  const clearBody = await clear.json()
  expect(clearBody.ok === true && clearBody.cleared === true, `clearCookies ok: ${JSON.stringify(clearBody)}`)
}

// 4) Method guards
{
  const getAction = await fetch(`${base}/dsh-insider-browser/action`)
  expect(getAction.status === 405, `GET /action must be 405, got ${getAction.status}`)
  const postEvents = await fetch(`${base}/dsh-insider-browser/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  expect(postEvents.status === 405, `POST /events must be 405, got ${postEvents.status}`)
}

// 5) Dispose removes routes and closes SSE streams
for (const d of disposers.reverse()) await d()
expect(routes.size === 0, `routes not removed: ${[...routes.keys()].join(',')}`)
await new Promise((resolve) => server.close(resolve))

if (problems.length > 0) {
  console.error(`http surface check FAILED (${problems.length}):`)
  for (const problem of problems) console.error(` - ${problem}`)
  process.exit(1)
}
console.log('http surface check passed: /state, SSE hello+frame+navigation+activity+cursor, action guards, dispose')
process.exit(0)
