// 验收：dsh-lineup-manager 安装完整性 + 服务端逻辑
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const PROFILE = path.join(process.env.USERPROFILE, '.dsh/profiles/desktop')
const NM = path.join(PROFILE, 'node_modules/dsh-lineup-manager')

const results = []
function check(name, cond, msg = '') {
  results.push({ name, pass: !!cond, msg })
}

// ---- 安装完整性 ----
const pkgRaw = await fs.readFile(path.join(PROFILE, 'package.json'), 'utf8')
const pkg = JSON.parse(pkgRaw)
const bundles = pkg.dsh.profile.bundles || []

check('I1 实体已安装', await fs.stat(NM).then(() => true).catch(() => false))
check('I2 依赖已声明', !!pkg.dependencies['dsh-lineup-manager'], pkg.dependencies['dsh-lineup-manager'] || '')
check('I3 已注册 bundles', bundles.includes('dsh-lineup-manager'))
for (const f of ['index.js', 'client.js', 'cordis.patch.yml', 'package.json']) {
  check('I4 文件存在: ' + f, await fs.stat(path.join(NM, f)).then(() => true).catch(() => false))
}

// package.json 契约
const myPkg = JSON.parse(await fs.readFile(path.join(NM, 'package.json'), 'utf8'))
check('I5 main 指向 index.js', myPkg.main === './index.js', myPkg.main)
check('I6 exports 含 ./client', !!myPkg.exports['./client'], JSON.stringify(myPkg.exports))
check('I7 dsh.bundle.patch 已声明', myPkg.dsh?.bundle?.patch === './cordis.patch.yml')
check('I8 dsh.client.platform 为 web', myPkg.dsh?.client?.platform === 'web')

// loader id 必须等于包名
const clientSrc = await fs.readFile(path.join(NM, 'client.js'), 'utf8')
const idMatch = clientSrc.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)
check('I9 loader id 等于包名', idMatch && idMatch[1] === 'dsh-lineup-manager', idMatch ? idMatch[1] : '未找到')

// ---- 服务端逻辑（端到端，真实文件）----
const mod = await import('file:///' + path.join(NM, 'index.js').replace(/\\/g, '/'))

const TMP = path.join(os.tmpdir(), 'lineup-acc-' + Date.now())
const profDir = path.join(TMP, 'profiles', 'desktop')
await fs.mkdir(profDir, { recursive: true })

const sample = `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      alpha:
        apiKeyEnv: A_KEY
        models:
          - id: a/1:free
            name: A1
            contextWindow: 1000
          - id: a/2
            name: A2
      beta:
        apiKeyEnv: B_KEY
- id: other
  name: other
  config:
    x: 1
`
await fs.writeFile(path.join(profDir, 'cordis.patch.yml'), sample, 'utf8')

process.env.DSH_HOME = TMP
process.env.DSH_PROFILE = 'desktop'

let handler = null
mod.apply({
  effect: (fn) => fn(),
  webServer: { register: (r) => { handler = r.handler; return () => {} } },
})
check('S1 webServer 路由已注册', !!handler)

function mkReq(body) {
  const c = [Buffer.from(JSON.stringify(body))]
  return { method: 'POST', headers: {}, on(ev, cb) { if (ev === 'data') c.forEach(cb); if (ev === 'end') cb(); return this } }
}
function mkRes() {
  const o = { status: 0, body: null }
  return { o, writeHead(s) { o.status = s }, end(b) { o.body = JSON.parse(b) } }
}
async function call(b) { const res = mkRes(); await handler(mkReq(b), res); return res.o }

const r = await call({ op: 'read' })
check('S2 read 返回 alpha 与 beta', r.body.providers?.length === 2, JSON.stringify(r.body.providers?.map?.((p) => p.name)))

const w = await call({ op: 'write', provider: 'alpha', ids: ['a/2', 'a/1:free'] })
check('S3 write 成功（含重排序）', w.body.ok, JSON.stringify(w.body))
const txt = await fs.readFile(path.join(profDir, 'cordis.patch.yml'), 'utf8')
check('S4 写入顺序被保留', txt.indexOf('a/2') < txt.indexOf('a/1:free'))
check('S5 其他 provider 未动', txt.includes('apiKeyEnv: B_KEY'))
check('S6 其他段未动', txt.includes('- id: other'))
check('S7 备份已生成', (await fs.readdir(profDir)).some((f) => f.includes('bak-lineup')))

const r2 = await call({ op: 'read' })
const alpha = r2.body.providers.find((p) => p.name === 'alpha')
check('S8 写后读一致', alpha.models.map((m) => m.id).join(',') === 'a/2,a/1:free', alpha.models.map((m) => m.id).join(','))

const bad = await call({ op: 'write', provider: 'nope', ids: ['x'] })
check('S9 未知 provider 被拒', bad.status === 409, 'status=' + bad.status)

check('S10 metadata 保留（A2 的 name）', txt.includes('name: A2'))

await fs.rm(TMP, { recursive: true, force: true })

console.log('=== dsh-lineup-manager 全量验收 ===')
let pass = 0, fail = 0
for (const x of results) {
  console.log((x.pass ? 'PASS  ' : 'FAIL  ') + x.name + (x.pass ? '' : '   → ' + x.msg))
  x.pass ? pass++ : fail++
}
console.log('')
console.log('小计: PASS=' + pass + '  FAIL=' + fail)
console.log(fail === 0 ? 'GREEN' : 'RED')
process.exit(fail === 0 ? 0 : 1)
