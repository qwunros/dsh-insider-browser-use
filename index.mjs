import { homedir } from 'node:os'
import { join } from 'node:path'
import { BrowserEngine } from './src/host/engine.mjs'
import { registerTools } from './src/host/tools.mjs'
import { registerRoutes } from './src/host/http.mjs'

/**
 * Host half of the built-in browser: one lazily started Chrome/Edge instance
 * driven over CDP, the model-facing `browser_*` tools, the right-sidebar SSE
 * and action routes, and the cookie settings endpoints.
 *
 * Everything is registered as an effect so unloading the plugin closes the
 * browser and every route/subscriber with it.
 */
export const inject = ['webServer', 'tools', 'systemPrompt']

export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const configObject = config && typeof config === 'object' ? config : {}
  const engine = new BrowserEngine({
    profileDir: configObject.profileDir || join(home, 'insider-browser', 'profile'),
    browserPath: configObject.browserPath,
    browserChannel: configObject.browserChannel,
    startUrl: configObject.startUrl,
    viewport: configObject.viewport || { width: 1280, height: 800 },
  }, ctx.logger)

  ctx.effect(() => engine.on('log', (entry) => {
    if (!entry || typeof entry.text !== 'string') return
    const logger = ctx.logger
    if (entry.level === 'error') logger?.error?.(`[insider-browser] ${entry.text}`)
    else if (entry.level === 'warn') logger?.warn?.(`[insider-browser] ${entry.text}`)
    else logger?.info?.(`[insider-browser] ${entry.text}`)
  }), 'insider-browser: engine log')

  ctx.effect(() => () => engine.stop(), 'insider-browser: browser lifetime')

  registerTools(ctx, engine, configObject)
  ctx.effect(() => registerRoutes(ctx, engine, configObject), 'insider-browser: routes')

  ctx.logger?.info?.('[insider-browser] mounted; the browser starts on first use')
}
