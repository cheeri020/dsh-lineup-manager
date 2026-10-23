/**
 * dsh-lineup-manager — Host half.
 *
 * Provides a small HTTP API the browser half uses to read and write the
 * model-lineup allowlists that live in the profile's `cordis.patch.yml`,
 * under `id: llm-pi-ai` → `config.providers.<provider>.models`.
 *
 * Design notes:
 * - The lineup list a provider shows is exactly the `models:` array declared
 *   for it. A provider with no `models:` key falls back to the adapter's full
 *   catalog — that is why a "mostly hidden" provider suddenly shows hundreds
 *   of entries. Editing that array is the whole point of this plugin.
 * - Writes are surgical: we replace only the `models:` line block of the
 *   provider being edited, so unrelated config (apiKeyEnv, baseURL, other
 *   sections) is never rewritten. A full YAML round-trip would reformat and
 *   reorder the user's file, which is a real hazard on a file whose corruption
 *   prevents DSH from starting.
 * - Every write is preceded by a timestamped backup and followed by a
 *   structural re-read; on mismatch we restore the backup and report failure.
 *
 * Registration follows the documented cleanup contract: routes are wired
 * through `ctx.effect(() => webServer.register(...))` so an unload (disable,
 * update, HMR) unregisters them.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

export const name = 'dsh-lineup-manager'

export const inject = ['webServer']

/**
 * Internals exposed for tests only. The host never reads this; it exists so
 * test-asar.mjs can exercise the archive reader without a live DSH process.
 */
export const __test = { readFromAsar }

const API_PATH = '/dsh-lineup-manager/api'
const BODY_MAX_BYTES = 256 * 1024

/**
 * Per-provider refresh timeout. A dead endpoint must not hang the panel: with
 * several providers refreshed in sequence, a long per-provider budget turns a
 * single unreachable host into a minute of waiting.
 */
const REFRESH_TIMEOUT_MS = 8 * 1000

/**
 * Settings namespace that `dsh-llm-pi-ai` registers its model discovery under.
 *
 * That plugin computes it as `ctx.fiber.entry?.options.id ?? NS` where
 * `NS = "llm-pi-ai"`, and the shipped profile declares `id: llm-pi-ai` -- so the
 * registered key is this exact string. It is NOT this plugin's own entry id:
 * deriving the namespace from our own `ctx.fiber.entry.options.id` yields
 * "dsh-lineup-manager" and the kernel answers NO_DISCOVERY.
 */
const LLM_PI_AI_NAMESPACE = 'llm-pi-ai'

/** Resolve the active profile's cordis.patch.yml. */
function configPath(ctx) {
  // The profile directory is where the loader was started from; `dsh` sets
  // this via the profile root. Fall back to the conventional location.
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  const profile = process.env.DSH_PROFILE || 'desktop'
  return path.join(home, 'profiles', profile, 'cordis.patch.yml')
}

/** Read the whole config file, or '' when it does not exist yet. */
async function readConfig(file) {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return ''
    throw err
  }
}

/**
 * Locate `providers:` inside the `- id: llm-pi-ai` section.
 * Returns { sectionStart, sectionEnd, providersStart, providersEnd } line
 * indices, or null when the shape is not found.
 */
function locateProviders(lines) {
  let sectionStart = -1
  let sectionEnd = lines.length
  for (let i = 0; i < lines.length; i++) {
    if (/^- id: llm-pi-ai\s*$/.test(lines[i])) {
      sectionStart = i
      for (let j = i + 1; j < lines.length; j++) {
        if (/^- /.test(lines[j])) { sectionEnd = j; break }
      }
      break
    }
  }
  if (sectionStart < 0) return null

  let providersStart = -1
  for (let i = sectionStart; i < sectionEnd; i++) {
    if (/^\s{4}providers:\s*$/.test(lines[i])) { providersStart = i; break }
  }
  if (providersStart < 0) return null

  // providers block ends at the next line indented less than 6, or section end.
  let providersEnd = sectionEnd
  for (let i = providersStart + 1; i < sectionEnd; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    const indent = line.match(/^(\s*)/)[1].length
    if (indent <= 4) { providersEnd = i; break }
  }
  return { sectionStart, sectionEnd, providersStart, providersEnd }
}

/**
 * Parse the provider blocks: [{ name, start, end, modelsStart, modelsEnd,
 * hasModels, models: [{id,name,...}], headerLines }].
 */
function parseProviders(lines, bounds) {
  const out = []
  const { providersStart, providersEnd } = bounds

  // Collect provider header lines (indent 6, "name:")
  const heads = []
  for (let i = providersStart + 1; i < providersEnd; i++) {
    const m = lines[i].match(/^\s{6}([A-Za-z0-9_-]+):\s*$/)
    if (m) heads.push({ name: m[1], line: i })
  }

  for (let k = 0; k < heads.length; k++) {
    const start = heads[k].line
    const end = k + 1 < heads.length ? heads[k + 1].line : providersEnd

    let modelsStart = -1
    for (let i = start + 1; i < end; i++) {
      if (/^\s{8}models:\s*$/.test(lines[i])) { modelsStart = i; break }
    }

    // Model entries: "          - id: xxx" at indent 10.
    const models = []
    let modelsEnd = end
    if (modelsStart >= 0) {
      for (let i = modelsStart + 1; i < end; i++) {
        const line = lines[i]
        if (line.trim() === '') continue
        const indent = line.match(/^(\s*)/)[1].length
        if (indent < 10) { modelsEnd = i; break }
      }
      for (let i = modelsStart + 1; i < modelsEnd; i++) {
        const m = lines[i].match(/^\s{10}-\s+id:\s*(.+?)\s*$/)
        if (!m) continue
        const entry = { id: m[1], name: m[1], contextWindow: null, maxTokens: null, vision: false, start: i, end: modelsEnd }
        // Collect this entry's own lines up to the next "- id:" or block end.
        let e = modelsEnd
        for (let j = i + 1; j < modelsEnd; j++) {
          if (/^\s{10}-\s+id:/.test(lines[j])) { e = j; break }
        }
        entry.end = e
        const body = lines.slice(i, e)
        for (const l of body) {
          const nm = l.match(/^\s{12}name:\s*(.+?)\s*$/)
          if (nm) entry.name = nm[1].replace(/^["']|["']$/g, '')
          const cw = l.match(/^\s{12}contextWindow:\s*(\d+)/)
          if (cw) entry.contextWindow = Number(cw[1])
          const mt = l.match(/^\s{12}maxTokens:\s*(\d+)/)
          if (mt) entry.maxTokens = Number(mt[1])
          if (/^\s{12}input:/.test(l) && /image/.test(l)) entry.vision = true
        }
        models.push(entry)
      }
    }

    out.push({
      name: heads[k].name,
      start,
      end,
      modelsStart,
      modelsEnd,
      hasModels: modelsStart >= 0,
      headerLines: lines.slice(start, modelsStart >= 0 ? modelsStart : end),
      models,
      extraLine: modelsStart >= 0 ? [lines[modelsStart]] : [],
    })
  }
  return out
}

/**
 * Quote a YAML scalar only when it actually needs quoting, so a round-trip
 * leaves ordinary names (A2, DeepSeek-V4-Flash) byte-identical to the source
 * instead of gaining JSON quotes.
 */
function yamlScalar(value) {
  const s = String(value)
  // Bare-safe: no leading/trailing space, no YAML-significant leading char,
  // no colon-space / hash-space sequences, no newline.
  const safe =
    s.length > 0 &&
    s === s.trim() &&
    !/^[-?:,[\]{}#&*!|>'"%@`]/.test(s) &&
    !/:\s/.test(s) &&
    !/\s#/.test(s) &&
    !/[\n\r\t]/.test(s)
  return safe ? s : JSON.stringify(s)
}

/** Render a models block for one provider. */
function renderModels(models) {
  const lines = ['        models:']
  for (const m of models) {
    lines.push('          - id: ' + yamlScalar(m.id))
    if (m.name && m.name !== m.id) lines.push('            name: ' + yamlScalar(m.name))
    if (m.contextWindow) lines.push('            contextWindow: ' + m.contextWindow)
    if (m.maxTokens) lines.push('            maxTokens: ' + m.maxTokens)
  }
  return lines
}

/** Structural sanity check: the file must still parse into the expected shape. */
function structuralCheck(lines) {
  const bounds = locateProviders(lines)
  if (!bounds) return { ok: false, reason: 'llm-pi-ai section not found after write' }
  const providers = parseProviders(lines, bounds)
  if (!providers.length) return { ok: false, reason: 'no providers parsed after write' }
  const dup = new Set()
  for (const p of providers) {
    if (dup.has(p.name)) return { ok: false, reason: 'duplicate provider: ' + p.name }
    dup.add(p.name)
    for (const m of p.models) {
      if (!m.id || /\s/.test(m.id)) return { ok: false, reason: 'bad model id in ' + p.name + ': ' + JSON.stringify(m.id) }
    }
  }
  return { ok: true, providers }
}

/**
 * Read one provider's endpoint settings (api, baseURL) straight from its
 * parsed header lines, which is where the config keeps them.
 */
function providerEndpoint(headerLines) {
  let api
  let baseURL
  for (const line of headerLines) {
    const a = line.match(/^\s{8}api:\s*(.+?)\s*$/)
    if (a) api = a[1].replace(/^["']|["']$/g, '')
    const b = line.match(/^\s{8}baseURL:\s*(.+?)\s*$/)
    if (b) baseURL = b[1].replace(/^["']|["']$/g, '')
  }
  return { api, baseURL }
}

/** Resolve the API key named by a provider's apiKeyEnv, from env or credentials. */
async function resolveApiKey(apiKeyEnv, home) {
  if (!apiKeyEnv) return undefined
  if (process.env[apiKeyEnv]) return process.env[apiKeyEnv]
  // Fall back to the profile's credentials file, which is where the Models
  // page stores keys the user typed there.
  for (const name of ['.credentials.yaml', '.credentials.yml']) {
    try {
      const text = await fs.readFile(path.join(home, name), 'utf8')
      const m = text.match(new RegExp('^\\s*' + apiKeyEnv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*(\\S+)\\s*$', 'm'))
      if (m) return m[1].replace(/^["']|["']$/g, '')
    } catch {}
  }
  return undefined
}

/**
 * Read one file out of an app.asar archive by its absolute path.
 *
 * asar layout: 4-byte size word, then a JSON header describing the tree, then
 * the file payloads. Offsets in the header are relative to the end of the
 * header.
 *
 * Only the header and the requested entry's own bytes are read. The installed
 * app.asar is ~174 MB and a whole-archive read costs ~125 ms and hundreds of MB
 * of RSS, which multiplies across the concurrent resolutions refreshAll
 * performs -- so this deliberately opens the archive and seeks instead.
 *
 * Returns undefined when the archive or the entry is absent, so callers can
 * just try the next candidate. `io` is injectable for tests.
 */
async function readFromAsar(absolutePath, io) {
  const marker = '.asar'
  const at = absolutePath.indexOf(marker)
  if (at < 0) return undefined
  const archive = absolutePath.slice(0, at + marker.length)
  const inner = absolutePath.slice(at + marker.length).replace(/\\/g, '/')
  const open = (io && io.open) || fs.open
  const stat = (io && io.stat) || fs.stat
  let handle
  try {
    const size = (await stat(archive)).size
    handle = await open(archive, 'r')
    // Header length sits in the second 4-byte word (bytes 12..16).
    const lenBuf = Buffer.alloc(16)
    await handle.read(lenBuf, 0, 16, 0)
    const headerSize = lenBuf.readUInt32LE(12)
    if (!Number.isFinite(headerSize) || headerSize <= 0 || 16 + headerSize > size) return undefined
    const headerBuf = Buffer.alloc(headerSize)
    await handle.read(headerBuf, 0, headerSize, 16)
    const header = JSON.parse(headerBuf.toString('utf8'))
    let node = header
    for (const segment of inner.split('/').filter(Boolean)) {
      if (!node || !node.files || !node.files[segment]) return undefined
      node = node.files[segment]
    }
    if (!node || node.files) return undefined
    const entrySize = Number(node.size)
    if (!Number.isFinite(entrySize) || entrySize < 0) return undefined
    const start = 16 + headerSize + Number(node.offset)
    if (start + entrySize > size) return undefined
    const buf = Buffer.alloc(entrySize)
    await handle.read(buf, 0, entrySize, start)
    return buf.toString('utf8')
  } catch {
    return undefined
  } finally {
    if (handle) { try { await handle.close() } catch {} }
  }
}

/**
 * Resolve a provider's endpoint from pi-ai's installed catalog.
 *
 * This is a fallback for providers whose config declares no `baseURL` (opencode
 * is the running example: its endpoint only exists in the catalog). It supplies
 * the ENDPOINT ONLY. The catalog's own model list must never be used as the
 * lineup result, because that list is frozen into the installed pi-ai version --
 * exactly the staleness this feature exists to defeat.
 *
 * Resolution order: a host-provided lookup (used by tests and by any embedding
 * that exposes one), then the installed pi-ai data files read from disk.
 */
async function catalogBaseURL(ctx, provider, home, wantApi) {
  const hostLookup = ctx && typeof ctx.catalogBaseURL === 'function' ? ctx.catalogBaseURL : null
  if (hostLookup) {
    try {
      const found = await hostLookup(provider)
      if (typeof found === 'string' && found.length > 0) return found
    } catch {}
  }
  // A provider's catalog entry carries one endpoint per protocol (openrouter
  // publishes both an anthropic-messages and an openai-completions base, and
  // only the latter ends in /v1). Pick the one matching the declared api, and
  // fall back to openai-completions -- the protocol this plugin refreshes with.
  const preferred = [wantApi, 'openai-completions'].filter(Boolean)
  // Read the catalog entry directly. Resolving the installed pi-ai package is
  // far more reliable than deriving an app root from process.execPath, which
  // points at whatever Node happens to run DSH rather than at the app itself.
  const candidates = []
  // 1) Ask Node's resolver for the installed pi-ai data directory.
  try {
    const { createRequire } = await import('node:module')
    const require_ = createRequire(import.meta.url)
    const pkgJson = require_.resolve('@earendil-works/pi-ai/package.json')
    candidates.push(path.join(path.dirname(pkgJson), 'dist', 'providers', 'data', provider + '.json'))
  } catch {}
  // 2) Known install layouts, for hosts where the plugin is not a sibling of pi-ai.
  const appRoots = [
    process.env.DSH_APP_ROOT,
    ...(process.env.APPDATA ? [path.join(process.env.APPDATA, 'Local', 'Programs', 'DeepSeek Harness')] : []),
    ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness')] : []),
  ].filter(Boolean)
  for (const root of appRoots) {
    candidates.push(path.join(root, 'resources', 'app.asar', 'dsh', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data', provider + '.json'))
  }
  candidates.push(path.join(home, 'profiles', process.env.DSH_PROFILE || 'desktop', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data', provider + '.json'))
  for (const file of candidates) {
    let text
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      // DSH ships pi-ai inside app.asar, which plain fs cannot read. Pull the
      // one entry out of the archive instead of unpacking it.
      try {
        text = await readFromAsar(file)
      } catch {
        continue
      }
      if (text === undefined) continue
    }
    try {
      const parsed = JSON.parse(text)
      // Prefer the endpoint whose protocol matches what we will query with.
      for (const want of preferred) {
        const group = parsed[want]
        if (!group || typeof group !== 'object') continue
        for (const key of Object.keys(group)) {
          const entry = group[key]
          if (entry && typeof entry === 'object' && typeof entry.baseUrl === 'string' && entry.baseUrl.length > 0) {
            return entry.baseUrl
          }
        }
      }
      // Last resort: any endpoint the entry declares.
      for (const api of Object.keys(parsed)) {
        const group = parsed[api]
        if (!group || typeof group !== 'object') continue
        for (const key of Object.keys(group)) {
          const entry = group[key]
          if (entry && typeof entry === 'object' && typeof entry.baseUrl === 'string' && entry.baseUrl.length > 0) {
            return entry.baseUrl
          }
        }
      }
    } catch {}
  }
  return undefined
}

/**
 * Pull one provider's live lineup list and diff it against the configured ids.
 *
 * Discovery is deliberately called with a `baseURL` and WITHOUT `provider`:
 * pi-ai ships a built-in catalog for openrouter/nvidia/opencode, and passing the
 * provider id makes discovery return that frozen catalog instead of asking the
 * endpoint -- exactly the staleness a refresh exists to defeat.
 */
async function refreshProvider(ctx, provider, headerLines, configuredIds) {
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  // Every exit path logs, so a provider that bails out before the network call
  // is still visible in the diagnostic file rather than silently missing.
  const trace = async (entry) => {
    try {
      await fs.appendFile(path.join(home, 'lineup-refresh.log'), JSON.stringify({ at: new Date().toISOString(), provider, ...entry }) + '\n', 'utf8')
    } catch {}
  }
  const { api, baseURL: declaredBaseURL } = providerEndpoint(headerLines)
  const apiKeyEnvMatch = headerLines.map((l) => l.match(/^\s{8}apiKeyEnv:\s*(.+?)\s*$/)).find(Boolean)
  const apiKeyEnv = apiKeyEnvMatch ? apiKeyEnvMatch[1].replace(/^["']|["']$/g, '') : undefined
  const llm = ctx.get ? ctx.get('llm') : ctx.llm
  if (!llm || typeof llm.discoverModels !== 'function') {
    await trace({
      phase: 'service-missing',
      hasCtxGet: typeof ctx.get === 'function',
      hasCtxLlm: !!ctx.llm,
      llmType: typeof llm,
      llmKeys: llm ? Object.keys(llm).slice(0, 20) : null,
      discoverType: llm ? typeof llm.discoverModels : null,
    })
    return { ok: false, error: 'llm discovery service unavailable' }
  }
  // Fall back to the catalog's endpoint when the config declares none. This is
  // itself fallible (module resolution, archive access), and an exception here
  // would escape the whole handler -- the caller sees an empty response and
  // nothing is logged. Contained and traced instead.
  let baseURL = declaredBaseURL
  if (!baseURL) {
    try {
      baseURL = await catalogBaseURL(ctx, provider, home, api)
    } catch (err) {
      await trace({ phase: 'catalog-lookup-threw', declaredBaseURL: null, api: api ?? null, error: String(err && err.message ? err.message : err), stack: err && err.stack ? String(err.stack).split('\n').slice(0, 4).join(' // ') : undefined })
      return { ok: false, error: 'resolving this provider endpoint from the catalog failed: ' + String(err && err.message ? err.message : err) }
    }
  }
  if (!baseURL) {
    await trace({ phase: 'no-endpoint', declaredBaseURL: declaredBaseURL || null, api: api ?? null })
    return {
      ok: false,
      error: `"${provider}" declares no baseURL and its endpoint could not be read from the installed catalog. `
        + `Add this provider's endpoint to cordis.patch.yml under the provider block, then refresh again:\n`
        + `        api: openai-completions\n`
        + `        baseURL: https://<host>/v1`,
    }
  }
  const apiKey = await resolveApiKey(apiKeyEnv, home)
  // Ask for the namespace llm-pi-ai actually registered. Using our own entry id
  // here is the NO_DISCOVERY bug this constant exists to prevent.
  const ns = LLM_PI_AI_NAMESPACE
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS)
  try {
    const discovered = await llm.discoverModels(ns, {
      baseURL,
      ...(api === undefined ? {} : { api }),
      ...(apiKey === undefined ? {} : { apiKey }),
    }, controller.signal)
    const live = discovered.map((m) => ({ id: m.id, name: m.name ?? m.id, contextWindow: m.contextWindow ?? null, maxTokens: m.maxTokens ?? null }))
    const liveIds = new Set(live.map((m) => m.id))
    const configured = new Set(configuredIds)
    const added = live.filter((m) => !configured.has(m.id)).map((m) => m.id)
    const removed = [...configured].filter((id) => !liveIds.has(id))
    const common = live.filter((m) => configured.has(m.id)).map((m) => m.id)
    await trace({ ok: true, baseURL, live: live.length, ns, sentApi: api === undefined ? '(omitted)' : api })
    return { ok: true, baseURL, live, added, removed, common }
  } catch (err) {
    const message = err && err.name === 'AbortError'
      ? `refresh timed out after ${REFRESH_TIMEOUT_MS / 1000}s`
      : String(err && err.message ? err.message : err)
    // Carry the diagnostic fields the host exposes: LlmError.code and the
    // `cause` chain, which is where the real endpoint complaint lives.
    const cause = err && err.cause
    const diag = {
      name: err && err.name,
      code: err && err.code,
      causeName: cause && cause.name,
      causeMessage: cause && cause.message,
      causeCode: cause && cause.code,
      api,
      apiKeySource: apiKeyEnv
        ? (process.env[apiKeyEnv] ? 'env' : (apiKey ? 'credentials' : 'missing'))
        : 'none-declared',
      apiKeyLen: apiKey ? apiKey.length : 0,
      ns,
      sentApi: api === undefined ? '(omitted)' : api,
      sentKeyLength: apiKey ? apiKey.length : 0,
      stack: err && err.stack ? String(err.stack).split('\n').slice(0, 4).join(' // ') : undefined,
    }
    // Persist the full failure beside the config: a message on a badge is not
    // enough to diagnose a host-side mismatch, and this file outlives a reload.
    await trace({ error: message, baseURL, diag })
    return { ok: false, error: message, baseURL, diag }
  } finally {
    clearTimeout(timer)
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > BODY_MAX_BYTES) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) return resolve({})
      try { resolve(JSON.parse(raw)) } catch (e) { reject(new Error('invalid JSON body')) }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function handle(req, res, ctx) {
  const file = configPath(ctx)

  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'POST only' })
    return
  }

  let payload
  try {
    payload = await readBody(req)
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err.message })
    return
  }

  const op = payload.op

  // ---- read ----
  if (op === 'read') {
    try {
      const text = await readConfig(file)
      const lines = text.split(/\r?\n/)
      const bounds = locateProviders(lines)
      if (!bounds) {
        sendJson(res, 200, { ok: false, error: 'llm-pi-ai section not found in ' + file })
        return
      }
      const providers = parseProviders(lines, bounds).map((p) => ({
        name: p.name,
        hasModels: p.hasModels,
        models: p.models.map((m) => ({
          id: m.id, name: m.name, contextWindow: m.contextWindow, maxTokens: m.maxTokens, vision: m.vision,
        })),
      }))
      let mtime = null
      try { mtime = (await fs.stat(file)).mtimeMs } catch {}
      sendJson(res, 200, { ok: true, file, mtime, providers })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
    }
    return
  }

  // ---- write ----
  if (op === 'write') {
    const providerName = payload.provider
    const ids = Array.isArray(payload.ids) ? payload.ids : null
    if (!providerName || !ids) {
      sendJson(res, 400, { ok: false, error: 'write needs { provider, ids[] }' })
      return
    }
    if (new Set(ids).size !== ids.length) {
      sendJson(res, 400, { ok: false, error: 'duplicate ids in payload' })
      return
    }

    let original
    try {
      original = await readConfig(file)
    } catch (err) {
      sendJson(res, 500, { ok: false, error: 'cannot read config: ' + err.message })
      return
    }
    const lines = original.split(/\r?\n/)
    const bounds = locateProviders(lines)
    if (!bounds) {
      sendJson(res, 409, { ok: false, error: 'llm-pi-ai section not found; refusing to write' })
      return
    }
    const providers = parseProviders(lines, bounds)
    const target = providers.find((p) => p.name === providerName)
    if (!target) {
      sendJson(res, 409, { ok: false, error: 'provider not found: ' + providerName })
      return
    }

    // Keep declared metadata for ids we already know; unknown ids keep bare form.
    const known = new Map(target.models.map((m) => [m.id, m]))
    const nextModels = ids.map((id) => {
      const k = known.get(id)
      return k ? { id: k.id, name: k.name, contextWindow: k.contextWindow, maxTokens: k.maxTokens } : { id }
    })

    const block = renderModels(nextModels)
    let out
    if (target.hasModels) {
      out = [...lines.slice(0, target.modelsStart), ...block, ...lines.slice(target.modelsEnd)]
    } else {
      // No models block yet: insert right after the provider's header lines.
      const insertAt = target.modelsStart >= 0 ? target.modelsStart : target.end
      out = [...lines.slice(0, insertAt), ...block, ...lines.slice(insertAt)]
    }

    const check = structuralCheck(out)
    if (!check.ok) {
      sendJson(res, 500, { ok: false, error: 'refusing to write, would break config: ' + check.reason })
      return
    }

    // ---- backup + write ----
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
    const backup = file + '.bak-lineup-' + stamp
    try {
      await fs.writeFile(backup, original, 'utf8')
    } catch (err) {
      sendJson(res, 500, { ok: false, error: 'cannot write backup, refusing: ' + err.message })
      return
    }

    try {
      await fs.writeFile(file, out.join('\n'), 'utf8')
    } catch (err) {
      // Restore, best effort.
      try { await fs.writeFile(file, original, 'utf8') } catch {}
      sendJson(res, 500, { ok: false, error: 'write failed, restored: ' + err.message })
      return
    }

    // ---- verify by re-reading from disk ----
    try {
      const verifyText = await fs.readFile(file, 'utf8')
      const verify = structuralCheck(verifyText.split(/\r?\n/))
      if (!verify.ok) {
        await fs.writeFile(file, original, 'utf8')
        sendJson(res, 500, { ok: false, error: 'verification failed, rolled back: ' + verify.reason })
        return
      }
      const after = verify.providers.find((p) => p.name === providerName)
      const gotIds = after ? after.models.map((m) => m.id) : []
      if (gotIds.length !== ids.length || gotIds.some((v, i) => v !== ids[i])) {
        await fs.writeFile(file, original, 'utf8')
        sendJson(res, 500, { ok: false, error: 'read-back mismatch, rolled back' })
        return
      }
    } catch (err) {
      sendJson(res, 500, { ok: false, error: 'verify failed: ' + err.message + ' (backup at ' + backup + ')' })
      return
    }

    sendJson(res, 200, { ok: true, provider: providerName, count: nextModels.length, backup, restartRequired: true })
    return
  }

  // ---- refresh one provider ----
  if (op === 'refresh') {
    const providerName = payload.provider
    if (!providerName) {
      sendJson(res, 400, { ok: false, error: 'refresh needs { provider }' })
      return
    }
    let text
    try {
      text = await readConfig(file)
    } catch (err) {
      sendJson(res, 500, { ok: false, error: 'cannot read config: ' + err.message })
      return
    }
    const lines = text.split(/\r?\n/)
    const bounds = locateProviders(lines)
    if (!bounds) {
      sendJson(res, 409, { ok: false, error: 'llm-pi-ai section not found; cannot refresh' })
      return
    }
    const target = parseProviders(lines, bounds).find((p) => p.name === providerName)
    if (!target) {
      sendJson(res, 409, { ok: false, error: 'provider not found: ' + providerName })
      return
    }
    const configuredIds = target.models.map((m) => m.id)
    const result = await refreshProvider(ctx, providerName, target.headerLines, configuredIds)
    if (!result.ok) {
      sendJson(res, 502, {
        ok: false,
        provider: providerName,
        error: result.error,
        ...(result.baseURL === undefined ? {} : { baseURL: result.baseURL }),
        ...(result.diag === undefined ? {} : { diag: result.diag }),
      })
      return
    }
    sendJson(res, 200, { ok: true, provider: providerName, result })
    return
  }

  // ---- refresh every provider (isolated failures) ----
  if (op === 'refreshAll') {
    let text
    try {
      text = await readConfig(file)
    } catch (err) {
      sendJson(res, 500, { ok: false, error: 'cannot read config: ' + err.message })
      return
    }
    const lines = text.split(/\r?\n/)
    const bounds = locateProviders(lines)
    if (!bounds) {
      sendJson(res, 409, { ok: false, error: 'llm-pi-ai section not found; cannot refresh' })
      return
    }
    const providers = parseProviders(lines, bounds)
    // Resolve providers one at a time. The discovery service may be a Remote
    // carrier that does not tolerate concurrent calls on one connection, and
    // serial refresh is plenty fast for a handful of providers.
    const results = []
    for (const p of providers) {
      const result = await refreshProvider(ctx, p.name, p.headerLines, p.models.map((m) => m.id))
      results.push(result.ok
        ? { provider: p.name, ok: true, result }
        : { provider: p.name, ok: false, error: result.error, ...(result.diag === undefined ? {} : { diag: result.diag }) })
    }
    sendJson(res, 200, { ok: true, results })
    return
  }

  sendJson(res, 400, { ok: false, error: 'unknown op: ' + String(op) })
}

export function apply(ctx) {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: API_PATH,
      handler: async (req, res) => {
        // A rejected handler leaves the response unwritten, which the client
        // can only report as an empty body -- losing the real fault entirely.
        // Every failure must leave here as JSON.
        try {
          await handle(req, res, ctx)
        } catch (err) {
          const detail = err && err.stack ? String(err.stack).split('\n').slice(0, 5).join(' // ') : String(err)
          try {
            const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
            await fs.appendFile(path.join(home, 'lineup-refresh.log'), JSON.stringify({ at: new Date().toISOString(), phase: 'handler-threw', error: String(err && err.message ? err.message : err), stack: detail }) + '\n', 'utf8')
          } catch {}
          try {
            if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err), stack: detail })
          } catch {}
        }
      },
    })
  )
}
