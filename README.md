# dsh-lineup-manager

线路管理器：在 DeepSeek Harness 设置页勾选要显示的模型线路，按供应商分组管理。

## 解决什么问题

DSH 的模型下拉菜单按供应商分组，但显示的条目数取决于配置：

- 供应商在 `cordis.patch.yml` 里**声明了 `models` 列表** → 菜单只显示列表内的线路
- 供应商**没有声明 `models`** → 菜单显示该适配器返回的**全部线路**（可能上百条）

这导致只想保留免费线路时，必须手工编辑 YAML 文件。本插件把这件事变成设置页里的勾选操作。

## 用法

1. 打开 **设置 → 顶部「线路管理」按钮**
2. 面板列出配置文件中每个供应商及其线路，勾选框控制显示哪些
3. 每个供应商可单独：**全选 / 全不选 / 仅保留 free**，然后点该组的 **保存**
4. 保存后**重启 DSH** 生效

未保存的改动会显示提示；关闭面板时会二次确认。

## 线路刷新

各平台的线路三不五时就变（新增、下线、免费额度调整）。**刷新**会直接向平台端点
拉取当前真实可用的线路清单，与本地配置比对，在面板上标出差异：

- 绿色 **新增** 徽标 = 平台有、但你没勾选
- 灰色划掉 **已下线** 徽标 = 你勾了、但平台已不再提供
- 每家的 **刷新** 按钮刷一家，页脚的 **全部刷新** 一起刷

**刷新只标记，绝不写盘。** 改动依然要你手动勾选后点该家的「保存」才会落盘，
并照常走备份 + 回读校验 + 失败回滚。

### 实现要点（易踩的坑）

- **必须绕开 pi-ai 内置 catalog。** `discoverModels` 一旦收到 `provider` 参数，
  对 openrouter / nvidia / opencode 这类内置了 catalog 的供应商会**直接返回随 DSH
  版本冻结的旧清单**，根本不发请求——刷新就形同虚设。因此刷新只传 `baseURL`。
  这条约束由 `test-refresh.mjs` 的 R2 守护。
- **baseURL 兜底。** 配置里没写 `baseURL` 的供应商（如 opencode），端点从 pi-ai
  的 catalog 里取。同一供应商在 catalog 里按协议有多个端点，需按声明的 `api`
  匹配，否则会取到 `anthropic-messages` 的路径而 404。
- **asar 按需读取。** catalog 装在 `app.asar` 内（约 174 MB）。整包读入会花
  ~125 ms 并把 RSS 顶到数百 MB，而「全部刷新」是并发解析多家。因此只读归档头部
  与目标条目字节区间；实测 4 家并发由 ~905 MB 降到 ~69 MB。由 `test-asar.mjs` 守护。
- **key 过期会被如实报出。** 平台返回 401 `api_key_expired` 时该家显示失败徽标，
  不影响其他家，本地配置也不受影响。

### 强烈建议：每个供应商都显式写 baseURL

```yaml
      openrouter:
        apiKeyEnv: OPENROUTER_API_KEY
        api: openai-completions
        baseURL: https://openrouter.ai/api/v1
```

原因：**没写 `baseURL` 时，插件只能去读安装目录里的 pi-ai catalog 来推断端点**
（那段兜底既要做模块解析、又要穿透 `app.asar`）。这条链路依赖宿主环境，容易失败；
而一失败表现就很差——handler 抛异常、响应为空，客户端只能显示
`HTTP 400 (empty body)`，看不出真实原因（这个坑实际发生过，排查了很久）。

写死 `baseURL` 就完全走直连，不碰那段逻辑。已实测可用的端点：

| 供应商 | baseURL |
|---|---|
| openrouter | `https://openrouter.ai/api/v1` |
| opencode | `https://opencode.ai/zen/v1` |
| nvidia | `https://integrate.api.nvidia.com/v1` |

补 `baseURL` 后需**重启 DSH** 生效。

## 安全性

写配置文件是有风险的操作（写坏了 DSH 可能启动失败），本插件做了四层保护：

| 保护 | 说明 |
|---|---|
| 精确替换 | 只替换目标供应商的 `models:` 行块，不重写整个文件，其他段与 provider 完全不动 |
| 写入前备份 | 每次写入生成 `cordis.patch.yml.bak-lineup-<时间戳>` |
| 结构校验 | 写入前先在内存中校验（provider 无重复、模型 id 合法），不合格直接拒绝 |
| 回读验证 | 写入后从磁盘重读比对，不一致则自动回滚到写入前内容 |

另外：未知供应商返回 409 拒绝；重复 id、含空格的 id 被拒；正文大小上限 256 KB。

备份文件会累积。确认配置正常后可自行清理 `cordis.patch.yml.bak-lineup-*`。

## 接口

服务端注册一个端点，客户端调用：

```
POST /dsh-lineup-manager/api
  { "op": "read" }                              → { ok, file, mtime, providers[] }
  { "op": "write", "provider": "openrouter",
    "ids": ["a/1:free", "a/2:free"] }           → { ok, provider, count, backup, restartRequired }
  { "op": "refresh", "provider": "openrouter" }  → { ok, provider, result: { baseURL, live[], added[], removed[], common[] } }
  { "op": "refreshAll" }                         → { ok, results: [{ provider, ok, result|null, error? }] }
```

`ids` 的顺序即写入顺序，因此可用于重排菜单。

`refresh` / `refreshAll` 是**只读**操作：不写文件、不产生备份。`refresh` 在端点失败时
返回 HTTP 502 与可读的 `error`；`refreshAll` 始终返回 200，逐家给出 `ok` 与 `error`，
单家失败不影响其他家。

## 打包

- 服务端 `index.js`：ESM，导出 `name` / `inject` / `apply` / `__test`
- 客户端 `client.js`：手写 `window.__ModuleLoader__.load({ id, factory(require) })`，无需构建工具
- **loader id 必须等于 package.json 的 `name`**，否则运行时找不到模块，插件不会激活

## 测试

```bash
node test-server.mjs    # 服务端读写逻辑（17 项）
node test-accept.mjs    # 安装完整性 + 端到端（22 项）
node test-refresh.mjs   # 线路刷新：差异计算、绕过静态 catalog、只读性、错误隔离（19 项）
node test-asar.mjs      # asar 读取器内存行为（6 项）
node test-live.mjs      # 真实网络实测：对配置中真实供应商执行 refreshAll（需有效 key）
```

前四套在临时目录用真实文件跑端到端，不触碰实际 profile。`test-live.mjs` 会真实联网
并读取实际 profile 的 key，仅在手动验证时运行；它同时断言配置文件未被刷新改动。

## 兼容性

宿主 DSH `0.2.1-rc.2`。依赖 `webServer` 服务与 `settings.action` slot。
