# dsh-lineup-manager

**在 DeepSeek Harness 的模型下拉菜单里挑选要显示的线路——按供应商分组，并从各平台实时刷新。**

[English](README.md) · [简体中文](README-zh.md) · [Español](README-es.md) · [Português](README-pt.md) · [हिन्दी](README-hi.md)

## Compatibility

| 表面 | 状态 |
|---|---|
| Harness | DeepSeek Harness `0.2.1-rc.2` |
| Node | `^22.19.0 || >=24.0.0` |
| 平台 | 全平台（纯 ESM；无原生代码、无构建工具链） |

## The problem

DSH 的模型下拉菜单按供应商分组，但显示多少条目取决于你的配置：

- 供应商**声明了 `models:` 列表** → 菜单只显示列表内的线路
- 供应商**没有 `models:` 列表** → 菜单显示该适配器的**全部线路**，可能上百条

所以只想保留免费线路时，必须手工编辑 YAML。本插件把这件事变成设置页里的勾选操作。

各平台的线路三五天就变一次——新模型上线、免费额度下线。刷新会拉取实时清单并标出差异，
不用离开面板就能看到哪里变了。

## Features

- 每个供应商的每条线路一个勾选框
- 按供应商批量操作：**全选** / **全不选** / **仅保留 free**
- **刷新** —— 拉取平台当前线路清单，标出**新增**与**已下线**；单家刷新和**全部刷新**都有
- 平台新上线、但配置里还没有的线路，刷新后可以直接勾选
- 写入是精确且有回滚的：只替换目标供应商的 `models:` 行块，写入前备份、写入后结构校验与回读验证，不一致就回滚

## Install

### 用 tarball（推荐）

```sh
pnpm pack                       # 产出 dsh-external-dsh-lineup-manager-<version>.tgz
dsh plugin add ./dsh-external-dsh-lineup-manager-0.2.0.tgz
```

之后重启 DSH。

### 从 git 仓库安装

```sh
dsh plugin add github:<you>/dsh-lineup-manager
```

`prepare` 脚本会在安装时构建 `dist/`。pnpm ≥10 默认拒绝执行 git 依赖的构建脚本；
如果第一次 `add` 失败，在 profile 的 `pnpm-workspace.yaml` 里加上这段再重试：

```yaml
allowBuilds:
  "@dsh-external/dsh-lineup-manager": true
```

只对可信来源放行，并固定提交：`github:<you>/dsh-lineup-manager#<sha>`。

### 手动安装

```sh
pnpm install
pnpm build                     # 产出并校验 dist/
```

然后把整个包复制进 `$DSH_HOME/profiles/<profile>/node_modules/`，重启 DSH。

## Usage

1. 打开 **设置 → 顶部「线路管理」按钮**
2. 面板列出 `cordis.patch.yml` 中每个供应商及其线路，勾选框控制显示哪些
3. 每个供应商可单独：**全选 / 全不选 / 仅保留 free**，然后点该组的 **保存**
4. **重启 DSH** 才会反映到模型下拉菜单

未保存的改动会显示提示；关闭面板时会二次确认。

### 刷新

点某家的 **刷新**（或页脚的 **全部刷新**）拉取该平台的当前清单：

- 绿色 **新增** 徽标 = 平台有、但你没勾选
- 灰色划掉 **已下线** 徽标 = 你勾了、但平台已不再提供

**刷新绝不写盘。** 它只负责标记。在你勾选并点「保存」之前，配置文件一个字都不会变；
保存仍走备份 / 结构校验 / 回读回滚那条路。

### 强烈建议：每个供应商都显式写 baseURL

```yaml
      openrouter:
        apiKeyEnv: OPENROUTER_API_KEY
        api: openai-completions
        baseURL: https://openrouter.ai/api/v1
```

没写 `baseURL` 时，插件只能去读安装目录里 `app.asar` 内的 pi-ai catalog 来推断端点。
这条链路依赖宿主环境，失败时表现很差——响应为空，客户端只能显示
`HTTP 400 (empty body)`。写死 `baseURL` 就直接走网络，完全不碰那段代码。

已实测的端点：

| 供应商 | baseURL |
|---|---|
| openrouter | `https://openrouter.ai/api/v1` |
| opencode | `https://opencode.ai/zen/v1` |
| nvidia | `https://integrate.api.nvidia.com/v1` |

改 `baseURL` 需要重启 DSH。

## Safety

写配置文件是有风险的操作（写坏了 DSH 可能启动失败），本插件做了四层保护：

| 保护 | 说明 |
|---|---|
| 精确替换 | 只替换目标供应商的 `models:` 行块，其他供应商与段落完全不动 |
| 写入前备份 | 每次写入生成 `cordis.patch.yml.bak-lineup-<时间戳>` |
| 结构校验 | 写入前先在内存中校验（供应商无重复、模型 id 合法），不合格直接拒绝 |
| 回读验证 | 写入后从磁盘重读比对，不一致则自动回滚到写入前内容 |

另外：未知供应商返回 409 拒绝；重复 id、含空格的 id 被拒；正文大小上限 256 KB。

备份文件会累积。确认配置正常后可自行清理 `cordis.patch.yml.bak-lineup-*`。

## How refresh works (and the traps)

### 必须绕开 pi-ai 内置 catalog

`discoverModels` 一旦收到 `provider` 参数，就会返回**随 DSH 版本冻结的**内置 catalog。
这是一种静默失效：功能看起来能用，显示的却是几个月前的数据。因此刷新只传 `baseURL`、
**绝不**传 `provider`。由 `test-refresh.mjs` 的 R2 守护。

### 命名空间

`dsh-llm-pi-ai` 用**它自己**的 loader entry id（profile 里声明的 `llm-pi-ai`）注册模型探测。
本插件跑在另一个 entry 下，所以用 `ctx.fiber.entry.options.id` 推导会得到
`dsh-lineup-manager`，内核回一句 `NO_DISCOVERY`。命名空间是个常量。
由 `test-refresh.mjs` 的 R9 守护。

### asar 读取

catalog 装在 `app.asar` 内（约 174 MB）。整包读入要 ~125 ms 并把 RSS 顶到数百 MB，
「全部刷新」还会乘以家数。读取器是定位读取：只读归档头部与目标条目的字节区间。
实测 4 家并发解析由 ~905 MB 降到 ~69 MB。由 `test-asar.mjs` 守护。

### key 过期

平台返回 `401 api_key_expired` 时，该家显示失败徽标；其他家不受影响，配置也不受影响。
刷新把这件事报出来正是它的职责，不是 bug。

## Layout

```
src/                  运行时源码
  index.js            服务端：围绕 cordis.patch.yml 的 HTTP API
  client.js           客户端：设置页面板
  cordis.patch.yml    bundle patch
scripts/build.mjs     产出 dist/ 并校验副本
tests/                纯 Node 测试套件
dist/                 构建产物（不入版本库）
```

## Development

```sh
pnpm build        # 产出并校验 dist/
pnpm test         # 四套共 66 项检查
pnpm test:live    # 访问真实供应商端点，需要真实凭据
```

| 套件 | 覆盖 |
|---|---|
| `test-server.mjs` | 配置读写、四层写入保护（17） |
| `test-accept.mjs` | 安装完整性 + 端到端（22） |
| `test-refresh.mjs` | 刷新差异、绕过内置 catalog、命名空间、只读性（21） |
| `test-asar.mjs` | asar 读取器的内存行为（6） |

前四套全部在临时目录里跑，不触碰真实 profile。`test-live.mjs` 会真实联网并读取你的
真实凭据，同时断言配置文件未被改动。

## License

[MIT](LICENSE)
