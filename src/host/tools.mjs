/**
 * dsh-insider-browser — model-facing `browser_*` tools.
 *
 * Hand-written JSON Schemas (the registry's supported subset: `type`,
 * `properties`, `required` as a string array, `additionalProperties`, `items`,
 * `enum`) plus an English system-prompt section. Every tool validates its own
 * arguments and wraps the call in an engine activity reference so the right
 * sidebar opens and the "dsh is operating the browser" toast shows while the
 * call is running.
 */

const TOOL_TIMEOUT_MS = 60_000
const DEFAULT_MAX_ELEMENTS = 120

// ---------------------------------------------------------------------------
// Shared schema fragments
// ---------------------------------------------------------------------------

const ELEMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ref: { type: 'integer', description: 'Stable-within-one-snapshot element number.' },
    kind: { type: 'string' },
    label: { type: 'string' },
    value: { type: 'string' },
    selector: { type: 'string' },
    x: { type: 'number' },
    y: { type: 'number' },
    w: { type: 'number' },
    h: { type: 'number' },
  },
  required: ['ref', 'kind', 'label', 'value', 'selector', 'x', 'y', 'w', 'h'],
}

const VIEWPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    width: { type: 'integer' },
    height: { type: 'integer' },
  },
  required: ['width', 'height'],
}

const SNAPSHOT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url: { type: 'string' },
    title: { type: 'string' },
    viewport: VIEWPORT_SCHEMA,
    text: { type: 'string' },
    elements: { type: 'array', items: ELEMENT_SCHEMA },
    truncated: { type: 'boolean' },
  },
  required: ['url', 'title', 'viewport', 'text', 'elements', 'truncated'],
}

const LOCATION_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url: { type: 'string' },
    title: { type: 'string' },
  },
  required: ['url', 'title'],
}

/** Fresh empty parameter schema per tool (registration keeps the object). */
function emptyParameters() {
  return { type: 'object', properties: {}, required: [], additionalProperties: false }
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function truncate(text, limit) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n…(truncated, ${value.length - limit} more characters)`
}

/** Render a snapshot value as compact, model-readable text. */
function formatSnapshot(value) {
  const lines = []
  lines.push(`URL: ${value?.url || '(none)'}`)
  lines.push(`Title: ${value?.title || '(untitled)'}`)
  if (value?.viewport) lines.push(`Viewport: ${value.viewport.width}x${value.viewport.height} CSS px`)
  lines.push('')
  const elements = Array.isArray(value?.elements) ? value.elements : []
  if (elements.length === 0) {
    lines.push('Interactive elements: (none found)')
  } else {
    lines.push(`Interactive elements (${elements.length}):`)
    for (const element of elements) {
      const valueText = element.value ? ` value=${JSON.stringify(truncate(element.value, 80))}` : ''
      const selector = element.selector ? ` {${element.selector}}` : ''
      lines.push(`[${element.ref}] ${element.kind}: ${truncate(element.label, 120)}${valueText} (${Math.round(element.x)},${Math.round(element.y)})${selector}`)
    }
  }
  if (value?.truncated === true) lines.push('(snapshot truncated: there are more interactive elements or page text)')
  lines.push('')
  lines.push('Page text:')
  lines.push(value?.text ? truncate(value.text, 12_000) : '(no visible page text)')
  return lines.join('\n')
}

function formatContent(value) {
  const header = `Page content (${value.format}, ${value.text.length} characters${value.truncated ? ', truncated' : ''}):`
  return `${header}\n\n${value.text}`
}

function formatSource(value) {
  return `Page source (${value.text.length} characters${value.truncated ? ', truncated' : ''}):\n\n${value.text}`
}

function formatLocation(prefix, value) {
  return `${prefix}\nURL: ${value.url || '(none)'}\nTitle: ${value.title || '(untitled)'}`
}

// ---------------------------------------------------------------------------
// Argument validation (the registry does not validate raw definitions)
// ---------------------------------------------------------------------------

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`"${name}" must be a non-empty string`)
  }
  return value
}

function optionalString(value, name) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`"${name}" must be a string when provided`)
  return value
}

function optionalInteger(value, name, min, max) {
  if (value === undefined || value === null) return undefined
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) throw new Error(`"${name}" must be a number when provided`)
  return Math.min(max, Math.max(min, Math.round(number)))
}

function optionalBoolean(value, name) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new Error(`"${name}" must be a boolean when provided`)
  return value
}

/** Best-effort image-capability probe for the calling model route. */
async function imageRouteProblem(ctx, exec) {
  try {
    const routed = exec?.agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? exec?.agent?.options?.provider
    const model = routed?.model ?? exec?.agent?.options?.model
    const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    if (!provider || !model || !llm || typeof llm.resolveModelInfo !== 'function') return null
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    const modalities = Array.isArray(info?.inputModalities) ? info.inputModalities : null
    if (modalities === null || modalities.includes('image')) return null
    return `model "${String(model)}" does not declare image input, so the screenshot image cannot be shown to you; switch to an image-capable model, or read the page with browser_snapshot / browser_content instead`
  } catch {
    // Capability probing is advisory: never fail a screenshot because the
    // route could not be resolved.
    return null
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT_SECTION = [
  'Use the browser_* tools to operate the built-in browser shown live in the right sidebar. It is a real headless browser with a persistent profile, so site logins survive between calls; the user can watch every navigation, click and keystroke on the mirrored view.',
  '',
  '- Start with browser_open (or browser_snapshot when a page is already open). browser_snapshot returns numbered interactive elements; cite those numbers (ref) in browser_click and browser_type instead of guessing selectors or coordinates.',
  '- Read pages with browser_content (text) or browser_source (HTML). Do not use the browser to fetch static pages that web_fetch can read faster.',
  '- Use browser_screenshot only when visual judgement is needed. It requires an image-capable model and saves the JPEG as an attachment.',
  '- Prefer browser_wait_for after navigating slow or scripted pages, then re-snapshot.',
  '- If a page shows a CAPTCHA or human-verification challenge, stop retrying: ask the user to complete it in the sidebar panel (or try another site/approach), then snapshot again.',
  '- One built-in browser is shared by every session; do not assume a page you did not open is still on the same URL.',
  '- Close the browser with browser_close when the task no longer needs it, and report what you saw on the page to the user.',
].join('\n')

/**
 * Register every `browser_*` tool plus the system-prompt guidance section.
 * @param {object} ctx plugin context (tools + systemPrompt + optional attachments)
 * @param {import('./engine.mjs').BrowserEngine} engine
 * @param {object} [config]
 */
export function registerTools(ctx, engine, config) {
  if (!ctx || !engine) throw new Error('registerTools requires a plugin context and a BrowserEngine')
  const options = config && typeof config === 'object' ? config : {}

  // -- system prompt ------------------------------------------------------
  try {
    if (ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
      ctx.systemPrompt.section({
        name: 'tool:insider-browser',
        order: 150,
        text: SYSTEM_PROMPT_SECTION,
      })
    }
  } catch (error) {
    logWarn(ctx, `could not register the insider-browser system prompt section: ${errorMessage(error)}`)
  }

  // -- helpers ------------------------------------------------------------
  const register = (definition) => {
    try {
      ctx.tools.register(definition)
    } catch (error) {
      logWarn(ctx, `could not register ${definition.name}: ${errorMessage(error)}`)
    }
  }

  /**
   * Run one tool body with a reference-counted activity flag.
   * The `finally` always runs, so a thrown tool error cannot leave the toast on.
   */
  const withActivity = async (exec, label, body) => {
    const sessionId = exec && exec.agent ? exec.agent.id : undefined
    engine.setActivity(sessionId, true, label)
    try {
      return await body()
    } finally {
      engine.setActivity(sessionId, false)
    }
  }

  // -- open ---------------------------------------------------------------
  register({
    name: 'browser_open',
    description: 'Open an http(s) URL in the built-in browser and return its snapshot (URL, title, viewport, page text, numbered interactive elements). The browser appears automatically in the right sidebar. This starts the browser on first use; it can take a few seconds.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'The http:// or https:// URL to open.' },
        maxElements: { type: 'integer', description: `Maximum interactive elements to list (default ${DEFAULT_MAX_ELEMENTS}).` },
      },
      required: ['url'],
    },
    output: {
      schema: SNAPSHOT_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const url = requireNonEmptyString(args?.url, 'url')
      const maxElements = optionalInteger(args?.maxElements, 'maxElements', 1, 500)
      return withActivity(exec, 'browser_open', async () => {
        await engine.navigate(url)
        return engine.snapshot({ maxElements: maxElements ?? DEFAULT_MAX_ELEMENTS })
      })
    },
  })

  // -- snapshot -----------------------------------------------------------
  register({
    name: 'browser_snapshot',
    description: 'Return a snapshot of the current built-in browser page: numbered interactive elements (links, buttons, inputs) plus the visible page text. Use it to understand a page and to get refs for browser_click/browser_type. Refs are reassigned on every snapshot, so take a fresh snapshot after the page changes.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxElements: { type: 'integer', description: `Maximum interactive elements to list (default ${DEFAULT_MAX_ELEMENTS}).` },
      },
      required: [],
    },
    output: {
      schema: SNAPSHOT_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const maxElements = optionalInteger(args?.maxElements, 'maxElements', 1, 500)
      return withActivity(exec, 'browser_snapshot', async () => engine.snapshot({ maxElements: maxElements ?? DEFAULT_MAX_ELEMENTS }))
    },
  })

  // -- content ------------------------------------------------------------
  register({
    name: 'browser_content',
    description: 'Read the current built-in browser page as plain text (default) or as HTML. Use this (or browser_source) to extract information without screenshots.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        format: { type: 'string', enum: ['text', 'html'], description: 'text (default) returns the visible body text; html returns the body HTML.' },
        maxChars: { type: 'integer', description: 'Maximum characters to return (default 20000).' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          format: { type: 'string' },
          text: { type: 'string' },
          truncated: { type: 'boolean' },
        },
        required: ['format', 'text', 'truncated'],
      },
      render: (_args, value) => [{ type: 'text', text: formatContent(value) }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const format = optionalString(args?.format, 'format')
      if (format !== undefined && format !== 'text' && format !== 'html') throw new Error('"format" must be "text" or "html"')
      const maxChars = optionalInteger(args?.maxChars, 'maxChars', 100, 2_000_000)
      return withActivity(exec, 'browser_content', async () => engine.content({ format: format ?? 'text', maxChars }))
    },
  })

  // -- source -------------------------------------------------------------
  register({
    name: 'browser_source',
    description: 'Return the full HTML source (outerHTML) of the current built-in browser page. Use browser_content for readable text; use this only when you need the raw markup.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxChars: { type: 'integer', description: 'Maximum characters to return (default 200000).' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          truncated: { type: 'boolean' },
        },
        required: ['text', 'truncated'],
      },
      render: (_args, value) => [{ type: 'text', text: formatSource(value) }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const maxChars = optionalInteger(args?.maxChars, 'maxChars', 100, 2_000_000)
      return withActivity(exec, 'browser_source', async () => engine.source({ maxChars }))
    },
  })

  // -- screenshot ---------------------------------------------------------
  register({
    name: 'browser_screenshot',
    description: 'Capture a JPEG screenshot of the current built-in browser page and return it as an image. Use this only when visual judgement is needed; browser_snapshot/browser_content are cheaper for reading content. Requires a model that accepts image input.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        fullPage: { type: 'boolean', description: 'Capture the whole scrollable page instead of the current viewport (default false).' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          attachmentId: { type: 'string' },
          mediaType: { type: 'string' },
          bytes: { type: 'integer' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          fullPage: { type: 'boolean' },
        },
        required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height', 'fullPage'],
      },
      render: (_args, value) => [
        { type: 'text', text: `Screenshot ${value.width}x${value.height} (${value.bytes} bytes, ${value.mediaType})${value.fullPage ? ' of the full page' : ' of the viewport'}.` },
        { type: 'image', attachment: { attachmentId: value.attachmentId, mediaType: value.mediaType, bytes: value.bytes, width: value.width, height: value.height } },
      ],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const fullPage = optionalBoolean(args?.fullPage, 'fullPage') === true
      return withActivity(exec, 'browser_screenshot', async () => {
        const attachments = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined
        if (!attachments || typeof attachments.saveImage !== 'function') {
          throw new Error('cannot return a screenshot: the image attachment service is not mounted in this deployment, so images cannot be delivered to the model')
        }
        const shot = await engine.screenshot({ fullPage })
        const reference = await attachments.saveImage({ data: shot.data, mediaType: shot.mediaType, name: 'browser-shot.jpg' })
        const problem = await imageRouteProblem(ctx, exec)
        if (problem) {
          throw new Error(`screenshot saved as attachment "${String(reference.attachmentId)}", but ${problem}`)
        }
        return {
          attachmentId: String(reference.attachmentId),
          mediaType: String(reference.mediaType || shot.mediaType),
          bytes: Number.isFinite(reference.bytes) ? reference.bytes : shot.data.length,
          width: Number.isFinite(reference.width) ? reference.width : shot.width,
          height: Number.isFinite(reference.height) ? reference.height : shot.height,
          fullPage,
        }
      })
    },
  })

  // -- click --------------------------------------------------------------
  register({
    name: 'browser_click',
    description: 'Click an element on the current built-in browser page. Prefer a ref from browser_snapshot; selector or visible text also work, or pass viewport x/y coordinates (CSS pixels). Scrolls the target into view first and shows the virtual cursor.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ref: { type: 'integer', description: 'Element ref from the most recent browser_snapshot / browser_open.' },
        selector: { type: 'string', description: 'CSS selector for the element to click.' },
        text: { type: 'string', description: 'Visible text of the element to click (case-insensitive).' },
        x: { type: 'number', description: 'Viewport X in CSS pixels (with y).' },
        y: { type: 'number', description: 'Viewport Y in CSS pixels (with x).' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          url: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['x', 'y', 'url', 'title'],
      },
      render: (_args, value) => [{ type: 'text', text: formatLocation(`Clicked at viewport (${Math.round(value.x)}, ${Math.round(value.y)}).`, value) }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const ref = optionalInteger(args?.ref, 'ref', 0, 1_000_000)
      const selector = optionalString(args?.selector, 'selector')
      const text = optionalString(args?.text, 'text')
      const x = args?.x === undefined || args?.x === null ? undefined : Number(args.x)
      const y = args?.y === undefined || args?.y === null ? undefined : Number(args.y)
      if (ref === undefined && !selector && !text && !(Number.isFinite(x) && Number.isFinite(y))) {
        throw new Error('browser_click needs one of: ref, selector, text, or x/y coordinates')
      }
      if ((x !== undefined && !Number.isFinite(x)) || (y !== undefined && !Number.isFinite(y))) {
        throw new Error('"x" and "y" must both be finite numbers')
      }
      const target = {}
      if (ref !== undefined) target.ref = ref
      if (selector) target.selector = selector
      if (text) target.text = text
      if (Number.isFinite(x) && Number.isFinite(y)) {
        target.x = x
        target.y = y
      }
      return withActivity(exec, 'browser_click', async () => engine.click(target))
    },
  })

  // -- type ---------------------------------------------------------------
  register({
    name: 'browser_type',
    description: 'Type text into an input, textarea or contenteditable element on the current built-in browser page. Pass a ref from browser_snapshot (or a selector); without a target it types into the currently focused element. Set clear:true to replace existing content.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'The text to insert.' },
        ref: { type: 'integer', description: 'Element ref from the most recent snapshot.' },
        selector: { type: 'string', description: 'CSS selector of the field to type into.' },
        clear: { type: 'boolean', description: 'Select-all and delete existing content before typing (default false).' },
      },
      required: ['text'],
    },
    output: {
      schema: LOCATION_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: formatLocation('Typed into the page.', value) }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const text = args?.text
      if (typeof text !== 'string') throw new Error('"text" must be a string')
      const ref = optionalInteger(args?.ref, 'ref', 0, 1_000_000)
      const selector = optionalString(args?.selector, 'selector')
      const clear = optionalBoolean(args?.clear, 'clear') === true
      if (ref !== undefined && selector) throw new Error('pass either "ref" or "selector", not both')
      const target = { text, clear }
      if (ref !== undefined) target.ref = ref
      if (selector) target.selector = selector
      return withActivity(exec, 'browser_type', async () => engine.type(target))
    },
  })

  // -- key ----------------------------------------------------------------
  register({
    name: 'browser_key',
    description: 'Press a keyboard key on the current built-in browser page, e.g. Enter, Escape, Tab, ArrowDown, Backspace, PageDown, or a modified key like Ctrl+A. Use it to submit forms or dismiss overlays after browser_type.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        key: { type: 'string', description: 'Key name such as Enter, Escape, Tab, ArrowDown, Ctrl+A.' },
      },
      required: ['key'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string' },
          url: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['key', 'url', 'title'],
      },
      render: (_args, value) => [{ type: 'text', text: formatLocation(`Pressed ${value.key}.`, value) }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const key = requireNonEmptyString(args?.key, 'key')
      return withActivity(exec, 'browser_key', async () => {
        await engine.key({ key })
        const status = engine.status
        return { key, url: status.url, title: status.title }
      })
    },
  })

  // -- scroll -------------------------------------------------------------
  register({
    name: 'browser_scroll',
    description: 'Scroll the current built-in browser page with a mouse wheel. Positive dy scrolls down, negative up; dx scrolls horizontally. Defaults to 600px down at the viewport center.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dx: { type: 'number', description: 'Horizontal delta in CSS pixels (default 0).' },
        dy: { type: 'number', description: 'Vertical delta in CSS pixels (default 600).' },
        x: { type: 'number', description: 'Viewport X where the wheel event is sent (default: current cursor).' },
        y: { type: 'number', description: 'Viewport Y where the wheel event is sent (default: current cursor).' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dx: { type: 'number' },
          dy: { type: 'number' },
          url: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['dx', 'dy', 'url', 'title'],
      },
      render: (_args, value) => [{ type: 'text', text: formatLocation(`Scrolled by (${value.dx}, ${value.dy}).`, value) }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const dx = args?.dx === undefined || args?.dx === null ? 0 : Number(args.dx)
      const dy = args?.dy === undefined || args?.dy === null ? 0 : Number(args.dy)
      if (args?.dx !== undefined && args?.dx !== null && !Number.isFinite(dx)) throw new Error('"dx" must be a finite number')
      if (args?.dy !== undefined && args?.dy !== null && !Number.isFinite(dy)) throw new Error('"dy" must be a finite number')
      const x = args?.x === undefined || args?.x === null ? undefined : Number(args.x)
      const y = args?.y === undefined || args?.y === null ? undefined : Number(args.y)
      if ((x !== undefined && !Number.isFinite(x)) || (y !== undefined && !Number.isFinite(y))) throw new Error('"x" and "y" must be finite numbers')
      const params = { dx, dy }
      if (Number.isFinite(x)) params.x = x
      if (Number.isFinite(y)) params.y = y
      return withActivity(exec, 'browser_scroll', async () => {
        await engine.scroll(params)
        const status = engine.status
        const effectiveDx = dx
        const effectiveDy = dx === 0 && dy === 0 ? 600 : dy
        return { dx: effectiveDx, dy: effectiveDy, url: status.url, title: status.title }
      })
    },
  })

  // -- wait_for -----------------------------------------------------------
  register({
    name: 'browser_wait_for',
    description: 'Wait until text appears on the page or a CSS selector matches. Returns {ok:false, reason} when the condition is not met before the timeout, so you can decide whether to re-snapshot or give up. Prefer this over guessing after a slow navigation.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'Visible page text to wait for.' },
        selector: { type: 'string', description: 'CSS selector to wait for.' },
        timeoutMs: { type: 'integer', description: 'Maximum wait in milliseconds (default 10000).' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          reason: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: value.ok ? 'Condition met.' : `Condition not met: ${value.reason || 'timed out'}` }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const text = optionalString(args?.text, 'text')
      const selector = optionalString(args?.selector, 'selector')
      if (!text && !selector) throw new Error('browser_wait_for needs at least one of: text, selector')
      const timeoutMs = optionalInteger(args?.timeoutMs, 'timeoutMs', 250, 55_000)
      return withActivity(exec, 'browser_wait_for', async () => engine.waitFor({ text: text || undefined, selector: selector || undefined, timeoutMs }))
    },
  })

  // -- history ------------------------------------------------------------
  const historyTool = (name, description, action, label) => {
    register({
      name,
      description,
      parameters: emptyParameters(),
      output: {
        schema: LOCATION_OUTPUT,
        render: (_args, value) => [{ type: 'text', text: formatLocation(label, value) }],
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return withActivity(exec, name, async () => action())
      },
    })
  }
  historyTool('browser_back', 'Navigate back in the built-in browser history. Returns the resulting URL and title (a no-op when there is no previous page).', () => engine.back(), 'Went back.')
  historyTool('browser_forward', 'Navigate forward in the built-in browser history. Returns the resulting URL and title (a no-op when there is no next page).', () => engine.forward(), 'Went forward.')
  historyTool('browser_reload', 'Reload the current built-in browser page and return the resulting URL and title.', () => engine.reload(), 'Reloaded.')

  // -- close --------------------------------------------------------------
  register({
    name: 'browser_close',
    description: 'Close the built-in browser and stop the headless Chrome/Edge process. The next browser_* call starts it again with the same persistent profile.',
    parameters: emptyParameters(),
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          closed: { type: 'boolean' },
        },
        required: ['closed'],
      },
      render: () => [{ type: 'text', text: 'Built-in browser closed.' }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return withActivity(exec, 'browser_close', async () => {
        await engine.stop()
        return { closed: true }
      })
    },
  })
}

function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function logWarn(ctx, message) {
  try {
    if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn(`[insider-browser] ${message}`)
    else console.warn(`[insider-browser] ${message}`)
  } catch {
    /* ignore */
  }
}
