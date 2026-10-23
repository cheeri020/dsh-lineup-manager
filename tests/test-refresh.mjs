// Test "lineup refresh": pull the live lineup list from a provider endpoint and
// diff it against the local config.
//
// Design constraints this test guards:
// 1. Discovery MUST bypass pi-ai's built-in static catalog -- passing `provider`
//    returns the frozen catalog instead of live data. Refresh therefore sends
//    baseURL only, never provider.
// 2. Refresh is read-only: it must never modify the config file.
// 3. A failing endpoint must yield a readable error without breaking the rest.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Resolve the package root from this test file, so the suite runs from any
// checkout location and on any machine.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mod = await import(pathToFileURL(path.join(REPO, 'dist', 'index.js')).href)
const TMP = path.join(os.tmpdir(), 'lineup-refresh-' + Date.now())
const profDir = path.join(TMP, 'profiles', 'desktop')
await fs.mkdir(profDir, { recursive: true })

// A local fake endpoint simulating a changed platform catalog: one new model,
// one vanished model.
const liveModels = [
  { id: 'a/one:free', name: 'One Free', contextWindow: 1000 },
  { id: 'a/three:free', name: 'Three Free', contextWindow: 5000 },
]

const sample = `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      fake:
        apiKeyEnv: FAKE_API_KEY
        api: openai-completions
        baseURL: __BASE__
        models:
          - id: a/one:free
            name: One Free
            contextWindow: 1000
          - id: a/two:free
            name: Two Free
            contextWindow: 2000
      broken:
        apiKeyEnv: BROKEN_API_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:1/v1
        models:
          - id: x
      nobase:
        apiKeyEnv: FAKE_API_KEY
        api: openai-completions
        models:
          - id: a/one:free
      nobase-nocatalog:
        apiKeyEnv: FAKE_API_KEY
        api: openai-completions
        models:
          - id: y
`

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/v1/models')) {
    const auth = req.headers.authorization || ''
    if (auth !== 'Bearer test-key') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'bad key' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: liveModels }))
    return
  }
  res.writeHead(404)
  res.end('{}')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const base = 'http://127.0.0.1:' + port + '/v1'
await fs.writeFile(path.join(profDir, 'cordis.patch.yml'), sample.replace('__BASE__', base), 'utf8')

const discoveryCalls = []
let handler = null

// The endpoint the built-in catalog is expected to supply for `nobase`.
const catalogFallbackBase = 'http://127.0.0.1:' + port + '/v1'

const ctx = {
  effect: (fn) => { fn(); return () => {} },
  webServer: { register: (route) => { handler = route.handler; return () => {} } },
  // This mirrors the real host: the plugin runs under its OWN loader entry, so
  // ctx.fiber.entry.options.id is 'dsh-lineup-manager'. Discovery is registered
  // by llm-pi-ai under ITS entry id ('llm-pi-ai'), so a namespace derived from
  // the plugin's own entry is guaranteed to miss.
  fiber: { entry: { options: { id: 'dsh-lineup-manager' } } },
  // Host lookup the plugin uses to resolve a provider's endpoint from pi-ai's
  // installed catalog when the config declares none.
  catalogBaseURL: async (provider) => (provider === 'nobase' ? catalogFallbackBase : undefined),
  llm: {
    async discoverModels(ns, request) {
      discoveryCalls.push({ ns, request })
      // Reproduce the kernel's contract: discovery is registered per settings
      // namespace and anything unregistered fails with NO_DISCOVERY. Without
      // this check the suite cannot catch a wrong namespace.
      if (ns !== 'llm-pi-ai') {
        const err = new Error(`no model discovery is registered for "${ns}"`)
        err.name = 'LlmError'
        err.code = 'NO_DISCOVERY'
        throw err
      }
      if (request.baseURL && request.baseURL.includes('127.0.0.1:1')) {
        throw new Error('connect ECONNREFUSED')
      }
      const r = await fetch(request.baseURL.replace(/\/+$/, '') + '/models', {
        headers: request.apiKey ? { authorization: 'Bearer ' + request.apiKey } : {},
      })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const j = await r.json()
      return j.data
    },
  },
}

mod.apply(ctx)
if (!handler) { console.log('FAIL: handler not registered'); process.exit(1) }

function makeReq(body) {
  const chunks = [Buffer.from(JSON.stringify(body))]
  return {
    method: 'POST',
    headers: {},
    on(ev, cb) {
      if (ev === 'data') chunks.forEach((c) => cb(c))
      if (ev === 'end') cb()
      return this
    },
  }
}
function makeRes() {
  const out = { status: 0, body: null }
  return { out, writeHead(s) { out.status = s }, end(b) { out.body = JSON.parse(b) } }
}
async function call(body) {
  const res = makeRes()
  await handler(makeReq(body), res)
  return res.out
}

process.env.DSH_HOME = TMP
process.env.DSH_PROFILE = 'desktop'
process.env.FAKE_API_KEY = 'test-key'
process.env.BROKEN_API_KEY = 'x'

const results = []
const check = (name, cond, msg) => results.push({ name, pass: !!cond, msg })

// R1 -- refresh one provider: live list plus added/removed/common.
const configFile = path.join(profDir, 'cordis.patch.yml')
const beforeText = await fs.readFile(configFile, 'utf8')
const r1 = await call({ op: 'refresh', provider: 'fake' })
check('R1 refresh succeeds', r1.status === 200 && r1.body.ok, JSON.stringify(r1.body).slice(0, 300))
const rr = r1.body.result || {}
check('R1b live list has 2 models', Array.isArray(rr.live) && rr.live.length === 2, 'live=' + (rr.live || []).map((m) => m.id).join(','))
check('R1c new model flagged added', (rr.added || []).includes('a/three:free'), 'added=' + (rr.added || []).join(','))
check('R1d vanished model flagged removed', (rr.removed || []).includes('a/two:free'), 'removed=' + (rr.removed || []).join(','))
check('R1e shared model is common', (rr.common || []).includes('a/one:free'), 'common=' + (rr.common || []).join(','))

// R2 -- the critical one: refresh must bypass the built-in static catalog.
const fakeCall = discoveryCalls.find((c) => c.request.baseURL === base)
check('R2 discovery received baseURL', !!fakeCall, JSON.stringify(discoveryCalls.map((c) => c.request)))
check('R2b discovery did NOT receive provider', fakeCall && fakeCall.request.provider === undefined, 'provider=' + (fakeCall && fakeCall.request.provider))

// R3 -- refresh is read-only.
const afterText = await fs.readFile(configFile, 'utf8')
check('R3 refresh leaves config untouched', beforeText === afterText, '')
const baks = (await fs.readdir(profDir)).filter((f) => f.includes('bak-lineup'))
check('R3b refresh writes no backup', baks.length === 0, 'baks=' + baks.join(','))

// R4 -- unreachable endpoint gives a readable error, not an outer throw.
const r4 = await call({ op: 'refresh', provider: 'broken' })
check('R4 unreachable endpoint reports ok:false', r4.status !== 200 || r4.body.ok === false, JSON.stringify(r4.body).slice(0, 200))
check('R4b error text is readable', r4.body && typeof r4.body.error === 'string' && r4.body.error.length > 0, JSON.stringify(r4.body).slice(0, 200))

// R5 -- refreshAll: one failure does not affect the other.
const r5 = await call({ op: 'refreshAll' })
check('R5 refreshAll returns a result set', r5.status === 200 && r5.body.ok && Array.isArray(r5.body.results), JSON.stringify(r5.body).slice(0, 200))
const byName = Object.fromEntries((r5.body.results || []).map((x) => [x.provider, x]))
check('R5b fake succeeded with one addition', byName.fake && byName.fake.ok && byName.fake.result.added.length === 1, JSON.stringify(byName.fake || {}).slice(0, 200))
check('R5c broken failed but carries an error', byName.broken && byName.broken.ok === false && !!byName.broken.error, JSON.stringify(byName.broken || {}).slice(0, 200))

// R6 -- unknown provider refused.
const r6 = await call({ op: 'refresh', provider: 'nope' })
check('R6 unknown provider refused', r6.body.ok === false, JSON.stringify(r6.body))

// R7 -- a provider with no baseURL falls back to the endpoint declared by the
// built-in catalog for that provider id, then refreshes live from it. The
// catalog supplies the ENDPOINT only; the model list must still be fetched.
const r7 = await call({ op: 'refresh', provider: 'nobase' })
check('R7 no-baseURL provider refreshes via catalog endpoint', r7.status === 200 && r7.body.ok, JSON.stringify(r7.body).slice(0, 250))
const nobaseCall = discoveryCalls.filter((c) => c.request.baseURL === catalogFallbackBase)
check('R7b discovery received the catalog-resolved baseURL', nobaseCall.length > 0, JSON.stringify(discoveryCalls.map((c) => c.request.baseURL)))
check('R7c discovery still sends no provider', nobaseCall.every((c) => c.request.provider === undefined), JSON.stringify(nobaseCall.map((c) => c.request)))

// R8 -- a provider with neither a configured baseURL nor a catalog entry fails
// loudly instead of silently succeeding with an empty list.
const r8 = await call({ op: 'refresh', provider: 'nobase-nocatalog' })
check('R8 no baseURL and no catalog entry reports an error', r8.body.ok === false && typeof r8.body.error === 'string', JSON.stringify(r8.body).slice(0, 200))

// R9 -- the namespace must be the one llm-pi-ai registered under, NOT this
// plugin's own entry id. dsh-llm-pi-ai derives its namespace from its OWN
// loader entry options.id, which the profile declares as `id: llm-pi-ai`.
// Reusing ctx.fiber.entry.options.id here yields 'dsh-lineup-manager' and the
// kernel answers NO_DISCOVERY -- the exact failure observed in the live panel.
const nsUsed = [...new Set(discoveryCalls.map((c) => c.ns))]
check('R9 discovery uses the llm-pi-ai namespace', nsUsed.length > 0 && nsUsed.every((n) => n === 'llm-pi-ai'), 'namespaces seen: ' + JSON.stringify(nsUsed))
check('R9b never passes this plugin own entry id as the namespace', !nsUsed.includes('dsh-lineup-manager'), 'namespaces seen: ' + JSON.stringify(nsUsed))

console.log('=== dsh-lineup-manager refresh tests ===')
let pass = 0, fail = 0
for (const r of results) {
  console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.pass ? '' : '   -> ' + r.msg))
  r.pass ? pass++ : fail++
}
console.log('')
console.log('total: PASS=' + pass + '  FAIL=' + fail)
server.close()
await fs.rm(TMP, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)