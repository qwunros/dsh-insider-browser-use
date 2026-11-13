/**
 * dsh-insider-browser — engine + tools self-check.
 *
 * Two modes:
 *
 *   node tools/engine-check.mjs
 *     Real end-to-end run: launches system Chrome/Edge through BrowserEngine and
 *     drives https://example.com (navigate, snapshot, content, source, screenshot,
 *     clicks, cookies, history, stop). Requires a shell where Chrome can fully
 *     start; it uses --no-sandbox only for this check.
 *
 *   node tools/engine-check.mjs --mock
 *     No browser. Replaces the CDP transport with a scripted fake page so the
 *     engine's protocol plumbing and the registered browser_* tools can be
 *     verified anywhere, including inside a confined sandbox that blocks Chrome's
 *     Mojo IPC channels.
 */

import { createServer } from 'node:http'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserEngine, normalizeBrowserUrl, resolveAttachTarget } from '../src/host/engine.mjs'
import { registerTools } from '../src/host/tools.mjs'

const cliArgs = new Set(process.argv.slice(2))
const MOCK_MODE = cliArgs.has('--mock')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const results = []
function check(name, ok, detail) {
  const entry = { name, ok: ok === true, detail: detail === undefined ? '' : String(detail) }
  results.push(entry)
  console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${name}${entry.detail ? ` — ${entry.detail}` : ''}`)
  return entry.ok
}

function report() {
  const failed = results.filter((result) => result.ok !== true)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) {
    console.log('FAILED CHECKS:')
    for (const failure of failed) console.log(` - ${failure.name}: ${failure.detail}`)
    process.exitCode = 1
  }
}

// ---------------------------------------------------------------------------
// Real browser checks
// ---------------------------------------------------------------------------

async function runBrowserChecks() {
  const profileRoot = join(process.cwd(), '.tmp-engine-check')
  const profileDir = join(profileRoot, 'profile')
  rmSync(profileRoot, { recursive: true, force: true })
  mkdirSync(profileDir, { recursive: true })

  const engine = new BrowserEngine(
    {
      profileDir,
      viewport: { width: 1280, height: 800 },
      // Test-only flags: the plugin itself never adds --no-sandbox.
      noSandbox: true,
      extraArgs: ['--disable-gpu', '--disable-dev-shm-usage', '--disable-crash-reporter', '--disable-breakpad'],
    },
    {
      info: (message) => console.log('[engine]', message),
      warn: (message) => console.log('[engine:warn]', message),
      error: (message) => console.log('[engine:error]', message),
    },
  )

  let frames = 0
  let navigations = 0
  let states = 0
  const cursors = []
  const activityEvents = []
  engine.on('frame', () => { frames += 1 })
  engine.on('navigation', () => { navigations += 1 })
  engine.on('cursor', (event) => { cursors.push(event) })
  engine.on('activity', (event) => { activityEvents.push(event) })
  engine.on('state', () => { states += 1 })
  engine.on('log', (entry) => console.log(`[log:${entry.level}] ${entry.text}`))

  let pid = null
  try {
    await engine.start()
    pid = engine._child?.pid ?? null
    check('browser started', engine.status.running === true, `${engine.status.channel || 'unknown'} ${engine.status.executable || ''}`)
    check('browser pid captured', Number.isInteger(pid), String(pid))

    engine.setActivity('check-session', true, 'browser_snapshot')
    await sleep(20)
    check('activity active after setActivity(true)', engine.activity.active === true && activityEvents.some((event) => event.active === true), JSON.stringify(engine.activity))
    engine.setActivity('check-session', false)
    await sleep(20)
    check('activity inactive after setActivity(false)', engine.activity.active === false && activityEvents.some((event) => event.active === false))

    const nav = await engine.navigate('https://example.com')
    check('navigate example.com', /example\.com/.test(nav.url), `${nav.url} | ${nav.title}`)

    const snapshot = await engine.snapshot()
    check('snapshot has interactive elements', Array.isArray(snapshot.elements) && snapshot.elements.length > 0, `${snapshot.elements.length} elements`)
    check('snapshot has page text', typeof snapshot.text === 'string' && snapshot.text.length > 0, `${snapshot.text.length} chars`)
    check('snapshot viewport is 1280x800', snapshot.viewport.width === 1280 && snapshot.viewport.height === 800, JSON.stringify(snapshot.viewport))

    const content = await engine.content()
    check('content returns text', content.format === 'text' && typeof content.text === 'string')
    check('content contains "Example Domain"', content.text.includes('Example Domain'), `${content.text.length} chars`)

    const htmlContent = await engine.content({ format: 'html', maxChars: 1000 })
    check('content format html', htmlContent.format === 'html' && htmlContent.text.length > 0, `${htmlContent.text.length} chars`)

    const source = await engine.source()
    check('source contains <html', /<html/i.test(source.text), `${source.text.length} chars`)

    const shot = await engine.screenshot()
    check('screenshot is a non-empty JPEG buffer', Buffer.isBuffer(shot.data) && shot.data.length > 0 && shot.mediaType === 'image/jpeg', `${shot.width}x${shot.height}, ${shot.data.length} bytes`)
    check('screenshot has positive dimensions', shot.width > 0 && shot.height > 0, `${shot.width}x${shot.height}`)
    const fullShot = await engine.screenshot({ fullPage: true })
    check('full-page screenshot captured', Buffer.isBuffer(fullShot.data) && fullShot.data.length > 0, `${fullShot.width}x${fullShot.height}, ${fullShot.data.length} bytes`)

    await sleep(300)
    check('screencast frames received', frames > 0, `${frames} frames`)

    const waitFound = await engine.waitFor({ text: 'Example Domain', timeoutMs: 3000 })
    check('waitFor finds existing text', waitFound.ok === true, JSON.stringify(waitFound))
    const waitMissed = await engine.waitFor({ selector: '#dsh-check-does-not-exist', timeoutMs: 800 })
    check('waitFor reports a miss as ok:false', waitMissed.ok === false && typeof waitMissed.reason === 'string', waitMissed.reason)

    const cookieSet = await engine.setCookies([{
      name: 'dsh_check_cookie',
      value: '1',
      domain: 'example.com',
      path: '/',
      secure: true,
      expires: Math.floor(Date.now() / 1000) + 600,
      sameSite: 'Lax',
    }])
    check('setCookies wrote one cookie', cookieSet.set === 1 && cookieSet.failed === 0, JSON.stringify({ set: cookieSet.set, failed: cookieSet.failed, errors: cookieSet.errors }))
    const listed = await engine.listCookies()
    check('listCookies sees the cookie', listed.some((cookie) => cookie.name === 'dsh_check_cookie'), `${listed.length} cookies`)
    const cleared = await engine.clearCookies()
    const afterClear = await engine.listCookies()
    check('clearCookies empties the jar', cleared.cleared === true && afterClear.length === 0, `${afterClear.length} cookies after clear`)

    const link = snapshot.elements.find((element) => element.kind === 'link')
    const urlBefore = snapshot.url
    if (link) {
      const clickResult = await engine.click({ ref: link.ref })
      check('click first link did not throw', true, `ref ${link.ref} "${link.label}" at (${clickResult.x}, ${clickResult.y})`)
      check('click changed the URL', clickResult.url !== urlBefore, `${urlBefore} -> ${clickResult.url}`)
    } else {
      check('click first link', false, 'the snapshot contained no link element')
    }
    check('cursor events were emitted', cursors.some((event) => event.action === 'move') && cursors.some((event) => event.action === 'click'), `${cursors.length} cursor events`)

    await engine.navigate('https://example.com')
    const textClick = await engine.click({ text: 'More information' })
    check('click by text resolved a target', Number.isFinite(textClick.x) && Number.isFinite(textClick.y), `(${textClick.x}, ${textClick.y})`)

    await engine.navigate('https://example.com')
    const coordClick = await engine.click({ x: 640, y: 300 })
    check('click by coordinates did not throw', Number.isFinite(coordClick.x), `(${coordClick.x}, ${coordClick.y})`)

    await engine.key({ key: 'Escape' })
    check('key Escape did not throw', true)
    await engine.scroll({ dy: 200 })
    check('scroll did not throw', true)

    await engine.navigate('https://example.com')
    await engine.navigate('https://www.iana.org/help/example-domains')
    check('back returns a page', typeof (await engine.back()).url === 'string')
    check('forward returns a page', typeof (await engine.forward()).url === 'string')
    check('reload returns a page', typeof (await engine.reload()).url === 'string')

    check('navigation events were emitted', navigations > 0, `${navigations} events`)
    check('state events were emitted', states > 0, `${states} events`)
    const finalStatus = engine.status
    check('status exposes the contract fields', typeof finalStatus.running === 'boolean'
      && typeof finalStatus.starting === 'boolean'
      && typeof finalStatus.profileDir === 'string'
      && finalStatus.viewport.width === 1280
      && finalStatus.viewport.height === 800
      && typeof finalStatus.url === 'string'
      && typeof finalStatus.title === 'string'
      && typeof finalStatus.loading === 'boolean'
      && typeof finalStatus.canGoBack === 'boolean'
      && typeof finalStatus.canGoForward === 'boolean', JSON.stringify({ url: finalStatus.url, channel: finalStatus.channel }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    check('unexpected failure', false, error instanceof Error ? `${message}\n${error.stack}` : message)
    if (/Page\.enable timed out/.test(message)) {
      console.log('\nHINT: the Chrome browser process answered browser-level CDP commands (createTarget/attachToTarget)')
      console.log('but the page target never answered Page.enable. That means the renderer/IPC channel could not')
      console.log('start — typical when Chrome is spawned from inside a restricted process sandbox (Mojo named')
      console.log('pipes are blocked: "platform_channel.cc ... access denied 0x5"). Run this script from an')
      console.log('unconfined shell / the Host process to get the real end-to-end result.')
    }
  } finally {
    try {
      await engine.stop()
    } catch (error) {
      check('stop threw', false, error instanceof Error ? error.message : String(error))
    }
    await sleep(600)
    check('status reports stopped', engine.status.running === false)
    if (Number.isInteger(pid)) {
      let alive = false
      try {
        process.kill(pid, 0)
        alive = true
      } catch {
        alive = false
      }
      check('chrome process exited after stop', alive === false, `pid ${pid}`)
    }
    try {
      rmSync(profileRoot, { recursive: true, force: true })
    } catch (error) {
      console.log(`(could not remove the temporary profile: ${error instanceof Error ? error.message : String(error)})`)
    }
  }
}

// ---------------------------------------------------------------------------
// Fake CDP page for --mock mode
// ---------------------------------------------------------------------------

class FakeCdp {
  constructor() {
    this.isOpen = true
    this.listeners = new Map()
    this.url = 'about:blank'
    this.title = 'about:blank'
    this.history = [{ id: 1, url: 'about:blank', title: 'about:blank' }]
    this.historyIndex = 0
    this.cookies = []
    this.mouseEvents = []
    this.keyEvents = []
    this.insertedText = ''
    this.metricOverrides = []
    this.acks = 0
    this.closed = false
    this.screencast = false
    this.selection = ''
    this.focusEmulation = false
    this.bringToFront = 0
    this.visibility = 'visible'
    this.focused = true
    this.closedTargets = []
    this.browserCloses = 0
    this.bodyText = 'Example Domain\nThis domain is for use in illustrative examples in documents.\nMore information...'
    this.elements = [
      { ref: 1, kind: 'link', label: 'More information...', value: '', selector: 'a', x: 640, y: 320, w: 120, h: 20 },
      { ref: 2, kind: 'input', label: 'Search', value: '', selector: '#q', x: 640, y: 420, w: 220, h: 30 },
    ]
  }

  on(method, listener) {
    let handlers = this.listeners.get(method)
    if (!handlers) {
      handlers = new Set()
      this.listeners.set(method, handlers)
    }
    handlers.add(listener)
    return () => {
      handlers.delete(listener)
    }
  }

  emit(method, params) {
    const handlers = this.listeners.get(method)
    if (!handlers) return
    for (const handler of [...handlers]) handler(params, { sessionId: 'session-1' })
  }

  close() {
    this.isOpen = false
    this.closed = true
  }

  _navigateTo(url, title) {
    this.url = url
    this.title = title || url
    this.history.push({ id: this.history.length + 1, url: this.url, title: this.title })
    this.historyIndex = this.history.length - 1
  }

  _afterLoad() {
    setTimeout(() => {
      this.emit('Page.frameNavigated', { frame: { id: 'frame-1', url: this.url, title: this.title } })
      this.emit('Page.loadEventFired', { timestamp: Date.now() })
    }, 5)
  }

  async send(method, params = {}) {
    switch (method) {
      case 'Page.navigate': {
        this._navigateTo(String(params.url), String(params.url))
        this._afterLoad()
        return { frameId: 'frame-1' }
      }
      case 'Page.reload': {
        this._afterLoad()
        return {}
      }
      case 'Page.getNavigationHistory':
        return { currentIndex: this.historyIndex, entries: this.history.map((entry) => ({ ...entry })) }
      case 'Page.navigateToHistoryEntry': {
        const index = this.history.findIndex((entry) => entry.id === params.entryId)
        if (index >= 0) {
          this.historyIndex = index
          this.url = this.history[index].url
          this.title = this.history[index].title
        }
        this._afterLoad()
        return {}
      }
      case 'Page.getLayoutMetrics':
        return { cssContentSize: { width: 1500, height: 2400 }, contentSize: { width: 1500, height: 2400 } }
      case 'Page.captureScreenshot':
        return { data: Buffer.from('fake-jpeg-bytes').toString('base64') }
      case 'Page.startScreencast': {
        this.screencast = true
        setTimeout(() => this.emit('Page.screencastFrame', { data: Buffer.from('fake-frame').toString('base64'), sessionId: 7, metadata: {} }), 10)
        return {}
      }
      case 'Page.screencastFrameAck':
        this.acks += 1
        return {}
      case 'Emulation.setDeviceMetricsOverride':
        this.metricOverrides.push({ ...params })
        return {}
      case 'Emulation.setUserAgentOverride':
        this.userAgentOverride = params.userAgent
        return {}
      case 'Emulation.setFocusEmulationEnabled':
        this.focusEmulation = params.enabled === true
        this.visibility = 'visible'
        this.focused = true
        return {}
      case 'Page.bringToFront':
        this.bringToFront += 1
        this.visibility = 'visible'
        this.focused = true
        return {}
      case 'Target.getTargetInfo':
        return { targetInfo: { targetId: params.targetId, type: 'page', url: 'http://example.com/opened' } }
      case 'Target.closeTarget':
        this.closedTargets.push(params.targetId)
        return { success: true }
      case 'Network.getAllCookies':
        return { cookies: this.cookies.map((cookie) => ({ ...cookie })) }
      case 'Network.clearBrowserCookies':
        this.cookies = []
        return {}
      case 'Network.setCookie': {
        if (!params.name) return { success: false }
        this.cookies = this.cookies.filter((cookie) => !(cookie.name === params.name && cookie.domain === params.domain))
        this.cookies.push({
          name: params.name,
          value: params.value || '',
          domain: params.domain || 'example.com',
          path: params.path || '/',
          secure: params.secure === true,
          httpOnly: params.httpOnly === true,
          ...(Number.isFinite(params.expires) ? { expires: params.expires } : {}),
          ...(params.sameSite ? { sameSite: params.sameSite } : {}),
        })
        return { success: true }
      }
      case 'Input.dispatchMouseEvent':
        this.mouseEvents.push({ ...params })
        return {}
      case 'Input.dispatchKeyEvent':
        this.keyEvents.push({ ...params })
        return {}
      case 'Input.insertText':
        this.insertedText += params.text
        return {}
      case 'Runtime.evaluate':
        return { result: { value: this._evaluate(String(params.expression || '')) } }
      case 'Page.handleJavaScriptDialog':
        return {}
      case 'Browser.close':
        this.closed = true
        this.browserCloses += 1
        return {}
      default:
        throw new Error(`fake CDP does not implement ${method}`)
    }
  }

  _evaluate(expression) {
    if (expression.includes('const MAX =') && expression.includes('data-dsh-browser-ref')) {
      const maxMatch = /const MAX = (\d+);/.exec(expression)
      const max = maxMatch ? Number(maxMatch[1]) : this.elements.length
      return {
        url: this.url,
        title: this.title,
        viewport: { width: 1280, height: 800 },
        elements: this.elements.slice(0, max).map((element) => ({ ...element })),
        text: this.bodyText.slice(0, 12000),
        truncated: this.elements.length > max,
      }
    }
    if (expression.includes('const arg = ')) {
      const argMatch = /const arg = (\{[^\n]*\});/.exec(expression)
      const arg = argMatch ? JSON.parse(argMatch[1]) : {}
      let element = null
      if (arg.ref !== null) element = this.elements.find((candidate) => String(candidate.ref) === String(arg.ref)) || null
      else if (arg.selector !== null) element = arg.selector === '#q' ? this.elements[1] : null
      else if (arg.text !== null) {
        const needle = String(arg.text).toLowerCase()
        element = this.elements.find((candidate) => candidate.label.toLowerCase().includes(needle)) || null
      }
      if (!element) return { ok: false, reason: `no target for ${JSON.stringify(arg)}` }
      return { ok: true, x: element.x, y: element.y, w: element.w, h: element.h, label: element.label, focused: true, source: 'ref' }
    }
    if (expression.includes('document.activeElement')) {
      return { ok: true, x: this.elements[1].x, y: this.elements[1].y, w: this.elements[1].w, h: this.elements[1].h, label: this.elements[1].label }
    }
    if (expression.includes('selectorOk')) {
      const selector = /const selector = (null|"[^"]*");/.exec(expression)?.[1] ?? 'null'
      const text = /const text = (null|"[^"]*");/.exec(expression)?.[1] ?? 'null'
      const selectorValue = selector === 'null' ? null : JSON.parse(selector)
      const textValue = text === 'null' ? null : JSON.parse(text)
      return {
        selectorOk: selectorValue === null ? true : selectorValue === '#q',
        textOk: textValue === null ? true : this.bodyText.includes(textValue),
        ready: true,
      }
    }
    if (expression.includes('document.visibilityState')) return { visibility: this.visibility, focus: this.focused }
    if (expression.includes('document.body.innerHTML')) return '<div id="q">Example Domain</div>'
    if (expression.includes('document.body.innerText')) return this.bodyText
    if (expression.includes('window.getSelection')) return this.selection
    if (expression.includes('documentElement.outerHTML')) return '<html><body>Example Domain</body></html>'
    if (expression.includes('title: document.title')) return { url: this.url, title: this.title }
    if (expression.includes('url: location.href') && expression.includes('ready: document.readyState')) {
      return { url: this.url, ready: 'complete' }
    }
    if (expression.trim() === 'document.readyState') return 'complete'
    throw new Error(`fake CDP cannot evaluate: ${expression.slice(0, 120)}`)
  }
}

/** Point an engine at a fake CDP page without spawning a process. */
function attachFakePage(engine, fake) {
  engine._cdp = fake
  engine._running = true
  engine._sessionId = 'session-1'
  engine._targetId = 'target-1'
  engine._mainFrameId = 'frame-1'
  engine._installBrowserEventListeners()
}

// ---------------------------------------------------------------------------
// Schema helpers (the harness-supported JSON Schema subset)
// ---------------------------------------------------------------------------

const SCHEMA_KEYWORDS = new Set(['type', 'description', 'title', 'default', 'examples', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])

function validateSchemaSubset(schema, path, violations) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    violations.push(`${path}: schema must be an object`)
    return
  }
  for (const keyword of Object.keys(schema)) {
    if (!SCHEMA_KEYWORDS.has(keyword)) violations.push(`${path}.${keyword}: unsupported JSON Schema keyword`)
  }
  if ('required' in schema) {
    if (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== 'string')) {
      violations.push(`${path}.required: must be an array of strings`)
    } else {
      const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {}
      for (const name of schema.required) {
        if (!Object.hasOwn(properties, name)) violations.push(`${path}.required names "${name}" which is not declared in properties`)
      }
    }
  }
  if ('additionalProperties' in schema && typeof schema.additionalProperties !== 'boolean') {
    violations.push(`${path}.additionalProperties: must be a boolean`)
  }
  if (schema.properties && typeof schema.properties === 'object') {
    for (const [name, child] of Object.entries(schema.properties)) validateSchemaSubset(child, `${path}.properties.${name}`, violations)
  }
  if (schema.items) validateSchemaSubset(schema.items, `${path}.items`, violations)
  if ('enum' in schema && (!Array.isArray(schema.enum) || schema.enum.length === 0)) violations.push(`${path}.enum: must be a non-empty array`)
}

function validateValue(schema, value, path, violations) {
  if (!schema || typeof schema !== 'object') return violations
  if (schema.const !== undefined && value !== schema.const) violations.push(`${path}: must equal ${JSON.stringify(schema.const)}`)
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) violations.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`)
  const type = schema.type
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      violations.push(`${path}: expected object, got ${Array.isArray(value) ? 'array' : typeof value}`)
      return violations
    }
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {}
    for (const name of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.hasOwn(value, name) || value[name] === undefined) violations.push(`${path}.${name}: is required`)
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) {
        if (!Object.hasOwn(properties, name)) violations.push(`${path}.${name}: not declared (additionalProperties: false)`)
      }
    }
    for (const [name, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, name) && value[name] !== undefined) validateValue(child, value[name], `${path}.${name}`, violations)
    }
    return violations
  }
  if (type === 'array') {
    if (!Array.isArray(value)) {
      violations.push(`${path}: expected array, got ${typeof value}`)
      return violations
    }
    value.forEach((item, index) => validateValue(schema.items, item, `${path}[${index}]`, violations))
    return violations
  }
  if (type === 'string' && typeof value !== 'string') violations.push(`${path}: expected string, got ${typeof value}`)
  else if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) violations.push(`${path}: expected finite number, got ${typeof value}`)
  else if (type === 'integer' && !Number.isInteger(value)) violations.push(`${path}: expected integer, got ${value}`)
  else if (type === 'boolean' && typeof value !== 'boolean') violations.push(`${path}: expected boolean, got ${typeof value}`)
  else if (type === 'null' && value !== null) violations.push(`${path}: expected null`)
  return violations
}

// ---------------------------------------------------------------------------
// Mock checks: engine protocol + tool registration/execution
// ---------------------------------------------------------------------------

function makeMockCtx(options = {}) {
  const definitions = new Map()
  const sections = []
  const ctx = {
    definitions,
    sections,
    tools: {
      register(definition) {
        if (definitions.has(definition.name)) throw new Error(`duplicate tool name ${definition.name}`)
        definitions.set(definition.name, definition)
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
      },
    },
    get(name) {
      if (name === 'attachments') return options.attachments
      if (name === 'llm') return options.llm
      return undefined
    },
    logger: {
      info() {},
      warn() {},
      error() {},
    },
  }
  return ctx
}

function makeExec(agentId = 'mock-session') {
  return {
    agent: {
      id: agentId,
      options: {},
      session: { requestHeader: () => ({ config: {} }) },
    },
    signal: new AbortController().signal,
  }
}

async function expectFailure(fn, pattern) {
  try {
    await fn()
    return { ok: false, message: 'did not throw' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: pattern.test(message), message }
  }
}

async function runMockChecks() {
  // -- URL normalization --------------------------------------------------
  check('url: adds https for a bare host', normalizeBrowserUrl('example.com') === 'https://example.com/', normalizeBrowserUrl('example.com'))
  check('url: keeps about:blank', normalizeBrowserUrl('about:blank') === 'about:blank')
  check('url: accepts http', normalizeBrowserUrl('http://127.0.0.1:3080/x') === 'http://127.0.0.1:3080/x')
  for (const rejected of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,hi']) {
    const outcome = await expectFailure(() => Promise.resolve(normalizeBrowserUrl(rejected)), /only http:\/\/ and https:\/\//)
    check(`url: rejects ${rejected.split(':')[0]}:`, outcome.ok, outcome.message)
  }
  const emptyUrl = await expectFailure(() => Promise.resolve(normalizeBrowserUrl('   ')), /must not be empty/)
  check('url: rejects empty input', emptyUrl.ok, emptyUrl.message)

  // -- engine protocol over a fake CDP ------------------------------------
  const fake = new FakeCdp()
  const engine = new BrowserEngine({ profileDir: join(process.cwd(), '.tmp-mock-profile'), viewport: { width: 1280, height: 800 } })
  attachFakePage(engine, fake)
  const frames = []
  const navigations = []
  const cursors = []
  const activityEvents = []
  engine.on('frame', (event) => frames.push(event))
  engine.on('navigation', (event) => navigations.push(event))
  engine.on('cursor', (event) => cursors.push(event))
  engine.on('activity', (event) => activityEvents.push(event))

  check('mock: status reports running', engine.status.running === true && engine.status.viewport.width === 1280)
  await engine.ensure()
  check('mock: ensure keeps the fake page', engine.status.running === true)

  const nav = await engine.navigate('example.com')
  check('mock: navigate normalizes URL and returns state', nav.url === 'https://example.com/' && typeof nav.title === 'string', JSON.stringify(nav))
  check('mock: navigation event emitted', navigations.length > 0, `${navigations.length} events`)

  const snapshot = await engine.snapshot()
  check('mock: snapshot elements normalized', snapshot.elements.length === 2 && snapshot.elements[0].ref === 1 && typeof snapshot.elements[0].selector === 'string', JSON.stringify(snapshot.elements.map((element) => element.ref)))
  check('mock: snapshot text present', snapshot.text.includes('Example Domain'), `${snapshot.text.length} chars`)
  const limited = await engine.snapshot({ maxElements: 1 })
  check('mock: maxElements limits the list', limited.elements.length === 1 && limited.truncated === true)

  const content = await engine.content()
  check('mock: content text', content.format === 'text' && content.text.includes('Example Domain'))
  const html = await engine.content({ format: 'html' })
  check('mock: content html', html.format === 'html' && html.text.includes('Example Domain'))
  const source = await engine.source()
  check('mock: source html', /<html/i.test(source.text))

  const shot = await engine.screenshot()
  check('mock: screenshot returns Buffer JPEG', Buffer.isBuffer(shot.data) && shot.data.length > 0 && shot.mediaType === 'image/jpeg', `${shot.width}x${shot.height}`)
  const fullShot = await engine.screenshot({ fullPage: true })
  check('mock: full-page screenshot uses layout metrics', fullShot.width === 1500 && fullShot.height === 2400, `${fullShot.width}x${fullShot.height}`)
  check('mock: full-page viewport restored', fake.metricOverrides.at(-1).width === 1280 && fake.metricOverrides.at(-1).height === 800, JSON.stringify(fake.metricOverrides.at(-1)))

  const refClick = await engine.click({ ref: 1 })
  check('mock: click by ref returns coordinates', refClick.x === 640 && refClick.y === 320, JSON.stringify(refClick))
  const mouseSequence = fake.mouseEvents.slice(-3).map((event) => event.type)
  check('mock: click dispatches move/press/release', JSON.stringify(mouseSequence) === JSON.stringify(['mouseMoved', 'mousePressed', 'mouseReleased']), JSON.stringify(mouseSequence))
  check('mock: click emits move then click cursors', cursors.some((event) => event.action === 'move') && cursors.some((event) => event.action === 'click'), JSON.stringify(cursors.map((event) => event.action)))
  const textClick = await engine.click({ text: 'more information' })
  check('mock: click by text', textClick.x === 640 && textClick.y === 320, JSON.stringify(textClick))
  const selectorClick = await engine.click({ selector: '#q' })
  check('mock: click by selector', selectorClick.x === 640 && selectorClick.y === 420, JSON.stringify(selectorClick))
  const coordClick = await engine.click({ x: 10, y: 20 })
  check('mock: click by coordinates', coordClick.x === 10 && coordClick.y === 20, JSON.stringify(coordClick))
  const badClick = await expectFailure(() => engine.click({ selector: '#nope' }), /could not click/)
  check('mock: unresolvable click has a readable error', badClick.ok, badClick.message)
  const emptyClick = await expectFailure(() => engine.click({}), /needs one of/)
  check('mock: click without a target has a readable error', emptyClick.ok, emptyClick.message)

  const typeResult = await engine.type({ ref: 2, text: 'hello', clear: true })
  check('mock: type inserts text', fake.insertedText === 'hello' && typeof typeResult.url === 'string', fake.insertedText)
  check('mock: type clear sends Ctrl+A and Backspace', fake.keyEvents.some((event) => event.key === 'a' && event.modifiers === 2) && fake.keyEvents.some((event) => event.key === 'Backspace'), `${fake.keyEvents.length} key events`)
  check('mock: type emits a type cursor', cursors.some((event) => event.action === 'type'))

  await engine.key({ key: 'Enter' })
  const enterDown = fake.keyEvents.filter((event) => event.key === 'Enter')
  check('mock: key Enter sends down+up', enterDown.length === 2 && enterDown[0].type === 'keyDown' && enterDown[0].text === '\r' && enterDown[1].type === 'keyUp', JSON.stringify(enterDown.map((event) => event.type)))
  await engine.key({ key: 'Ctrl+A' })
  check('mock: modified key sets the Ctrl modifier', fake.keyEvents.at(-2).modifiers === 2, JSON.stringify(fake.keyEvents.at(-2)))
  const badKey = await expectFailure(() => engine.key({ key: 'F13' }), /unsupported key/)
  check('mock: unsupported key has a readable error', badKey.ok, badKey.message)

  await engine.scroll({ dy: 300 })
  check('mock: scroll dispatches mouseWheel', fake.mouseEvents.at(-1).type === 'mouseWheel' && fake.mouseEvents.at(-1).deltaY === 300, JSON.stringify(fake.mouseEvents.at(-1)))
  check('mock: scroll emits a scroll cursor', cursors.some((event) => event.action === 'scroll'))

  // -- human input bridge (mirrored panel -> CDP Input domain) ------------
  const cursorsBeforeInput = cursors.length
  const activityBeforeInput = activityEvents.length
  const humanMouseStart = fake.mouseEvents.length
  const humanKeyStart = fake.keyEvents.length
  const mixedInput = await engine.dispatchInput([
    { t: 'm', a: 'move', x: 100, y: 200 },
    { t: 'm', a: 'down', x: 100, y: 200, button: 'left', clickCount: 1 },
    { t: 'm', a: 'move', x: 110, y: 210 },
    { t: 'm', a: 'up', x: 110, y: 210, button: 'left' },
    { t: 'm', a: 'wheel', x: 110, y: 210, dx: 0, dy: -120 },
    { t: 'k', a: 'down', key: 'a', code: 'KeyA', vk: 65, mods: 0, text: 'a' },
    { t: 'k', a: 'up', key: 'a', code: 'KeyA', vk: 65, mods: 0 },
    { t: 't', text: 'héllo' },
  ])
  const humanMouse = fake.mouseEvents.slice(humanMouseStart)
  const humanKeys = fake.keyEvents.slice(humanKeyStart)
  check('mock: dispatchInput sends a mixed batch', mixedInput.dispatched === 8 && mixedInput.skipped === 0, JSON.stringify(mixedInput))
  check('mock: human move carries the current button mask', humanMouse[0]?.type === 'mouseMoved' && humanMouse[0]?.button === 'none' && humanMouse[0]?.buttons === 0 && humanMouse[0]?.clickCount === 0 && humanMouse[0]?.pointerType === 'mouse', JSON.stringify(humanMouse[0]))
  check('mock: human press/release map to mousePressed/mouseReleased', humanMouse[1]?.type === 'mousePressed' && humanMouse[1]?.button === 'left' && humanMouse[1]?.buttons === 1 && humanMouse[1]?.clickCount === 1 && humanMouse[3]?.type === 'mouseReleased' && humanMouse[3]?.button === 'left' && humanMouse[3]?.buttons === 0, JSON.stringify([humanMouse[1], humanMouse[3]]))
  check('mock: human move while held reports buttons=1', humanMouse[2]?.type === 'mouseMoved' && humanMouse[2]?.buttons === 1 && humanMouse[2]?.x === 110 && humanMouse[2]?.y === 210, JSON.stringify(humanMouse[2]))
  check('mock: human wheel maps deltaX/deltaY', humanMouse[4]?.type === 'mouseWheel' && humanMouse[4]?.deltaX === 0 && humanMouse[4]?.deltaY === -120, JSON.stringify(humanMouse[4]))
  check('mock: human key down with text is a keyDown', humanKeys[0]?.type === 'keyDown' && humanKeys[0]?.key === 'a' && humanKeys[0]?.code === 'KeyA' && humanKeys[0]?.text === 'a' && humanKeys[0]?.unmodifiedText === 'a' && humanKeys[0]?.windowsVirtualKeyCode === 65 && humanKeys[0]?.nativeVirtualKeyCode === 65 && humanKeys[0]?.modifiers === 0 && humanKeys[0]?.location === 0 && humanKeys[0]?.isKeypad === false && humanKeys[0]?.autoRepeat === false, JSON.stringify(humanKeys[0]))
  check('mock: human key up is a keyUp without text', humanKeys[1]?.type === 'keyUp' && humanKeys[1]?.key === 'a' && humanKeys[1]?.text === undefined, JSON.stringify(humanKeys[1]))
  check('mock: human text goes through Input.insertText', fake.insertedText.endsWith('héllo'), fake.insertedText)
  check('mock: dispatchInput emits no cursor/activity', cursors.length === cursorsBeforeInput && activityEvents.length === activityBeforeInput, `${cursors.length - cursorsBeforeInput} cursors, ${activityEvents.length - activityBeforeInput} activity`)
  check('mock: dispatchInput leaves buttons=0', engine.inputState().buttons === 0, JSON.stringify(engine.inputState()))

  const rightStart = fake.mouseEvents.length
  const rightDown = await engine.dispatchInput([{ t: 'm', a: 'down', x: 50, y: 60, button: 'right' }])
  const rightHeld = engine.inputState().buttons
  const rightUp = await engine.dispatchInput([{ t: 'm', a: 'up', x: 50, y: 60, button: 'right' }])
  check('mock: right button sets then clears bit 2', rightDown.dispatched === 1 && rightHeld === 2 && rightUp.dispatched === 1 && engine.inputState().buttons === 0, `held ${rightHeld}, after ${engine.inputState().buttons}`)
  check('mock: right button events carry buttons 2 then 0', fake.mouseEvents[rightStart]?.button === 'right' && fake.mouseEvents[rightStart]?.buttons === 2 && fake.mouseEvents[rightStart + 1]?.buttons === 0, JSON.stringify([fake.mouseEvents[rightStart], fake.mouseEvents[rightStart + 1]]))

  await engine.dispatchInput([{ t: 'm', a: 'down', x: 70, y: 80, button: 'left' }])
  const heldAcrossNavigation = engine.inputState().buttons
  fake.emit('Page.frameNavigated', { frame: { id: 'frame-1', url: 'http://127.0.0.1:8899/next', title: 'next' } })
  await sleep(20)
  check(
    'mock: a navigation clears held human buttons',
    heldAcrossNavigation === 1 && engine.inputState().buttons === 0,
    `before ${heldAcrossNavigation}, after ${engine.inputState().buttons}`,
  )

  const clampStart = fake.mouseEvents.length
  const weirdInput = await engine.dispatchInput([
    null,
    { t: 'x', a: 'move', x: 1, y: 1 },
    { t: 'm', a: 'down', button: 'left' },
    { t: 'm', a: 'move', x: 99999, y: -50 },
    { t: 'm', a: 'wheel', x: 10, y: 10, dx: 99999, dy: -99999 },
    { t: 'm', a: 'down', x: 10, y: 10, button: 'side' },
    { t: 't', text: '' },
  ])
  const clampedMove = fake.mouseEvents[clampStart]
  const clampedWheel = fake.mouseEvents[clampStart + 1]
  check('mock: invalid human input events are skipped', weirdInput.dispatched === 2 && weirdInput.skipped === 5, JSON.stringify(weirdInput))
  check('mock: human coordinates clamp to the viewport', clampedMove?.type === 'mouseMoved' && clampedMove?.x === 1280 && clampedMove?.y === 0, JSON.stringify(clampedMove))
  check('mock: human wheel deltas clamp to ±10000', clampedWheel?.type === 'mouseWheel' && clampedWheel?.deltaX === 10000 && clampedWheel?.deltaY === -10000, JSON.stringify(clampedWheel))

  const manyMoves = Array.from({ length: 130 }, () => ({ t: 'm', a: 'move', x: 1, y: 1 }))
  const cappedInput = await engine.dispatchInput(manyMoves)
  check('mock: human input batch caps at 128 events', cappedInput.dispatched === 128 && cappedInput.skipped === 2, JSON.stringify(cappedInput))

  const modifiedKeyStart = fake.keyEvents.length
  await engine.dispatchInput([
    { t: 'k', a: 'down', key: 'a', code: 'KeyA', vk: 65, mods: 2, text: 'a' },
    { t: 't', text: 'x'.repeat(5000) },
  ])
  const modifiedKey = fake.keyEvents[modifiedKeyStart]
  check('mock: modified human key is a rawKeyDown without text', modifiedKey?.type === 'rawKeyDown' && modifiedKey?.modifiers === 2 && modifiedKey?.text === undefined, JSON.stringify(modifiedKey))
  check('mock: human inserted text is capped at 4000 chars', fake.insertedText.endsWith('x'.repeat(4000)) && !fake.insertedText.endsWith('x'.repeat(4001)), `${fake.insertedText.length} chars`)

  const originalSend = fake.send.bind(fake)
  fake.send = async (...args) => {
    await sleep(80)
    return originalSend(...args)
  }
  const fastStart = Date.now()
  const fastInput = await engine.dispatchInput([{ t: 'm', a: 'move', x: 5, y: 5 }])
  const fastElapsed = Date.now() - fastStart
  fake.send = originalSend
  check(
    'mock: dispatchInput does not wait for CDP round-trips',
    fastInput.dispatched === 1 && fastElapsed < 40,
    `${fastElapsed}ms for a 80ms round-trip`,
  )

  fake.emit('Target.targetCreated', {
    targetInfo: { targetId: 'popup-1', type: 'page', url: '', openerId: 'target-1' },
  })
  fake.emit('Target.targetInfoChanged', {
    targetInfo: { targetId: 'popup-1', type: 'page', url: 'http://example.com/opened', openerId: 'target-1' },
  })
  await sleep(450)
  check(
    'mock: a link opened in a new tab is followed in the mirror',
    engine.status.url === 'http://example.com/opened',
    engine.status.url,
  )
  check(
    'mock: the followed new tab is closed again',
    fake.closedTargets.includes('popup-1'),
    JSON.stringify(fake.closedTargets),
  )

  fake.selection = 'Example Domain selected text'
  const selection = await engine.selectionText()
  check('mock: selectionText reads the page selection', selection === 'Example Domain selected text', selection)

  const waitFound = await engine.waitFor({ text: 'Example Domain', timeoutMs: 500 })
  check('mock: waitFor finds text', waitFound.ok === true, JSON.stringify(waitFound))
  const waitMissed = await engine.waitFor({ selector: '#nope', timeoutMs: 300 })
  check('mock: waitFor reports timeout as ok:false', waitMissed.ok === false && typeof waitMissed.reason === 'string', waitMissed.reason)

  const cookieResult = await engine.setCookies([
    { name: 'a', value: '1', domain: 'example.com', path: '/', secure: true, sameSite: 'Lax', expires: Math.floor(Date.now() / 1000) + 60 },
    { name: '', value: 'broken' },
  ])
  check('mock: setCookies counts written/failed', cookieResult.set === 1 && cookieResult.failed === 1 && cookieResult.errors.length === 1, JSON.stringify(cookieResult))
  const listed = await engine.listCookies()
  check('mock: listCookies maps fields', listed.length === 1 && listed[0].domain === 'example.com' && listed[0].secure === true, JSON.stringify(listed))
  check('mock: cookie values are never logged', !JSON.stringify(activityEvents).includes('value'))
  await engine.clearCookies()
  check('mock: clearCookies empties the jar', (await engine.listCookies()).length === 0)

  await engine.navigate('https://second.example/')
  const beforeBack = engine.status.url
  const back = await engine.back()
  check('mock: back moves history', back.url !== beforeBack, `${beforeBack} -> ${back.url}`)
  const forward = await engine.forward()
  check('mock: forward moves history', forward.url === beforeBack, `${back.url} -> ${forward.url}`)
  const reloaded = await engine.reload()
  check('mock: reload returns state', typeof reloaded.url === 'string')

  engine.setActivity('session-a', true, 'browser_snapshot')
  engine.setActivity('session-b', true, 'browser_click')
  engine.setActivity('session-a', false)
  check('mock: activity ref-count keeps another session active', engine.activity.active === true && engine.activity.sessionId === 'session-b', JSON.stringify(engine.activity))
  engine.setActivity('session-b', false)
  check('mock: activity clears at zero', engine.activity.active === false && activityEvents.filter((event) => event.active === true).length >= 2, JSON.stringify(activityEvents))

  await sleep(50)
  // The fake page emits no screencast on its own in mock mode (Page.startScreencast
  // runs inside the real page creation path), so drive one frame through the
  // engine handlers explicitly and verify the ack-before-emit contract.
  fake.emit('Page.screencastFrame', { data: Buffer.from('fake-frame').toString('base64'), sessionId: 7, metadata: {} })
  await sleep(50)
  check('mock: screencast frame emitted and acked', frames.length > 0 && fake.acks > 0, `${frames.length} frames, ${fake.acks} acks`)

  await engine._ensurePageActive()
  check(
    'mock: focus emulation marks the page visible',
    fake.focusEmulation === true && engine.status.visible === true && engine.status.focused === true,
    JSON.stringify({ focusEmulation: fake.focusEmulation, visible: engine.status.visible, focused: engine.status.focused }),
  )
  fake.visibility = 'hidden'
  fake.focused = false
  await engine._checkPageVisibility()
  check(
    'mock: visibility watchdog brings a hidden page back',
    fake.bringToFront > 0 && fake.focusEmulation === true && engine.status.visible === true,
    `${fake.bringToFront} bringToFront, visible=${engine.status.visible}`,
  )

  await engine.stop()
  check('mock: stop closes the fake page', engine.status.running === false)
  check('mock: a spawned browser is closed on stop', fake.browserCloses === 1, `${fake.browserCloses} Browser.close`)
  const selectionAfterStop = await engine.selectionText()
  check('mock: selectionText is empty when no page is running', selectionAfterStop === '', JSON.stringify(selectionAfterStop))

  // -- attach mode --------------------------------------------------------
  check('attach: a bare port points at loopback', JSON.stringify(resolveAttachTarget({ attachTo: '9222' }, {})) === JSON.stringify({ kind: 'http', url: 'http://127.0.0.1:9222', source: 'attachTo' }), JSON.stringify(resolveAttachTarget({ attachTo: '9222' }, {})))
  check('attach: an http endpoint is normalized', resolveAttachTarget({ attachTo: 'http://127.0.0.1:9333/' }, {}).url === 'http://127.0.0.1:9333')
  check('attach: a ws URL is used directly', resolveAttachTarget({}, { DSH_BROWSER_DEBUG_URL: 'ws://127.0.0.1:9222/devtools/browser/x' }).kind === 'ws')
  check('attach: the env port is honored', resolveAttachTarget({}, { DSH_BROWSER_DEBUG_PORT: '9555' }).url === 'http://127.0.0.1:9555')
  check('attach: nothing configured means spawn', resolveAttachTarget({}, {}) === null)
  let attachRejected = false
  try { resolveAttachTarget({ attachTo: 'not a url' }, {}) } catch { attachRejected = true }
  check('attach: an invalid attachTo is rejected', attachRejected)

  const fakeAttached = new FakeCdp()
  const attachedEngine = new BrowserEngine({ attachTo: 'http://127.0.0.1:9222' })
  attachFakePage(attachedEngine, fakeAttached)
  attachedEngine._carrier = 'attached'
  attachedEngine._endpoint = 'http://127.0.0.1:9222'
  check('attach: status reports the carrier and endpoint', attachedEngine.status.carrier === 'attached' && attachedEngine.status.endpoint === 'http://127.0.0.1:9222', JSON.stringify({ carrier: attachedEngine.status.carrier, endpoint: attachedEngine.status.endpoint }))
  let cookieWriteBlocked = false
  try { await attachedEngine.clearCookies() } catch (error) { cookieWriteBlocked = /refusing to clear cookies/.test(error.message) }
  check('attach: cookie clears are refused by default', cookieWriteBlocked)
  let cookieSetBlocked = false
  try { await attachedEngine.setCookies([{ name: 'a', value: '1' }]) } catch (error) { cookieSetBlocked = /refusing to write cookies/.test(error.message) }
  check('attach: cookie writes are refused by default', cookieSetBlocked)
  const optedInEngine = new BrowserEngine({ attachTo: 'http://127.0.0.1:9222', allowCookieWrites: true })
  attachFakePage(optedInEngine, new FakeCdp())
  optedInEngine._carrier = 'attached'
  let optedInAllowed = true
  try { await optedInEngine.clearCookies() } catch { optedInAllowed = false }
  check('attach: allowCookieWrites opts in to cookie writes', optedInAllowed)
  const attachedListed = await attachedEngine.listCookies()
  check('attach: cookie reads stay allowed', Array.isArray(attachedListed))
  await attachedEngine.stop()
  check('attach: stop closes only our tab', fakeAttached.closedTargets.includes('target-1') && fakeAttached.browserCloses === 0, JSON.stringify({ closed: fakeAttached.closedTargets, closes: fakeAttached.browserCloses }))
  check('attach: stop leaves the carrier running', attachedEngine.status.running === false && attachedEngine.status.carrier === 'none')

  // -- discovery ----------------------------------------------------------
  const previousBrowserPath = process.env.DSH_BROWSER_PATH
  process.env.DSH_BROWSER_PATH = process.execPath
  const pathEngine = new BrowserEngine({ profileDir: join(process.cwd(), '.tmp-mock-profile') })
  let resolvedFromEnv = null
  try {
    resolvedFromEnv = pathEngine._resolveExecutable()
  } finally {
    if (previousBrowserPath === undefined) delete process.env.DSH_BROWSER_PATH
    else process.env.DSH_BROWSER_PATH = previousBrowserPath
  }
  check('discovery: DSH_BROWSER_PATH is honored', resolvedFromEnv && resolvedFromEnv.path === process.execPath, JSON.stringify(resolvedFromEnv))
  check('discovery: candidates report their source', pathEngine._browserCandidates().every((candidate) => typeof candidate.source === 'string'))

  const noAttachEngine = new BrowserEngine({ profileDir: join(process.cwd(), '.tmp-mock-profile') })
  const noAttachDiagnostics = await noAttachEngine.diagnose({ maxAgeMs: 0 })
  check(
    'discovery: diagnose explains an unconfigured attach target',
    noAttachDiagnostics.attach.configured === false && Array.isArray(noAttachDiagnostics.candidates) && typeof noAttachDiagnostics.platform === 'string',
    JSON.stringify({ attach: noAttachDiagnostics.attach, candidates: noAttachDiagnostics.candidates.length }),
  )
  const unreachableEngine = new BrowserEngine({ attachTo: 'http://127.0.0.1:1', profileDir: join(process.cwd(), '.tmp-mock-profile') })
  const unreachableDiagnostics = await unreachableEngine.diagnose({ maxAgeMs: 0 })
  check(
    'discovery: diagnose reports an unreachable endpoint',
    unreachableDiagnostics.attach.configured === true && unreachableDiagnostics.attach.reachable === false && typeof unreachableDiagnostics.attach.error === 'string',
    JSON.stringify(unreachableDiagnostics.attach),
  )

  // Auto-attach: a DevTools endpoint answering on one of the configured ports
  // must be picked up without any attachTo option.
  const autoPort = await new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === '/json/version') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/fake`, product: 'Fake/1' }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
    server.on('error', () => resolve({ server: null, port: 0 }))
  })
  if (autoPort.server) {
    try {
      const autoEngine = new BrowserEngine({
        profileDir: join(process.cwd(), '.tmp-mock-profile'),
        autoAttachPorts: [autoPort.port],
      })
      const picked = await autoEngine._pickAttachTarget()
      check('discovery: a listening DevTools port is auto-attached', picked && picked.url === `http://127.0.0.1:${autoPort.port}`, JSON.stringify(picked))

      const offEngine = new BrowserEngine({
        profileDir: join(process.cwd(), '.tmp-mock-profile'),
        autoAttach: false,
        autoAttachPorts: [autoPort.port],
      })
      check('discovery: autoAttach:false keeps spawning', (await offEngine._pickAttachTarget()) === null)
    } finally {
      autoPort.server.close()
    }
  } else {
    console.log('SKIP discovery: could not bind a temporary port for the auto-attach check')
  }

  // -- tools registration -------------------------------------------------
  const fake2 = new FakeCdp()
  const engine2 = new BrowserEngine({ profileDir: join(process.cwd(), '.tmp-mock-profile'), viewport: { width: 1280, height: 800 } })
  attachFakePage(engine2, fake2)
  const toolActivity = []
  engine2.on('activity', (event) => toolActivity.push(event))
  const mockCtx = makeMockCtx({
    attachments: {
      async saveImage({ data, mediaType }) {
        return { attachmentId: 'attachment-1', mediaType, bytes: data.length, width: 1280, height: 800 }
      },
    },
  })
  registerTools(mockCtx, engine2, {})
  const definitions = mockCtx.definitions
  const expectedTools = ['browser_open', 'browser_snapshot', 'browser_content', 'browser_source', 'browser_screenshot', 'browser_click', 'browser_type', 'browser_key', 'browser_scroll', 'browser_wait_for', 'browser_back', 'browser_forward', 'browser_reload', 'browser_close']
  check('tools: every expected tool registered', expectedTools.every((name) => definitions.has(name)) && definitions.size === expectedTools.length, `${definitions.size} tools`)
  check('tools: system prompt section registered', mockCtx.sections.length === 1 && mockCtx.sections[0].name === 'tool:insider-browser' && mockCtx.sections[0].order === 150 && typeof mockCtx.sections[0].text === 'string' && mockCtx.sections[0].text.length > 100, JSON.stringify(mockCtx.sections.map((section) => section.name)))
  check('tools: system prompt mentions the right sidebar and snapshot', /right sidebar/i.test(mockCtx.sections[0].text) && /browser_snapshot/.test(mockCtx.sections[0].text))

  const readTools = new Set(['browser_snapshot', 'browser_content', 'browser_source', 'browser_screenshot', 'browser_wait_for'])
  const schemaProblems = []
  const timeoutProblems = []
  for (const [name, definition] of definitions) {
    validateSchemaSubset(definition.parameters, `${name}.parameters`, schemaProblems)
    validateSchemaSubset(definition.output.schema, `${name}.output`, schemaProblems)
    if (definition.timeoutMs !== 60_000) timeoutProblems.push(`${name}: timeoutMs=${definition.timeoutMs}`)
    if (typeof definition.execute !== 'function') timeoutProblems.push(`${name}: no execute`)
    if (typeof definition.output.render !== 'function') timeoutProblems.push(`${name}: no render`)
    const safe = definition.isConcurrencySafe()
    if (safe !== readTools.has(name)) timeoutProblems.push(`${name}: isConcurrencySafe=${safe}, expected ${readTools.has(name)}`)
  }
  check('tools: parameter/output schemas use the supported subset', schemaProblems.length === 0, schemaProblems.join('; '))
  check('tools: timeoutMs / concurrency classification', timeoutProblems.length === 0, timeoutProblems.join('; '))

  const exec = makeExec()
  const activityProblems = []
  const runTool = async (name, args) => {
    const definition = definitions.get(name)
    const activityBefore = toolActivity.length
    const value = await definition.execute(args, exec)
    const observed = toolActivity.slice(activityBefore)
    if (!observed.some((event) => event.active === true) || !observed.some((event) => event.active === false)) {
      activityProblems.push(`${name}: ${JSON.stringify(observed)}`)
    }
    const violations = validateValue(definition.output.schema, value, 'value', [])
    check(`tools: ${name} output validates`, violations.length === 0, violations.join('; '))
    const blocks = definition.output.render(args, value)
    check(`tools: ${name} render returns content blocks`, Array.isArray(blocks) && blocks.length > 0 && blocks.every((block) => block && typeof block.type === 'string'), JSON.stringify(blocks.map((block) => block.type)))
    return { value, blocks }
  }

  const openResult = await runTool('browser_open', { url: 'example.com' })
  check('tools: browser_open returns a snapshot', openResult.value.url === 'https://example.com/' && openResult.value.elements.length === 2, `${openResult.value.elements.length} elements`)
  await runTool('browser_snapshot', { maxElements: 2 })
  await runTool('browser_content', { format: 'text' })
  await runTool('browser_source', {})
  const screenshotResult = await runTool('browser_screenshot', { fullPage: false })
  check('tools: screenshot render includes an image block', screenshotResult.blocks.some((block) => block.type === 'image' && block.attachment && block.attachment.attachmentId === 'attachment-1'), JSON.stringify(screenshotResult.blocks.map((block) => block.type)))
  await runTool('browser_click', { ref: 1 })
  await runTool('browser_type', { ref: 2, text: 'hello', clear: true })
  await runTool('browser_key', { key: 'Enter' })
  await runTool('browser_scroll', { dy: 120 })
  await runTool('browser_wait_for', { text: 'Example Domain', timeoutMs: 500 })
  await runTool('browser_back', {})
  await runTool('browser_forward', {})
  await runTool('browser_reload', {})

  check('tools: every execute toggled activity on and off', activityProblems.length === 0, activityProblems.join(' | '))

  const badClickArgs = await expectFailure(() => definitions.get('browser_click').execute({}, exec), /needs one of/)
  check('tools: browser_click rejects an empty target readably', badClickArgs.ok, badClickArgs.message)
  const badOpen = await expectFailure(() => definitions.get('browser_open').execute({}, exec), /"url" must be a non-empty string/)
  check('tools: browser_open validates url', badOpen.ok, badOpen.message)
  const badWait = await expectFailure(() => definitions.get('browser_wait_for').execute({}, exec), /needs at least one/)
  check('tools: browser_wait_for validates its condition', badWait.ok, badWait.message)

  // Missing attachment service: readable error, not a crash.
  const ctxNoAttachments = makeMockCtx()
  const fake3 = new FakeCdp()
  const engine3 = new BrowserEngine({ profileDir: join(process.cwd(), '.tmp-mock-profile') })
  attachFakePage(engine3, fake3)
  registerTools(ctxNoAttachments, engine3, {})
  const noAttachments = await expectFailure(() => ctxNoAttachments.definitions.get('browser_screenshot').execute({}, exec), /attachment service is not mounted/)
  check('tools: screenshot without attachments errors readably', noAttachments.ok, noAttachments.message)

  // Model route without image input: attachment is saved, then a readable error.
  const ctxTextOnlyModel = makeMockCtx({
    attachments: {
      async saveImage({ data, mediaType }) {
        return { attachmentId: 'attachment-2', mediaType, bytes: data.length, width: 1280, height: 800 }
      },
    },
    llm: { async resolveModelInfo() { return { inputModalities: ['text'] } } },
  })
  const fake4 = new FakeCdp()
  const engine4 = new BrowserEngine({ profileDir: join(process.cwd(), '.tmp-mock-profile') })
  attachFakePage(engine4, fake4)
  registerTools(ctxTextOnlyModel, engine4, {})
  const textOnlyExec = {
    agent: {
      id: 'mock-session',
      options: { provider: 'fake', model: 'text-only' },
      session: { requestHeader: () => ({ config: { provider: 'fake', model: 'text-only' } }) },
    },
    signal: new AbortController().signal,
  }
  const textOnly = await expectFailure(() => ctxTextOnlyModel.definitions.get('browser_screenshot').execute({}, textOnlyExec), /does not declare image input/)
  check('tools: screenshot on a text-only model errors readably after saving', textOnly.ok, textOnly.message)

  // Close last: it stops engine2's fake browser.
  await runTool('browser_close', {})
  check('tools: browser_close stops the engine', engine2.status.running === false)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (MOCK_MODE) {
  try {
    await runMockChecks()
  } catch (error) {
    check('mock mode crashed', false, error instanceof Error ? `${error.message}\n${error.stack}` : String(error))
  }
} else {
  await runBrowserChecks()
}
report()
