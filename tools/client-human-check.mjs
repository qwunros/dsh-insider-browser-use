// Client-side input-layer smoke test: loads client.js with a stubbed
// ModuleLoader/React/DOM, renders BrowserBody once, then drives its pointer,
// wheel, keyboard, IME and paste handlers and asserts the POSTed input events.
import { setTimeout as sleep } from 'node:timers/promises'

const problems = []
const expect = (condition, message) => { if (!condition) problems.push(message) }

// ---------------------------------------------------------------------------
// React stub: just enough hooks to invoke the component once and capture effects.
// ---------------------------------------------------------------------------
const effects = []
const react = {
  createElement(type, props, ...children) {
    const normalized = { ...(props || {}) }
    if (children.length === 1) normalized.children = children[0]
    else if (children.length > 1) normalized.children = children
    if (normalized.ref && typeof normalized.ref === 'object') normalized.ref.current = fakeNode(type)
    return { type, props: normalized }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useRef(initial) {
    return { current: initial }
  },
  useEffect(callback) {
    effects.push(callback)
    return undefined
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    return getSnapshot()
  },
}

function fakeNode(kind) {
  const node = {
    kind,
    value: '',
    listeners: {},
    style: {},
    dataset: {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 1280, height: 800, right: 1280, bottom: 800 }
    },
    addEventListener(type, fn) { node.listeners[type] = fn },
    removeEventListener(type) { delete node.listeners[type] },
    focus() {},
    select() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    setAttribute() {},
    removeAttribute() {},
    appendChild() {},
  }
  return node
}

Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true,
  writable: true,
})
globalThis.window = {
  __ModuleLoader__: {
    load(registration) { globalThis.__registration = registration },
  },
}

// ---------------------------------------------------------------------------
// fetch stub: record every POST body.
// ---------------------------------------------------------------------------
const calls = []
globalThis.fetch = async (url, options = {}) => {
  const body = options.body ? JSON.parse(options.body) : undefined
  calls.push({ url, body })
  return { ok: true, status: 200, json: async () => ({ ok: true }) }
}

// ModuleLoader shim must exist before client.js runs.
await import(new URL('../client.js', import.meta.url).href)
const registration = globalThis.__registration
expect(registration && typeof registration.factory === 'function', 'ModuleLoader registration missing')
const mod = registration.factory((id) => {
  if (id === 'react') return react
  throw new Error(`unexpected require(${id})`)
})
expect(typeof mod.apply === 'function', 'client module must export apply()')

// ---------------------------------------------------------------------------
// Context stub: capture the BrowserBody component from the slot registration.
// ---------------------------------------------------------------------------
let Body = null
const ctx = {
  effect(callback) {
    const dispose = callback()
    return dispose
  },
  locale: {
    register() { return () => {} },
    bind() { return (key) => key },
  },
  slots: {
    inject(_name, callback) { callback() },
    register(definition, component) {
      if (definition && definition.name === 'sidebar.right.pane.tab') Body = component
      return () => {}
    },
  },
  sidebarRightTabs: { register() { return () => {} } },
}
mod.apply(ctx)
expect(typeof Body === 'function', 'BrowserBody was not registered')

const snapshot = {
  connected: true,
  everConnected: true,
  hadError: false,
  viewport: { width: 1280, height: 800 },
  frame: { data: 'AAAA', seq: 1 },
  navigation: { url: 'http://127.0.0.1:8899/', title: 'demo', loading: false, canGoBack: false, canGoForward: false },
  activity: { active: false },
  cursor: null,
  status: null,
}
const live = {
  subscribe() { return () => {} },
  getSnapshot() { return snapshot },
  dispose() {},
}

const LINK_URL = 'http://127.0.0.1:8899/linked-page'
effects.length = 0
const tree = Body({
  live,
  t: (key) => key,
  useTabInfo: () => ({
    sidebar: { expanded: true, fullscreen: false },
    panel: { id: 'pane-1' },
    tab: {
      id: 'tab-1',
      navigation: { address: 'browser:page', params: { url: LINK_URL }, revision: 3 },
    },
  }),
})
for (const effect of effects) {
  try { effect() } catch (error) { problems.push(`effect threw: ${error.message}`) }
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (node.props) visit(node)
  const children = node.props ? node.props.children : undefined
  if (Array.isArray(children)) for (const child of children) walk(child, visit)
  else if (children) walk(children, visit)
}
let frameProps = null
let captureProps = null
let frameNode = null
walk(tree, (element) => {
  const props = element.props || {}
  if (props.className === 'dib-frame') { frameProps = props; frameNode = props.ref && props.ref.current }
  if (props.className === 'dib-input-layer') captureProps = props
})
expect(frameProps !== null, 'frame element not rendered')
expect(captureProps !== null, 'capture textarea not rendered')
expect(frameProps && frameProps.onPointerDown, 'frame has no pointerdown handler')
expect(captureProps && captureProps.onKeyDown, 'textarea has no keydown handler')

// ---------------------------------------------------------------------------
// Event helpers.
// ---------------------------------------------------------------------------
function event(extra = {}) {
  const state = { prevented: false, stopped: false }
  return {
    ...extra,
    preventDefault() { state.prevented = true },
    stopPropagation() { state.stopped = true },
    get prevented() { return state.prevented },
    get stopped() { return state.stopped },
  }
}
function pointer(extra) {
  return event({
    clientX: 320,
    clientY: 200,
    button: 0,
    pointerId: 1,
    currentTarget: frameNode,
    ...extra,
  })
}

// 1) Single click: move + down + up at mapped viewport coordinates.
frameProps.onPointerDown(pointer({}))
frameProps.onPointerUp(pointer({}))
// 2) Double click: a second down within 400ms must carry clickCount 2.
frameProps.onPointerDown(pointer({}))
frameProps.onPointerUp(pointer({}))
// 3) Hover move.
frameProps.onPointerMove(pointer({ button: -1 }))
// 4) Wheel through the native non-passive listener captured by the effect.
const wheel = event({ clientX: 640, clientY: 400, deltaX: 0, deltaY: 120 })
frameNode.listeners.wheel(wheel)
// 5) Keyboard: printable char is forwarded as keyDown with text + keyUp.
const charDown = event({ key: 'a', code: 'KeyA', keyCode: 65, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })
captureProps.onKeyDown(charDown)
const charUp = event({ key: 'a', code: 'KeyA', keyCode: 65 })
captureProps.onKeyUp(charUp)
// 6) Enter carries text '\r'.
const enterDown = event({ key: 'Enter', code: 'Enter', keyCode: 13 })
captureProps.onKeyDown(enterDown)
captureProps.onKeyUp(event({ key: 'Enter', code: 'Enter', keyCode: 13 }))
// 7) Ctrl+A: modifier shortcut, raw key (no text).
const ctrlA = event({ key: 'a', code: 'KeyA', keyCode: 65, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })
captureProps.onKeyDown(ctrlA)
captureProps.onKeyUp(event({ key: 'a', code: 'KeyA', keyCode: 65, ctrlKey: true }))
// 8) IME composition end inserts text.
captureProps.onCompositionStart()
captureProps.onCompositionEnd({ data: '你好' })
// 9) Paste inserts clipboard text.
const paste = event({ clipboardData: { getData: () => 'pasted-text' } })
captureProps.onPaste(paste)
// 10) Composition input events must not double-insert.
captureProps.onInput({ nativeEvent: { isComposing: true } })

await sleep(120)

// A tab opened from a conversation link must navigate the real browser to the
// URL carried by navigation.params.url, not just show the existing page.
const linkNavigations = calls.filter((call) => call.body && call.body.action === 'navigate' && call.body.url === LINK_URL)
expect(linkNavigations.length === 1, `conversation link did not navigate: ${JSON.stringify(calls.filter((c) => c.body && c.body.action === 'navigate'))}`)

const inputCalls = calls.filter((call) => call.body && call.body.action === 'input')
const events = inputCalls.flatMap((call) => call.body.events || [])
const mouseDowns = events.filter((e) => e.t === 'm' && e.a === 'down')
const mouseUps = events.filter((e) => e.t === 'm' && e.a === 'up')
const moves = events.filter((e) => e.t === 'm' && e.a === 'move')
const wheels = events.filter((e) => e.t === 'm' && e.a === 'wheel')
const keys = events.filter((e) => e.t === 'k')

expect(inputCalls.length > 0, 'no input batch was POSTed')
expect(mouseDowns.length === 2, `expected 2 mouse downs, got ${mouseDowns.length}`)
expect(mouseDowns[0] && mouseDowns[0].x === 320 && mouseDowns[0].y === 200, `mapped coordinates wrong: ${JSON.stringify(mouseDowns[0])}`)
expect(mouseDowns[0] && mouseDowns[0].button === 'left' && mouseDowns[0].clickCount === 1, `first click shape wrong: ${JSON.stringify(mouseDowns[0])}`)
expect(mouseDowns[1] && mouseDowns[1].clickCount === 2, `double click count not 2: ${JSON.stringify(mouseDowns[1])}`)
expect(mouseUps.length === 2, `expected 2 mouse ups, got ${mouseUps.length}`)
expect(moves.length >= 2, `expected hover/drag moves, got ${moves.length}`)
expect(wheels.length === 1 && wheels[0].dy === 120, `wheel not forwarded: ${JSON.stringify(wheels)}`)
expect(wheel.prevented === true, 'wheel default was not prevented')

const keyDownChar = keys.find((e) => e.a === 'down' && e.key === 'a' && e.mods === 0)
const keyUpChar = keys.find((e) => e.a === 'up' && e.key === 'a' && e.mods === 0)
expect(keyDownChar && keyDownChar.text === 'a', `printable keyDown text missing: ${JSON.stringify(keyDownChar)}`)
expect(keyUpChar !== undefined, 'printable keyUp missing')
const enterKey = keys.find((e) => e.a === 'down' && e.key === 'Enter')
expect(enterKey && enterKey.text === '\r', `Enter text missing: ${JSON.stringify(enterKey)}`)
const ctrlKey = keys.find((e) => e.a === 'down' && e.key === 'a' && e.mods === 2)
expect(ctrlKey && ctrlKey.text === undefined, `Ctrl+A must not carry text: ${JSON.stringify(ctrlKey)}`)
expect(charDown.prevented === true, 'printable key default was not prevented')
expect(charDown.stopped === true, 'printable key propagation was not stopped')

const texts = events.filter((e) => e.t === 't').map((e) => e.text)
expect(texts.includes('你好'), `IME composition text missing: ${JSON.stringify(texts)}`)
expect(texts.includes('pasted-text'), `pasted text missing: ${JSON.stringify(texts)}`)
expect(texts.filter((text) => text === '你好').length === 1, 'IME text inserted twice')

// 11) Panel shortcut Ctrl+R reloads the page instead of reaching the page.
const reloadBefore = calls.filter((call) => call.body && call.body.action === 'reload').length
const ctrlR = event({ key: 'r', code: 'KeyR', keyCode: 82, ctrlKey: true })
captureProps.onKeyDown(ctrlR)
expect(ctrlR.prevented === true, 'Ctrl+R panel shortcut was not prevented')
const reloadAfter = calls.filter((call) => call.body && call.body.action === 'reload').length
expect(reloadAfter > reloadBefore, 'Ctrl+R did not trigger a reload action')

// 12) Address bar focus shortcut Ctrl+L.
const ctrlL = event({ key: 'l', code: 'KeyL', keyCode: 76, ctrlKey: true })
captureProps.onKeyDown(ctrlL)
expect(ctrlL.prevented === true, 'Ctrl+L panel shortcut was not prevented')

if (problems.length > 0) {
  console.error(`client human-input smoke check FAILED (${problems.length}):`)
  for (const problem of problems) console.error(` - ${problem}`)
  process.exit(1)
}
console.log(`client human-input smoke check passed: ${events.length} input events in ${inputCalls.length} batch(es), ${calls.length} POSTs`)
process.exit(0)
