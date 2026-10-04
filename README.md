# dsh-memu

把 DeepSeek Harness（DSH）接成 [memU](https://github.com/Swcmb/memU) 的一等宿主。它一个包同时绑住 memU 的两条 seam：

- **record** —— 订阅 DSH 的 `session/event`，把每个会话投影成 memU 能挖的规范 JSONL。
- **inject** —— 往系统提示词注册常驻指令，并提供 `memu_retrieve` 等原生工具。

本仓库是 memU 主仓库的 git submodule，也是可独立安装的公开仓库：既可以
`git clone` 下来单独装，也可以随 memU 主仓库一起 checkout。

## 它做什么

| 部分 | 行为 |
| --- | --- |
| 导出 | 落盘 `~/.dsh/memu/transcripts/<encoded-cwd>/<session-id>.jsonl`，与 DSH 自己的 cwd 编码一致（`D:\memU` → `--D-memU--`） |
| 投影 | 只保留三类记录：`message` / `tool_call` / `tool_result`；`reasoning`、`system/message`、`request/header`、`session/title*`、`session-log-deepseek/*` 等噪音一律丢弃 |
| 增量 | 加载时用 `seq` 补录（`session.snapshotEvents()`），之后实时追加；已在补录窗口内的事件会被去重 |
| 指令 | 系统提示词段落 `memu-memory`（默认 order 900）：问题可能依赖既往偏好 / 历史决定 / 项目约定时，先调 `memu_retrieve` |
| 工具 | `memu_retrieve`、`memu_bridge_prepare`、`memu_bridge_commit`，都经 `ctx.subprocess` 调 `memu-dsh` |

**全链路 fail-open**：导出或调用失败只写日志，绝不向会话事件路径抛异常，也不会拦住 DSH 的任何一步。

## 安装

前提：memU 的 `memu-dsh` 二进制在 `PATH` 上（`uv tool install --editable <memU 检出目录>`）。

```sh
# 方式一：从独立仓库克隆
git clone https://github.com/Swcmb/dsh-memu.git
dsh plugin --profile desktop add link:<克隆路径>

# 方式二：作为 memU 主仓库的 submodule 一起 checkout
git clone --recurse-submodules git@github.com:Swcmb/memU.git
dsh plugin --profile desktop add link:<memU 检出目录>/dsh-memu
```

装完确认 profile 的 `package.json` 里 `dependencies` 与 `dsh.profile.bundles` 都出现了
`dsh-memu`。**新装或改动插件 JS 之后都要重启 DSH**，原因见"开发与更新"。

> ⚠️ **只能用 `link:` spec**。用 `file:<目录>` 安装时，pnpm 的目录依赖语义会把
> `dsh-memu/` 源目录搬空（本机实测过一次），源文件只能再从 profile 副本里捞回来。

## 配置

插件自身没有配置文件，配置由 profile 的 Cordis 层传给 `apply(ctx, config)`；
省略的字段用下面的默认值：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `exportEnabled` | `true` | 是否导出会话转录 |
| `instructionEnabled` | `true` | 是否注入常驻指令段落 |
| `toolEnabled` | `true` | 是否注册 memU 工具 |
| `command` | `["memu-dsh"]` | 调 memU 的命令前缀（不在 PATH 上时可改成 `["uv","run","--project","<memU 检出目录>","memu-dsh"]`） |
| `transcriptsDir` | `<DSH_HOME>/memu/transcripts` | 导出目录；DSH 侧适配器读的也是它 |
| `maxFieldChars` | `8000` | 单个字段的截断长度，超出部分标注被截掉的字符数 |
| `sectionOrder` | `900` | 系统提示词段落的排序位 |

memU 自己的配置（记忆后端、embedding 密钥）仍然只由 `~/.memu/config.env` 与 `memu-dsh config` 管。

## 卸载

```sh
dsh plugin --profile <profile> remove dsh-memu
```

导出目录 `~/.dsh/memu/transcripts/` 是中间产物：删掉不会影响已提交的记忆，但会让
**还没被挖掘**的对话失去素材，所以删之前先确认。

## 验证

```sh
cd <memU 检出目录>/dsh-memu
node --test
```

28 个用例：投影映射、噪音丢弃、字段截断、cwd 编码、首次全量补录、重新跟踪只补新增、
实时追加与补录去重、未跟踪会话不落盘、工具侧的子进程读取（pipe 流 + 晚到的输出 +
完全无输出时的接线诊断），以及入口接线（服务晚于 `apply` 就绪时经 `internal/service`
补接线、段落名重复时降级、配置开关）。

端到端联调（需要 `memu-dsh`）：

```sh
memu-dsh prepare          # 必须报出会话数；0 是新装的正常结果
memu-dsh doctor           # 未配 embedding 密钥时失败是预期的
```

## 开发与更新

- **改 `lib/*.js` 之后必须重启 DSH。** `link:` 插件的 JS 在一个 DSH 进程里只 import 一次：
  `dsh plugin --profile <p> add/remove`（以及 plugin-manager 的 install/remove）只**重注册**
  bundle 条目，不会重新导入已缓存的 ESM 模块——manager 报 `applied` 并不代表新代码生效
  （只有它自己判定确实需要时才返回 `restart-required`）。HMR 也救不了：它的 watcher 只盯
  profile 目录并忽略 `**/node_modules`，而 `link:` 的目标在 profile 之外
  （`D:\memU\dsh-memu`），源码改动永远进不了它的 stash 集合。
- **接线必须等服务就绪，不能在 `apply` 时一次性抓服务。** Cordis 并发加载兄弟插件，
  `ctx.get("tools")` 在 `apply` 时通常还是 `undefined`（实测 web 与 headless 都要等约 0.5s
  才出现）。早期版本此刻只写一条告警就返回，结果是**工具在整个宿主里静默失踪，而指令段落
  照常注入**——排查时极具迷惑性（agent 会说"系统提示词里提到了 memu_retrieve，但我的工具
  列表里没有"）。现在 `whenService()` 用 `internal/service` 事件 + 轮询等服务出现后再接线，
  30s 仍未就绪才降级告警。
- **改完怎么验证**：重启桌面应用，或用一个全新进程（`dsh --profile <CLI 管理的 profile> "..."`）
  跑一次，然后确认工具不再返回旧行为——例如 `memu_bridge_prepare` 能回出 job 清单与任务
  说明，而不是空。

## 已知限制

- **工具输出取决于宿主给出的 subprocess 接线。** 0.1.0 首版用 collect 读数器，在真宿主里
  读数器始终为空，于是「有输出」被误报成「无输出」；现行实现改走 `pipe` 流（spawn 后立刻
  挂读取器、`done` 落地后再取文本，collect 快照只作兜底）。若再看到
  `无输出（stdout=… stderr=… collected=…）` 这种带诊断的失败，说明宿主这次没给出可读流，
  诊断串会指明是哪一路、以及 collected 里有什么。
- **不回填安装前的历史会话**：插件只在加载之后跟踪会话，更早的会话 DSH 已写入自己的多帧
  zstd 日志，本插件不解析它。
- **转录根下所有 cwd 目录都会被 memU 发现**：多 cwd 共享同一个 `scan_region` 语义。
- **不 import 任何 `@deepseek-ai/*` 包**：`link:` 安装时 Node 沿真实路径解析 bare specifier，
  而 `dsh-memu/` 下没有 `node_modules`，因此 DSH_HOME 直接读 `process.env.DSH_HOME`
  （回退 `~/.dsh`），配置校验也自带默认值而不依赖 schemastery。

## 与 memU 适配器的分工

本插件只负责「把 DSH 的会话变成 memU 认得的东西」和「让 DSH 在回答前能取到记忆」。
挖掘流水线、job 模板、内容哈希快照与回写全部在 memU 侧（`memu-dsh`，源码在
`src/memu/hosts/dsh/`）。

## License

Apache-2.0（与 memU 主仓库一致）。
