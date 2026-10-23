// Live smoke test: exercise the real refresh path against the real provider
// endpoints, using the real config and the real credentials file.
//
// This talks to the network on purpose: it is the only way to prove the refresh
// reaches the platform instead of returning pi-ai's frozen built-in catalog.
import { promises as fs } from 'node:fs'
import path from 'node:path'

const REPO = 'C:/Users/richa/Documents/deepseek-harness/default-workspace/dsh-lineup-manager'
const mod = await import('file:///' + REPO + '/index.js')

let handler = null
// Minimal ctx: real llm discovery shim that performs a genuine HTTP GET.
// We mirror what discoverModels does for openai-completions: GET {baseURL}/models
// with bearer auth, because the installed plugin cannot reach the host service
// from a bare Node process.
const ctx = {
  effect: (fn) => { fn(); return () => {} },
  webServer: { register: (route) => { handler = route.handler; return () => {} } },
  llm: {
    async discoverModels(ns, request, signal) {
      const url = request.baseURL.replace(/\/+$/, '') + '/models'
      const headers = { accept: 'application/json' }
      if (request.apiKey) headers.authorization = 'Bearer ' + request.apiKey
      const r = await fetch(url, { headers, signal })
      if (!r.ok) {
        const body = await r.text()
        let detail = 'HTTP ' + r.status
        try {
          const j = JSON.parse(body)
          const m = j?.error?.message ?? j?.message ?? j?.error
          if (typeof m === 'string') detail += ': ' + m.slice(0, 120)
        } catch {}
        throw new Error(detail)
      }
      const j = await r.json()
      if (!Array.isArray(j.data)) throw new Error('reply has no data array')
      return j.data.map((d) => ({
        id: d.id,
        name: d.name ?? d.display_name ?? d.id,
        contextWindow: d.context_length ?? d.context_window ?? d.limit?.context,
        maxTokens: d.max_completion_tokens ?? d.limit?.output ?? d.top_provider?.max_completion_tokens,
      }))
    },
  },
}

mod.apply(ctx)
if (!handler) { console.log('FAIL: handler not registered'); process.exit(1) }

function makeReq(body) {
  const chunks = [Buffer.from(JSON.stringify(body))]
  return { method: 'POST', headers: {}, on(ev, cb) { if (ev === 'data') chunks.forEach((c) => cb(c)); if (ev === 'end') cb(); return this } }
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

// Point at the REAL profile so the real providers and keys are read.
process.env.DSH_HOME = process.env.USERPROFILE + '/.dsh'
process.env.DSH_PROFILE = 'desktop'
const realConfig = path.join(process.env.DSH_HOME, 'profiles', 'desktop', 'cordis.patch.yml')
const beforeText = await fs.readFile(realConfig, 'utf8')

console.log('=== LIVE refresh against real providers ===\n')
const all = await call({ op: 'refreshAll' })
const payload = all.body || {}
if (!payload.ok) { console.log('refreshAll failed:', JSON.stringify(payload).slice(0, 400)); process.exit(1) }

let okCount = 0
for (const item of payload.results) {
  if (!item.ok) {
    console.log(`[FAIL] ${item.provider}: ${item.error}`)
    continue
  }
  okCount++
  const r = item.result
  console.log(`[ OK ] ${item.provider}  live=${r.live.length}  common=${r.common.length}  added=${r.added.length}  removed=${r.removed.length}`)
  if (r.added.length) console.log(`       新上线: ${r.added.slice(0, 6).join(', ')}${r.added.length > 6 ? ' …' : ''}`)
  if (r.removed.length) console.log(`       已下线: ${r.removed.slice(0, 6).join(', ')}${r.removed.length > 6 ? ' …' : ''}`)
}

const afterText = await fs.readFile(realConfig, 'utf8')
console.log('')
console.log(payload.results.length + ' providers, ' + okCount + ' refreshed successfully')
console.log('config untouched by refresh: ' + (beforeText === afterText))
const exitCode = okCount > 0 && beforeText === afterText ? 0 : 1
process.exit(exitCode)