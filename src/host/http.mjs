/**
 * Host HTTP surface for the built-in browser.
 *
 * Two same-origin endpoints under /dsh-insider-browser:
 *   GET  /events  Server-Sent Events: hello, screencast frames, navigation,
 *                 agent activity, virtual-cursor positions, warnings.
 *   GET  /state   JSON status snapshot used by the settings page.
 *   POST /action  JSON actions from the sidebar panel and the settings page.
 *
 * The web server carries no authentication or origin policy of its own, so this
 * module enforces same-origin (when the browser sends an Origin header) and
 * JSON content types on mutations. The listener itself is bound to loopback by
 * the profile's webserver row.
 */

const PREFIX = '/dsh-insider-browser'

/** Guard against an unbounded body from a same-origin page bug. */
const MAX_BODY_BYTES = 1024 * 1024

/** Drop screencast frames once this much output is queued for one client. */
const MAX_QUEUED_BYTES = 4 * 1024 * 1024

/**
 * Register the routes and wire engine events to every connected SSE client.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('./engine.mjs').BrowserEngine} engine
 * @param {object} config plugin row config
 * @returns {() => void} disposer owning routes, subscribers and timers
 */
export function registerRoutes(ctx, engine, config = {}) {
  const disposers = []
  const clients = new Set()
  /** Diagnostics for the panel's SSE connection; visible through GET /state. */
  const sseStats = {
    active: 0,
    peak: 0,
    opened: 0,
    rejected: 0,
    lastOrigin: null,
    lastRejectedOrigin: null,
    lastError: null,
  }

  const writeEvent = (res, payload) => {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
      return true
    } catch {
      return false
    }
  }

  const broadcast = (payload) => {
    if (clients.size === 0) return
    for (const client of clients) {
      const res = client.res
      if (res.writableEnded || res.destroyed) {
        clients.delete(client)
        continue
      }
      if (isFrame(payload) && res.writableLength > MAX_QUEUED_BYTES) continue
      if (!writeEvent(res, payload)) clients.delete(client)
    }
  }

  const stateOf = async () => {
    const status = engine.status || {}
    let cookieCount
    if (config.reportCookieCount !== false) {
      try {
        const cookies = await engine.listCookies()
        cookieCount = Array.isArray(cookies) ? cookies.length : undefined
      } catch {
        cookieCount = undefined
      }
    }
    return {
      status,
      url: status.url,
      title: status.title,
      loading: status.loading,
      canGoBack: status.canGoBack,
      canGoForward: status.canGoForward,
      cookieCount,
      sse: {
        active: sseStats.active,
        peak: sseStats.peak,
        opened: sseStats.opened,
        rejected: sseStats.rejected,
        lastOrigin: sseStats.lastOrigin,
        lastRejectedOrigin: sseStats.lastRejectedOrigin,
        lastError: sseStats.lastError,
      },
    }
  }

  const unsubscribeEngine = []
  unsubscribeEngine.push(engine.on('frame', (payload) => broadcast({ type: 'frame', ...payload })))
  unsubscribeEngine.push(engine.on('navigation', (payload) => broadcast({ type: 'navigation', ...payload })))
  unsubscribeEngine.push(engine.on('activity', (payload) => broadcast({ type: 'activity', ...payload })))
  unsubscribeEngine.push(engine.on('cursor', (payload) => broadcast({ type: 'cursor', ...payload })))
  unsubscribeEngine.push(engine.on('log', (payload) => {
    if (payload && payload.level !== 'info') broadcast({ type: 'log', ...payload })
  }))
  disposers.push(() => {
    for (const off of unsubscribeEngine) {
      try { off() } catch { /* ignore */ }
    }
  })

  const isLoopbackName = (hostname) => {
    if (typeof hostname !== 'string' || hostname.length === 0) return false
    const name = hostname.toLowerCase()
    return name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === '[::1]' || /^127\./.test(name)
  }

  const originAllowed = (req) => {
    const origin = req.headers?.origin
    if (typeof origin !== 'string' || origin.length === 0) return true
    let expected
    try {
      expected = ctx.webServer?.getOrigin?.()
    } catch {
      expected = undefined
    }
    if (typeof expected !== 'string' || expected.length === 0) {
      // Before the listener reports its origin, compare against the request Host.
      const host = req.headers?.host
      try {
        return new URL(origin).host === host
      } catch {
        return false
      }
    }
    try {
      const parsedOrigin = new URL(origin)
      const parsedExpected = new URL(expected)
      if (parsedOrigin.origin === parsedExpected.origin) return true
      // `localhost`, `127.0.0.1` and other loopback spellings are the same GUI.
      return parsedOrigin.protocol === parsedExpected.protocol &&
        parsedOrigin.port === parsedExpected.port &&
        isLoopbackName(parsedOrigin.hostname) &&
        isLoopbackName(parsedExpected.hostname)
    } catch {
      return false
    }
  }

  const readJsonBody = (req) => new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim().length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('request body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })

  const sendJson = (res, status, value) => {
    if (res.writableEnded) return
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(JSON.stringify(value))
  }

  const reject = (res, status, reason) => {
    sendJson(res, status, { ok: false, error: reason })
  }

  const originDenied = (req, res) => {
    if (originAllowed(req)) return false
    reject(res, 403, 'this endpoint only accepts same-origin requests')
    return true
  }

  const serveEvents = (req, res) => {
    const requestOrigin = typeof req.headers?.origin === 'string' ? req.headers.origin : null
    if (requestOrigin !== null) sseStats.lastOrigin = requestOrigin
    if (!originAllowed(req)) {
      sseStats.rejected += 1
      sseStats.lastRejectedOrigin = requestOrigin
      reject(res, 403, 'this endpoint only accepts same-origin requests')
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    // Disable Nagle so small frames leave immediately.
    try { res.socket?.setNoDelay?.(true) } catch { /* ignore */ }
    res.write('retry: 1500\n\n')
    const client = { res }
    clients.add(client)
    sseStats.active += 1
    sseStats.opened += 1
    if (sseStats.active > sseStats.peak) sseStats.peak = sseStats.active
    if (!writeEvent(res, {
      type: 'hello',
      status: engine.status,
      activity: engine.activity,
      viewport: engine.status?.viewport,
    })) {
      sseStats.lastError = 'could not write the first SSE frame'
    }
    const ping = setInterval(() => {
      if (res.destroyed || res.writableEnded) return
      try { res.write(': ping\n\n') } catch { /* cleanup runs on close */ }
    }, 15000)
    if (typeof ping.unref === 'function') ping.unref()
    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      clearInterval(ping)
      clients.delete(client)
      sseStats.active = Math.max(0, sseStats.active - 1)
    }
    req.on('close', cleanup)
    res.on('close', cleanup)
    res.on('error', cleanup)
  }

  const serveState = async (req, res) => {
    if (originDenied(req, res)) return
    try {
      sendJson(res, 200, { ok: true, ...(await stateOf()) })
    } catch (error) {
      reject(res, 200, errorText(error))
    }
  }

  const runAction = async (action, body) => {
    switch (action) {
      case 'ensure': {
        await engine.ensure()
        return { status: engine.status }
      }
      case 'status':
        return await stateOf()
      case 'navigate': {
        const url = typeof body.url === 'string' ? body.url.trim() : ''
        if (url.length === 0) throw new Error('"url" is required')
        const result = await engine.navigate(url)
        return { url: result?.url ?? engine.status.url, title: result?.title ?? engine.status.title }
      }
      case 'back':
      case 'forward':
      case 'reload': {
        const result = await engine[action]()
        return { url: result?.url ?? engine.status.url, title: result?.title ?? engine.status.title }
      }
      case 'click': {
        const { x, y } = body
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('"x" and "y" must be numbers')
        await engine.click({ x: Number(x), y: Number(y) })
        return { url: engine.status.url, title: engine.status.title }
      }
      case 'scroll': {
        await engine.scroll({
          dx: Number.isFinite(body.dx) ? Number(body.dx) : 0,
          dy: Number.isFinite(body.dy) ? Number(body.dy) : 0,
          ...(Number.isFinite(body.x) ? { x: Number(body.x) } : {}),
          ...(Number.isFinite(body.y) ? { y: Number(body.y) } : {}),
        })
        return { ok: true }
      }
      case 'input': {
        const events = Array.isArray(body.events) ? body.events : null
        if (!events) throw new Error('"events" must be an array')
        if (events.length > 128) throw new Error('too many input events in one request (max 128)')
        const result = await engine.dispatchInput(events)
        return { dispatched: result.dispatched, skipped: result.skipped }
      }
      case 'selection': {
        const text = typeof engine.selectionText === 'function' ? await engine.selectionText() : ''
        return { text: text }
      }
      case 'clearCookies': {
        await engine.clearCookies()
        return { cleared: true }
      }
      case 'importCookies': {
        const browser = typeof body.browser === 'string' ? body.browser.trim().toLowerCase() : ''
        if (!['chrome', 'edge', 'firefox'].includes(browser)) {
          throw new Error('"browser" must be one of chrome, edge, firefox')
        }
        const { importCookies } = await import('./cookies.mjs')
        const result = await importCookies(engine, {
          browser,
          log: (level, text) => engine.log?.(level, text),
        })
        return result
      }
      case 'stop': {
        await engine.stop()
        return { stopped: true }
      }
      default:
        throw new Error(`unknown action: ${String(action)}`)
    }
  }

  const serveAction = async (req, res) => {
    if (originDenied(req, res)) return
    const contentType = String(req.headers?.['content-type'] ?? '')
    if (!contentType.toLowerCase().startsWith('application/json')) {
      reject(res, 415, 'Content-Type must be application/json')
      return
    }
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      reject(res, 400, errorText(error))
      return
    }
    const action = typeof body.action === 'string' ? body.action : ''
    if (action.length === 0) {
      reject(res, 400, '"action" is required')
      return
    }
    try {
      const value = await runAction(action, body)
      sendJson(res, 200, { ok: true, ...(value && typeof value === 'object' ? value : {}) })
    } catch (error) {
      const message = errorText(error)
      engine.log?.('warn', `action ${action} failed: ${message}`)
      sendJson(res, 200, { ok: false, error: message })
    }
  }

  const methodNotAllowed = (res, allow) => {
    if (res.writableEnded) return
    res.writeHead(405, { Allow: allow, 'Cache-Control': 'no-store' })
    res.end()
  }

  // Route handlers receive (req, res) only; wrap each with its method guard.
  const guard = (allow, handler) => (req, res) => {
    if (String(req.method ?? '').toUpperCase() !== allow) {
      methodNotAllowed(res, allow)
      return
    }
    void handler(req, res)
  }

  const routes = [
    { kind: 'exact', path: `${PREFIX}/events`, handler: guard('GET', serveEvents) },
    { kind: 'exact', path: `${PREFIX}/state`, handler: guard('GET', serveState) },
    { kind: 'exact', path: `${PREFIX}/action`, handler: guard('POST', serveAction) },
  ]
  for (const route of routes) {
    disposers.push(ctx.webServer.register(route))
  }

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch { /* ignore */ }
    }
    for (const client of clients) {
      try { client.res.end() } catch { /* ignore */ }
    }
    clients.clear()
  }
}

/** Whether a payload rides the screencast lane (only frames get a backpressure cap). */
function isFrame(payload) {
  return payload && payload.type === 'frame'
}

/** Readable text of an arbitrary thrown value. */
function errorText(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try { return JSON.stringify(error) } catch { return String(error) }
}
