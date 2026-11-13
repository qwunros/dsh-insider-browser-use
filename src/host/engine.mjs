/**
 * dsh-insider-browser — Host CDP engine.
 *
 * A dependency-free controller for one real headless Chrome/Edge instance,
 * driven over the Chrome DevTools Protocol on Node's global `WebSocket`.
 *
 * Everything here uses `node:` builtins only. The public surface is the
 * `BrowserEngine` contract described in docs/ARCHITECTURE.md: lifecycle,
 * navigation, DOM interaction, screencast frames, cookies, activity reference
 * counting, and events consumed by the Host SSE route.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_VIEWPORT = { width: 1280, height: 800 }
const NAVIGATION_TIMEOUT_MS = 15_000
const STARTUP_TIMEOUT_MS = 15_000
const CDP_DEFAULT_TIMEOUT_MS = 30_000
/** ~30 fps: screencast frames arriving faster than this are acked but not emitted. */
const SCREENCAST_MIN_INTERVAL_MS = 32
/**
 * Live frames are downscaled before JPEG encoding: the sidebar is a few hundred
 * CSS pixels wide, so 1280px was mostly wasted bytes and decode time on every
 * frame. Screenshots and page reads still use the full viewport.
 */
const SCREENCAST_MAX_WIDTH = 960
const SCREENCAST_QUALITY = 50
const PROFILE_LOCK_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket']

/**
 * Elements the DOM snapshot exposes to the model. Kept as one selector so the
 * snapshot script and the click/text resolver cannot drift apart.
 */
const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[onclick]',
].join(',')

const KEY_ALIASES = Object.freeze({
  return: 'Enter',
  enter: 'Enter',
  tab: 'Tab',
  esc: 'Escape',
  escape: 'Escape',
  backspace: 'Backspace',
  del: 'Delete',
  delete: 'Delete',
  space: 'Space',
  spacebar: 'Space',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
})

/** key -> { key, code, vk, text? } for the keys agents actually press. */
const KEY_SPECS = Object.freeze({
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
})

const DEFAULT_SNAPSHOT_TEXT_LIMIT = 12_000
const DEFAULT_MAX_ELEMENTS = 120
const DEFAULT_CONTENT_MAX_CHARS = 20_000
const DEFAULT_SOURCE_MAX_CHARS = 200_000
const MAX_CHARS = 2_000_000
const MAX_FULL_PAGE_HEIGHT = 12_000
const MAX_FULL_PAGE_WIDTH = 4_000

/** Human input bridge (mirrored panel -> CDP Input domain), see dispatchInput. */
const MAX_INPUT_EVENTS = 128
const INPUT_EVENT_TIMEOUT_MS = 10_000
const MAX_INPUT_TEXT_CHARS = 4_000
const MAX_KEY_FIELD_CHARS = 64
const MAX_SELECTION_CHARS = 100_000
const MAX_WHEEL_DELTA = 10_000

/** CDP `buttons` bit mask for the mouse buttons a human can hold down. */
const HUMAN_BUTTON_BITS = Object.freeze({ left: 1, right: 2, middle: 4 })

/**
 * How often the page's visibility/focus is re-checked. Chrome only paints
 * frames for a visible page and delays input dispatch by ~5s for a hidden one,
 * so a backgrounded tab must be reactivated promptly.
 */
const PAGE_VISIBILITY_INTERVAL_MS = 2000

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Resolve after `ms` milliseconds. */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Coerce a possibly-string/number value into a clamped integer. */
function clampInt(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** Coerce a possibly-string/number value into a clamped finite number. */
function clampNumber(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/** Readable message from any thrown value. */
function errorMessage(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * Truncate any value to at most `max` characters.
 * Missing values become the empty string so callers can test for emptiness.
 */
function clampText(value, max) {
  return String(value == null ? '' : value).slice(0, max)
}

/**
 * Clamp one viewport coordinate from a human input event.
 * Accepts finite numbers and non-empty numeric strings; everything else yields
 * `fallback` so the caller can reject the event.
 * @param {unknown} value
 * @param {number} max viewport width or height
 * @param {number} fallback value returned for unusable input
 */
function inputCoordinate(value, max, fallback) {
  let number = NaN
  if (typeof value === 'number') number = value
  else if (typeof value === 'string' && value.trim() !== '') number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(0, Math.round(number)))
}

/** Normalize a CDP mouse button name, or return null for anything else. */
function humanButtonName(value) {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return Object.hasOwn(HUMAN_BUTTON_BITS, name) ? name : null
}

/**
 * Validate and normalize a user-supplied URL.
 * Only `http:`, `https:` and `about:blank` are accepted.
 */
export function normalizeBrowserUrl(input) {
  if (typeof input !== 'string') throw new TypeError('url must be a string')
  const raw = input.trim()
  if (!raw) throw new Error('url must not be empty')
  if (/^about:blank(?:\?.*)?$/i.test(raw)) return 'about:blank'
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) ? raw : `https://${raw}`
  let parsed
  try {
    parsed = new URL(withScheme)
  } catch {
    throw new Error(`invalid URL: ${JSON.stringify(input)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`refusing to open a ${parsed.protocol} URL: only http:// and https:// pages are supported (about:blank is also allowed)`)
  }
  return parsed.toString()
}

/** Build key dispatch parameters for one (possibly modified) key press. */
function parseKeySpec(input) {
  const raw = String(input || '').trim()
  if (!raw) throw new Error('key must be a non-empty string')
  const parts = raw.split('+').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) throw new Error('key must be a non-empty string')
  const keyPart = parts.pop()
  let modifiers = 0
  for (const part of parts) {
    const lowered = part.toLowerCase()
    if (lowered === 'ctrl' || lowered === 'control') modifiers |= 2
    else if (lowered === 'alt') modifiers |= 1
    else if (lowered === 'shift') modifiers |= 8
    else if (lowered === 'meta' || lowered === 'cmd' || lowered === 'command' || lowered === 'win' || lowered === 'super') modifiers |= 4
    else throw new Error(`unknown key modifier: ${part}`)
  }
  const alias = KEY_ALIASES[keyPart.toLowerCase()] || keyPart
  const known = KEY_SPECS[alias]
  if (known) return { ...known, modifiers }
  if (keyPart.length === 1) {
    const upper = keyPart.toUpperCase()
    const isLetter = /^[A-Za-z]$/.test(keyPart)
    const isDigit = /^[0-9]$/.test(keyPart)
    return {
      key: keyPart,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${keyPart}` : '',
      vk: upper.charCodeAt(0),
      text: keyPart,
      modifiers,
    }
  }
  throw new Error(`unsupported key: ${JSON.stringify(keyPart)}; use Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, or a single character, optionally with Ctrl/Alt/Shift/Meta`)
}

function escapeForScriptAttribute(value) {
  return String(value).replace(/["\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// Page-side scripts
// ---------------------------------------------------------------------------

/** Extract a visible text label from an element. */
const PAGE_HELPERS = `
  const dshClean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
  const dshVisible = (el) => {
    try {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      if (Number(style.opacity) === 0) return false;
      return true;
    } catch (error) { return false; }
  };
  const dshKind = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return el.multiple ? 'select' : 'select';
    if (tag === 'textarea') return 'textarea';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
      if (type === 'file') return 'file';
      return 'input';
    }
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role) return role;
    if (el.isContentEditable) return 'contenteditable';
    return 'other';
  };
  const dshLabel = (el) => {
    const candidates = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('title'), el.getAttribute('alt'), el.getAttribute('name'), el.id, el.innerText, el.value];
    for (const candidate of candidates) {
      const text = dshClean(candidate);
      if (text) return text.slice(0, 120);
    }
    return '';
  };
  const dshValue = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'password') return el.value ? '••••••' : '';
      if (type === 'checkbox' || type === 'radio') return el.checked ? 'true' : 'false';
      return dshClean(el.value).slice(0, 200);
    }
    if (tag === 'textarea' || tag === 'select') return dshClean(el.value).slice(0, 200);
    if (el.isContentEditable) return dshClean(el.innerText).slice(0, 200);
    return '';
  };
  const dshSelector = (el) => {
    if (el.id) return '#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
    const name = el.getAttribute('name');
    if (name) return el.tagName.toLowerCase() + '[name=' + JSON.stringify(name) + ']';
    return '';
  };
  const dshRect = (el) => {
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round((rect.left + rect.width / 2) * 100) / 100,
      y: Math.round((rect.top + rect.height / 2) * 100) / 100,
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    };
  };
`

/** Build the snapshot expression: numbered interactive elements + page text. */
function snapshotExpression(maxElements) {
  return `(() => {
  try {
    ${PAGE_HELPERS}
    const MAX = ${maxElements};
    const SELECTOR = ${JSON.stringify(INTERACTIVE_SELECTOR)};
    for (const stale of document.querySelectorAll('[data-dsh-browser-ref]')) stale.removeAttribute('data-dsh-browser-ref');
    const elements = [];
    for (const el of document.querySelectorAll(SELECTOR)) {
      if (elements.length >= MAX) break;
      if (!dshVisible(el)) continue;
      const ref = elements.length + 1;
      el.setAttribute('data-dsh-browser-ref', String(ref));
      const rect = dshRect(el);
      elements.push({
        ref,
        kind: dshKind(el),
        label: dshLabel(el),
        value: dshValue(el),
        selector: dshSelector(el),
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
      });
    }
    const bodyText = document.body ? String(document.body.innerText || '') : '';
    const text = bodyText.replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, ${DEFAULT_SNAPSHOT_TEXT_LIMIT});
    return {
      url: String(location.href || ''),
      title: String(document.title || ''),
      viewport: { width: window.innerWidth || 0, height: window.innerHeight || 0 },
      elements,
      text,
      truncated: elements.length >= MAX || bodyText.length > ${DEFAULT_SNAPSHOT_TEXT_LIMIT},
    };
  } catch (error) {
    return { error: String(error && error.message ? error.message : error) };
  }
})()`
}

/** Build an expression that resolves a click target to viewport coordinates. */
function resolveTargetExpression(args) {
  const payload = JSON.stringify({
    ref: args && args.ref !== undefined && args.ref !== null ? String(args.ref) : null,
    selector: typeof args?.selector === 'string' && args.selector ? args.selector : null,
    text: typeof args?.text === 'string' && args.text ? args.text : null,
  })
  return `(() => {
  try {
    ${PAGE_HELPERS}
    const arg = ${payload};
    const SELECTOR = ${JSON.stringify(INTERACTIVE_SELECTOR)};
    let el = null;
    let reason = '';
    if (arg.ref !== null) {
      const ref = String(arg.ref).replace(/"/g, '');
      el = document.querySelector('[data-dsh-browser-ref="' + ref + '"]');
      if (!el) reason = 'no element with ref ' + ref + '; run browser_snapshot again (refs are reassigned on every snapshot)';
    }
    if (!el && arg.selector !== null) {
      try { el = document.querySelector(arg.selector); } catch (error) { return { ok: false, reason: 'invalid CSS selector: ' + error.message }; }
      if (!el) reason = 'CSS selector matched no element: ' + arg.selector;
    }
    if (!el && arg.text !== null) {
      const needle = dshClean(arg.text).toLowerCase();
      let best = null;
      let bestArea = Infinity;
      for (const candidate of document.querySelectorAll(SELECTOR)) {
        if (!dshVisible(candidate)) continue;
        const label = dshClean(candidate.getAttribute('aria-label') || '').toLowerCase();
        const inner = dshClean(candidate.innerText || '').toLowerCase();
        const full = label + ' ' + inner;
        if (full === needle || label === needle || inner === needle) { best = candidate; bestArea = -1; break; }
        if (inner.includes(needle) || label.includes(needle)) {
          const rect = candidate.getBoundingClientRect();
          const area = Math.max(1, rect.width * rect.height);
          if (area < bestArea) { best = candidate; bestArea = area; }
        }
      }
      if (!best) {
        for (const candidate of document.querySelectorAll('body *')) {
          if (!dshVisible(candidate)) continue;
          const inner = dshClean(candidate.innerText || '').toLowerCase();
          if (!inner || !inner.includes(needle)) continue;
          const clickable = candidate.closest(SELECTOR) || candidate;
          const rect = clickable.getBoundingClientRect();
          const area = Math.max(1, rect.width * rect.height);
          if (area < bestArea) { best = clickable; bestArea = area; }
        }
      }
      el = best;
      if (!el) reason = 'no visible clickable element matched text ' + JSON.stringify(arg.text);
    }
    if (!el) return { ok: false, reason: reason || 'no click target was resolved' };
    try { el.focus({ preventScroll: true }); } catch (error) { /* not focusable */ }
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (error) { try { el.scrollIntoView(); } catch (nested) { /* ignore */ } }
    const rect = dshRect(el);
    return {
      ok: true,
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
      label: dshLabel(el).slice(0, 80),
      focused: document.activeElement === el,
      source: arg.ref !== null ? 'ref' : arg.selector !== null ? 'selector' : 'text',
    };
  } catch (error) {
    return { ok: false, reason: String(error && error.message ? error.message : error) };
  }
})()`
}

/** Build an expression that describes the currently focused element. */
function activeElementExpression() {
  return `(() => {
  try {
    ${PAGE_HELPERS}
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) {
      return { ok: false, reason: 'no element is focused; pass ref or selector to browser_type' };
    }
    const rect = dshRect(el);
    return { ok: true, x: rect.x, y: rect.y, w: rect.w, h: rect.h, label: dshLabel(el).slice(0, 80) };
  } catch (error) {
    return { ok: false, reason: String(error && error.message ? error.message : error) };
  }
})()`
}

/** Build the poll expression used by `waitFor`. */
function waitExpression(args) {
  const selector = typeof args?.selector === 'string' && args.selector ? args.selector : null
  const text = typeof args?.text === 'string' && args.text ? args.text : null
  return `(() => {
  try {
    const selector = ${JSON.stringify(selector)};
    const text = ${JSON.stringify(text)};
    let selectorOk = true;
    if (selector !== null) {
      try { selectorOk = Boolean(document.querySelector(selector)); } catch (error) { return { error: 'invalid CSS selector: ' + error.message }; }
    }
    let textOk = true;
    if (text !== null) {
      const body = document.body ? String(document.body.innerText || '') : '';
      textOk = body.includes(text);
    }
    return { selectorOk, textOk, ready: document.readyState === 'complete' };
  } catch (error) {
    return { error: String(error && error.message ? error.message : error) };
  }
})()`
}

// ---------------------------------------------------------------------------
// Minimal CDP client (global WebSocket, no dependencies)
// ---------------------------------------------------------------------------

/**
 * JSON-RPC-over-WebSocket client for one Chrome DevTools endpoint.
 *
 * `send`/`once`/event dispatch are exactly the small surface the engine needs;
 * `flatten: true` sessions arrive as a top-level `sessionId` on each message
 * and are passed back to listeners as `meta.sessionId`.
 */
class Cdp {
  /**
   * @param {() => void} [onClose] invoked once when the socket closes unexpectedly.
   */
  constructor(onClose) {
    this._ws = null
    this._nextId = 1
    this._pending = new Map()
    this._handlers = new Map()
    this._onceWaiters = []
    this._closed = true
    this._onClose = typeof onClose === 'function' ? onClose : () => {}
  }

  /** Whether the DevTools socket is open. */
  get isOpen() {
    return Boolean(this._ws) && !this._closed && this._ws.readyState === 1
  }

  /** Open the DevTools WebSocket. Rejects with a readable message on failure. */
  async connect(url, timeoutMs = STARTUP_TIMEOUT_MS) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      let settled = false
      const finish = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        ws.removeEventListener('open', onOpen)
        ws.removeEventListener('error', onError)
        if (error) reject(error)
        else resolve()
      }
      const onOpen = () => finish(null)
      const onError = () => finish(new Error('could not open the browser DevTools WebSocket'))
      const timer = setTimeout(() => {
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        finish(new Error(`timed out after ${timeoutMs}ms connecting to the browser DevTools WebSocket`))
      }, timeoutMs)
      ws.addEventListener('open', onOpen)
      ws.addEventListener('error', onError)
    })
    this._ws = ws
    this._closed = false
    ws.addEventListener('message', (event) => this._handleMessage(event))
    ws.addEventListener('close', () => this._handleClose())
    ws.addEventListener('error', () => {
      /* Swallow late socket errors; the close handler owns recovery. */
    })
  }

  /**
   * Send one CDP command.
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {string} [sessionId] flattened target session
   * @param {number} [timeoutMs]
   */
  send(method, params = {}, sessionId, timeoutMs = CDP_DEFAULT_TIMEOUT_MS) {
    if (!this._ws || this._closed || this._ws.readyState !== 1) {
      return Promise.reject(new Error(`CDP ${method} failed: the DevTools connection is not open`))
    }
    const id = this._nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this._pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        this._ws.send(JSON.stringify({ id, method, params: params || {}, ...(sessionId ? { sessionId } : {}) }))
      } catch (error) {
        clearTimeout(timer)
        this._pending.delete(id)
        reject(new Error(`CDP ${method} could not be sent: ${errorMessage(error)}`))
      }
    })
  }

  /**
   * Resolve with the first matching event payload.
   * @param {string} method
   * @param {number} [timeoutMs]
   * @param {string} [sessionId] restrict to one flattened session
   */
  once(method, timeoutMs = CDP_DEFAULT_TIMEOUT_MS, sessionId) {
    return new Promise((resolve, reject) => {
      const waiter = {
        method,
        sessionId,
        resolve: (params) => {
          clearTimeout(waiter.timer)
          resolve(params)
        },
        reject: (error) => {
          clearTimeout(waiter.timer)
          reject(error)
        },
        timer: undefined,
      }
      waiter.timer = setTimeout(() => {
        const index = this._onceWaiters.indexOf(waiter)
        if (index >= 0) this._onceWaiters.splice(index, 1)
        reject(new Error(`CDP event ${method} did not arrive within ${timeoutMs}ms`))
      }, timeoutMs)
      this._onceWaiters.push(waiter)
    })
  }

  /**
   * Subscribe to a CDP event.
   * @param {string} method
   * @param {(params: any, meta: { sessionId?: string }) => void} listener
   * @returns {() => void} unsubscribe
   */
  on(method, listener) {
    if (typeof listener !== 'function') throw new TypeError('CDP listener must be a function')
    let handlers = this._handlers.get(method)
    if (!handlers) {
      handlers = new Set()
      this._handlers.set(method, handlers)
    }
    handlers.add(listener)
    return () => {
      try {
        handlers.delete(listener)
      } catch {
        /* ignore */
      }
    }
  }

  /** Close the socket and reject every outstanding call. */
  close() {
    if (this._closed && !this._ws) return
    this._closed = true
    const ws = this._ws
    this._ws = null
    this._failOutstanding('CDP connection closed')
    this._handlers.clear()
    if (ws) {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
  }

  _failOutstanding(reason) {
    for (const pending of this._pending.values()) pending.reject(new Error(`${reason} before ${pending.method} completed`))
    this._pending.clear()
    const waiters = this._onceWaiters.slice()
    this._onceWaiters.length = 0
    for (const waiter of waiters) waiter.reject(new Error(`${reason} while waiting for ${waiter.method}`))
  }

  _handleMessage(event) {
    let text
    try {
      const data = event && event.data
      if (typeof data === 'string') text = data
      else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data)
      else if (ArrayBuffer.isView(data)) text = new TextDecoder().decode(data)
      else text = String(data ?? '')
    } catch {
      return
    }
    let message
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (!message || typeof message !== 'object') return
    if (typeof message.id === 'number') {
      const pending = this._pending.get(message.id)
      if (!pending) return
      this._pending.delete(message.id)
      if (message.error) {
        const detail = `${pending.method} failed: ${message.error.message || 'unknown CDP error'}${message.error.code !== undefined ? ` (code ${message.error.code})` : ''}`
        const error = new Error(detail)
        error.code = message.error.code
        pending.reject(error)
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (typeof message.method !== 'string') return
    const meta = { sessionId: typeof message.sessionId === 'string' ? message.sessionId : undefined }
    const params = message.params || {}
    for (const waiter of this._onceWaiters.slice()) {
      if (waiter.method !== message.method) continue
      if (waiter.sessionId !== undefined && waiter.sessionId !== meta.sessionId) continue
      const index = this._onceWaiters.indexOf(waiter)
      if (index >= 0) this._onceWaiters.splice(index, 1)
      waiter.resolve(params)
    }
    const handlers = this._handlers.get(message.method)
    if (!handlers) return
    for (const handler of [...handlers]) {
      try {
        handler(params, meta)
      } catch {
        /* Listener failures must not take down the socket loop. */
      }
    }
  }

  _handleClose() {
    if (this._closed) return
    this._closed = true
    this._ws = null
    this._failOutstanding('the DevTools connection closed')
    this._handlers.clear()
    try {
      this._onClose()
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// BrowserEngine
// ---------------------------------------------------------------------------

/**
 * One lazily started headless browser plus its page target.
 *
 * Events: `frame`, `navigation`, `activity`, `cursor`, `log`, `state`.
 * `on(event, listener)` returns an unsubscribe function.
 */
export class BrowserEngine {
  /**
   * @param {object} [config]
   * @param {string} [config.browserPath] explicit Chrome/Edge executable
   * @param {'chrome'|'edge'|'system'} [config.browserChannel] preferred channel
   * @param {string} [config.profileDir] persistent user-data-dir
   * @param {{width:number,height:number}} [config.viewport]
   * @param {string} [config.startUrl] optional URL opened with the first page
   * @param {string[]} [config.extraArgs] extra Chrome switches (tests only)
   * @param {boolean} [config.noSandbox] add --no-sandbox (tests only; never in production)
   * @param {{info?:Function,warn?:Function,error?:Function}} [log]
   */
  constructor(config = {}, log) {
    const options = config && typeof config === 'object' ? config : {}
    this._config = options
    this._logger = log && typeof log === 'object' ? log : undefined
    const viewport = options.viewport && typeof options.viewport === 'object' ? options.viewport : {}
    this._viewport = {
      width: clampInt(viewport.width, 200, 4000, DEFAULT_VIEWPORT.width),
      height: clampInt(viewport.height, 200, 4000, DEFAULT_VIEWPORT.height),
    }
    this._profileDir = typeof options.profileDir === 'string' && options.profileDir.trim()
      ? options.profileDir
      : join(tmpdir(), 'dsh-insider-browser', 'profile')
    this._extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs.filter((arg) => typeof arg === 'string' && arg.length > 0) : []
    this._noSandbox = options.noSandbox === true
    this._startUrl = typeof options.startUrl === 'string' && options.startUrl.trim() ? options.startUrl.trim() : ''
    this._initialNavigationDone = false

    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map()
    /** @type {Map<string, number>} */
    this._activityCounts = new Map()
    this._activity = { active: false }
    this._lastCursor = null
    /** Held human mouse buttons (CDP `buttons` bit mask) for dispatchInput. */
    this._humanButtons = 0
    this._humanSendWarned = false

    this._child = null
    this._cdp = null
    this._executable = null
    this._channel = null
    this._browserVersion = null
    this._userAgent = ''
    this._running = false
    this._starting = false
    this._stopping = false
    this._startPromise = null
    this._ensurePromise = null

    this._targetId = null
    this._sessionId = null
    this._mainFrameId = null
    this._pageEpoch = 0
    this._state = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false }
    this._navTimer = null
    this._refreshing = false
    this._refreshQueued = false
    this._frameSeq = 0
    this._lastFrameEmitAt = 0
    this._droppedFrames = 0
    this._lastTickLogAt = 0
    /** Keep the mirrored page visible/focused; see `_checkPageVisibility`. */
    this._visibilityTimer = null
    this._visibilityChecking = false
    this._visibilityWarned = false
    this._pageVisible = null
    this._pageFocused = null
    this._focusTimer = null
    /** Tabs opened by the mirrored page (target=_blank / window.open), see _trackOpenedTarget. */
    this._openedTargets = new Map()
    this._popupQueue = new Map()
    this._popupTimer = null
    this._popupFollowing = false
  }

  // -- events ---------------------------------------------------------------

  /**
   * Subscribe to an engine event.
   * @param {'frame'|'navigation'|'activity'|'cursor'|'log'|'state'} event
   * @param {(payload:any)=>void} listener
   * @returns {() => void} unsubscribe
   */
  on(event, listener) {
    if (typeof event !== 'string' || event.length === 0) throw new TypeError('event name must be a non-empty string')
    if (typeof listener !== 'function') throw new TypeError('event listener must be a function')
    let listeners = this._listeners.get(event)
    if (!listeners) {
      listeners = new Set()
      this._listeners.set(event, listeners)
    }
    listeners.add(listener)
    return () => {
      try {
        listeners.delete(listener)
      } catch {
        /* ignore */
      }
    }
  }

  _emit(event, payload) {
    const listeners = this._listeners.get(event)
    if (!listeners || listeners.size === 0) return
    for (const listener of [...listeners]) {
      try {
        listener(payload)
      } catch (error) {
        try {
          console.warn(`[insider-browser] ${event} listener failed: ${errorMessage(error)}`)
        } catch {
          /* ignore */
        }
      }
    }
  }

  _log(level, text) {
    const entry = { level: level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info', text: String(text) }
    const hasListeners = (this._listeners.get('log')?.size ?? 0) > 0
    this._emit('log', entry)
    if (hasListeners) return
    const logger = this._logger
    try {
      if (entry.level === 'error') logger?.error?.(`[insider-browser] ${entry.text}`)
      else if (entry.level === 'warn') logger?.warn?.(`[insider-browser] ${entry.text}`)
      else logger?.info?.(`[insider-browser] ${entry.text}`)
    } catch {
      /* ignore */
    }
  }

  // -- status ---------------------------------------------------------------

  /** Snapshot of the engine state consumed by the SSE hello payload. */
  get status() {
    return {
      running: Boolean(this._running && this._cdp && this._cdp.isOpen),
      starting: Boolean(this._starting),
      channel: this._channel,
      executable: this._executable,
      profileDir: this._profileDir,
      viewport: { ...this._viewport },
      url: this._state.url,
      title: this._state.title,
      loading: Boolean(this._state.loading),
      canGoBack: Boolean(this._state.canGoBack),
      canGoForward: Boolean(this._state.canGoForward),
      ...(typeof this._pageVisible === 'boolean' ? { visible: this._pageVisible } : {}),
      ...(typeof this._pageFocused === 'boolean' ? { focused: this._pageFocused } : {}),
    }
  }

  /** Current activity reference state. */
  get activity() {
    const current = this._activity || { active: false }
    return {
      active: current.active === true,
      ...(current.sessionId ? { sessionId: current.sessionId } : {}),
      ...(current.label ? { label: current.label } : {}),
    }
  }

  // -- lifecycle ------------------------------------------------------------

  /** Start the browser. Idempotent and concurrency safe. */
  async start() {
    if (this._running && this._cdp && this._cdp.isOpen) return
    if (this._startPromise) return this._startPromise
    this._startPromise = this._doStart().finally(() => {
      this._startPromise = null
    })
    return this._startPromise
  }

  /** Start the browser and make sure one page target is attached. */
  async ensure() {
    await this.start()
    if (this._pageReady()) return
    if (!this._ensurePromise) {
      this._ensurePromise = this._createPage().finally(() => {
        this._ensurePromise = null
      })
    }
    return this._ensurePromise
  }

  /** Stop the browser and reset all page state. Safe to call repeatedly. */
  async stop() {
    this._stopping = true
    if (this._navTimer) {
      clearTimeout(this._navTimer)
      this._navTimer = null
    }
    try {
      // A start() in flight would otherwise finish after this stop and leave a
      // browser running; give it a bounded moment, then cancel it below.
      if (this._startPromise) {
        try {
          await Promise.race([this._startPromise.catch(() => {}), delay(5000)])
        } catch {
          /* ignore */
        }
      }
      if (this._ensurePromise) {
        try {
          await Promise.race([this._ensurePromise, delay(2000)])
        } catch {
          /* ignore */
        }
      }
      const cdp = this._cdp
      if (cdp && cdp.isOpen) {
        try {
          await cdp.send('Browser.close', {}, undefined, 1500)
        } catch {
          /* the process may already be gone */
        }
      }
      if (cdp) cdp.close()
      this._cdp = null
      await this._killChild()
      this._running = false
      this._resetPage('browser stopped', { log: false })
      this._activityCounts.clear()
      if (this._activity.active) {
        this._activity = { active: false }
        this._emit('activity', { active: false })
      }
      this._cleanupProfileLocks()
      this._log('info', 'browser stopped')
    } finally {
      this._stopping = false
      this._emit('state', this.status)
    }
  }

  async _doStart() {
    this._starting = true
    this._stopping = false
    try {
      await this._killChild()
      const resolved = this._resolveExecutable()
      this._executable = resolved.path
      this._channel = resolved.channel
      try {
        mkdirSync(this._profileDir, { recursive: true })
      } catch (error) {
        throw new Error(`could not create the browser profile directory ${JSON.stringify(this._profileDir)}: ${errorMessage(error)}`)
      }
      try {
        rmSync(join(this._profileDir, 'DevToolsActivePort'), { force: true })
      } catch {
        /* ignore */
      }
      const args = this._buildLaunchArgs()
      let child
      try {
        child = spawn(resolved.path, args, { stdio: 'ignore', windowsHide: true })
      } catch (error) {
        throw new Error(`could not launch ${resolved.channel} (${resolved.path}): ${errorMessage(error)}`)
      }
      this._child = child
      child.once('error', (error) => {
        this._log('error', `browser process error: ${errorMessage(error)}`)
      })
      child.once('exit', (code, signal) => {
        const wasCurrent = this._child === child
        if (wasCurrent) this._child = null
        if (this._stopping) return
        this._running = false
        if (this._cdp) {
          const cdp = this._cdp
          this._cdp = null
          try {
            cdp.close()
          } catch {
            /* ignore */
          }
        }
        this._resetPage(`browser process exited (code ${code === null ? 'null' : code}${signal ? `, signal ${signal}` : ''})`, { log: false })
        if (wasCurrent) this._log('warn', 'the browser process exited unexpectedly; it will be restarted on the next call')
        this._emit('state', this.status)
      })

      const endpoint = await this._waitForDevToolsPort(STARTUP_TIMEOUT_MS)
      const cdp = new Cdp(() => this._handleBrowserDisconnect())
      try {
        await cdp.connect(`ws://127.0.0.1:${endpoint.port}${endpoint.path}`, STARTUP_TIMEOUT_MS)
      } catch (error) {
        cdp.close()
        await this._killChild()
        throw new Error(`could not attach to the browser DevTools endpoint on port ${endpoint.port}: ${errorMessage(error)}`)
      }
      this._cdp = cdp
      this._installBrowserEventListeners()
      try {
        await cdp.send('Target.setDiscoverTargets', { discover: true }, undefined, 5000)
      } catch {
        /* target discovery is an enhancement; tool calls still work without it */
      }
      try {
        const version = await cdp.send('Browser.getVersion', {}, undefined, 10_000)
        this._browserVersion = version || null
        const rawUserAgent = String(version?.userAgent || '')
        this._userAgent = rawUserAgent.replace(/HeadlessChrome/g, 'Chrome')
      } catch {
        this._browserVersion = null
        this._userAgent = ''
      }
      this._running = true
      this._initialNavigationDone = false
      if (this._stopping) {
        // stop() ran while this start was racing it: do not leave a browser behind.
        this._running = false
        const raceCdp = this._cdp
        this._cdp = null
        try {
          raceCdp?.close()
        } catch {
          /* ignore */
        }
        await this._killChild()
        throw new Error('browser start was cancelled by stop()')
      }
      this._log('info', `started ${resolved.channel} in headless mode (pid ${child.pid})`)
      this._emit('state', this.status)
    } finally {
      this._starting = false
    }
  }

  /** Resolve the executable and channel, preferring an explicitly configured path. */
  _resolveExecutable() {
    const configured = this._config && typeof this._config.browserPath === 'string' ? this._config.browserPath.trim() : ''
    if (configured) {
      if (!existsSync(configured)) throw new Error(`the configured browserPath does not exist: ${JSON.stringify(configured)}`)
      const requested = typeof this._config.browserChannel === 'string' ? this._config.browserChannel.toLowerCase() : ''
      return { path: configured, channel: requested === 'edge' ? 'edge' : requested === 'chrome' ? 'chrome' : 'system' }
    }
    const requested = typeof this._config.browserChannel === 'string' ? this._config.browserChannel.toLowerCase() : ''
    const candidates = []
    if (process.platform === 'win32') {
      const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
      const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
      const localAppData = process.env.LOCALAPPDATA || ''
      const chrome = [
        join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ...(localAppData ? [join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
      ]
      const edge = [
        join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ...(localAppData ? [join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe')] : []),
      ]
      if (requested === 'edge') candidates.push(...edge.map((path) => ({ path, channel: 'edge' })))
      else if (requested === 'chrome') candidates.push(...chrome.map((path) => ({ path, channel: 'chrome' })))
      else candidates.push(...chrome.map((path) => ({ path, channel: 'chrome' })), ...edge.map((path) => ({ path, channel: 'edge' })))
    } else if (process.platform === 'darwin') {
      const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      const edge = ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      candidates.push(...chrome.map((path) => ({ path, channel: 'chrome' })), ...edge.map((path) => ({ path, channel: 'edge' })))
    } else {
      const chrome = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
      const edge = ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable']
      candidates.push(...chrome.map((path) => ({ path, channel: 'chrome' })), ...edge.map((path) => ({ path, channel: 'edge' })))
    }
    for (const candidate of candidates) {
      if (existsSync(candidate.path)) return candidate
    }
    throw new Error('could not find a Chrome or Edge executable to drive; set the browserPath plugin option to the browser executable')
  }

  _buildLaunchArgs() {
    const args = [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${this._profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--hide-scrollbars',
      '--mute-audio',
      `--window-size=${this._viewport.width},${this._viewport.height}`,
    ]
    if (this._noSandbox) args.push('--no-sandbox')
    args.push(...this._extraArgs)
    args.push('about:blank')
    return args
  }

  /** Poll `<profileDir>/DevToolsActivePort` until the browser is ready. */
  async _waitForDevToolsPort(timeoutMs) {
    const portFile = join(this._profileDir, 'DevToolsActivePort')
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const child = this._child
      if (child && child.exitCode !== null) {
        throw new Error(`the browser process exited before its DevTools endpoint was ready (exit code ${child.exitCode}); the profile may be locked by another Chrome instance`)
      }
      try {
        const text = readFileSync(portFile, 'utf8')
        const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
        if (lines.length >= 2) {
          const port = Number(lines[0])
          if (Number.isInteger(port) && port > 0) {
            const path = lines[1].startsWith('/') ? lines[1] : `/${lines[1]}`
            return { port, path }
          }
        }
      } catch {
        /* not written yet */
      }
      await delay(50)
    }
    await this._killChild()
    throw new Error(`timed out after ${timeoutMs}ms waiting for the browser DevTools endpoint; the browser may have failed to start (check that no other browser is using ${JSON.stringify(this._profileDir)})`)
  }

  async _killChild() {
    const child = this._child
    this._child = null
    if (!child) return
    if (child.exitCode !== null) return
    try {
      child.kill()
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        finish()
      }, 2500)
      child.once('exit', finish)
    })
  }

  _cleanupProfileLocks() {
    for (const name of PROFILE_LOCK_FILES) {
      try {
        rmSync(join(this._profileDir, name), { force: true })
      } catch {
        /* the browser may still hold it; harmless */
      }
    }
  }

  _handleBrowserDisconnect() {
    if (this._stopping) return
    this._cdp = null
    this._running = false
    this._resetPage('the DevTools connection closed', { log: false })
    this._log('warn', 'lost the DevTools connection to the browser; it will be restarted on the next call')
    this._emit('state', this.status)
  }

  _pageReady() {
    return Boolean(this._running && this._cdp && this._cdp.isOpen && this._sessionId && this._targetId)
  }

  _resetPage(reason, options = {}) {
    const hadPage = Boolean(this._sessionId)
    this._stopVisibilityWatchdog()
    this._resetPopupTracking()
    this._visibilityChecking = false
    this._visibilityWarned = false
    this._pageVisible = null
    this._pageFocused = null
    this._sessionId = null
    this._mainFrameId = null
    this._targetId = null
    this._state = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false }
    this._lastFrameEmitAt = 0
    this._lastCursor = null
    this._humanButtons = 0
    this._humanSendWarned = false
    if (this._navTimer) {
      clearTimeout(this._navTimer)
      this._navTimer = null
    }
    if (hadPage && options.log !== false) this._log('warn', `browser page reset: ${reason}`)
    if (options.emitState !== false) this._emit('state', this.status)
  }

  /** Create and configure the single page target this engine drives. */
  async _createPage() {
    if (!this._running || !this._cdp || !this._cdp.isOpen) throw new Error('the browser is not running; call browser_open to start it again')
    const epoch = ++this._pageEpoch
    let targetId
    try {
      const created = await this._cdp.send('Target.createTarget', { url: 'about:blank' }, undefined, 15_000)
      targetId = created?.targetId
      if (!targetId) throw new Error('the browser did not return a target id')
    } catch (error) {
      throw new Error(`could not open a browser page: ${errorMessage(error)}`)
    }
    let sessionId
    try {
      const attached = await this._cdp.send('Target.attachToTarget', { targetId, flatten: true }, undefined, 15_000)
      sessionId = attached?.sessionId
      if (!sessionId) throw new Error('the browser did not return a session id')
    } catch (error) {
      try {
        await this._cdp.send('Target.closeTarget', { targetId }, undefined, 5000)
      } catch {
        /* ignore */
      }
      throw new Error(`could not attach to the browser page: ${errorMessage(error)}`)
    }
    if (epoch !== this._pageEpoch) {
      try {
        await this._cdp.send('Target.closeTarget', { targetId }, undefined, 5000)
      } catch {
        /* ignore */
      }
      throw new Error('the browser page was replaced while it was being created; try again')
    }
    this._targetId = targetId
    this._sessionId = sessionId
    this._state = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false }
    try {
      await this._sendPage('Page.enable', {}, 15_000)
      await this._sendPage('Runtime.enable', {}, 15_000)
      await this._sendPage('Network.enable', {}, 15_000)
      await this._sendPage('DOM.enable', {}, 15_000)
      try {
        await this._sendPage('Accessibility.enable', {}, 15_000)
      } catch {
        /* Accessibility is a best-effort extra domain. */
      }
      await this._sendPage('Emulation.setDeviceMetricsOverride', {
        width: this._viewport.width,
        height: this._viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
      }, 15_000)
      if (this._userAgent) {
        try {
          await this._sendPage('Emulation.setUserAgentOverride', { userAgent: this._userAgent }, 10_000)
        } catch {
          /* optional */
        }
      }
      try {
        const tree = await this._sendPage('Page.getFrameTree', {}, 10_000)
        this._mainFrameId = tree?.frameTree?.frame?.id || null
      } catch {
        this._mainFrameId = null
      }
      // A background tab is not painted and its input dispatch is delayed, so
      // make the page visible/focused before the screencast starts.
      await this._ensurePageActive()
      try {
        const streamWidth = Math.min(this._viewport.width, SCREENCAST_MAX_WIDTH)
        const streamHeight = Math.max(1, Math.round(streamWidth * this._viewport.height / this._viewport.width))
        await this._sendPage('Page.startScreencast', {
          format: 'jpeg',
          quality: SCREENCAST_QUALITY,
          maxWidth: streamWidth,
          maxHeight: streamHeight,
          everyNthFrame: 1,
        }, 15_000)
      } catch (error) {
        // The mirror is a nice-to-have: tool calls must still work without it.
        this._log('warn', `could not start the live screencast: ${errorMessage(error)}`)
      }
      this._startVisibilityWatchdog()
    } catch (error) {
      this._sessionId = null
      this._targetId = null
      try {
        await this._cdp.send('Target.closeTarget', { targetId }, undefined, 5000)
      } catch {
        /* ignore */
      }
      const hint = /Page\.enable timed out|Page\.enable.*timed out/i.test(errorMessage(error))
        ? ' — the page target never answered; if this browser is running inside a restricted process sandbox, Chrome\'s IPC channels may be blocked (start it outside the sandbox)'
        : ''
      throw new Error(`could not initialize the browser page: ${errorMessage(error)}${hint}`)
    }
    await this._refreshNavigation()
    if (this._startUrl && !this._initialNavigationDone) {
      this._initialNavigationDone = true
      try {
        await this._navigateNormalized(normalizeBrowserUrl(this._startUrl))
      } catch (error) {
        this._log('warn', `could not open the configured startUrl: ${errorMessage(error)}`)
      }
    }
    this._emit('state', this.status)
  }

  // -- CDP event wiring -----------------------------------------------------

  _installBrowserEventListeners() {
    const cdp = this._cdp
    if (!cdp) return
    const isPage = (meta) => meta && (meta.sessionId === undefined || meta.sessionId === this._sessionId)
    const isMainFrame = (frameId) => Boolean(this._mainFrameId) && frameId === this._mainFrameId

    cdp.on('Page.frameNavigated', (params, meta) => {
      if (!isPage(meta)) return
      const frame = params?.frame
      if (!frame || frame.parentId) return
      this._mainFrameId = frame.id || this._mainFrameId
      this._state.url = String(frame.url || this._state.url || '')
      this._state.loading = false
      // A navigation releases every mouse button held on the old document; if
      // the mask were kept, all later clicks would look like a drag.
      this._humanButtons = 0
      // New documents start hidden in some Chrome versions until activated.
      this._reassertFocusSoon()
      this._emitNavigationSoon()
    })
    cdp.on('Page.loadEventFired', (_params, meta) => {
      if (!isPage(meta)) return
      this._reassertFocusSoon()
      this._state.loading = false
      this._emitNavigationSoon()
    })
    cdp.on('Page.navigatedWithinDocument', (params, meta) => {
      if (!isPage(meta)) return
      if (params?.url) this._state.url = String(params.url)
      this._emitNavigationSoon()
    })
    cdp.on('Page.domContentEventFired', (_params, meta) => {
      if (!isPage(meta)) return
      this._emitNavigationSoon()
    })
    cdp.on('Page.frameStartedLoading', (params, meta) => {
      if (!isPage(meta)) return
      if (params?.frameId && this._mainFrameId && params.frameId !== this._mainFrameId) return
      this._state.loading = true
      this._emitNavigationSoon()
    })
    cdp.on('Page.frameStoppedLoading', (params, meta) => {
      if (!isPage(meta)) return
      if (params?.frameId && this._mainFrameId && params.frameId !== this._mainFrameId) return
      this._state.loading = false
      this._emitNavigationSoon()
    })
    cdp.on('Page.screencastFrame', (params, meta) => this._handleScreencastFrame(params, meta))
    cdp.on('Page.javascriptDialogOpening', (params, meta) => {
      if (!isPage(meta)) return
      this._log('info', `dismissing a page dialog (${params?.type || 'dialog'}${params?.message ? `: ${String(params.message).slice(0, 120)}` : ''})`)
      cdp.send('Page.handleJavaScriptDialog', { accept: true }, meta?.sessionId, 5000).catch(() => {})
    })
    cdp.on('Inspector.detached', (params, meta) => {
      if (meta?.sessionId && meta.sessionId !== this._sessionId) return
      this._resetPage(`the browser page was detached (${params?.reason || 'unknown reason'})`)
      this._log('warn', 'the browser page was detached; the next call will open a new page')
    })
    cdp.on('Target.targetCrashed', (params, meta) => {
      if (!params || !this._targetId || params.targetId !== this._targetId) return
      this._resetPage(`the browser page crashed (${params.status || params.errorCode || 'renderer crash'})`)
      this._log('error', 'the browser page crashed; the next call will open a new page')
    })
    cdp.on('Target.detachedFromTarget', (params, meta) => {
      if (!params || !this._sessionId) return
      if (params.sessionId !== this._sessionId && meta?.sessionId !== this._sessionId) return
      this._resetPage('the browser page was detached', { log: false })
    })
    // Links with target="_blank" and window.open() create a new page target.
    // Without this the click appears to do nothing: the new tab loads hidden
    // while the mirror stays on the old page. Follow it in the same view.
    cdp.on('Target.targetCreated', (params) => this._trackOpenedTarget(params?.targetInfo))
    cdp.on('Target.targetInfoChanged', (params) => this._trackOpenedTarget(params?.targetInfo))
    cdp.on('Target.targetDestroyed', (params) => {
      if (!params || typeof params.targetId !== 'string') return
      this._openedTargets.delete(params.targetId)
      this._popupQueue.delete(params.targetId)
    })
  }

  /**
   * Track a page target opened by the mirrored page.
   *
   * `Target.targetCreated` usually arrives with an empty/about:blank URL; the
   * final address follows in `Target.targetInfoChanged`. Both events land here
   * and the first usable http(s) URL is queued for `_pumpPopupQueue`, which
   * navigates the mirror to it and closes the now-redundant tab.
   * @param {Record<string, any>|undefined} info
   */
  _trackOpenedTarget(info) {
    if (!info || info.type !== 'page' || !this._targetId) return
    const targetId = typeof info.targetId === 'string' ? info.targetId : ''
    if (!targetId || targetId === this._targetId) return
    const status = this._openedTargets.get(targetId)
    if (status === 'following') return
    const openedByUs = info.openerId === this._targetId
    if (!status && !openedByUs) return
    if (!status) this._openedTargets.set(targetId, 'new')
    const raw = typeof info.url === 'string' ? info.url : ''
    if (raw === '' || /^about:blank(?:[?#].*)?$/i.test(raw)) return
    let url
    try {
      url = normalizeBrowserUrl(raw)
    } catch {
      // chrome://, data:, blob:, file: and similar targets cannot be mirrored.
      this._openedTargets.delete(targetId)
      return
    }
    if (url === 'about:blank') return
    this._openedTargets.set(targetId, 'queued')
    this._popupQueue.set(targetId, url)
    if (this._popupTimer) clearTimeout(this._popupTimer)
    this._popupTimer = setTimeout(() => {
      this._popupTimer = null
      void this._pumpPopupQueue()
    }, 250)
    if (typeof this._popupTimer.unref === 'function') this._popupTimer.unref()
  }

  /** Navigate the mirrored page to one queued new-tab URL, then close that tab. */
  async _pumpPopupQueue() {
    if (this._popupFollowing || this._popupQueue.size === 0 || !this._pageReady()) return
    this._popupFollowing = true
    const entry = this._popupQueue.entries().next().value
    const targetId = entry[0]
    const url = entry[1]
    this._popupQueue.delete(targetId)
    this._openedTargets.set(targetId, 'following')
    try {
      // The tab may have been closed (or never finished opening) meanwhile.
      try {
        await this._cdp.send('Target.getTargetInfo', { targetId }, undefined, 3000)
      } catch {
        return
      }
      if (!this._pageReady()) return
      if (url === this._state.url) return
      this._log('info', `following a link opened in a new tab in the mirrored view: ${url}`)
      try {
        await this._navigateNormalized(url)
      } catch (error) {
        this._log('warn', `could not follow the link opened in a new tab: ${errorMessage(error)}`)
      }
    } finally {
      try {
        await this._cdp.send('Target.closeTarget', { targetId }, undefined, 5000)
      } catch {
        /* the tab closed itself or the browser is going away */
      }
      this._openedTargets.delete(targetId)
      this._popupFollowing = false
      if (this._popupQueue.size > 0) {
        const timer = setTimeout(() => {
          this._popupTimer = null
          void this._pumpPopupQueue()
        }, 0)
        if (typeof timer.unref === 'function') timer.unref()
        this._popupTimer = timer
      }
    }
  }

  /** Drop pending new-tab bookkeeping when the mirrored page is replaced. */
  _resetPopupTracking() {
    if (this._popupTimer) {
      clearTimeout(this._popupTimer)
      this._popupTimer = null
    }
    this._openedTargets.clear()
    this._popupQueue.clear()
    this._popupFollowing = false
  }

  _handleScreencastFrame(params, meta) {
    if (!params || typeof params.data !== 'string' || params.data.length === 0) return
    const sessionId = meta?.sessionId
    if (sessionId && this._sessionId && sessionId !== this._sessionId) return
    // Ack every frame, including ones dropped below, or Chrome stops the cast.
    if (params.sessionId !== undefined) {
      const cdp = this._cdp
      if (cdp) cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId, 5000).catch(() => {})
    }
    const now = Date.now()
    if (now - this._lastFrameEmitAt < SCREENCAST_MIN_INTERVAL_MS) {
      this._droppedFrames += 1
      return
    }
    this._lastFrameEmitAt = now
    this._frameSeq += 1
    this._emit('frame', {
      data: params.data,
      seq: this._frameSeq,
      viewport: { ...this._viewport },
    })
  }

  // -- navigation state -----------------------------------------------------

  _emitNavigationSoon() {
    if (this._navTimer) return
    this._navTimer = setTimeout(() => {
      this._navTimer = null
      void this._refreshNavigation()
    }, 100)
  }

  _applyState(partial) {
    if (!partial || typeof partial !== 'object') return
    if (typeof partial.url === 'string' && partial.url) this._state.url = partial.url
    if (typeof partial.title === 'string') this._state.title = partial.title
    if (typeof partial.loading === 'boolean') this._state.loading = partial.loading
    if (typeof partial.canGoBack === 'boolean') this._state.canGoBack = partial.canGoBack
    if (typeof partial.canGoForward === 'boolean') this._state.canGoForward = partial.canGoForward
  }

  _emitNavigation() {
    this._emit('navigation', {
      url: this._state.url,
      title: this._state.title,
      loading: this._state.loading,
      canGoBack: this._state.canGoBack,
      canGoForward: this._state.canGoForward,
    })
  }

  /** Read URL/title/history and emit one `navigation` event (debounced by callers). */
  async _refreshNavigation() {
    if (!this._pageReady()) return
    if (this._refreshing) {
      this._refreshQueued = true
      return
    }
    this._refreshing = true
    try {
      const state = {}
      try {
        const evaluated = await this._evaluate(
          '(() => { try { return { url: location.href, title: document.title || "" } } catch (e) { return null } })()',
          { timeoutMs: 5000 },
        )
        if (evaluated && typeof evaluated === 'object') {
          if (typeof evaluated.url === 'string') state.url = evaluated.url
          if (typeof evaluated.title === 'string') state.title = evaluated.title
        }
      } catch {
        /* the document may be mid-navigation */
      }
      try {
        const history = await this._sendPage('Page.getNavigationHistory', {}, 5000)
        if (history && Array.isArray(history.entries)) {
          const index = Number(history.currentIndex)
          state.canGoBack = Number.isFinite(index) ? index > 0 : false
          state.canGoForward = Number.isFinite(index) ? index < history.entries.length - 1 : false
        }
      } catch {
        /* optional */
      }
      this._applyState(state)
      this._emitNavigation()
    } finally {
      this._refreshing = false
      if (this._refreshQueued) {
        this._refreshQueued = false
        void this._refreshNavigation()
      }
    }
  }

  _setLoading(loading) {
    this._state.loading = loading === true
    this._emitNavigationSoon()
  }

  // -- CDP helpers ----------------------------------------------------------

  _sendPage(method, params = {}, timeoutMs = CDP_DEFAULT_TIMEOUT_MS) {
    if (!this._cdp || !this._sessionId) {
      return Promise.reject(new Error('the built-in browser page is not available; call browser_open again'))
    }
    return this._cdp.send(method, params, this._sessionId, timeoutMs)
  }

  /**
   * Keep this page visible and focused inside Chrome.
   *
   * Chrome only produces compositor frames — and therefore only delivers
   * `Page.screencastFrame` events — for a visible tab, and `Input.dispatch*`
   * to a hidden page stalls for about five seconds before being handled. A tab
   * that is pushed into the background (another tab opens, the agent navigates
   * a popup, the window is considered occluded) therefore freezes the mirror
   * and makes human input feel dead. `Emulation.setFocusEmulationEnabled` makes
   * the page report itself as visible and focused without having to steal the
   * foreground tab; `Page.bringToFront` is kept as a fallback.
   * @param {boolean} [bringToFront] also activate the tab
   */
  async _ensurePageActive(bringToFront = false) {
    if (!this._pageReady()) return
    let emulated = false
    try {
      await this._sendPage('Emulation.setFocusEmulationEnabled', { enabled: true }, 5000)
      emulated = true
      this._pageVisible = true
      this._pageFocused = true
    } catch {
      /* older Chrome builds may not implement it; bringToFront still helps */
    }
    if (bringToFront || !emulated) {
      try {
        await this._sendPage('Page.bringToFront', {}, 5000)
        this._pageVisible = true
        this._pageFocused = true
      } catch {
        /* the page may be navigating; the next check retries */
      }
    }
  }

  /** Re-assert visibility/focus shortly after a navigation, coalesced. */
  _reassertFocusSoon() {
    if (this._focusTimer || !this._pageReady()) return
    this._focusTimer = setTimeout(() => {
      this._focusTimer = null
      void this._ensurePageActive()
    }, 300)
    if (typeof this._focusTimer.unref === 'function') this._focusTimer.unref()
  }

  _startVisibilityWatchdog() {
    this._stopVisibilityWatchdog()
    const timer = setInterval(() => {
      void this._checkPageVisibility()
    }, PAGE_VISIBILITY_INTERVAL_MS)
    if (typeof timer.unref === 'function') timer.unref()
    this._visibilityTimer = timer
  }

  _stopVisibilityWatchdog() {
    if (this._visibilityTimer) {
      clearInterval(this._visibilityTimer)
      this._visibilityTimer = null
    }
    if (this._focusTimer) {
      clearTimeout(this._focusTimer)
      this._focusTimer = null
    }
  }

  /** Watchdog: reactivate the page if it drifted into the background. */
  async _checkPageVisibility() {
    if (this._visibilityChecking || !this._pageReady()) return
    this._visibilityChecking = true
    try {
      const state = await this._evaluate(
        '(() => { try { return { visibility: document.visibilityState, focus: document.hasFocus() } } catch (e) { return null } })()',
        { timeoutMs: 3000 },
      )
      if (!state) return
      this._pageVisible = state.visibility === 'visible'
      this._pageFocused = state.focus === true
      if (state.visibility === 'visible' && state.focus !== false) return
      if (!this._pageReady()) return
      if (!this._visibilityWarned) {
        this._visibilityWarned = true
        this._log('info', 'the browser page was in the background; reactivating it so the mirror keeps painting and input stays responsive')
      }
      await this._ensurePageActive(true)
    } catch {
      /* a page in the middle of a navigation is checked again next tick */
    } finally {
      this._visibilityChecking = false
    }
  }

  async _evaluate(expression, options = {}) {
    const result = await this._sendPage('Runtime.evaluate', {
      expression,
      returnByValue: options.returnByValue !== false,
      awaitPromise: options.awaitPromise === true,
      userGesture: options.userGesture !== false,
      includeCommandLineAPI: false,
    }, options.timeoutMs ?? CDP_DEFAULT_TIMEOUT_MS)
    if (result && result.exceptionDetails) {
      const details = result.exceptionDetails
      const description = details.exception && (details.exception.description || details.exception.value)
      throw new Error(`page script failed: ${description || details.text || 'unknown page error'}`)
    }
    return result ? result.result?.value : undefined
  }

  /** Resolve once the main frame looks loaded, or after `timeoutMs` (never rejects). */
  _waitForLoad(timeoutMs, options = {}) {
    if (!this._cdp) return Promise.resolve()
    const startUrl = this._state.url || ''
    const expectedUrl = typeof options.expectedUrl === 'string' ? options.expectedUrl : ''
    return new Promise((resolve) => {
      let settled = false
      let poll = null
      let timer = null
      let off = null
      const finish = () => {
        if (settled) return
        settled = true
        if (poll) clearInterval(poll)
        if (timer) clearTimeout(timer)
        if (off) {
          try {
            off()
          } catch {
            /* ignore */
          }
        }
        resolve()
      }
      try {
        off = this._cdp.on('Page.loadEventFired', (_params, meta) => {
          if (!meta || meta.sessionId === undefined || meta.sessionId === this._sessionId) finish()
        })
      } catch {
        off = null
      }
      poll = setInterval(() => {
        if (settled) return
        void (async () => {
          try {
            const state = await this._evaluate('(() => ({ url: location.href, ready: document.readyState }))()', { timeoutMs: 2000 })
            if (settled || !state || typeof state !== 'object') return
            if (state.ready !== 'complete') return
            const url = String(state.url || '')
            const changed = startUrl === '' || url !== startUrl || (expectedUrl !== '' && url === expectedUrl)
            if (changed) finish()
          } catch {
            /* document replaced mid-navigation */
          }
        })()
      }, 200)
      timer = setTimeout(finish, timeoutMs)
    })
  }

  /** Let click/type/key-triggered navigation or SPA updates settle, then refresh state. */
  async _settleAfterAction() {
    await delay(200)
    if (this._state.loading) {
      await this._waitForLoad(NAVIGATION_TIMEOUT_MS)
    } else {
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        try {
          const ready = await this._evaluate('document.readyState', { timeoutMs: 2000 })
          if (ready === 'complete') break
        } catch {
          /* keep waiting */
        }
        await delay(150)
      }
    }
    this._state.loading = false
    await this._refreshNavigation()
  }

  async _dispatchMouse(type, x, y, clickCount = 1) {
    const params = {
      type,
      x,
      y,
      button: type === 'mouseMoved' ? 'none' : 'left',
      buttons: type === 'mousePressed' ? 1 : 0,
      clickCount: type === 'mouseMoved' ? 0 : clickCount,
      pointerType: 'mouse',
    }
    await this._sendPage('Input.dispatchMouseEvent', params, 10_000)
  }

  /**
   * Translate ONE human input event from the mirrored panel into the CDP
   * command it maps to. Invalid events throw; `dispatchInput` counts those as
   * skipped and keeps going with the rest of the batch.
   *
   * This is deliberately synchronous: the whole batch is converted first and
   * then written to the DevTools socket without waiting for the per-command
   * responses. Chrome delivers commands over one session in order, so the
   * page still sees the exact event sequence — but a fast mouse no longer
   * spends ~8ms per move waiting for a CDP round-trip.
   * @param {unknown} event
   * @returns {{method:string,params:object}}
   */
  _humanInputCommand(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new Error('the input event is not an object')
    }
    if (event.t === 'm') {
      const action = event.a
      if (action !== 'move' && action !== 'down' && action !== 'up' && action !== 'wheel') {
        throw new Error(`unknown mouse action: ${JSON.stringify(action)}`)
      }
      const x = inputCoordinate(event.x, this._viewport.width, NaN)
      const y = inputCoordinate(event.y, this._viewport.height, NaN)
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('the pointer event has no usable x/y coordinates')
      if (action === 'move') {
        // While a button is held, Chrome needs the pressed button on the move
        // event too: that is what turns a stream of moves into a drag (text
        // selection, sliders, canvas tools). Without it the page sees position
        // changes but never treats the gesture as a drag.
        const heldButton = event.button === undefined || event.button === null
          ? 'none'
          : humanButtonName(event.button)
        if (heldButton === undefined) throw new Error(`unknown mouse button: ${JSON.stringify(event.button)}`)
        return {
          method: 'Input.dispatchMouseEvent',
          params: {
            type: 'mouseMoved',
            x,
            y,
            button: heldButton,
            buttons: this._humanButtons,
            clickCount: 0,
            pointerType: 'mouse',
          },
        }
      }
      if (action === 'wheel') {
        return {
          method: 'Input.dispatchMouseEvent',
          params: {
            type: 'mouseWheel',
            x,
            y,
            deltaX: clampNumber(event.dx, -MAX_WHEEL_DELTA, MAX_WHEEL_DELTA, 0),
            deltaY: clampNumber(event.dy, -MAX_WHEEL_DELTA, MAX_WHEEL_DELTA, 0),
            pointerType: 'mouse',
          },
        }
      }
      const button = humanButtonName(event.button)
      if (!button) throw new Error(`unknown mouse button: ${JSON.stringify(event.button)}`)
      const bits = HUMAN_BUTTON_BITS[button]
      const buttons = action === 'down' ? this._humanButtons | bits : this._humanButtons & ~bits
      // Commands are written in this same order, so later moves in the batch
      // see the new mask. Navigation resets it if a release never arrives.
      this._humanButtons = buttons
      return {
        method: 'Input.dispatchMouseEvent',
        params: {
          type: action === 'down' ? 'mousePressed' : 'mouseReleased',
          x,
          y,
          button,
          buttons,
          clickCount: clampInt(event.clickCount, 1, 3, 1),
          pointerType: 'mouse',
        },
      }
    }
    if (event.t === 'k') {
      if (event.a !== 'down' && event.a !== 'up') throw new Error(`unknown key action: ${JSON.stringify(event.a)}`)
      const key = clampText(event.key, MAX_KEY_FIELD_CHARS)
      if (!key) throw new Error('the key event has no "key"')
      const modifiers = clampInt(event.mods, 0, 15, 0)
      const common = {
        key,
        code: clampText(event.code, MAX_KEY_FIELD_CHARS),
        windowsVirtualKeyCode: clampInt(event.vk, 0, 65_535, 0),
        nativeVirtualKeyCode: clampInt(event.vk, 0, 65_535, 0),
        modifiers,
        location: 0,
        isKeypad: false,
        autoRepeat: false,
      }
      if (event.a === 'up') {
        return { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', ...common } }
      }
      const text = clampText(event.text, MAX_INPUT_TEXT_CHARS)
      if (text && modifiers === 0) {
        return {
          method: 'Input.dispatchKeyEvent',
          params: { type: 'keyDown', ...common, text, unmodifiedText: text },
        }
      }
      return { method: 'Input.dispatchKeyEvent', params: { type: 'rawKeyDown', ...common } }
    }
    if (event.t === 't') {
      const text = clampText(event.text, MAX_INPUT_TEXT_CHARS)
      if (!text) throw new Error('the text event has no text')
      return { method: 'Input.insertText', params: { text } }
    }
    throw new Error(`unknown input event type: ${JSON.stringify(event.t)}`)
  }

  async _pressKey(keyName, modifiers = 0) {
    const spec = parseKeySpec(keyName)
    const base = {
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.vk,
      nativeVirtualKeyCode: spec.vk,
      modifiers,
    }
    if (spec.text !== undefined && modifiers === 0) {
      await this._sendPage('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: spec.text }, 10_000)
    } else {
      await this._sendPage('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, 10_000)
    }
    await this._sendPage('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, 10_000)
  }

  _viewportCenter() {
    return { x: Math.round(this._viewport.width / 2), y: Math.round(this._viewport.height / 2) }
  }

  _emitCursor(x, y, action, label) {
    const payload = {
      x: Math.round(Number(x) * 100) / 100,
      y: Math.round(Number(y) * 100) / 100,
      action,
    }
    if (!Number.isFinite(payload.x) || !Number.isFinite(payload.y)) return
    if (typeof label === 'string' && label) payload.label = label.slice(0, 80)
    this._lastCursor = { x: payload.x, y: payload.y }
    this._emit('cursor', payload)
  }

  // -- public actions -------------------------------------------------------

  /**
   * Navigate the page. Waits up to 15s for load without throwing on timeout.
   * @param {string} url http(s) URL or about:blank
   * @returns {Promise<{url:string,title:string}>}
   */
  async navigate(url) {
    const target = normalizeBrowserUrl(url)
    await this.ensure()
    return this._navigateNormalized(target)
  }

  async _navigateNormalized(target) {
    if (!this._pageReady()) throw new Error('the built-in browser page is not available; call browser_open again')
    const load = this._waitForLoad(NAVIGATION_TIMEOUT_MS, { expectedUrl: target })
    this._setLoading(true)
    let result
    try {
      result = await this._sendPage('Page.navigate', { url: target }, 30_000)
    } catch (error) {
      this._setLoading(false)
      throw new Error(`could not navigate to ${target}: ${errorMessage(error)}`)
    }
    if (result && typeof result.errorText === 'string' && result.errorText) {
      this._setLoading(false)
      throw new Error(`could not navigate to ${target}: ${result.errorText}`)
    }
    try {
      await load
    } catch {
      /* timeouts are reported through state, not thrown */
    }
    this._state.loading = false
    await this._ensurePageActive()
    await this._refreshNavigation()
    return { url: this._state.url, title: this._state.title }
  }

  /** Go back in history. No-op when there is no previous entry. */
  async back() {
    return this._moveHistory(-1)
  }

  /** Go forward in history. No-op when there is no next entry. */
  async forward() {
    return this._moveHistory(1)
  }

  async _moveHistory(delta) {
    await this.ensure()
    let history
    try {
      history = await this._sendPage('Page.getNavigationHistory', {}, 10_000)
    } catch (error) {
      throw new Error(`could not read the browser history: ${errorMessage(error)}`)
    }
    const entries = history && Array.isArray(history.entries) ? history.entries : []
    const currentIndex = Number(history?.currentIndex)
    if (!Number.isFinite(currentIndex) || entries.length === 0) {
      await this._refreshNavigation()
      return { url: this._state.url, title: this._state.title }
    }
    const index = currentIndex + delta
    if (index < 0 || index >= entries.length) {
      this._log('info', delta < 0 ? 'there is no previous page in the browser history' : 'there is no next page in the browser history')
      await this._refreshNavigation()
      return { url: this._state.url, title: this._state.title }
    }
    const load = this._waitForLoad(NAVIGATION_TIMEOUT_MS)
    this._setLoading(true)
    try {
      await this._sendPage('Page.navigateToHistoryEntry', { entryId: entries[index].id }, 15_000)
    } catch (error) {
      this._setLoading(false)
      throw new Error(`could not navigate the browser history: ${errorMessage(error)}`)
    }
    try {
      await load
    } catch {
      /* ignore timeouts */
    }
    this._state.loading = false
    await this._ensurePageActive()
    await this._refreshNavigation()
    return { url: this._state.url, title: this._state.title }
  }

  /** Reload the current page. */
  async reload() {
    await this.ensure()
    const load = this._waitForLoad(NAVIGATION_TIMEOUT_MS)
    this._setLoading(true)
    try {
      await this._sendPage('Page.reload', { ignoreCache: true }, 30_000)
    } catch (error) {
      this._setLoading(false)
      throw new Error(`could not reload the page: ${errorMessage(error)}`)
    }
    try {
      await load
    } catch {
      /* ignore timeouts */
    }
    this._state.loading = false
    await this._ensurePageActive()
    await this._refreshNavigation()
    return { url: this._state.url, title: this._state.title }
  }

  /**
   * Click an element or a viewport coordinate.
   * @param {{ref?:number|string,selector?:string,text?:string,x?:number,y?:number}} [target]
   */
  async click(target = {}) {
    const args = target && typeof target === 'object' ? target : {}
    await this.ensure()
    let point = null
    let label = ''
    const hasCoordinates = Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))
    if (hasCoordinates && args.ref === undefined && !args.selector && !args.text) {
      point = { x: Number(args.x), y: Number(args.y) }
    } else {
      if (args.ref === undefined && !args.selector && !args.text) {
        throw new Error('click needs one of: ref (from browser_snapshot), selector, text, or x/y coordinates')
      }
      const resolved = await this._evaluate(resolveTargetExpression(args), { timeoutMs: 15_000 })
      if (!resolved || resolved.ok !== true) {
        throw new Error(`could not click: ${(resolved && resolved.reason) || 'the target could not be resolved'}`)
      }
      point = { x: Number(resolved.x), y: Number(resolved.y) }
      label = typeof resolved.label === 'string' ? resolved.label : ''
    }
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('could not click: the target coordinates are not finite')
    this._emitCursor(point.x, point.y, 'move')
    await this._dispatchMouse('mouseMoved', point.x, point.y)
    this._emitCursor(point.x, point.y, 'click', label)
    await this._dispatchMouse('mousePressed', point.x, point.y, 1)
    await this._dispatchMouse('mouseReleased', point.x, point.y, 1)
    await this._settleAfterAction()
    return { x: point.x, y: point.y, url: this._state.url, title: this._state.title }
  }

  /**
   * Focus a target and insert text.
   * @param {{ref?:number|string,selector?:string,text:string,clear?:boolean}} target
   */
  async type(target = {}) {
    const args = target && typeof target === 'object' ? target : {}
    if (typeof args.text !== 'string') throw new Error('type requires a string "text" argument')
    await this.ensure()
    let point = null
    let focused = false
    let label = ''
    if (args.ref !== undefined || args.selector) {
      const resolved = await this._evaluate(resolveTargetExpression(args), { timeoutMs: 15_000 })
      if (!resolved || resolved.ok !== true) {
        throw new Error(`could not type: ${(resolved && resolved.reason) || 'the target could not be resolved'}`)
      }
      point = { x: Number(resolved.x), y: Number(resolved.y) }
      focused = resolved.focused === true
      label = typeof resolved.label === 'string' ? resolved.label : ''
    } else {
      const active = await this._evaluate(activeElementExpression(), { timeoutMs: 10_000 })
      if (active && active.ok === true) {
        point = { x: Number(active.x), y: Number(active.y) }
        focused = true
        label = typeof active.label === 'string' ? active.label : ''
      }
    }
    if (!point) throw new Error('could not type: no element is focused; pass ref (from browser_snapshot) or selector')
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('could not type: the target has no usable viewport coordinates')
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      this._emitCursor(point.x, point.y, 'move')
      await this._dispatchMouse('mouseMoved', point.x, point.y)
    }
    if (point && !focused) {
      this._emitCursor(point.x, point.y, 'click', label)
      await this._dispatchMouse('mousePressed', point.x, point.y, 1)
      await this._dispatchMouse('mouseReleased', point.x, point.y, 1)
      await delay(80)
    }
    if (args.clear === true) {
      await this._pressKey('a', 2)
      await delay(40)
      await this._pressKey('Backspace', 0)
      await delay(40)
    }
    const cursor = point && Number.isFinite(point.x) ? point : (this._lastCursor || this._viewportCenter())
    this._emitCursor(cursor.x, cursor.y, 'type', label)
    await this._sendPage('Input.insertText', { text: args.text }, 30_000)
    await this._settleAfterAction()
    return { url: this._state.url, title: this._state.title }
  }

  /**
   * Press a key, e.g. "Enter", "Escape", "Tab", "ArrowDown", "Ctrl+A".
   * @param {{key:string}} [params]
   */
  async key(params = {}) {
    const args = params && typeof params === 'object' ? params : {}
    const raw = typeof args.key === 'string' ? args.key.trim() : ''
    if (!raw) throw new Error('key requires a non-empty "key" string')
    await this.ensure()
    const spec = parseKeySpec(raw)
    const cursor = this._lastCursor || this._viewportCenter()
    this._emitCursor(cursor.x, cursor.y, 'key', spec.key)
    const base = {
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.vk,
      nativeVirtualKeyCode: spec.vk,
      modifiers: spec.modifiers,
    }
    if (spec.text !== undefined && spec.modifiers === 0) {
      await this._sendPage('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: spec.text }, 10_000)
    } else {
      await this._sendPage('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, 10_000)
    }
    await this._sendPage('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, 10_000)
    await this._settleAfterAction()
  }

  /**
   * Scroll the page with a mouse wheel event.
   * @param {{dx?:number,dy?:number,x?:number,y?:number}} [params]
   */
  async scroll(params = {}) {
    const args = params && typeof params === 'object' ? params : {}
    await this.ensure()
    let dx = Number.isFinite(Number(args.dx)) ? Number(args.dx) : 0
    let dy = Number.isFinite(Number(args.dy)) ? Number(args.dy) : 0
    if (dx === 0 && dy === 0) dy = 600
    dx = Math.max(-10_000, Math.min(10_000, dx))
    dy = Math.max(-10_000, Math.min(10_000, dy))
    const base = this._lastCursor || this._viewportCenter()
    const x = Number.isFinite(Number(args.x)) ? Number(args.x) : base.x
    const y = Number.isFinite(Number(args.y)) ? Number(args.y) : base.y
    this._emitCursor(x, y, 'move')
    await this._dispatchMouse('mouseMoved', x, y)
    this._emitCursor(x, y, 'scroll')
    await this._sendPage('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX: dx,
      deltaY: dy,
      pointerType: 'mouse',
    }, 10_000)
    await delay(150)
  }

  /**
   * Dispatch one batch of HUMAN input events from the mirrored panel.
   * Never emits the agent 'cursor' event; never triggers activity/toast, and it
   * does not wait for navigation or refresh state (the page's own events drive
   * the screencast, exactly as if a person used the browser directly).
   *
   * Accepted shapes (all fields optional from the caller's point of view — bad
   * events are skipped instead of failing the batch):
   *   { t:'m', a:'move',  x, y }
   *   { t:'m', a:'down'|'up', x, y, button:'left'|'right'|'middle', clickCount? }
   *   { t:'m', a:'wheel', x, y, dx, dy }
   *   { t:'k', a:'down', key, code, vk, mods?, text? }
   *   { t:'k', a:'up',   key, code, vk, mods? }
   *   { t:'t', text }
   *
   * Coordinates are clamped to the viewport, wheel deltas to ±10000, text to
   * 4000 characters and key/code to 64 characters. At most the first 128 events
   * of one batch are dispatched.
   * @param {Array<object>} events
   * @returns {Promise<{dispatched:number, skipped:number}>} `skipped` counts
   *   invalid events, empty text events and events beyond the 128-event cap.
   */
  async dispatchInput(events) {
    if (!Array.isArray(events)) throw new TypeError('dispatchInput expects an array of input events')
    await this.ensure()
    const count = Math.min(events.length, MAX_INPUT_EVENTS)
    const commands = []
    let skipped = Math.max(0, events.length - MAX_INPUT_EVENTS)
    for (let index = 0; index < count; index += 1) {
      try {
        commands.push(this._humanInputCommand(events[index]))
      } catch {
        // One bad event must not drop the rest of the batch.
        skipped += 1
      }
    }
    // Write the whole batch without awaiting each CDP response: the page still
    // receives the commands in order, and a 60-event drag no longer spends
    // ~8ms per event in round-trip waits before the next panel batch can start.
    let dispatched = 0
    for (const command of commands) {
      try {
        this._sendPage(command.method, command.params, INPUT_EVENT_TIMEOUT_MS).catch((error) => {
          if (this._humanSendWarned) return
          this._humanSendWarned = true
          this._log('warn', `could not forward human input to the page: ${errorMessage(error)}`)
        })
        dispatched += 1
      } catch {
        skipped += 1
      }
    }
    return { dispatched, skipped }
  }

  /**
   * Read the text currently selected in the page.
   * @returns {Promise<string>} at most 100000 characters; the empty string when
   *   no page is running or the selection cannot be read (never throws).
   */
  async selectionText() {
    if (!this._pageReady()) return ''
    try {
      const raw = await this._evaluate(
        "String(window.getSelection ? window.getSelection().toString() : '')",
        { timeoutMs: 5000 },
      )
      return clampText(raw, MAX_SELECTION_CHARS)
    } catch {
      return ''
    }
  }

  /**
   * Internal state of the human mouse buttons currently held down, exposed for
   * diagnostics and the mock checks.
   * @returns {{buttons:number}} CDP `buttons` bit mask (left=1, right=2, middle=4)
   */
  inputState() {
    return { buttons: this._humanButtons }
  }

  /**
   * Poll the page until text and/or a selector appears.
   * @param {{text?:string,selector?:string,timeoutMs?:number}} [params]
   * @returns {Promise<{ok:boolean,reason?:string}>}
   */
  async waitFor(params = {}) {
    const args = params && typeof params === 'object' ? params : {}
    const selector = typeof args.selector === 'string' && args.selector.trim() ? args.selector.trim() : ''
    const text = typeof args.text === 'string' && args.text.length > 0 ? args.text : ''
    if (!selector && !text) throw new Error('waitFor needs at least one of: text, selector')
    await this.ensure()
    const timeoutMs = clampInt(args.timeoutMs, 250, 60_000, 10_000)
    const deadline = Date.now() + timeoutMs
    let last = null
    while (Date.now() < deadline) {
      try {
        const result = await this._evaluate(waitExpression({ selector: selector || null, text: text || null }), { timeoutMs: 5000 })
        if (result && typeof result === 'object' && typeof result.error === 'string') throw new Error(result.error)
        last = result
        const selectorOk = selector ? result?.selectorOk === true : true
        const textOk = text ? result?.textOk === true : true
        if (selectorOk && textOk) return { ok: true }
      } catch (error) {
        if (/invalid CSS selector/.test(errorMessage(error))) throw error
        /* the document may be mid-navigation; retry */
      }
      await delay(200)
    }
    const missing = []
    if (selector && last?.selectorOk !== true) missing.push(`selector ${JSON.stringify(selector)} was not found`)
    if (text && last?.textOk !== true) missing.push(`text ${JSON.stringify(text)} did not appear`)
    return { ok: false, reason: `${missing.join(' and ') || 'the condition was not met'} within ${timeoutMs}ms` }
  }

  /**
   * Return numbered interactive elements plus page text.
   * @param {{maxElements?:number}} [options]
   */
  async snapshot(options = {}) {
    const args = options && typeof options === 'object' ? options : {}
    const maxElements = clampInt(args.maxElements, 1, 500, DEFAULT_MAX_ELEMENTS)
    await this.ensure()
    const value = await this._evaluate(snapshotExpression(maxElements), { timeoutMs: 20_000 })
    if (value && typeof value === 'object' && typeof value.error === 'string') {
      throw new Error(`could not read the page snapshot: ${value.error}`)
    }
    const elements = Array.isArray(value?.elements) ? value.elements : []
    const normalized = elements.map((element) => ({
      ref: Number(element.ref) || 0,
      kind: String(element.kind || 'other'),
      label: String(element.label || ''),
      value: String(element.value || ''),
      selector: String(element.selector || ''),
      x: Number(element.x) || 0,
      y: Number(element.y) || 0,
      w: Number(element.w) || 0,
      h: Number(element.h) || 0,
    }))
    const viewport = value?.viewport && typeof value.viewport === 'object'
      ? { width: clampInt(value.viewport.width, 0, 100_000, this._viewport.width), height: clampInt(value.viewport.height, 0, 100_000, this._viewport.height) }
      : { ...this._viewport }
    return {
      url: String(value?.url || this._state.url || ''),
      title: String(value?.title || this._state.title || ''),
      viewport,
      elements: normalized,
      text: String(value?.text || ''),
      truncated: value?.truncated === true,
    }
  }

  /**
   * Read the page body text or HTML.
   * @param {{format?:'text'|'html',maxChars?:number}} [options]
   */
  async content(options = {}) {
    const args = options && typeof options === 'object' ? options : {}
    const format = args.format === 'html' ? 'html' : 'text'
    const maxChars = clampInt(args.maxChars, 100, MAX_CHARS, DEFAULT_CONTENT_MAX_CHARS)
    await this.ensure()
    const expression = format === 'html'
      ? '(() => { try { return document.body ? String(document.body.innerHTML || "") : "" } catch (e) { return "" } })()'
      : '(() => { try { return document.body ? String(document.body.innerText || "") : "" } catch (e) { return "" } })()'
    const raw = await this._evaluate(expression, { timeoutMs: 20_000 })
    const text = typeof raw === 'string' ? raw : ''
    return { format, text: text.slice(0, maxChars), truncated: text.length > maxChars }
  }

  /**
   * Read the full page source (outerHTML).
   * @param {{maxChars?:number}} [options]
   */
  async source(options = {}) {
    const args = options && typeof options === 'object' ? options : {}
    const maxChars = clampInt(args.maxChars, 100, MAX_CHARS, DEFAULT_SOURCE_MAX_CHARS)
    await this.ensure()
    const raw = await this._evaluate(
      '(() => { try { return document.documentElement ? document.documentElement.outerHTML : "" } catch (e) { return "" } })()',
      { timeoutMs: 20_000 },
    )
    const text = typeof raw === 'string' ? raw : ''
    return { text: text.slice(0, maxChars), truncated: text.length > maxChars }
  }

  /**
   * Capture a JPEG screenshot.
   * @param {{fullPage?:boolean}} [options]
   * @returns {Promise<{data:Buffer,mediaType:'image/jpeg',width:number,height:number}>}
   */
  async screenshot(options = {}) {
    const args = options && typeof options === 'object' ? options : {}
    await this.ensure()
    if (args.fullPage === true) {
      let contentSize = null
      try {
        const metrics = await this._sendPage('Page.getLayoutMetrics', {}, 10_000)
        contentSize = metrics?.cssContentSize || metrics?.contentSize || null
      } catch {
        contentSize = null
      }
      const width = contentSize ? clampInt(contentSize.width, 1, MAX_FULL_PAGE_WIDTH, this._viewport.width) : this._viewport.width
      const height = contentSize ? clampInt(contentSize.height, 1, MAX_FULL_PAGE_HEIGHT, this._viewport.height) : this._viewport.height
      try {
        await this._sendPage('Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        }, 15_000)
        const captured = await this._sendPage('Page.captureScreenshot', { format: 'jpeg', quality: 80, captureBeyondViewport: true }, 30_000)
        if (!captured || typeof captured.data !== 'string') throw new Error('the browser returned no screenshot data')
        return { data: Buffer.from(captured.data, 'base64'), mediaType: 'image/jpeg', width, height }
      } finally {
        try {
          await this._sendPage('Emulation.setDeviceMetricsOverride', {
            width: this._viewport.width,
            height: this._viewport.height,
            deviceScaleFactor: 1,
            mobile: false,
          }, 10_000)
        } catch {
          /* ignore */
        }
      }
    }
    const captured = await this._sendPage('Page.captureScreenshot', { format: 'jpeg', quality: 80 }, 30_000)
    if (!captured || typeof captured.data !== 'string') throw new Error('the browser returned no screenshot data')
    return {
      data: Buffer.from(captured.data, 'base64'),
      mediaType: 'image/jpeg',
      width: this._viewport.width,
      height: this._viewport.height,
    }
  }

  // -- activity -------------------------------------------------------------

  /**
   * Reference-counted "the agent is operating the browser" flag.
   * @param {string|undefined|null} sessionId
   * @param {boolean} active
   * @param {string} [label] tool name shown by the client toast
   */
  setActivity(sessionId, active, label) {
    const key = typeof sessionId === 'string' && sessionId ? sessionId : '__anonymous__'
    const nextLabel = typeof label === 'string' && label ? label : undefined
    if (active === true) {
      this._activityCounts.set(key, (this._activityCounts.get(key) || 0) + 1)
      this._activity = {
        active: true,
        ...(key !== '__anonymous__' ? { sessionId: key } : {}),
        ...(nextLabel ? { label: nextLabel } : {}),
      }
      this._emit('activity', { ...this._activity })
      return
    }
    const current = this._activityCounts.get(key) || 0
    if (current <= 0) return
    if (current === 1) this._activityCounts.delete(key)
    else this._activityCounts.set(key, current - 1)
    let total = 0
    for (const count of this._activityCounts.values()) total += count
    if (total === 0) {
      this._activity = { active: false }
      this._emit('activity', { active: false })
      return
    }
    const nextSession = [...this._activityCounts.keys()].find((candidate) => candidate !== '__anonymous__')
    this._activity = {
      active: true,
      ...(nextSession ? { sessionId: nextSession } : {}),
      ...(nextLabel ? { label: nextLabel } : this._activity.label ? { label: this._activity.label } : {}),
    }
    this._emit('activity', { ...this._activity })
  }

  // -- cookies --------------------------------------------------------------

  /** List all cookies held by the built-in browser profile. */
  async listCookies() {
    await this.ensure()
    let result
    try {
      result = await this._sendPage('Network.getAllCookies', {}, 20_000)
    } catch (networkError) {
      try {
        // Newer Chrome builds prefer the Storage domain; fall back when the
        // deprecated Network command is unavailable.
        result = await this._cdp.send('Storage.getCookies', {}, undefined, 20_000)
      } catch (storageError) {
        throw new Error(`could not read the browser cookies: ${errorMessage(networkError)}; fallback: ${errorMessage(storageError)}`)
      }
    }
    const cookies = Array.isArray(result?.cookies) ? result.cookies : []
    return cookies.map((cookie) => ({
      domain: String(cookie.domain || ''),
      name: String(cookie.name || ''),
      path: String(cookie.path || '/'),
      value: String(cookie.value ?? ''),
      secure: cookie.secure === true,
      httpOnly: cookie.httpOnly === true,
      ...(Number.isFinite(cookie.expires) && cookie.expires > 0 ? { expires: cookie.expires } : {}),
      ...(typeof cookie.sameSite === 'string' && cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
    }))
  }

  /** Clear every cookie in the built-in browser profile. */
  async clearCookies() {
    await this.ensure()
    try {
      await this._sendPage('Network.clearBrowserCookies', {}, 20_000)
    } catch (networkError) {
      try {
        await this._cdp.send('Storage.clearCookies', {}, undefined, 20_000)
      } catch (storageError) {
        throw new Error(`could not clear the browser cookies: ${errorMessage(networkError)}; fallback: ${errorMessage(storageError)}`)
      }
    }
    this._log('info', 'cleared all browser cookies')
    return { cleared: true }
  }

  /**
   * Write cookies into the built-in browser.
   * @param {Array<{domain?:string,name:string,value?:string,path?:string,secure?:boolean,httpOnly?:boolean,expires?:number,sameSite?:string,url?:string}>} cookies
   */
  async setCookies(cookies) {
    if (!Array.isArray(cookies)) throw new Error('setCookies expects an array of cookie objects')
    await this.ensure()
    let set = 0
    let failed = 0
    const errors = []
    for (const raw of cookies) {
      try {
        if (!raw || typeof raw !== 'object') throw new Error('the cookie entry is not an object')
        const name = typeof raw.name === 'string' ? raw.name : ''
        if (!name) throw new Error('the cookie has no name')
        const value = raw.value === undefined || raw.value === null ? '' : String(raw.value)
        const domain = typeof raw.domain === 'string' ? raw.domain.trim() : ''
        const path = typeof raw.path === 'string' && raw.path.startsWith('/') ? raw.path : '/'
        const secure = raw.secure === true
        const httpOnly = raw.httpOnly === true
        let url = typeof raw.url === 'string' && raw.url ? raw.url : ''
        if (!url) {
          if (domain) {
            url = `${secure ? 'https' : 'http'}://${domain.replace(/^\./, '')}${path}`
          } else if (/^https?:\/\//i.test(this._state.url)) {
            try {
              url = new URL(this._state.url).origin + path
            } catch {
              url = `http://localhost${path}`
            }
          } else {
            url = `http://localhost${path}`
          }
        }
        const params = { name, value, url, path, secure, httpOnly }
        if (domain) params.domain = domain
        if (Number.isFinite(raw.expires) && raw.expires > 0) params.expires = raw.expires
        if (typeof raw.sameSite === 'string' && raw.sameSite) {
          const lowered = raw.sameSite.toLowerCase()
          if (lowered === 'none') params.sameSite = 'None'
          else if (lowered === 'lax') params.sameSite = 'Lax'
          else if (lowered === 'strict') params.sameSite = 'Strict'
        }
        const result = await this._sendPage('Network.setCookie', params, 15_000)
        if (result && result.success === false) throw new Error('the browser rejected the cookie')
        set += 1
      } catch (error) {
        failed += 1
        if (errors.length < 20) errors.push(errorMessage(error))
      }
    }
    this._log('info', `cookie import finished: ${set} written, ${failed} failed`)
    return { set, failed, errors }
  }

  // -- misc -----------------------------------------------------------------

  /**
   * Emit one engine `log` event. Used by sibling Host modules (cookie import,
   * HTTP actions) that only have the engine reference to log through.
   * @param {'info'|'warn'|'error'} level
   * @param {string} text
   */
  log(level, text) {
    this._log(level === 'warn' || level === 'error' ? level : 'info', text)
  }

  /** Last activity timestamp for debug output. */
  get lastInteractionAt() {
    return this._lastCursor ? Date.now() : null
  }
}

export default BrowserEngine
