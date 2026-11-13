// Host-side wiring check: load index.mjs against a fake Cordis context and make
// sure the plugin registers its routes, prompt section and tools without a
// running Chrome. Chrome-dependent behavior is covered by engine-check.mjs --mock.
import { pathToFileURL } from 'node:url'

const disposers = []
const tools = new Map()
const sections = []
const routes = []
const effects = []

const fakeCtx = {
  logger: { info() {}, warn() {}, error() {} },
  effect(callback, label) {
    const dispose = callback()
    effects.push({ label, dispose })
    if (typeof dispose === 'function') disposers.push(dispose)
    return () => {}
  },
  tools: {
    register(definition) {
      if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  },
  systemPrompt: {
    section(section) {
      sections.push(section)
      return () => {}
    },
  },
  webServer: {
    getOrigin: () => 'http://127.0.0.1:3080',
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  get(name) {
    return undefined // no attachments in this wiring check
  },
}

const plugin = await import(new URL('../index.mjs', import.meta.url).href)
plugin.apply(fakeCtx, {})

const problems = []
const expect = (condition, message) => { if (!condition) problems.push(message) }

expect(typeof plugin.apply === 'function', 'index.mjs must export apply()')
expect(Array.isArray(plugin.inject) && plugin.inject.includes('webServer'), 'index.mjs must inject webServer')
expect(routes.length === 3, `expected 3 HTTP routes, got ${routes.length}`)
const paths = routes.map((route) => route.path).sort()
expect(paths.join(',') === '/dsh-insider-browser/action,/dsh-insider-browser/events,/dsh-insider-browser/state',
  `unexpected route paths: ${paths.join(',')}`)
expect(sections.some((section) => section.name === 'tool:insider-browser' && typeof section.text === 'string'),
  'missing tool:insider-browser prompt section')

const expectedTools = [
  'browser_open', 'browser_snapshot', 'browser_content', 'browser_source', 'browser_screenshot',
  'browser_click', 'browser_type', 'browser_key', 'browser_scroll', 'browser_wait_for',
  'browser_back', 'browser_forward', 'browser_reload', 'browser_close',
]
for (const name of expectedTools) {
  const tool = tools.get(name)
  expect(tool !== undefined, `missing tool ${name}`)
  if (tool === undefined) continue
  expect(typeof tool.description === 'string' && tool.description.length > 20, `${name}: description too short`)
  expect(tool.parameters && tool.parameters.type === 'object', `${name}: parameters must be an object schema`)
  expect(Array.isArray(tool.parameters.required), `${name}: parameters.required must be an array`)
  expect(tool.output && typeof tool.output.render === 'function', `${name}: output.render must be a function`)
  expect(tool.output && tool.output.schema && typeof tool.output.schema === 'object', `${name}: output.schema missing`)
  expect(typeof tool.execute === 'function', `${name}: execute missing`)
  expect(tool.timeoutMs === 60000, `${name}: timeoutMs should be 60000`)
}

// Dispose every effect the plugin installed; none may throw with no browser running.
for (const effect of effects.reverse()) {
  try {
    if (typeof effect.dispose === 'function') await effect.dispose()
  } catch (error) {
    problems.push(`dispose "${effect.label}" threw: ${error && error.message ? error.message : String(error)}`)
  }
}

if (problems.length > 0) {
  console.error(`host wiring check FAILED (${problems.length} problem(s)):`)
  for (const problem of problems) console.error(` - ${problem}`)
  process.exit(1)
}
console.log(`host wiring check passed: ${tools.size} tools, ${sections.length} prompt section(s), ${routes.length} routes, ${effects.length} effects disposed`)
