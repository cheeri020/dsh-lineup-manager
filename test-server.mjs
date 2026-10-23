// 测试 lineup-manager 的核心配置读写逻辑（不依赖 DSH 运行时）
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// 直接内联被测逻辑的副本？不行——必须测真实代码。
// 改为：动态导入 index.js，但它的 apply 需要 ctx。我们只测纯函数部分。
// 由于 index.js 未导出内部函数，这里用「模拟 webServer + 真实文件」的方式端到端测。

const mod = await import('file:///C:/Users/richa/Documents/deepseek-harness/default-workspace/dsh-lineup-manager/index.js')

const TMP = path.join(os.tmpdir(), 'lineup-test-' + Date.now())
await fs.mkdir(TMP, { recursive: true })

// 造一个测试配置：llm-pi-ai 含 3 个 provider，其中一个没有 models
const sample = `- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: nvidia
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      openrouter:
        apiKeyEnv: OPENROUTER_API_KEY
        models:
          - id: a/one:free
            name: One Free
            contextWindow: 1000
          - id: a/two:free
            name: Two Free
            contextWindow: 2000
      amd:
        displayName: AMD
        apiKeyEnv: AMD_API_KEY
        baseURL: https://example.com/v1
        models:
          - id: Model-X
            name: Model-X
            contextWindow: 3000
      nvidia:
        apiKeyEnv: NVIDIA_API_KEY
- id: pwsh-sandbox
  name: "@deepseek-ai/dsh-pwsh-sandbox"
  config:
    maxOutputBytes: 100
`

const FILE = path.join(TMP, 'cordis.patch.yml')
await fs.writeFile(FILE, sample, 'utf8')

// 模拟一个 webServer，捕获 handler
let handler = null
const ctx = {
  effect: (fn) => { const d = fn(); return () => {} },
  webServer: {
    register: (route) => { handler = route.handler; return () => {} },
  },
}

mod.apply(ctx)
if (!handler) { console.log('FAIL: handler 未注册'); process.exit(1) }

// 模拟 req/res
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
  return {
    out,
    writeHead(status) { out.status = status },
    end(body) { out.body = JSON.parse(body) },
  }
}
async function call(body) {
  const res = makeRes()
  await handler(makeReq(body), res)
  return res.out
}

const results = []
function check(name, cond, msg) {
  results.push({ name, pass: !!cond, msg })
}

// 环境变量指向临时文件
process.env.DSH_HOME = TMP
process.env.DSH_PROFILE = 'desktop'
// configPath 拼的是 <home>/profiles/<profile>/cordis.patch.yml，调整目录结构
const profDir = path.join(TMP, 'profiles', 'desktop')
await fs.mkdir(profDir, { recursive: true })
await fs.writeFile(path.join(profDir, 'cordis.patch.yml'), sample, 'utf8')

// --- T1 读取 ---
const r1 = await call({ op: 'read' })
check('T1 read 成功', r1.status === 200 && r1.body.ok, JSON.stringify(r1.body).slice(0, 200))
const provs = r1.body.providers || []
check('T1b 解析出 3 个 provider', provs.length === 3, '得到 ' + provs.length + ': ' + provs.map((p) => p.name).join(','))
const or = provs.find((p) => p.name === 'openrouter')
check('T1c openrouter 有 2 条线路', or && or.models.length === 2, or ? or.models.map((m) => m.id).join(',') : 'null')
const nv = provs.find((p) => p.name === 'nvidia')
check('T1d nvidia 标记为无 models', nv && nv.hasModels === false, nv ? 'hasModels=' + nv.hasModels : 'null')

// --- T2 写入 openrouter（缩减到 1 条）---
const r2 = await call({ op: 'write', provider: 'openrouter', ids: ['a/one:free'] })
check('T2 write 成功', r2.status === 200 && r2.body.ok, JSON.stringify(r2.body).slice(0, 200))

const after = await fs.readFile(path.join(profDir, 'cordis.patch.yml'), 'utf8')
check('T2b a/one:free 保留', after.includes('a/one:free'), '')
check('T2c a/two:free 已移除', !after.includes('a/two:free'), '')
check('T2d 其他 provider 未受影响', after.includes('Model-X') && after.includes('AMD_API_KEY'), '')
check('T2e 其他顶层段未受影响', after.includes('- id: pwsh-sandbox') && after.includes('- id: agent-default-model'), '')
check('T2f nvidia 仍无 models 键（未被误加）', /nvidia:\s*\n\s+apiKeyEnv: NVIDIA_API_KEY/.test(after), '')
check('T2g 备份文件已生成', r2.body.backup && (await fs.readdir(profDir)).some((f) => f.includes('bak-lineup')), '')

// --- T3 给 nvidia 首次写入 models（此前无此键）---
const r3 = await call({ op: 'write', provider: 'nvidia', ids: ['x/one', 'x/two'] })
check('T3 给无 models 的 provider 写入成功', r3.status === 200 && r3.body.ok, JSON.stringify(r3.body).slice(0, 200))
const after3 = await fs.readFile(path.join(profDir, 'cordis.patch.yml'), 'utf8')
check('T3b nvidia 已有两条', after3.includes('x/one') && after3.includes('x/two'), '')
check('T3c pwsh-sandbox 仍在', after3.includes('- id: pwsh-sandbox'), '')

// --- T4 拒绝非法写入 ---
const r4 = await call({ op: 'write', provider: 'nonexistent', ids: ['a'] })
check('T4 未知 provider 被拒绝', r4.status === 409 && !r4.body.ok, 'status=' + r4.status)
const r5 = await call({ op: 'write', provider: 'openrouter', ids: ['dup', 'dup'] })
check('T5 重复 id 被拒绝', r5.status === 400, 'status=' + r5.status)

// --- T6 破坏性 id 被拒（含空格/换行的注入尝试）---
const before6 = await fs.readFile(path.join(profDir, 'cordis.patch.yml'), 'utf8')
const r6 = await call({ op: 'write', provider: 'openrouter', ids: ['bad id with space'] })
const after6 = await fs.readFile(path.join(profDir, 'cordis.patch.yml'), 'utf8')
check('T6 含空格的 id 被结构性校验拦下', r6.status !== 200 || before6 === after6, 'status=' + r6.status)

console.log('=== dsh-lineup-manager 服务端测试 ===')
let pass = 0, fail = 0
for (const r of results) {
  console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.pass ? '' : '   → ' + r.msg))
  r.pass ? pass++ : fail++
}
console.log('')
console.log('小计: PASS=' + pass + '  FAIL=' + fail)
console.log(fail === 0 ? 'GREEN' : 'RED')
await fs.rm(TMP, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
