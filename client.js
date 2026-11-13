/**
 * dsh-insider-browser — Web client half.
 *
 * Plain `window.__ModuleLoader__` bundle: no build step, no imports besides
 * React. Everything the panel shows comes from the Host half over HTTP:
 *
 *   GET  /dsh-insider-browser/events   SSE  hello / frame / navigation / activity / cursor / log
 *   POST /dsh-insider-browser/action   navigate / back / forward / reload / clearCookies / importCookies
 *   GET  /dsh-insider-browser/state    engine status + current page + cookie count
 *
 * Registered into the shell:
 *   - a right-sidebar tab type, kind `browser` (extension band, so it takes over
 *     the built-in browser kind), with a localized guide card;
 *   - its body in `sidebar.right.pane.tab` (keyed by this implementation's id),
 *     plus the optional chip title;
 *   - a `settings.section` page for cookie management.
 *
 * The SSE connection is created once from `apply` (page load) so the panel can be
 * opened automatically when the agent starts operating, even if the right
 * sidebar was never opened by hand.
 */
window.__ModuleLoader__.load({
  id: 'dsh-insider-browser',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement
    const useEffect = react.useEffect
    const useRef = react.useRef
    const useState = react.useState
    const useSyncExternalStore = typeof react.useSyncExternalStore === 'function' ? react.useSyncExternalStore : null

    const NAME = 'dsh-insider-browser'
    const NS = 'insiderBrowser'
    const BASE = '/dsh-insider-browser'
    const TAB_ID = 'dsh-insider-browser'
    const STYLE_ID = 'dsh-insider-browser-styles'

    // --------------------------------------------------------------------- //
    // Locale                                                                //
    // --------------------------------------------------------------------- //

    const zh = {
      title: '内置浏览器',
      guideTitle: '浏览器',
      guideDescription: '在右侧栏实时查看智能体正在操作的网页',
      back: '后退',
      forward: '前进',
      reload: '刷新',
      external: '在系统浏览器中打开',
      go: '前往',
      'address.placeholder': '输入网址，回车打开',
      'empty.desc': '智能体操作时会自动显示在这里',
      'empty.hint': '也可以输入网址开始浏览',
      'human.hint': '点击画面可直接操作',
      'human.active': '已接管输入：键盘/鼠标发送到页面',
      toast: 'dsh正在操作浏览器',
      'status.connected': '已连接',
      'status.connecting': '连接中…',
      'status.reconnecting': '未连接，重连中…',
      'status.loading': '加载中…',
      'error.empty': '请输入网址。',
      'error.invalid': '网址无效。',
      'error.protocol': '只支持 http/https 网址。',
      'error.network': '无法连接 Host 服务，请确认 dsh web 正在运行。',
      'error.unknown': '操作失败。',
      'common.refresh': '刷新',
      'common.retry': '重试',
      'common.cancel': '取消',
      'settings.nav': '浏览器',
      'settings.title': '内置浏览器',
      'settings.description':
        '内置浏览器是 Host 启动的本机 Chrome/Edge 无头实例，登录态保存在插件自己的 profile 里；这里的操作立即生效。',
      'settings.status.title': '内置浏览器状态',
      'settings.status.loading': '正在读取状态…',
      'settings.status.loadFailed': '读取状态失败：',
      'settings.status.running': '运行中',
      'settings.status.stopped': '未启动',
      'settings.status.channel': '浏览器',
      'settings.status.profile': '配置目录',
      'settings.status.viewport': '视口',
      'settings.status.cookies': 'Cookie 数量',
      'settings.status.page': '当前页面',
      'settings.cookies.title': 'Cookie',
      'settings.cookies.desc': '清除后内置浏览器回到未登录状态，不影响你日常使用的浏览器。',
      'settings.clear': '清除内置浏览器 Cookie',
      'settings.clear.confirm': '确认清除',
      'settings.clear.busy': '正在清除…',
      'settings.clear.ok': '已清除内置浏览器 Cookie。',
      'settings.clear.failed': '清除失败：',
      'settings.import.title': '从外部浏览器导入 Cookie',
      'settings.import.desc':
        '从本机 Chrome / Edge / Firefox 的配置目录读取 Cookie 并写入内置浏览器，用于复用登录态。只读取数量，不记录 Cookie 值。',
      'settings.import.chrome': 'Chrome',
      'settings.import.edge': 'Edge',
      'settings.import.firefox': 'Firefox',
      'settings.import.chrome.desc': '读取本机 Chrome 最近使用的配置目录。',
      'settings.import.edge.desc': '读取本机 Edge 最近使用的配置目录。',
      'settings.import.firefox.desc': '读取默认的 Firefox 配置目录。',
      'settings.import.button': '导入',
      'settings.import.busy': '导入中…',
      'settings.import.done': '已导入 {imported} 条（失败 {failed} 条）',
      'settings.import.failed': '导入失败：',
      'settings.import.profile': '来源配置',
      'settings.import.warnings': '提示',
    }

    const en = {
      title: 'Built-in browser',
      guideTitle: 'Browser',
      guideDescription: 'Watch the page the agent is driving, live in the sidebar',
      back: 'Back',
      forward: 'Forward',
      reload: 'Reload',
      external: 'Open in system browser',
      go: 'Go',
      'address.placeholder': 'Enter a URL and press Enter',
      'empty.desc': 'It shows up here automatically while the agent is operating.',
      'empty.hint': 'You can also enter a URL to start browsing.',
      'human.hint': 'Click the page to interact',
      'human.active': 'Input captured: mouse and keyboard go to the page',
      toast: 'dsh is operating the browser',
      'status.connected': 'Connected',
      'status.connecting': 'Connecting…',
      'status.reconnecting': 'Disconnected, reconnecting…',
      'status.loading': 'Loading…',
      'error.empty': 'Enter a URL.',
      'error.invalid': 'That URL is invalid.',
      'error.protocol': 'Only http/https URLs are supported.',
      'error.network': 'Cannot reach the host service; make sure dsh web is running.',
      'error.unknown': 'The request failed.',
      'common.refresh': 'Refresh',
      'common.retry': 'Retry',
      'common.cancel': 'Cancel',
      'settings.nav': 'Browser',
      'settings.title': 'Built-in browser',
      'settings.description':
        'The built-in browser is a headless local Chrome/Edge instance started by the host. Its login state lives in the plugin profile; changes here apply immediately.',
      'settings.status.title': 'Built-in browser status',
      'settings.status.loading': 'Loading status…',
      'settings.status.loadFailed': 'Could not load status: ',
      'settings.status.running': 'Running',
      'settings.status.stopped': 'Not running',
      'settings.status.channel': 'Browser',
      'settings.status.profile': 'Profile directory',
      'settings.status.viewport': 'Viewport',
      'settings.status.cookies': 'Cookies',
      'settings.status.page': 'Current page',
      'settings.cookies.title': 'Cookies',
      'settings.cookies.desc':
        'Clearing signs the built-in browser out; your everyday browser is not touched.',
      'settings.clear': 'Clear built-in browser cookies',
      'settings.clear.confirm': 'Confirm clear',
      'settings.clear.busy': 'Clearing…',
      'settings.clear.ok': 'Built-in browser cookies cleared.',
      'settings.clear.failed': 'Could not clear cookies: ',
      'settings.import.title': 'Import cookies from another browser',
      'settings.import.desc':
        'Reads cookies from the local Chrome / Edge / Firefox profile and writes them into the built-in browser so existing logins can be reused. Only counts are reported; cookie values are never logged.',
      'settings.import.chrome': 'Chrome',
      'settings.import.edge': 'Edge',
      'settings.import.firefox': 'Firefox',
      'settings.import.chrome.desc': "Reads Chrome's most recently used local profile.",
      'settings.import.edge.desc': "Reads Edge's most recently used local profile.",
      'settings.import.firefox.desc': 'Reads the default Firefox local profile.',
      'settings.import.button': 'Import',
      'settings.import.busy': 'Importing…',
      'settings.import.done': 'Imported {imported} (failed {failed})',
      'settings.import.failed': 'Import failed: ',
      'settings.import.profile': 'Source profile',
      'settings.import.warnings': 'Notes',
    }

    /** Falls back to the key itself before `apply` binds the namespace. */
    let translate = function (key) { return key }

    function tr(key, params) {
      try {
        const value = translate(key, params)
        return typeof value === 'string' ? value : key
      } catch (error) {
        return key
      }
    }

    /** A component reads `t` from its injected props, then from the module binding. */
    function getT(props) {
      return props && typeof props.t === 'function' ? props.t : translate
    }

    // --------------------------------------------------------------------- //
    // HTTP helpers                                                          //
    // --------------------------------------------------------------------- //

    async function postAction(payload) {
      let response
      try {
        response = await fetch(BASE + '/action', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(payload),
          cache: 'no-store',
        })
      } catch (error) {
        const failure = new Error('network')
        failure.dibNetwork = true
        throw failure
      }
      let data
      try {
        data = await response.json()
      } catch (error) {
        data = undefined
      }
      if (!response.ok) {
        throw new Error(data && data.error ? String(data.error) : 'HTTP ' + response.status)
      }
      if (!data || data.ok !== true) {
        throw new Error(data && data.error ? String(data.error) : 'request failed')
      }
      return data
    }

    async function getState() {
      let response
      try {
        response = await fetch(BASE + '/state', {
          method: 'GET',
          headers: { accept: 'application/json' },
          cache: 'no-store',
        })
      } catch (error) {
        const failure = new Error('network')
        failure.dibNetwork = true
        throw failure
      }
      let data
      try {
        data = await response.json()
      } catch (error) {
        data = undefined
      }
      if (!response.ok) {
        throw new Error(data && data.error ? String(data.error) : 'HTTP ' + response.status)
      }
      if (!data || typeof data !== 'object') throw new Error('invalid response')
      if (data.ok === false) throw new Error(String(data.error || 'request failed'))
      return data
    }

    /** Readable text for an action/transport failure (never an alert). */
    function errorMessage(error, t) {
      const translateError = typeof t === 'function' ? t : tr
      if (!error) return translateError('error.unknown')
      if (error.dibNetwork) return translateError('error.network')
      const message = error && error.message ? String(error.message) : String(error)
      return message === '' ? translateError('error.unknown') : message
    }

    /** Split `{status,url,...}` (or a `{state:{...}}` envelope) into the settings view model. */
    function normalizeStatePayload(data) {
      const source = data && typeof data === 'object' ? data : {}
      const nested = source.state && typeof source.state === 'object' ? source.state : undefined
      let status = source.status && typeof source.status === 'object' ? source.status : undefined
      if (!status && nested && nested.status && typeof nested.status === 'object') status = nested.status
      if (!status && typeof source.running === 'boolean') status = source
      if (!status) status = {}
      const pickString = function (a, b, c) {
        if (typeof a === 'string') return a
        if (typeof b === 'string') return b
        if (typeof c === 'string') return c
        return ''
      }
      const url = pickString(source.url, status.url, nested && nested.url)
      const title = pickString(source.title, status.title, nested && nested.title)
      const loading = typeof source.loading === 'boolean' ? source.loading : status.loading === true
      let cookieCount
      if (typeof source.cookieCount === 'number') cookieCount = source.cookieCount
      else if (typeof status.cookieCount === 'number') cookieCount = status.cookieCount
      else if (nested && typeof nested.cookieCount === 'number') cookieCount = nested.cookieCount
      return { status: status, url: url, title: title, loading: loading, cookieCount: cookieCount }
    }

    // --------------------------------------------------------------------- //
    // SSE live store (one per apply, connected from page load)              //
    // --------------------------------------------------------------------- //

    const DEFAULT_VIEWPORT = { width: 1280, height: 800 }
    const EMPTY_NAVIGATION = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false }
    /** Keys forwarded to the page as raw key events rather than inserted text. */
    const NAMED_KEYS = {
      Enter: true,
      Tab: true,
      Escape: true,
      Backspace: true,
      Delete: true,
      ArrowUp: true,
      ArrowDown: true,
      ArrowLeft: true,
      ArrowRight: true,
      Home: true,
      End: true,
      PageUp: true,
      PageDown: true,
      Insert: true,
      ContextMenu: true,
    }

    function initialLiveState() {
      return {
        connected: false,
        everConnected: false,
        hadError: false,
        status: null,
        viewport: { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height },
        frame: null,
        navigation: { url: '', title: '', loading: false, canGoBack: false, canGoForward: false },
        activity: { active: false },
        cursor: null,
        logs: [],
      }
    }

    const EMPTY_SNAPSHOT = initialLiveState()
    const FALLBACK_LIVE = {
      getSnapshot: function () { return EMPTY_SNAPSHOT },
      subscribe: function () { return function () {} },
      dispose: function () {},
      ensurePanel: function () {},
    }

    function normalizeViewport(value) {
      if (!value || typeof value !== 'object') return null
      const width = Number(value.width)
      const height = Number(value.height)
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
      return { width: Math.round(width), height: Math.round(height) }
    }

    function normalizeActivity(value) {
      if (!value || typeof value !== 'object') return { active: false }
      return {
        active: value.active === true,
        sessionId: typeof value.sessionId === 'string' && value.sessionId !== '' ? value.sessionId : undefined,
        label: typeof value.label === 'string' ? value.label : undefined,
      }
    }

    function normalizeNavigation(value, fallback) {
      const base = fallback || EMPTY_NAVIGATION
      if (!value || typeof value !== 'object') return base
      return {
        url: typeof value.url === 'string' ? value.url : base.url,
        title: typeof value.title === 'string' ? value.title : base.title,
        loading: value.loading === true,
        canGoBack: value.canGoBack === true,
        canGoForward: value.canGoForward === true,
      }
    }

    /** Create the shared SSE store; the caller owns `dispose`. */
    function createLive(ctx) {
      let state = initialLiveState()
      const listeners = new Set()
      let source = null
      let disposed = false
      let retryTimer = null
      let retryDelay = 1500
      let cursorNonce = 0
      let unsubscribeMounted = null
      let lastMounted = undefined
      let lastEnsuredSession = undefined
      let lastEnsuredAt = 0

      function getSnapshot() {
        return state
      }

      function publish(patch) {
        if (disposed) return
        state = Object.assign({}, state, patch)
        const current = Array.from(listeners)
        for (let index = 0; index < current.length; index += 1) {
          try {
            current[index]()
          } catch (error) {
            console.error('[dsh-insider-browser] live subscriber failed:', error)
          }
        }
      }

      function subscribe(listener) {
        if (typeof listener !== 'function') return function () {}
        listeners.add(listener)
        return function () {
          listeners.delete(listener)
        }
      }

      // --- automatic panel opening ------------------------------------- //

      function ensurePanel(sessionId) {
        try {
          const sidebar = ctx && ctx.sidebarRight
          if (!sidebar) return false
          if (typeof sidebar.openTabIn === 'function') {
            sidebar.openTabIn(sessionId, 'browser')
            return true
          }
          const mounted =
            sidebar.mounted && typeof sidebar.mounted.getSnapshot === 'function'
              ? sidebar.mounted.getSnapshot()
              : undefined
          if (mounted === sessionId && typeof sidebar.openTab === 'function') {
            sidebar.openTab('browser')
            return true
          }
          return false
        } catch (error) {
          console.warn('[dsh-insider-browser] auto-open failed:', error)
          return false
        }
      }

      function maybeEnsurePanel(sessionId) {
        if (typeof sessionId !== 'string' || sessionId === '') return
        const now = Date.now()
        if (lastEnsuredSession === sessionId && now - lastEnsuredAt < 2000) return
        lastEnsuredSession = sessionId
        lastEnsuredAt = now
        ensurePanel(sessionId)
      }

      function watchMounted() {
        try {
          const sidebar = ctx && ctx.sidebarRight
          const mounted = sidebar && sidebar.mounted
          if (!mounted || typeof mounted.subscribe !== 'function') return
          try {
            lastMounted = typeof mounted.getSnapshot === 'function' ? mounted.getSnapshot() : undefined
          } catch (error) {
            lastMounted = undefined
          }
          unsubscribeMounted = mounted.subscribe(function () {
            try {
              const current = mounted.getSnapshot()
              if (current === lastMounted) return
              lastMounted = current
              const activity = state.activity
              if (
                activity &&
                activity.active === true &&
                typeof activity.sessionId === 'string' &&
                activity.sessionId === current
              ) {
                // Switching to the operating session is an explicit "show it
                // here" request: bypass the activity throttle.
                ensurePanel(current)
                lastEnsuredSession = current
                lastEnsuredAt = Date.now()
              }
            } catch (error) {
              console.warn('[dsh-insider-browser] mounted subscription failed:', error)
            }
          })
        } catch (error) {
          console.warn('[dsh-insider-browser] cannot watch the mounted session:', error)
        }
      }

      // --- SSE message handling ---------------------------------------- //

      function handleMessage(event) {
        if (!event || typeof event.data !== 'string' || event.data === '') return
        let message
        try {
          message = JSON.parse(event.data)
        } catch (error) {
          return
        }
        if (!message || typeof message !== 'object' || typeof message.type !== 'string') return

        switch (message.type) {
          case 'hello': {
            const activity = normalizeActivity(message.activity)
            const viewport = normalizeViewport(message.viewport)
            const navigation = normalizeNavigation(message.status, state.navigation)
            publish({
              connected: true,
              everConnected: true,
              hadError: false,
              status: message.status && typeof message.status === 'object' ? message.status : null,
              activity: activity,
              viewport: viewport || state.viewport,
              navigation: navigation,
            })
            if (activity.active === true && typeof activity.sessionId === 'string') {
              maybeEnsurePanel(activity.sessionId)
            }
            break
          }
          case 'frame': {
            if (typeof message.data !== 'string' || message.data === '') return
            const viewport = normalizeViewport(message.viewport)
            publish({
              frame: { data: message.data, seq: typeof message.seq === 'number' ? message.seq : 0 },
              viewport: viewport || state.viewport,
            })
            break
          }
          case 'navigation': {
            publish({ navigation: normalizeNavigation(message, state.navigation) })
            break
          }
          case 'activity': {
            const activity = normalizeActivity(message)
            publish({ activity: activity })
            if (activity.active === true && typeof activity.sessionId === 'string') {
              maybeEnsurePanel(activity.sessionId)
            }
            break
          }
          case 'cursor': {
            const x = Number(message.x)
            const y = Number(message.y)
            if (!Number.isFinite(x) || !Number.isFinite(y)) return
            cursorNonce += 1
            publish({
              cursor: {
                x: x,
                y: y,
                action: typeof message.action === 'string' ? message.action : 'move',
                label: typeof message.label === 'string' ? message.label : undefined,
                nonce: cursorNonce,
              },
            })
            break
          }
          case 'log': {
            const entry = {
              level: typeof message.level === 'string' ? message.level : 'info',
              text: typeof message.text === 'string' ? message.text : String(message.text || ''),
              at: Date.now(),
            }
            const logs = state.logs.concat([entry])
            publish({ logs: logs.length > 40 ? logs.slice(logs.length - 40) : logs })
            break
          }
          default:
            break
        }
      }

      function scheduleReconnect() {
        if (disposed || retryTimer) return
        const delay = retryDelay
        retryDelay = Math.min(10_000, Math.max(1000, Math.round(retryDelay * 2)))
        retryTimer = setTimeout(function () {
          retryTimer = null
          connect()
        }, delay)
      }

      function closeSource() {
        if (!source) return
        try {
          source.onopen = null
          source.onerror = null
          source.onmessage = null
          source.close()
        } catch (error) {
          /* closing a dead stream is not interesting */
        }
        source = null
      }

      function connect() {
        if (disposed) return
        if (typeof EventSource === 'undefined') {
          console.warn('[dsh-insider-browser] EventSource is unavailable; live panel will not update')
          publish({ hadError: true })
          return
        }
        closeSource()
        let eventSource
        try {
          eventSource = new EventSource(BASE + '/events')
        } catch (error) {
          console.warn('[dsh-insider-browser] cannot open the event stream:', error)
          publish({ connected: false, hadError: true })
          scheduleReconnect()
          return
        }
        source = eventSource
        eventSource.onopen = function () {
          retryDelay = 1500
          publish({ connected: true, everConnected: true, hadError: false })
        }
        // EventSource reconnects by itself after transport errors, but it does
        // NOT reconnect when the response was not a valid event stream (for
        // example the SPA fallback HTML served while the plugin is reloading).
        // Once the browser closes the source permanently, open a fresh one.
        eventSource.onerror = function () {
          publish({ connected: false, hadError: true })
          if (eventSource.readyState === 2) scheduleReconnect()
        }
        eventSource.onmessage = handleMessage
      }

      function dispose() {
        if (disposed) return
        disposed = true
        if (retryTimer) {
          clearTimeout(retryTimer)
          retryTimer = null
        }
        listeners.clear()
        closeSource()
        try {
          if (typeof unsubscribeMounted === 'function') unsubscribeMounted()
        } catch (error) {
          /* already gone */
        }
        unsubscribeMounted = null
      }

      // The connection is created as soon as the page loads: the panel must be
      // openable from outside, before anyone has seen it.
      watchMounted()
      connect()

      return {
        getSnapshot: getSnapshot,
        subscribe: subscribe,
        dispose: dispose,
        ensurePanel: ensurePanel,
      }
    }

    // --------------------------------------------------------------------- //
    // Icons (inline SVG, currentColor)                                      //
    // --------------------------------------------------------------------- //

    function makeIcon(render, defaultSize) {
      return function Icon(props) {
        const size =
          props && typeof props.size === 'number' && Number.isFinite(props.size) && props.size > 0
            ? props.size
            : defaultSize
        const attributes = {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        }
        if (props && typeof props.className === 'string' && props.className !== '') {
          attributes.className = props.className
        }
        return h('svg', attributes, render())
      }
    }

    function strokePath(d, extra) {
      return h(
        'path',
        Object.assign(
          {
            d: d,
            stroke: 'currentColor',
            strokeWidth: 1.4,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            fill: 'none',
          },
          extra || {},
        ),
      )
    }

    const BrowserIcon = makeIcon(function () {
      return [
        h('circle', { key: 'c', cx: 8, cy: 8, r: 5.9, stroke: 'currentColor', strokeWidth: 1.2, fill: 'none' }),
        strokePath('M2.3 8h11.4', { key: 'h', strokeWidth: 1.2 }),
        strokePath('M8 2.1c1.7 1.7 2.6 3.6 2.6 5.9S9.7 12.2 8 13.9C6.3 12.2 5.4 10.3 5.4 8S6.3 3.8 8 2.1Z', {
          key: 'v',
          strokeWidth: 1.2,
        }),
      ]
    }, 16)

    const BackIcon = makeIcon(function () {
      return strokePath('M10.2 3.4 5.6 8l4.6 4.6', { strokeWidth: 1.5 })
    }, 15)

    const ForwardIcon = makeIcon(function () {
      return strokePath('M5.8 3.4 10.4 8l-4.6 4.6', { strokeWidth: 1.5 })
    }, 15)

    const ReloadIcon = makeIcon(function () {
      return [
        strokePath('M13.1 8a5.1 5.1 0 1 1-1.6-3.7', { key: 'a', strokeWidth: 1.5 }),
        strokePath('M13.2 2.5v3.1H10.1', { key: 'b', strokeWidth: 1.5 }),
      ]
    }, 15)

    const ExternalIcon = makeIcon(function () {
      return [
        strokePath('M9.4 2.9h3.7v3.7', { key: 'a', strokeWidth: 1.4 }),
        strokePath('M13.1 2.9 7.9 8.1', { key: 'b', strokeWidth: 1.4 }),
        strokePath('M11.3 9.7v3.4H2.9V4.7h3.4', { key: 'c', strokeWidth: 1.4 }),
      ]
    }, 14)

    const GoIcon = makeIcon(function () {
      return [
        strokePath('M3.2 8h9.2', { key: 'a', strokeWidth: 1.4 }),
        strokePath('M8.9 4.3 12.6 8l-3.7 3.7', { key: 'b', strokeWidth: 1.4 }),
      ]
    }, 14)

    const CursorIcon = makeIcon(function () {
      return h('path', {
        d: 'M3 1.8v11l3.1-2.9 2.3 4.4 2-1.1-2.3-4.4 4.7-.1L3 1.8Z',
        fill: '#ffffff',
        stroke: 'rgba(0,0,0,.62)',
        strokeWidth: 1,
        strokeLinejoin: 'round',
      })
    }, 16)

    // --------------------------------------------------------------------- //
    // Stylesheet (hover/keyframes cannot be expressed inline)               //
    // --------------------------------------------------------------------- //

    const CSS = `
.dib-root {
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  color: var(--dsw-alias-label-primary, inherit);
  background: var(--dsw-alias-bg-base, #1f1f1f);
  font-size: var(--dsw-font-xxs-12-font-size, 12px);
  line-height: var(--dsw-font-xxs-12-line-height, 18px);
}
.dib-toolbar {
  box-sizing: border-box;
  flex: none;
  height: 38px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 6px;
  border-bottom: .5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.3));
}
.dib-tool {
  box-sizing: border-box;
  flex: none;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  cursor: pointer;
}
.dib-tool:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary, inherit);
  background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.15));
}
.dib-tool:active:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-active, rgba(128,128,128,.22));
}
.dib-tool:disabled {
  color: var(--dsw-alias-label-quaternary, rgba(128,128,128,.55));
  cursor: default;
}
.dib-tool[data-spinning="true"] svg {
  animation: dib-spin .9s linear infinite;
}
@keyframes dib-spin { to { transform: rotate(360deg); } }
.dib-address-form {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 2px;
}
.dib-address {
  box-sizing: border-box;
  flex: 1 1 auto;
  min-width: 0;
  height: 28px;
  padding: 0 9px;
  border: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35));
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.08));
  color: var(--dsw-alias-label-primary, inherit);
  font-size: var(--dsw-font-xxs-12-font-size, 12px);
  line-height: var(--dsw-font-xxs-12-line-height, 18px);
  font-family: inherit;
  outline: none;
}
.dib-address:focus {
  border-color: var(--dsw-alias-border-l3, rgba(128,128,128,.65));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.12));
}
.dib-address::placeholder {
  color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.85));
}
.dib-go { width: 24px; height: 28px; }
.dib-content {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12));
}
.dib-frame {
  position: relative;
  flex: none;
  overflow: hidden;
  border-radius: 2px;
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12));
}
.dib-frame img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  user-select: none;
  -webkit-user-drag: none;
}
.dib-frame {
  touch-action: none;
}
.dib-frame[data-focused="true"] {
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 55%, transparent);
}
/* Invisible focus target: carries keyboard/IME/paste events while the user
   interacts with the mirrored page. Pointer events stay on the frame element. */
.dib-input-layer {
  position: absolute;
  inset: 0;
  z-index: 2;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  resize: none;
  overflow: hidden;
  opacity: 0;
  background: transparent;
  color: transparent;
  caret-color: transparent;
  pointer-events: none;
  font-size: 16px;
  line-height: 16px;
  white-space: pre;
}
.dib-status-hint {
  flex: 0 0 auto;
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.9));
  opacity: .9;
}
.dib-empty {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 24px 18px;
  text-align: center;
  color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.9));
}
.dib-empty-icon {
  width: 44px;
  height: 44px;
  margin-bottom: 2px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.12));
  color: var(--dsw-alias-label-secondary, inherit);
}
.dib-empty-title {
  font-size: 14px;
  line-height: 20px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, inherit);
}
.dib-empty-desc {
  max-width: 240px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary, inherit);
}
.dib-empty-hint {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.9));
}
.dib-toast {
  position: absolute;
  top: 8px;
  left: 50%;
  z-index: 6;
  box-sizing: border-box;
  max-width: calc(100% - 16px);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35));
  border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #2a2a2a) 92%, transparent);
  box-shadow: 0 4px 14px rgba(0, 0, 0, .22);
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transform: translateX(-50%);
  opacity: 0;
  transition: opacity .18s ease;
  pointer-events: none;
}
.dib-toast[data-visible="true"] { opacity: 1; }
.dib-toast-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-state-success-primary, #3fb950);
  animation: dib-pulse 1.4s ease-out infinite;
}
@keyframes dib-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--dsw-alias-state-success-primary, #3fb950) 55%, transparent); }
  70% { box-shadow: 0 0 0 6px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
.dib-cursor {
  position: absolute;
  z-index: 7;
  width: 16px;
  height: 16px;
  margin: -1px 0 0 -1px;
  opacity: 0;
  transition: left .12s linear, top .12s linear, opacity .2s ease;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, .45));
  pointer-events: none;
}
.dib-cursor[data-visible="true"] { opacity: 1; }
.dib-ripple {
  position: absolute;
  z-index: 6;
  width: 30px;
  height: 30px;
  margin: -15px 0 0 -15px;
  border-radius: 50%;
  border: 2px solid var(--dsw-alias-state-success-primary, #3fb950);
  animation: dib-ripple .5s ease-out forwards;
  pointer-events: none;
}
@keyframes dib-ripple {
  from { opacity: .85; transform: scale(.45); }
  to { opacity: 0; transform: scale(1.5); }
}
.dib-status {
  box-sizing: border-box;
  flex: none;
  height: 24px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 9px;
  border-top: .5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.3));
  color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.9));
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
  overflow: hidden;
}
.dib-status-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-label-quaternary, rgba(128,128,128,.6));
}
.dib-status-dot[data-connected="true"] { background: var(--dsw-alias-state-success-primary, #3fb950); }
.dib-status-dot[data-connected="false"] { background: var(--dsw-alias-state-warn-primary, #d29922); }
.dib-status-text { flex: none; }
.dib-status-sep { flex: none; opacity: .5; }
.dib-status-title {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--dsw-alias-label-secondary, inherit);
}
.dib-status-url {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: .85;
}
.dib-error {
  box-sizing: border-box;
  flex: none;
  max-height: 72px;
  overflow-y: auto;
  padding: 4px 9px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-state-error-primary, #e5534b);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5534b) 8%, transparent);
  overflow-wrap: anywhere;
}
/* Settings page */
.dib-set {
  box-sizing: border-box;
  max-width: 760px;
  color: var(--dsw-alias-label-primary, inherit);
  font-size: var(--dsw-font-base-16-font-size, 14px);
}
.dib-set-head {
  padding: 4px 0 12px;
}
.dib-set-h {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 600;
}
.dib-set-lead {
  margin: 6px 0 0;
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 12px;
  line-height: 18px;
}
.dib-set-row {
  box-sizing: border-box;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding: 16px 0;
  border-bottom: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3));
}
.dib-set-row:last-child { border-bottom: 0; }
.dib-set-col { flex: 1 1 auto; min-width: 0; }
.dib-set-title {
  font-size: 14px;
  line-height: 20px;
}
.dib-set-desc {
  margin-top: 4px;
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
.dib-set-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 2px;
}
.dib-btn {
  box-sizing: border-box;
  height: 28px;
  padding: 0 12px;
  border: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35));
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.1));
  color: var(--dsw-alias-label-primary, inherit);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  cursor: pointer;
}
.dib-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.15)); }
.dib-btn:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active, rgba(128,128,128,.22)); }
.dib-btn:disabled { opacity: .55; cursor: default; }
.dib-btn[data-variant="danger"] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5534b) 45%, transparent);
  color: var(--dsw-alias-state-error-primary, #e5534b);
}
.dib-kv {
  display: flex;
  gap: 8px;
  margin-top: 2px;
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
.dib-kv-key {
  flex: none;
  min-width: 84px;
  color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.9));
}
.dib-kv-value { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.dib-run {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.dib-run-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-label-quaternary, rgba(128,128,128,.6));
}
.dib-run-dot[data-running="true"] { background: var(--dsw-alias-state-success-primary, #3fb950); }
.dib-set-ok {
  margin-top: 6px;
  color: var(--dsw-alias-state-success-primary, #3fb950);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
.dib-set-err {
  margin-top: 6px;
  color: var(--dsw-alias-state-error-primary, #e5534b);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
.dib-set-note {
  margin-top: 6px;
  color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.9));
  font-size: 12px;
  line-height: 18px;
}
.dib-set-warns {
  margin: 4px 0 0;
  padding-left: 16px;
  color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.9));
  font-size: 11px;
  line-height: 17px;
  overflow-wrap: anywhere;
}
`

    function installStyles() {
      try {
        if (typeof document === 'undefined' || !document) return
        if (typeof document.getElementById === 'function' && document.getElementById(STYLE_ID) !== null) return
        const tag = document.createElement('style')
        tag.id = STYLE_ID
        tag.textContent = CSS
        const head = document.head || document.documentElement
        if (head && typeof head.appendChild === 'function') head.appendChild(tag)
      } catch (error) {
        console.warn('[dsh-insider-browser] cannot install styles:', error)
      }
    }

    // --------------------------------------------------------------------- //
    // Shared UI bits                                                        //
    // --------------------------------------------------------------------- //

    let currentLive = null

    function resolveLive(props) {
      if (props && props.live && typeof props.live.getSnapshot === 'function') return props.live
      return currentLive || FALLBACK_LIVE
    }

    /** Subscribe to the live store through React 18's uSES, with a state fallback. */
    function useLiveSnapshot(live) {
      if (useSyncExternalStore) {
        return useSyncExternalStore(live.subscribe, live.getSnapshot, live.getSnapshot)
      }
      const [snapshot, setSnapshot] = useState(live.getSnapshot())
      useEffect(
        function () {
          return live.subscribe(function () {
            setSnapshot(live.getSnapshot())
          })
        },
        [live],
      )
      return snapshot
    }

    function percentOf(value, total) {
      const number = Number(value)
      const size = Number(total)
      if (!Number.isFinite(number) || !Number.isFinite(size) || size <= 0) return '0%'
      const ratio = Math.max(0, Math.min(1, number / size))
      return (ratio * 100).toFixed(3) + '%'
    }

    function connectionLabel(snapshot, t) {
      if (snapshot.connected) return t('status.connected')
      if (snapshot.everConnected || snapshot.hadError) return t('status.reconnecting')
      return t('status.connecting')
    }

    function expectHttpUrl(value) {
      if (typeof value !== 'string' || value === '') return ''
      try {
        const parsed = new URL(value)
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return value
      } catch (error) {
        return ''
      }
      return ''
    }

    function toolButton(options) {
      return h(
        'button',
        {
          key: options.key,
          type: 'button',
          className: 'dib-tool',
          title: options.title,
          'aria-label': options.title,
          disabled: options.disabled === true,
          'data-spinning': options.spinning === true ? 'true' : 'false',
          onClick: options.onClick,
        },
        options.children,
      )
    }

    // --------------------------------------------------------------------- //
    // BrowserBody: toolbar + screencast + toast + virtual cursor            //
    // --------------------------------------------------------------------- //

    function BrowserBody(props) {
      const t = getT(props)
      const live = resolveLive(props)
      const snapshot = useLiveSnapshot(live)
      // The right-sidebar tab framework injects `useTabInfo`; a chat link opening
      // this page type arrives as `navigation.params.url` and must be navigated
      // to, otherwise the tab appears but keeps whatever page was already there.
      const useTabInfo = props && typeof props.useTabInfo === 'function' ? props.useTabInfo : null
      const tabInfo = typeof useTabInfo === 'function' ? useTabInfo() : null
      const tabNavigation = tabInfo && tabInfo.tab && tabInfo.tab.navigation ? tabInfo.tab.navigation : null
      const requestedAddress =
        tabNavigation && tabNavigation.params && typeof tabNavigation.params.url === 'string'
          ? tabNavigation.params.url
          : ''
      const requestedRevision = tabNavigation && typeof tabNavigation.revision === 'number' ? tabNavigation.revision : 0
      const navigation = snapshot.navigation || EMPTY_NAVIGATION
      const viewport = snapshot.viewport || DEFAULT_VIEWPORT
      const viewportWidth = Math.max(1, Number(viewport.width) || DEFAULT_VIEWPORT.width)
      const viewportHeight = Math.max(1, Number(viewport.height) || DEFAULT_VIEWPORT.height)

      const [draft, setDraft] = useState(navigation.url || '')
      const [urlError, setUrlError] = useState('')
      const [busy, setBusy] = useState(false)
      const [box, setBox] = useState({ width: 0, height: 0 })
      const [cursorVisible, setCursorVisible] = useState(false)
      const [ripple, setRipple] = useState(null)
      const [interacting, setInteracting] = useState(false)

      const inputRef = useRef(null)
      const areaRef = useRef(null)
      const padRef = useRef(null)
      const captureRef = useRef(null)
      const currentUrlRef = useRef(navigation.url || '')
      const viewportRef = useRef({ width: viewportWidth, height: viewportHeight })
      const pointerRef = useRef({
        down: false,
        button: 'left',
        buttons: 0,
        x: 0,
        y: 0,
        clickCount: 1,
        lastButton: '',
        lastDownAt: 0,
        lastHoverAt: 0,
      })
      const inputQueueRef = useRef({ queue: [], timer: null, inflight: false, warned: false })
      const forwardedKeysRef = useRef({})
      const composingRef = useRef(false)
      const requestedNavigationRef = useRef(-1)
      viewportRef.current = { width: viewportWidth, height: viewportHeight }

      const currentUrl = navigation.url || ''
      currentUrlRef.current = currentUrl
      const activityActive = !!(snapshot.activity && snapshot.activity.active === true)
      const frame = snapshot.frame
      const hasFrame = frame !== null && frame !== undefined
      const cursor = snapshot.cursor

      // Keep the address bar in step with the page the Host reports, without
      // stealing text from a user who is typing in it.
      useEffect(
        function () {
          const input = inputRef.current
          if (input && typeof document !== 'undefined' && document && document.activeElement === input) return
          setDraft(currentUrl)
        },
        [currentUrl],
      )

      // Follow a link opened from the DSH conversation: the tab type receives
      // the target as `navigation.params.url`, once per open (the revision
      // increments for every navigation to this tab). Navigate the real browser
      // to it, and stay quiet when the page already shows that address.
      useEffect(
        function () {
          if (requestedAddress === '') return
          if (requestedNavigationRef.current === requestedRevision) return
          requestedNavigationRef.current = requestedRevision
          const target = expectHttpUrl(requestedAddress)
          if (target === '') {
            setUrlError(t('error.protocol'))
            return
          }
          if (target === currentUrlRef.current) return
          setBusy(true)
          setUrlError('')
          postAction({ action: 'navigate', url: target })
            .then(function () {
              setBusy(false)
              setDraft(target)
            })
            .catch(function (error) {
              setBusy(false)
              setUrlError(errorMessage(error, t))
            })
        },
        [requestedAddress, requestedRevision, t],
      )

      // Fit the screencast box to the pane while preserving the viewport ratio.
      // The virtual cursor is positioned by percentage of that box, so the box
      // has to have exactly the viewport's aspect ratio.
      useEffect(
        function () {
          const area = areaRef.current
          if (!area) return undefined
          const measure = function () {
            let rect
            try {
              rect = area.getBoundingClientRect()
            } catch (error) {
              return
            }
            if (!rect || !(rect.width > 0) || !(rect.height > 0)) return
            const scale = Math.min(rect.width / viewportWidth, rect.height / viewportHeight)
            if (!(scale > 0)) return
            const width = Math.max(1, Math.floor(viewportWidth * scale))
            const height = Math.max(1, Math.floor(viewportHeight * scale))
            setBox(function (previous) {
              if (previous.width === width && previous.height === height) return previous
              return { width: width, height: height }
            })
          }
          measure()
          let observer = null
          if (typeof ResizeObserver === 'function') {
            try {
              observer = new ResizeObserver(measure)
              observer.observe(area)
            } catch (error) {
              observer = null
            }
          }
          if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
            window.addEventListener('resize', measure)
          }
          return function () {
            if (observer) {
              try {
                observer.disconnect()
              } catch (error) {
                /* already disconnected */
              }
            }
            if (typeof window !== 'undefined' && window && typeof window.removeEventListener === 'function') {
              window.removeEventListener('resize', measure)
            }
          }
        },
        [viewportWidth, viewportHeight],
      )

      // Cursor: show on every event, hide 3s after the last one, pulse on click.
      useEffect(
        function () {
          if (!cursor) return undefined
          setCursorVisible(true)
          if (cursor.action === 'click') {
            setRipple({ key: cursor.nonce, x: cursor.x, y: cursor.y })
          }
          const timer = setTimeout(function () {
            setCursorVisible(false)
          }, 3000)
          return function () {
            clearTimeout(timer)
          }
        },
        [cursor],
      )

      useEffect(
        function () {
          if (!ripple) return undefined
          const timer = setTimeout(function () {
            setRipple(null)
          }, 560)
          return function () {
            clearTimeout(timer)
          }
        },
        [ripple],
      )

      useEffect(function () {
        return function () {
          const queue = inputQueueRef.current
          if (queue.timer) {
            clearTimeout(queue.timer)
            queue.timer = null
          }
          queue.queue.length = 0
          forwardedKeysRef.current = {}
        }
      }, [])

      function runAction(action) {
        if (busy) return
        setBusy(true)
        setUrlError('')
        postAction({ action: action })
          .then(function () {
            setBusy(false)
          })
          .catch(function (error) {
            setBusy(false)
            setUrlError(errorMessage(error, t))
          })
      }

      function submitAddress(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        if (busy) return
        const input = String(draft == null ? '' : draft).trim()
        if (input === '') {
          setUrlError(t('error.empty'))
          return
        }
        // No scheme unless it looks like one: `localhost:3000` must become
        // https://localhost:3000 rather than a bogus `localhost:` protocol.
        const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:(?!\d+(?:[/?#]|$))/.test(input) ? input : 'https://' + input
        let parsed
        try {
          parsed = new URL(candidate)
        } catch (error) {
          setUrlError(t('error.invalid'))
          return
        }
        if (parsed.username !== '' || parsed.password !== '') {
          setUrlError(t('error.invalid'))
          return
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          setUrlError(t('error.protocol'))
          return
        }
        setUrlError('')
        setBusy(true)
        postAction({ action: 'navigate', url: parsed.href })
          .then(function () {
            setBusy(false)
            setDraft(parsed.href)
            // Hand the keyboard back to the page: otherwise the next keystrokes
            // keep going into the address field and the page looks unresponsive.
            const input = inputRef.current
            if (input && typeof document !== 'undefined' && document.activeElement === input) focusCapture()
          })
          .catch(function (error) {
            setBusy(false)
            setUrlError(errorMessage(error, t))
          })
      }

      function onAddressKeyDown(event) {
        if (!event) return
        // An IME confirm is Enter for the input method, not for the form.
        const native = event.nativeEvent
        if (native && native.isComposing === true && (event.key === 'Enter' || event.keyCode === 13)) {
          if (typeof event.preventDefault === 'function') event.preventDefault()
        }
      }

      function openExternal() {
        const url = expectHttpUrl(currentUrl || draft)
        if (url === '') return
        try {
          window.open(url, '_blank', 'noopener')
        } catch (error) {
          console.warn('[dsh-insider-browser] cannot open the system browser:', error)
        }
      }

      // ------------------------------------------------------------------- //
      // Human input: forward mouse, wheel, keyboard and IME from the mirrored
      // panel to the real page. Events are batched into one POST /action
      // {action:'input'} so drags and typing stay responsive, and the agent can
      // keep operating at the same time (both paths dispatch raw CDP input).
      // ------------------------------------------------------------------- //

      function pointFromEvent(event) {
        const node = padRef.current
        if (!node || typeof node.getBoundingClientRect !== 'function' || !event) return null
        let rect
        try {
          rect = node.getBoundingClientRect()
        } catch (error) {
          return null
        }
        if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null
        const size = viewportRef.current
        const x = (event.clientX - rect.left) / rect.width * size.width
        const y = (event.clientY - rect.top) / rect.height * size.height
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null
        return {
          x: Math.max(0, Math.min(size.width, Math.round(x))),
          y: Math.max(0, Math.min(size.height, Math.round(y))),
        }
      }

      function buttonMask(button) {
        if (button === 'right') return 2
        if (button === 'middle') return 4
        return 1
      }

      function modifiersOf(event) {
        return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)
      }

      function isImeEvent(event) {
        if (!event) return false
        const native = event.nativeEvent
        const composing = !!(native && native.isComposing === true) || composingRef.current
        return composing || event.keyCode === 229 || event.key === 'Process' || event.key === 'Unidentified'
      }

      function focusCapture() {
        const node = captureRef.current
        if (!node || typeof node.focus !== 'function') return
        try {
          node.focus({ preventScroll: true })
        } catch (error) {
          try {
            node.focus()
          } catch (ignored) {
            /* focus is best-effort */
          }
        }
      }

      function enqueueInput(events) {
        if (!Array.isArray(events) || events.length === 0) return
        const queue = inputQueueRef.current
        for (let index = 0; index < events.length; index += 1) queue.queue.push(events[index])
        if (queue.queue.length > 256) queue.queue.splice(0, queue.queue.length - 256)
        if (queue.timer || queue.inflight) return
        queue.timer = setTimeout(flushInput, 2)
      }

      function flushInput() {
        const queue = inputQueueRef.current
        queue.timer = null
        if (queue.inflight || queue.queue.length === 0) return
        const batch = queue.queue.splice(0, 64)
        queue.inflight = true
        postAction({ action: 'input', events: batch })
          .catch(function (error) {
            if (!queue.warned) {
              queue.warned = true
              console.warn('[dsh-insider-browser] input forwarding failed:', error)
            }
          })
          .then(function () {
            queue.inflight = false
            if (queue.queue.length > 0) queue.timer = setTimeout(flushInput, 1)
          })
      }

      function copyPageSelection(cut) {
        postAction({ action: 'selection' })
          .then(function (data) {
            const text = data && typeof data.text === 'string' ? data.text : ''
            if (text === '') return
            const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null
            if (clipboard && typeof clipboard.writeText === 'function') {
              clipboard.writeText(text).catch(function () {
                /* clipboard permission denied: the page selection stays intact */
              })
            }
            if (cut) {
              enqueueInput([
                { t: 'k', a: 'down', key: 'Delete', code: 'Delete', vk: 46, mods: 0 },
                { t: 'k', a: 'up', key: 'Delete', code: 'Delete', vk: 46, mods: 0 },
              ])
            }
          })
          .catch(function () {
            /* selection unavailable */
          })
      }

      function handlePanelShortcut(event) {
        const key = String(event.key || '')
        const lower = key.toLowerCase()
        const command = event.ctrlKey || event.metaKey
        if (key === 'F5' || (command && lower === 'r')) {
          event.preventDefault()
          event.stopPropagation()
          runAction('reload')
          return true
        }
        if (command && lower === 'l') {
          event.preventDefault()
          event.stopPropagation()
          const input = inputRef.current
          if (input) {
            try {
              input.focus()
            } catch (error) {
              /* ignore */
            }
            try {
              input.select()
            } catch (error) {
              /* ignore */
            }
          }
          return true
        }
        if (event.altKey && key === 'ArrowLeft') {
          event.preventDefault()
          event.stopPropagation()
          runAction('back')
          return true
        }
        if (event.altKey && key === 'ArrowRight') {
          event.preventDefault()
          event.stopPropagation()
          runAction('forward')
          return true
        }
        if (command && (lower === 'c' || lower === 'x')) {
          event.preventDefault()
          event.stopPropagation()
          copyPageSelection(lower === 'x')
          return true
        }
        // Ctrl/Cmd+V must reach the hidden textarea so its paste event fires.
        return false
      }

      function onCaptureKeyDown(event) {
        if (!hasFrame || !event) return
        if (isImeEvent(event)) return
        if (handlePanelShortcut(event)) return
        const key = String(event.key || '')
        const command = event.ctrlKey || event.metaKey || event.altKey
        const printable = key.length === 1 && !command
        const named = NAMED_KEYS[event.key] === true || /^F\d{1,2}$/.test(key)
        if (!printable && !named && !command) return
        const payload = {
          t: 'k',
          a: 'down',
          key: key,
          code: String(event.code || ''),
          vk: Number(event.keyCode) || 0,
          mods: modifiersOf(event),
        }
        if (printable) payload.text = key
        else if (key === 'Enter' && event.ctrlKey !== true && event.metaKey !== true && event.altKey !== true) payload.text = '\r'
        forwardedKeysRef.current[String(event.code || key)] = true
        if (typeof event.preventDefault === 'function') event.preventDefault()
        if (typeof event.stopPropagation === 'function') event.stopPropagation()
        enqueueInput([payload])
      }

      function onCaptureKeyUp(event) {
        if (!hasFrame || !event) return
        if (isImeEvent(event)) return
        const id = String(event.code || event.key || '')
        if (!forwardedKeysRef.current[id]) return
        delete forwardedKeysRef.current[id]
        if (typeof event.preventDefault === 'function') event.preventDefault()
        if (typeof event.stopPropagation === 'function') event.stopPropagation()
        enqueueInput([{
          t: 'k',
          a: 'up',
          key: String(event.key || ''),
          code: String(event.code || ''),
          vk: Number(event.keyCode) || 0,
          mods: modifiersOf(event),
        }])
      }

      function onCaptureInput(event) {
        if (!hasFrame) return
        const native = event && event.nativeEvent ? event.nativeEvent : {}
        if (native.isComposing === true || composingRef.current) return
        const node = captureRef.current
        const value = node ? String(node.value || '') : ''
        if (value === '') return
        node.value = ''
        enqueueInput([{ t: 't', text: value }])
      }

      function onCaptureCompositionStart() {
        composingRef.current = true
      }

      function onCaptureCompositionEnd(event) {
        composingRef.current = false
        const node = captureRef.current
        if (node) node.value = ''
        const text = event && typeof event.data === 'string' ? event.data : ''
        if (text !== '') enqueueInput([{ t: 't', text: text }])
      }

      function onCapturePaste(event) {
        if (!hasFrame) return
        if (typeof event.preventDefault === 'function') event.preventDefault()
        if (typeof event.stopPropagation === 'function') event.stopPropagation()
        const data = (event && event.clipboardData) || (event && event.nativeEvent && event.nativeEvent.clipboardData)
        const text = data && typeof data.getData === 'function' ? data.getData('text') : ''
        if (text) enqueueInput([{ t: 't', text: String(text) }])
      }

      function onCaptureCopy(event) {
        if (!hasFrame) return
        if (typeof event.preventDefault === 'function') event.preventDefault()
        copyPageSelection(false)
      }

      function onCaptureCut(event) {
        if (!hasFrame) return
        if (typeof event.preventDefault === 'function') event.preventDefault()
        copyPageSelection(true)
      }

      function onPadPointerDown(event) {
        if (!hasFrame || !event) return
        if (event.button !== 0 && event.button !== 1 && event.button !== 2) return
        if (typeof event.preventDefault === 'function') event.preventDefault()
        focusCapture()
        const point = pointFromEvent(event)
        if (!point) return
        const pointer = pointerRef.current
        const now = Date.now()
        const button = event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left'
        let clickCount = 1
        if (button === 'left' && pointer.lastButton === 'left' && now - pointer.lastDownAt < 400) {
          clickCount = Math.min(3, (pointer.clickCount || 1) + 1)
        }
        pointer.down = true
        pointer.button = button
        pointer.buttons = pointer.buttons | buttonMask(button)
        pointer.x = point.x
        pointer.y = point.y
        pointer.clickCount = clickCount
        pointer.lastButton = button
        pointer.lastDownAt = now
        try {
          if (typeof event.currentTarget.setPointerCapture === 'function') {
            event.currentTarget.setPointerCapture(event.pointerId)
          }
        } catch (error) {
          /* pointer capture is best-effort */
        }
        enqueueInput([
          { t: 'm', a: 'move', x: point.x, y: point.y },
          { t: 'm', a: 'down', x: point.x, y: point.y, button: button, clickCount: clickCount },
        ])
      }

      function onPadPointerMove(event) {
        if (!hasFrame || !event) return
        const point = pointFromEvent(event)
        if (!point) return
        const pointer = pointerRef.current
        const now = Date.now()
        if (!pointer.down) {
          if (now - pointer.lastHoverAt < 16) return
          pointer.lastHoverAt = now
          enqueueInput([{ t: 'm', a: 'move', x: point.x, y: point.y }])
          return
        }
        if (point.x === pointer.x && point.y === pointer.y) return
        pointer.x = point.x
        pointer.y = point.y
        enqueueInput([{ t: 'm', a: 'move', x: point.x, y: point.y, button: pointer.button }])
      }

      function releasePointer(event) {
        const pointer = pointerRef.current
        if (!pointer.down) return
        const point = pointFromEvent(event) || { x: pointer.x, y: pointer.y }
        const button = pointer.button
        const clickCount = pointer.clickCount || 1
        pointer.down = false
        pointer.buttons = pointer.buttons & ~buttonMask(button)
        try {
          if (event && typeof event.currentTarget.releasePointerCapture === 'function' && event.pointerId !== undefined) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
        } catch (error) {
          /* already released */
        }
        enqueueInput([{ t: 'm', a: 'up', x: point.x, y: point.y, button: button, clickCount: clickCount }])
      }

      function onPadPointerUp(event) {
        if (!hasFrame || !event) return
        if (typeof event.preventDefault === 'function') event.preventDefault()
        releasePointer(event)
      }

      function onPadPointerCancel(event) {
        if (!hasFrame || !event) return
        releasePointer(event)
      }

      function onPadContextMenu(event) {
        if (!hasFrame || !event) return
        if (typeof event.preventDefault === 'function') event.preventDefault()
      }

      useEffect(function () {
        const node = padRef.current
        if (!node || !hasFrame || typeof node.addEventListener !== 'function') return undefined
        function onNativeWheel(event) {
          if (typeof event.preventDefault === 'function') event.preventDefault()
          const point = pointFromEvent(event)
          if (!point) return
          enqueueInput([{
            t: 'm',
            a: 'wheel',
            x: point.x,
            y: point.y,
            dx: Number(event.deltaX) || 0,
            dy: Number(event.deltaY) || 0,
          }])
        }
        node.addEventListener('wheel', onNativeWheel, { passive: false })
        return function () {
          node.removeEventListener('wheel', onNativeWheel)
        }
      }, [hasFrame])

      const urlForFrame = currentUrl !== '' ? currentUrl : draft
      const externalEnabled = expectHttpUrl(urlForFrame) !== ''
      const connected = snapshot.connected === true

      const toolbar = h('div', { key: 'toolbar', className: 'dib-toolbar' }, [
        toolButton({
          key: 'back',
          title: t('back'),
          disabled: busy || navigation.canGoBack !== true,
          onClick: function () { runAction('back') },
          children: h(BackIcon, { size: 15 }),
        }),
        toolButton({
          key: 'forward',
          title: t('forward'),
          disabled: busy || navigation.canGoForward !== true,
          onClick: function () { runAction('forward') },
          children: h(ForwardIcon, { size: 15 }),
        }),
        toolButton({
          key: 'reload',
          title: t('reload'),
          disabled: busy || navigation.loading === true || (navigation.url === '' && !frame),
          spinning: navigation.loading === true,
          onClick: function () { runAction('reload') },
          children: h(ReloadIcon, { size: 15 }),
        }),
        h('form', { key: 'address', className: 'dib-address-form', onSubmit: submitAddress }, [
          h('input', {
            key: 'input',
            ref: inputRef,
            className: 'dib-address',
            type: 'text',
            inputMode: 'url',
            spellCheck: false,
            autoComplete: 'off',
            value: draft,
            placeholder: t('address.placeholder'),
            'aria-label': t('address.placeholder'),
            onChange: function (event) {
              setDraft(event.target.value)
              if (urlError !== '') setUrlError('')
            },
            onKeyDown: onAddressKeyDown,
            onFocus: function (event) {
              try {
                event.target.select()
              } catch (error) {
                /* selection is cosmetic */
              }
            },
            onBlur: function () {
              const input = inputRef.current
              const value = input && typeof input.value === 'string' ? input.value : draft
              if (String(value || '').trim() === '') setDraft(currentUrlRef.current)
            },
          }),
          h(
            'button',
            {
              key: 'go',
              type: 'submit',
              className: 'dib-tool dib-go',
              title: t('go'),
              'aria-label': t('go'),
              disabled: busy,
            },
            h(GoIcon, { size: 14 }),
          ),
        ]),
        toolButton({
          key: 'external',
          title: t('external'),
          disabled: !externalEnabled,
          onClick: openExternal,
          children: h(ExternalIcon, { size: 14 }),
        }),
      ])

      const innerStyle = {
        position: 'relative',
        flex: '0 0 auto',
        overflow: 'hidden',
        borderRadius: 2,
        background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12))',
        aspectRatio: String(viewportWidth) + ' / ' + String(viewportHeight),
      }
      if (box.width > 0) {
        innerStyle.width = box.width + 'px'
        innerStyle.height = box.height + 'px'
      } else {
        innerStyle.width = '100%'
      }

      const frameNode = frame
        ? h('div', {
            key: 'frame',
            className: 'dib-frame',
            style: innerStyle,
            ref: padRef,
            'data-focused': interacting ? 'true' : 'false',
            onPointerDown: onPadPointerDown,
            onPointerMove: onPadPointerMove,
            onPointerUp: onPadPointerUp,
            onPointerCancel: onPadPointerCancel,
            onLostPointerCapture: onPadPointerCancel,
            onContextMenu: onPadContextMenu,
          }, [
            h('img', {
              key: 'img',
              src: 'data:image/jpeg;base64,' + frame.data,
              alt: t('title'),
              draggable: false,
              style: { width: '100%', height: '100%', display: 'block', objectFit: 'contain', userSelect: 'none' },
              onDragStart: function (event) {
                if (event && typeof event.preventDefault === 'function') event.preventDefault()
              },
            }),
            h('textarea', {
              key: 'capture',
              ref: captureRef,
              className: 'dib-input-layer',
              tabIndex: 0,
              'aria-label': t('human.hint'),
              autoComplete: 'off',
              autoCorrect: 'off',
              autoCapitalize: 'off',
              spellCheck: false,
              onFocus: function () { setInteracting(true) },
              onBlur: function () {
                setInteracting(false)
                forwardedKeysRef.current = {}
                composingRef.current = false
              },
              onKeyDown: onCaptureKeyDown,
              onKeyUp: onCaptureKeyUp,
              onInput: onCaptureInput,
              onCompositionStart: onCaptureCompositionStart,
              onCompositionEnd: onCaptureCompositionEnd,
              onPaste: onCapturePaste,
              onCopy: onCaptureCopy,
              onCut: onCaptureCut,
            }),
            cursor
              ? h(
                  'div',
                  {
                    key: 'cursor',
                    className: 'dib-cursor',
                    'data-visible': cursorVisible ? 'true' : 'false',
                    style: {
                      left: percentOf(cursor.x, viewportWidth),
                      top: percentOf(cursor.y, viewportHeight),
                    },
                  },
                  h(CursorIcon, { size: 16 }),
                )
              : null,
            ripple
              ? h('div', {
                  key: 'ripple-' + String(ripple.key),
                  className: 'dib-ripple',
                  style: {
                    left: percentOf(ripple.x, viewportWidth),
                    top: percentOf(ripple.y, viewportHeight),
                  },
                })
              : null,
          ])
        : h('div', { key: 'empty', className: 'dib-empty' }, [
            h('div', { key: 'icon', className: 'dib-empty-icon' }, h(BrowserIcon, { size: 22 })),
            h('div', { key: 'title', className: 'dib-empty-title' }, t('title')),
            h('div', { key: 'desc', className: 'dib-empty-desc' }, t('empty.desc')),
            h('div', { key: 'hint', className: 'dib-empty-hint' }, t('empty.hint')),
          ])

      const toast = h(
        'div',
        {
          key: 'toast',
          className: 'dib-toast',
          'data-visible': activityActive ? 'true' : 'false',
          role: 'status',
          'aria-live': 'polite',
        },
        [h('span', { key: 'dot', className: 'dib-toast-dot' }), h('span', { key: 'text' }, t('toast'))],
      )

      const statusParts = [
        h('span', { key: 'dot', className: 'dib-status-dot', 'data-connected': connected ? 'true' : 'false' }),
        h('span', { key: 'conn', className: 'dib-status-text' }, connectionLabel(snapshot, t)),
      ]
      if (frame) {
        statusParts.push(
          h(
            'span',
            {
              key: 'human-hint',
              className: 'dib-status-hint',
              title: t(interacting ? 'human.active' : 'human.hint'),
            },
            t(interacting ? 'human.active' : 'human.hint'),
          ),
        )
      }
      if (navigation.loading) {
        statusParts.push(h('span', { key: 'load', className: 'dib-status-text' }, t('status.loading')))
      }
      if (navigation.title) {
        statusParts.push(h('span', { key: 'sep1', className: 'dib-status-sep' }, '·'))
        statusParts.push(
          h('span', { key: 'title', className: 'dib-status-title', title: navigation.title }, navigation.title),
        )
      }
      if (urlForFrame) {
        statusParts.push(h('span', { key: 'sep2', className: 'dib-status-sep' }, '·'))
        statusParts.push(h('span', { key: 'url', className: 'dib-status-url', title: urlForFrame }, urlForFrame))
      }

      const errorText = urlError

      return h('div', { className: 'dib-root' }, [
        toolbar,
        h('div', { key: 'content', className: 'dib-content', ref: areaRef }, [frameNode, toast]),
        h('div', { key: 'status', className: 'dib-status' }, statusParts),
        errorText !== ''
          ? h('div', { key: 'error', className: 'dib-error', role: 'alert' }, errorText)
          : null,
      ])
    }

    /** Chip title: constant localized name for this tab type. */
    function BrowserTitle(props) {
      const t = getT(props)
      return h(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            minWidth: 0,
            overflow: 'hidden',
          },
        },
        [
          h(BrowserIcon, { key: 'icon', size: 14 }),
          h(
            'span',
            {
              key: 'label',
              style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            },
            t('title'),
          ),
        ],
      )
    }

    // --------------------------------------------------------------------- //
    // SettingsPage: status + clear cookies + import from other browsers     //
    // --------------------------------------------------------------------- //

    const IMPORT_BROWSERS = ['chrome', 'edge', 'firefox']

    function SettingsPage(props) {
      const t = getT(props)
      const [engine, setEngine] = useState(null)
      const [loading, setLoading] = useState(true)
      const [loadError, setLoadError] = useState('')
      const [reloadToken, setReloadToken] = useState(0)
      const [confirmClear, setConfirmClear] = useState(false)
      const [clearBusy, setClearBusy] = useState(false)
      const [clearMessage, setClearMessage] = useState('')
      const [clearError, setClearError] = useState('')
      const [imports, setImports] = useState({})

      useEffect(
        function () {
          let cancelled = false
          setLoading(true)
          setLoadError('')
          getState()
            .then(function (data) {
              if (cancelled) return
              setEngine(normalizeStatePayload(data))
              setLoading(false)
            })
            .catch(function (error) {
              if (cancelled) return
              setLoadError(errorMessage(error, t))
              setLoading(false)
            })
          return function () {
            cancelled = true
          }
        },
        [reloadToken],
      )

      useEffect(
        function () {
          if (!confirmClear) return undefined
          const timer = setTimeout(function () {
            setConfirmClear(false)
          }, 5000)
          return function () {
            clearTimeout(timer)
          }
        },
        [confirmClear],
      )

      function clearCookies() {
        if (clearBusy) return
        if (!confirmClear) {
          setConfirmClear(true)
          setClearMessage('')
          setClearError('')
          return
        }
        setConfirmClear(false)
        setClearBusy(true)
        setClearMessage('')
        setClearError('')
        postAction({ action: 'clearCookies' })
          .then(function () {
            setClearBusy(false)
            setClearMessage(t('settings.clear.ok'))
            setEngine(function (previous) {
              if (!previous) return previous
              return Object.assign({}, previous, { cookieCount: 0 })
            })
            setReloadToken(function (token) {
              return token + 1
            })
          })
          .catch(function (error) {
            setClearBusy(false)
            setClearError(errorMessage(error, t))
          })
      }

      function importCookies(browser) {
        const existing = imports[browser]
        if (existing && existing.status === 'busy') return
        setImports(function (previous) {
          const next = Object.assign({}, previous)
          next[browser] = { status: 'busy' }
          return next
        })
        postAction({ action: 'importCookies', browser: browser })
          .then(function (data) {
            setImports(function (previous) {
              const next = Object.assign({}, previous)
              next[browser] = {
                status: 'done',
                imported: typeof data.imported === 'number' ? data.imported : 0,
                failed: typeof data.failed === 'number' ? data.failed : 0,
                warnings: Array.isArray(data.warnings) ? data.warnings.map(String).slice(0, 12) : [],
                profile: typeof data.profile === 'string' ? data.profile : '',
              }
              return next
            })
            setReloadToken(function (token) {
              return token + 1
            })
          })
          .catch(function (error) {
            setImports(function (previous) {
              const next = Object.assign({}, previous)
              next[browser] = { status: 'error', error: errorMessage(error, t) }
              return next
            })
          })
      }

      const status = engine && engine.status ? engine.status : null
      const running = !!(status && status.running === true)
      const viewport = status && status.viewport ? status.viewport : null
      const anyImportBusy = IMPORT_BROWSERS.some(function (browser) {
        const item = imports[browser]
        return !!(item && item.status === 'busy')
      })

      const statusRows = []
      statusRows.push(
        h('div', { key: 'run', className: 'dib-kv' }, [
          h('span', { key: 'k', className: 'dib-kv-key' }, t('settings.status.title')),
          h(
            'span',
            { key: 'v', className: 'dib-kv-value' },
            h('span', { className: 'dib-run' }, [
              h('span', {
                key: 'dot',
                className: 'dib-run-dot',
                'data-running': running ? 'true' : 'false',
              }),
              h('span', { key: 'text' }, t(running ? 'settings.status.running' : 'settings.status.stopped')),
            ]),
          ),
        ]),
      )
      if (status) {
        statusRows.push(
          h('div', { key: 'channel', className: 'dib-kv' }, [
            h('span', { key: 'k', className: 'dib-kv-key' }, t('settings.status.channel')),
            h('span', { key: 'v', className: 'dib-kv-value' }, String(status.channel || '-')),
          ]),
        )
        statusRows.push(
          h('div', { key: 'viewport', className: 'dib-kv' }, [
            h('span', { key: 'k', className: 'dib-kv-key' }, t('settings.status.viewport')),
            h(
              'span',
              { key: 'v', className: 'dib-kv-value' },
              viewport && viewport.width && viewport.height
                ? String(viewport.width) + ' × ' + String(viewport.height)
                : '-',
            ),
          ]),
        )
        statusRows.push(
          h('div', { key: 'profile', className: 'dib-kv' }, [
            h('span', { key: 'k', className: 'dib-kv-key' }, t('settings.status.profile')),
            h('span', { key: 'v', className: 'dib-kv-value' }, String(status.profileDir || '-')),
          ]),
        )
      }
      if (engine) {
        statusRows.push(
          h('div', { key: 'cookies', className: 'dib-kv' }, [
            h('span', { key: 'k', className: 'dib-kv-key' }, t('settings.status.cookies')),
            h(
              'span',
              { key: 'v', className: 'dib-kv-value' },
              typeof engine.cookieCount === 'number' ? String(engine.cookieCount) : '-',
            ),
          ]),
        )
        statusRows.push(
          h('div', { key: 'page', className: 'dib-kv' }, [
            h('span', { key: 'k', className: 'dib-kv-key' }, t('settings.status.page')),
            h(
              'span',
              { key: 'v', className: 'dib-kv-value' },
              engine.url ? engine.url + (engine.title ? ' — ' + engine.title : '') : '-',
            ),
          ]),
        )
      }

      const statusRow = h('div', { key: 'status', className: 'dib-set-row' }, [
        h('div', { key: 'col', className: 'dib-set-col' }, [
          h('div', { key: 'title', className: 'dib-set-title' }, t('settings.status.title')),
          loading
            ? h('div', { key: 'loading', className: 'dib-set-desc' }, t('settings.status.loading'))
            : loadError !== ''
              ? h('div', { key: 'error', className: 'dib-set-err' }, t('settings.status.loadFailed') + ' ' + loadError)
              : statusRows,
        ]),
        h(
          'div',
          { key: 'actions', className: 'dib-set-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dib-btn',
              disabled: loading,
              onClick: function () {
                setReloadToken(function (token) {
                  return token + 1
                })
              },
            },
            t('common.refresh'),
          ),
        ),
      ])

      const clearRow = h('div', { key: 'clear', className: 'dib-set-row' }, [
        h('div', { key: 'col', className: 'dib-set-col' }, [
          h('div', { key: 'title', className: 'dib-set-title' }, t('settings.cookies.title')),
          h('div', { key: 'desc', className: 'dib-set-desc' }, t('settings.cookies.desc')),
          clearBusy ? h('div', { key: 'busy', className: 'dib-set-note' }, t('settings.clear.busy')) : null,
          clearMessage !== '' ? h('div', { key: 'ok', className: 'dib-set-ok' }, clearMessage) : null,
          clearError !== ''
            ? h('div', { key: 'err', className: 'dib-set-err' }, t('settings.clear.failed') + ' ' + clearError)
            : null,
        ]),
        h('div', { key: 'actions', className: 'dib-set-actions' }, [
          confirmClear
            ? h(
                'button',
                {
                  key: 'cancel',
                  type: 'button',
                  className: 'dib-btn',
                  onClick: function () {
                    setConfirmClear(false)
                  },
                },
                t('common.cancel'),
              )
            : null,
          h(
            'button',
            {
              key: 'clear',
              type: 'button',
              className: 'dib-btn',
              'data-variant': confirmClear ? 'danger' : 'normal',
              disabled: clearBusy,
              onClick: clearCookies,
            },
            confirmClear ? t('settings.clear.confirm') : t('settings.clear'),
          ),
        ]),
      ])

      const importHeaderRow = h('div', { key: 'import-header', className: 'dib-set-row' }, [
        h('div', { key: 'col', className: 'dib-set-col' }, [
          h('div', { key: 'title', className: 'dib-set-title' }, t('settings.import.title')),
          h('div', { key: 'desc', className: 'dib-set-desc' }, t('settings.import.desc')),
        ]),
      ])

      const importRows = IMPORT_BROWSERS.map(function (browser) {
        const item = imports[browser] || null
        const busy = !!(item && item.status === 'busy')
        const children = [
          h('div', { key: 'title', className: 'dib-set-title' }, t('settings.import.' + browser)),
          h('div', { key: 'desc', className: 'dib-set-desc' }, t('settings.import.' + browser + '.desc')),
        ]
        if (busy) children.push(h('div', { key: 'busy', className: 'dib-set-note' }, t('settings.import.busy')))
        if (item && item.status === 'done') {
          children.push(
            h(
              'div',
              { key: 'ok', className: 'dib-set-ok' },
              t('settings.import.done', { imported: item.imported, failed: item.failed }),
            ),
          )
          if (item.profile) {
            children.push(
              h(
                'div',
                { key: 'profile', className: 'dib-set-note' },
                t('settings.import.profile') + ': ' + item.profile,
              ),
            )
          }
          if (item.warnings && item.warnings.length > 0) {
            children.push(h('div', { key: 'warn-title', className: 'dib-set-note' }, t('settings.import.warnings')))
            children.push(
              h(
                'ul',
                { key: 'warns', className: 'dib-set-warns' },
                item.warnings.map(function (warning, index) {
                  return h('li', { key: 'w' + String(index) }, warning)
                }),
              ),
            )
          }
        }
        if (item && item.status === 'error') {
          children.push(
            h(
              'div',
              { key: 'err', className: 'dib-set-err' },
              t('settings.import.failed') + ' ' + String(item.error || ''),
            ),
          )
        }
        return h('div', { key: 'import-' + browser, className: 'dib-set-row' }, [
          h('div', { key: 'col', className: 'dib-set-col' }, children),
          h(
            'div',
            { key: 'actions', className: 'dib-set-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dib-btn',
                disabled: busy || anyImportBusy,
                onClick: function () {
                  importCookies(browser)
                },
              },
              busy ? t('settings.import.busy') : t('settings.import.button'),
            ),
          ),
        ])
      })

      return h('div', { className: 'dib-set' }, [
        h('div', { key: 'head', className: 'dib-set-head' }, [
          h('h2', { key: 'title', className: 'dib-set-h' }, t('settings.title')),
          h('p', { key: 'lead', className: 'dib-set-lead' }, t('settings.description')),
        ]),
        statusRow,
        clearRow,
        importHeaderRow,
      ].concat(importRows))
    }

    // --------------------------------------------------------------------- //
    // Register: one live connection, one tab type, body/title, settings     //
    // --------------------------------------------------------------------- //

    function apply(ctx) {
      if (!ctx || typeof ctx !== 'object') {
        console.warn('[dsh-insider-browser] apply() called without a context')
        return
      }

      try {
        installStyles()
      } catch (error) {
        console.warn('[dsh-insider-browser] style installation failed:', error)
      }

      // 1) Dictionaries + bound translate.
      try {
        if (ctx.locale && typeof ctx.locale.register === 'function') {
          ctx.effect(function () {
            return ctx.locale.register(NS, { zh: zh, en: en })
          }, 'insider-browser: locale')
        }
      } catch (error) {
        console.warn('[dsh-insider-browser] locale registration failed:', error)
      }
      if (ctx.locale && typeof ctx.locale.bind === 'function') {
        try {
          translate = ctx.locale.bind(NS)
        } catch (error) {
          console.warn('[dsh-insider-browser] locale binding failed:', error)
        }
      }

      // 2) The shared SSE store: one per apply, connected immediately, cleaned
      //    up through ctx.effect when the plugin unloads. A re-apply replaces
      //    the previous connection instead of stacking a second stream.
      let live = FALLBACK_LIVE
      try {
        if (currentLive && currentLive !== FALLBACK_LIVE && typeof currentLive.dispose === 'function') {
          try {
            currentLive.dispose()
          } catch (error) {
            console.warn('[dsh-insider-browser] previous live dispose failed:', error)
          }
          currentLive = null
        }
        live = createLive(ctx)
        currentLive = live
        ctx.effect(function () {
          return function () {
            if (currentLive === live) currentLive = null
            try {
              live.dispose()
            } catch (error) {
              console.warn('[dsh-insider-browser] live dispose failed:', error)
            }
          }
        }, 'insider-browser: live connection')
      } catch (error) {
        console.warn('[dsh-insider-browser] live connection failed:', error)
        live = FALLBACK_LIVE
        currentLive = FALLBACK_LIVE
      }

      // 3) Right-sidebar tab type (extension band overrides the builtin
      //    `browser` kind; the guide card is what the "start" page shows).
      try {
        if (ctx.sidebarRightTabs && typeof ctx.sidebarRightTabs.register === 'function') {
          ctx.effect(function () {
            return ctx.sidebarRightTabs.register({
              id: TAB_ID,
              kind: 'browser',
              priority: 'extension',
              multiple: false,
              title: function () {
                return tr('title')
              },
              guide: [
                {
                  id: 'open',
                  order: 30,
                  title: function () {
                    return tr('guideTitle')
                  },
                  description: function () {
                    return tr('guideDescription')
                  },
                  icon: BrowserIcon,
                },
              ],
            })
          }, 'insider-browser: tab type')
        }
      } catch (error) {
        console.warn('[dsh-insider-browser] tab type registration failed:', error)
      }

      // 4) The tab body, keyed by this implementation id.
      try {
        if (ctx.slots && typeof ctx.slots.inject === 'function') {
          ctx.effect(function () {
            return ctx.slots.inject('sidebar.right.pane.tab', function () {
              return ctx.slots.register(
                {
                  name: 'sidebar.right.pane.tab',
                  key: TAB_ID,
                  locale: NS,
                  inject: function () {
                    return { live: currentLive || live, t: translate }
                  },
                },
                BrowserBody,
              )
            })
          }, 'insider-browser: body')
        }
      } catch (error) {
        console.warn('[dsh-insider-browser] body registration failed:', error)
      }

      // 5) The chip title (optional: without it the registry's title is used).
      try {
        if (ctx.slots && typeof ctx.slots.inject === 'function') {
          ctx.effect(function () {
            return ctx.slots.inject('sidebar.right.pane.tab.title', function () {
              return ctx.slots.register(
                {
                  name: 'sidebar.right.pane.tab.title',
                  key: TAB_ID,
                  locale: NS,
                  inject: function () {
                    return { t: translate }
                  },
                },
                BrowserTitle,
              )
            })
          }, 'insider-browser: title')
        }
      } catch (error) {
        console.warn('[dsh-insider-browser] title registration failed:', error)
      }

      // 6) The settings page section.
      try {
        if (ctx.slots && typeof ctx.slots.inject === 'function') {
          ctx.effect(function () {
            return ctx.slots.inject('settings.section', function () {
              return ctx.slots.register(
                {
                  name: 'settings.section',
                  id: TAB_ID,
                  order: 60,
                  label: function () {
                    return tr('settings.nav')
                  },
                  locale: NS,
                  inject: function () {
                    return { t: translate }
                  },
                },
                SettingsPage,
              )
            })
          }, 'insider-browser: settings section')
        }
      } catch (error) {
        console.warn('[dsh-insider-browser] settings section registration failed:', error)
      }
    }

    exports.name = NAME
    exports.inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']
    exports.apply = apply
    return module.exports
  },
})
