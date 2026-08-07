# Desktop 应用实现方案

本文档是 Kimi Code Desktop（基于 kimi-code 后端的 Electron 桌面应用）的实现方案。内容分三部分：kimi-code 的客户端协议整理、Codex Desktop 的逆向分析结论，以及在此基础上得出的目标架构、界面映射与实现分期。

> 协议事实均来自本仓库代码（`packages/kap-server`、`packages/protocol`、`packages/transcript`、`packages/klient`），以代码为准。Codex Desktop 的结论来自对本机安装（macOS 上为 `ChatGPT.app`，bundle id `com.openai.codex`，观测版本 26.730.61639）前端产物 `app.asar` 的静态逆向分析，行为可能随版本变化。

::: info 说明
本文档面向开发桌面客户端的工程师，假设读者已了解 Kimi Code CLI 的基本概念（会话、Agent、工具调用、轮次）。这些概念见 [会话与上下文](/zh/guides/sessions)。
:::

## 总体架构

Desktop 采用「Electron 壳 + 内嵌 kap-server 后端 + React 渲染进程」三层结构，与 Codex Desktop 的「Electron 壳 + codex app-server 子进程」架构同构：

```text
┌─────────────────────────────────────────────────────────┐
│ Electron 主进程                                          │
│  · 内嵌 startServer() 启动 kap-server（loopback + token）│
│  · 或附着到已运行的 kimi web 实例（instance registry）   │
│  · 窗口 / 菜单 / 协议注册 / 系统能力                     │
└──────────────┬──────────────────────────────────────────┘
               │ HTTP + WebSocket（127.0.0.1，bearer token）
┌──────────────▼──────────────────────────────────────────┐
│ kap-server（agent-core-v2 引擎）                         │
│  · REST /api/v1/*     · WS /api/v1/ws                   │
│  · transcript 通道（turn / block / delta 粒度）          │
└──────────────▲──────────────────────────────────────────┘
               │ 契约：@moonshot-ai/protocol + @moonshot-ai/transcript
┌──────────────┴──────────────────────────────────────────┐
│ React 渲染进程（Codex 风格 UI）                          │
│  · 侧栏会话列表 / 聊天时间线 / Composer / 面板系统       │
│  · marked 正文渲染管线（与 Codex 对齐）                  │
└─────────────────────────────────────────────────────────┘
```

两个关键设计决策：渲染进程不直接 import 引擎代码，一切数据走 HTTP/WS，契约类型从 `@moonshot-ai/protocol` 与 `@moonshot-ai/transcript` 两个包 import；UI 结构、时间线条目与正文渲染对照 Codex Desktop 实现，设计 token 直接取自逆向所得的 CSS 变量值。

## kimi-code 客户端协议

本节整理 desktop 需要消费的全部协议面：连接与认证、REST、WebSocket、transcript 契约，以及断线重建的标准流程。

### 连接与认证

kap-server 由 `startServer(opts)` 引导（`packages/kap-server/src/start.ts`），不是独立可执行文件；CLI 入口是 `kimi web`。Desktop 主进程内嵌调用 `startServer()` 时必须传 `hostIdentity`（产品名 / 版本 / 平台），`webAssetsDir` 可不传。

| 项 | 值 | 说明 |
| --- | --- | --- |
| 默认 host | `127.0.0.1` | loopback 绑定 |
| 默认 port | `58627` | 冲突时自动 `port + 1` 重试，上限 100 次；也可传 `0` 取临时端口 |
| 认证 token | `<KIMI_CODE_HOME>/server.token` | 首启生成，`0600` 权限，跨重启复用；`KIMI_CODE_HOME` 默认 `~/.kimi-code` |
| HTTP 认证 | `Authorization: Bearer <token>` | 缺失或错误返回 401，envelope `code: 40101` |
| WS 认证 | 同上，或子协议 `kimi-code.bearer.<token>` | 浏览器 / 渲染进程只能用子协议方式 |
| 免认证路径 | `OPTIONS`、`GET /api/v1/healthz`、非 `/api/*` 静态资源 | `/openapi.json` 与 `/asyncapi.json` 也需要 token |

启动后先打 `GET /api/v1/meta` 校验：`server_version`、`capabilities`、`backend`（v2 引擎为 `'v2'`）、`dangerous_bypass_auth` 等字段。不要以 `--dangerous-bypass-auth` 启动——token 是 loopback 上唯一的防线。

附着模式（attach）依赖 instance registry：每个运行中的 server 在 `<KIMI_CODE_HOME>/server/instances/<serverId>.json` 写入 `{server_id, pid, host, port, started_at, heartbeat_at}`，15 秒心跳刷新，按 pid 存活清扫。Desktop 扫描该目录加读取 `server.token` 即可零配置连接已运行的实例，kimi-inspect 就是用这个模式。

### REST API

所有响应统一 envelope：`{code, msg, data, request_id, details?}`，成功为 `code: 0`。HTTP 状态只反映传输层，业务结果全部在 `code` 中：`4xxxx` 客户端错误、`5xxxx` 内部错误、`6xxxx` 工具运行时、`7xxxx` provider 透传、`8xxxx` MCP 透传（`packages/protocol/src/error-codes.ts`）。

按功能分组的核心端点（完整 schema 见 `packages/protocol/src/rest/`）：

| 分组 | Method + Path | 用途 |
| --- | --- | --- |
| 元信息 | `GET /api/v1/meta` | 版本、capabilities、引擎代际 |
| 认证 | `GET /api/v1/auth`、`POST /api/v1/oauth/login` 等 | 就绪度、OAuth device flow 登录 / 轮询 / 取消 / 登出 |
| 配置 | `GET/POST /api/v1/config` | 读 / 打补丁（providers、默认模型、权限模式、hooks 等） |
| 模型 | `GET /api/v1/models`、`POST /api/v1/models/{alias}:set_default` | 模型目录与默认模型 |
| 工作区 | `GET/POST /api/v1/workspaces`、`PATCH/DELETE /api/v1/workspaces/{id}` | 工作区 CRUD；id 形态 `wd_<slug>_<hash12>` |
| 会话 | 见下表 | 生命周期核心 |
| 搜索 | `POST /api/v1/search` | 全局全文搜索（跨会话，带索引状态） |
| 文件 | `POST /api/v1/files`（multipart）、`GET/DELETE /api/v1/files/{id}` | 附件上传 / 下载 |
| 终端 | `GET/POST /api/v1/sessions/{id}/terminals` 等 | PTY 会话（仅 loopback） |
| 技能 | `POST /api/v1/sessions/{id}/skills/{name}:activate` | 激活技能，等价 `/skill` 斜杠命令 |
| 调试 | `GET/POST /api/v1/debug/*` | DI 反射 RPC，需 `--debug-endpoints` 且 loopback |

会话生命周期端点：

| Method + Path | 用途 |
| --- | --- |
| `POST /api/v1/sessions` | 创建会话；body 必须给 `workspace_id` 或 `metadata.cwd` 之一 |
| `GET /api/v1/sessions` | 列表（cursor 分页，`busy` / `archived` / `workspace_id` 过滤） |
| `GET /api/v1/sessions/{id}` | 单查，返回完整 `Session`（含 `usage`、`agent_config`、`pending_interaction`） |
| `POST /api/v1/sessions/{id}/profile` | 更新标题、metadata、`agent_config`、`permission_rules` |
| `POST /api/v1/sessions/{id}:fork` / `:archive` / `:restore` / `:compact` / `:undo` / `:abort` | 分叉 / 归档（软删除，无硬删除）/ 恢复 / 压缩 / 撤回 / 中断 |
| `GET /api/v1/sessions/{id}/status` | 实时状态：`busy`、`model`、`plan_mode`、`context_usage` 等 |
| `GET /api/v2/sessions` | 侧栏会话列表：`activity.status`（`running` / `approval` / `question` / `failed` / `idle`）、`page_token` 分页、可选 `include=git` |

交互端点（发送消息、审批、提问）：

| Method + Path | 用途 |
| --- | --- |
| `POST /api/v1/sessions/{id}/prompts` | 发送 User 消息；body `{content: MessageContent[], model?, thinking?, permission_mode?, plan_mode?, ...}`，返回 `{prompt_id, status: 'running' \| 'queued' \| 'blocked'}`；忙时自动排队 |
| `POST /api/v1/sessions/{id}/prompts/{pid}:abort` | 中止指定 prompt（幂等，已结束返回 `40903`） |
| `GET /api/v1/sessions/{id}/approvals?status=pending` + `POST .../approvals/{approval_id}` | 查询与应答审批请求；`decision` 为 `approved` / `rejected` / `cancelled`，`scope: 'session'` 表示记住规则 |
| `GET /api/v1/sessions/{id}/questions?status=pending` + `POST .../questions/{qid}` / `:dismiss` | 查询与回答提问（单选 / 多选 / 自定义文本 / 跳过） |
| `GET /api/v1/sessions/{id}/messages` | 消息历史分页（`before_id` / `after_id`，content 为 `text` / `tool_use` / `tool_result` / `image` / `thinking` 等 discriminated union） |
| `GET /api/v1/sessions/{id}/snapshot` | IM 式初始同步，见 [断线重建与一致性](#断线重建与一致性) |
| `GET /api/v1/sessions/{id}/transcript` | turn 粒度 transcript 分页，见 [Transcript 契约](#transcript-契约) |
| `GET /api/v1/sessions/{id}/transcript/ops?since_seq=` | 点对点补洞；`complete: false` 表示必须全量刷新 |
| `GET /api/v1/sessions/{id}/transcript/plan` | ExitPlanMode 的计划内容与评审结果 |
| `POST /api/v1/sessions/{id}/fs:{action}` | 会话工作区文件动作：`list` / `read` / `stat` / `mkdir` / `search` / `grep` / `git_status` / `diff` / `open` / `open-in` / `reveal` |
| `GET /api/v1/fs::browse`、`GET /api/v1/fs::home` | 无会话的目录浏览（文件夹选择器） |

契约产物有两个运行时生成的端点：`GET /openapi.json`（由 fastify schema 生成）与 `GET /asyncapi.json`（WS 消息目录），均需 token。更可靠的方式是直接以 TypeScript 依赖消费 `@moonshot-ai/protocol`（REST / 事件 / envelope 的 zod schema）与 `@moonshot-ai/transcript`（transcript 契约）。

### WebSocket 协议

唯一的 WS 端点是 `ws://<host>:<port>/api/v1/ws`。升级请求带 bearer token（header 或 `kimi-code.bearer.<token>` 子协议），随后服务端立即下发 `server_hello`：

```json
{
  "type": "server_hello",
  "timestamp": 1760000000000,
  "payload": {
    "ws_connection_id": "...",
    "protocol_version": 2,
    "max_event_buffer_size": 1000,
    "capabilities": { "event_batching": false, "compression": false }
  }
}
```

客户端回 `client_hello`（仅 `client_id` 必填）完成握手。之后所有帧分三类：客户端控制帧（都有 `ack` 应答）、服务端系统帧、会话事件帧。事件帧的形状为 `{type: 'session_event', seq, epoch?, volatile?, offset?, session_id?, timestamp, payload}`，其中 `seq` / `epoch` 是 per-session 持久 journal 的游标：`seq` 是已应用的最后一个 durable 事件序号，`epoch` 是 journal 代次（重建即变）；`volatile: true` 的事件不进 journal、不推进 `seq`。

客户端控制帧全集：

| type | payload | 说明 |
| --- | --- | --- |
| `client_hello` | `{client_id, token?}` | 握手 |
| `subscribe` | `{session_ids[], cursors?, agent_filter?}` | 订阅会话事件流，`cursors` 携带 replay 游标 |
| `unsubscribe` | `{session_ids[]}` | 退订 |
| `subscribe_v2` | `{session_id, transcript: Record<agentId \| '*', grade>, transcript_since?}` | 唯一的 transcript 订阅通道，grade 为 `off` / `turn` / `block` / `delta` |
| `unsubscribe_v2` | `{session_id, agent_ids?}` | 按 Agent 摘除 transcript 流 |
| `watch_fs_add` / `watch_fs_remove` | `{session_id, paths[], recursive?}` | 工作区文件监听（单连接上限 100 条路径） |
| `pong` | `{nonce}` | 应答 `ping`；kap-server 自身从不主动发 `ping`，也无空闲超时，活性探测由客户端自行实现 |

服务端系统帧：`server_hello`、`ping`、`resync_required`（`reason` 为 `buffer_overflow` / `session_recreated` / `epoch_changed`，客户端须从 REST 重建该会话）、`error`。

会话事件（`session_event` 的 payload）分两类。durable 事件进 journal、可 replay：`turn.started` / `turn.ended` / `turn.step.*`、`tool.call.started` / `tool.result` / `tool.list.updated`、`subagent.spawned` / `started` / `completed` / `failed`、`compaction.*`、`task.started` / `task.terminated`、`prompt.submitted` / `completed` / `aborted` / `steered`、`goal.updated`、`skill.activated`、`session.meta.updated`、`event.session.created` / `work_changed`、`event.workspace.*`、`event.config.*`、`error`、`warning` 等。volatile 事件不 journal：`assistant.delta`、`thinking.delta`（带 `offset` 的文本增量）、`tool.call.delta`、`tool.progress`、`shell.output`、`agent.status.updated`。

投递模型上，全局事件（`session.meta.updated`、`event.session.*`、`event.workspace.*`、`event.config.*`）fan-out 到每个连接，会话 / Agent 粒度事件只发给订阅了该会话的连接，transcript 帧（`transcript.ops` / `transcript.reset`）只受 per-Agent grade 控制。服务端有 16ms 合帧窗口、64 帧批上限与 1MiB 背压水位，相邻的 `assistant.delta` 会被合并——客户端按 `offset` 对齐：`offset` 小于本地已累积长度是重复（跳过），大于则是丢帧（需重取快照）。

### Transcript 契约

Transcript（`packages/transcript`）是聊天渲染的唯一真相源：每个 Agent 一份独立转录，UI 不直接消费 `session_event` 重建时间线。数据模型分三层——分页的 **items**（turn / marker / taskref 混合时间线）与不分页的**全局态**（`tasks` / `interactions` / `attachments` / `todos` / `prompts` / `meta`，每页都带）。

```text
turn（一轮次）
 └─ step（一次模型调用）
     └─ frame：text（Assistant/User 文本）｜ thinking（推理）｜ tool（工具调用）｜ notice（提示）
```

`tool` frame 携带 `toolCallId`、`name`、`state`（`running` / `done` / `error`）、`input` / `output` / `display`、`approvalId` 等；`interaction` 表达审批与提问（`interactionKind: 'approval' | 'question'`，状态机 `pending` → `approved` / `answered` / `dismissed` 等）；`meta` 携带 goal、plan 模式、模型、context 用量等 Agent 级状态。

增量同步走 op batch（L2 幂等操作），共 14 种 op：`reset`、`turn.upsert`、`step.upsert`、`frame.upsert`、`append`（文本增量，带 `offset`）、`marker.upsert`、`taskref.upsert`、`task.upsert`、`interaction.upsert`、`attachment.upsert`、`todo.upsert`、`prompt.upsert`、`meta.merge`、`items.remove`。除 `append` 外全部是整态 upsert，flush 点会重发整态，因此客户端丢帧最终必然收敛；仓库提供现成的 L2 reducer（`packages/transcript/src/ops/`），客户端不要自己实现合并逻辑。

订阅粒度按 Agent 独立设置：

| grade | 内容 | 适用 |
| --- | --- | --- |
| `off` | 无 | 不关注 |
| `turn` | turn 头 + 全局态 | 通知级（侧栏徽章） |
| `block` | + step 头 + flush 点整态 frame，无 `append` | 默认推荐，最便宜的整态收敛 |
| `delta` | 全量含 `append` | 逐 token 打字机效果 |

分页以 turn 为单位：`GET .../transcript?agent_id=main` 不带游标返回最新页，`before_turn` 向旧翻页、`after_turn` 向新翻页；全局态不分页。渲染层用 view registry（`packages/transcript/src/view/`）按 key 分发组件：tool frame 按 `frame.view ?? frame.name`，turn 按 `origin.kind`，task 按 `task.kind`——框架无关，desktop 注入自己的 React 组件即可。

### 断线重建与一致性

官方设计的零缝隙重建路径（kimi-inspect 已验证）按顺序执行：

1. `GET /api/v1/sessions/{id}/snapshot` 拿基线：返回 `{as_of_seq, epoch, session, messages, in_flight_turn, pending_approvals, pending_questions}`，`in_flight_turn` 恢复进行中的流式文本。
2. WS `subscribe` 携带 `cursors: {sid: {seq: as_of_seq, epoch}}`，服务端从内存 tail（上限 1000 条）或磁盘 journal 回放之后的事件。
3. transcript 通道用 `subscribe_v2` 带 `transcript_since` 对齐；发现 seq 空洞时用 `GET .../transcript/ops?since_seq=` 点对点补齐，`complete: false` 或收到 `resync_required` 时回退到 REST 全量刷新。

重连策略参考 kimi-inspect：指数退避（500ms 翻倍、封顶 10s），重连后重新 `client_hello` + 按上面的流程重建。kimi-inspect 还验证了一个值得照抄的模式：**两条独立 socket**——一条 activity socket 不订阅任何会话、只消费全局事件驱动侧栏徽章，一条 transcript socket 服务当前打开的会话。

## Codex Desktop 分析

本节是对 Codex Desktop 前端实现的逆向结论，覆盖技术栈、界面结构、时间线条目、Composer、正文渲染协议与设计 token。它的后端通信模型也一并整理，作为 desktop 主进程设计的参照。

### 技术栈与后端通信

渲染进程技术栈：React 19、Vite 8 + Rolldown、Tailwind v4 + CSS Modules（样式为「自定义 `--color-*` 语义层 → `--vscode-*` 兼容层」双映射）、Slate 富文本编辑器（Composer）、Statsig 实验开关、react-intl 国际化。

后端通信是四层结构，对我们的主进程设计有直接参考价值：

```text
renderer（app:// 协议加载，无网络权限）
   │  window.electronBridge（contextBridge）
   │  · codex_desktop:message-from-view（invoke）/ message-for-view（event）
   │  · 大消息分片协议（codex-host-chunked-message-v1，逐 token 传输 + 逐片 ack）
   ▼
Electron 主进程（AppServerConnection）
   │  transport：stdio（spawn codex app-server，JSONL 逐行）或 websocket（daemon，unix socket）
   ▼
codex 二进制（Rust，内置 app-server，JSON-RPC + MCP 扩展）
```

协议形态是 JSON-RPC（`{id, method, params}`），方法命名空间包括 `thread/*`（start / resume / list / fork / archive / compact…）、`turn/*`（start / interrupt / steer）、`item/*`（`agentMessage/delta`、`commandExecution/outputDelta`、`fileChange/patchUpdated` 等流式通知）、`fs/*`、`config/*`、`model/*`、`account/*`。数据模型是 `thread → turn → item`，与 kimi-code 的 `session → turn → frame` 一一对应（映射表见 [界面映射](#界面映射)）。

可借鉴的主进程设计：渲染进程无网络权限、数据全走 IPC 桥；后端子进程 JSONL over stdio、daemon 模式用 unix socket 供多窗口共享；`initialize` 握手做版本协商，不匹配走 restart / update 两条路径；多连接注册表为远程环境预留 `hostId`。

### App shell 布局

整体为 flex 布局：左侧栏 + 主内容区 + 右侧 / 底部面板（均可拖拽调宽、宽度持久化）。macOS 用系统 `titleBarStyle: 'hiddenInset'` + vibrancy，无自绘标题栏；主窗口默认 1280×820。

左侧栏自上而下：

- **顶部操作**：New chat、Search（`Cmd+K`）、Quick chat（popover 轻量聊天）。
- **会话分区**：Pinned、按 project 分组的会话列表（排序支持 priority / updated / manual）、自定义分区。
- **底部导航**：Pull requests、Library、Sites、Automations（定时任务）、Skills / Plugins、Settings。

右侧与底部是统一的 tab 面板系统，tab 类型包括 `browser` / `diff` / `mcp-app` / `plan` / `sandbox` / `timeline` / `terminal` / `file tree` 等，tab 可在两个面板间移动。核心快捷键：`Cmd+B` 切换侧栏、`Cmd+J` 切换底部面板、`` Ctrl+` `` 切换终端、`Cmd+Shift+E` 文件树。

### 聊天时间线条目

时间线按 `thread → turn → item` 组织，item 渲染分发的 case 全集（与我们相关的加粗）：`user-message`、`assistant-message`、`reasoning`、`exec`、`patch`、`web-search`、`mcp-tool-call`、`dynamic-tool-call`、`permission-request`、`todo-list`、`proposed-plan` / `plan-implementation`、`turn-diff`、`subagent-activity`、`multi-agent-action`、`context-compaction`、`generated-image` / `image-view`、`worked-for`、`steered`、`stream-error` / `system-error`、`model-changed`、`forked-from-conversation` 等。

关键条目的视觉结构：

- **exec（命令执行）卡片**：圆角边框卡片，内含命令、cwd、输出与状态 footer（成功绿勾 / 失败 exit code / 中断 "Stopped"），可折叠展开。
- **patch（文件变更）**：状态机 `applied` / `rejected` / `stopped` / `streaming` / `pending`；每文件一个 diff 区块（header 带增删行数徽标，内容等宽字体、增删行着色），turn 结束时聚合为 `turn-diff`（"N files +X −Y"，带 Revert 按钮）。
- **reasoning（推理）**："Thinking" / "Thought for {elapsed}"，弱化色正文，默认折叠、可展开。
- **permission-request（审批卡片）**：圆角大卡片，标题 + 原因 + 详情，按钮 "Allow once"（主按钮，Enter）/ "Always allow" / "Allow this conversation" / "Deny"（Esc）。
- **worked-for 分隔线**：turn 之间插入 "Working…" / "Worked for {time}" / "You stopped after {time}" 加分隔线。
- **web-search**：单行摘要 "Searched the web for {query}"，进行中显示动画点。
- **user-message**：右侧或独立气泡，role 标题 "You said:"。

组间距 16px、组内间距 4px；活动行头部可折叠（chevron 旋转 + 双色摘要文案）。

### Composer

Composer 是 Codex 交互密度最高的组件，结构为：布局根（column flex）→ 输入体（带 `backdrop-filter` 的表面）→ footer 三列（leading / input / trailing）。要点：

- **输入框**：Slate 富文本，`max-height: 25dvh`，字号 13px；占位符按上下文切换（"Do anything" / goal / plan 文案）。
- **智能下拉**（trigger tooltip "Select model"）：Model / Effort / Speed 三区；effort 梯度 `none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` / `ultra`。
- **权限模式下拉**："Ask for approval" / "Full access"（带二次确认）/ "Custom (config.toml)"。
- **上下文与附件**：`@` 触发文件提及、`$` 触发 skill 提及、`/` 触发斜杠命令（`/init` `/goal` `/plan` `/model` `/compact` `/fork` `/review` 等）；支持拖放附件（"Drop to attach"）。
- **发送 / 停止按钮**：实心圆按钮，tooltip 按状态切换 Send / Steer / Queue / Stop（停止显示 Esc）；忙时发送语义是排队或 steer。

### 正文 Markdown 协议

Codex 的 Assistant 正文是一条 Markdown 字符串，管线为：预处理 → marked lexer（GFM + `breaks: true`）→ tokens → React 组件。要点（完整分析见前序逆向文档）：

- **lexer 选项**：GFM 开、软换行变 `<br>`、标准 `~~strikethrough~~` 被禁用（输入以 `~~` 开头时 `del` tokenizer 直接返回 false）。
- **directive 扩展**：`:::name{attrs}` 容器 / `::name{attrs}` 块 / `:name{attrs}` 内联三级；属性支持 `key=value`、引号、布尔、数字；**未知名称回退为原始文本，不得使整个消息崩溃**。
- **数学**：KaTeX 懒加载，`\[...\]` / `$$...$$` 块级、`\(...\)` 行内，`throwOnError: false`。
- **代码块**：Shiki 高亮；`mermaid` 渲染图表；`md` / `markdown` / `text` 语言可提升为可编辑 writing block；流式未闭合围栏有 `isCodeFenceOpen` 处理。
- **文件引用**：字面量 `【path/to/file.ts†L12】` / `【path†L12-L40】`（`F:` 前缀表示 percent-encoded），渲染为可点击 chip；链接形态支持 `path:12`、`path:12:4-40:8`、`path#L12C4` 等行号锚点。
- **预处理**：HTML 注释剥离；`<details>` 转 `:::github-details`；`> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION]` 转样式化引用块；围栏代码先占位保护。
- **健壮性**：每个扩展 tokenizer 独立 try/catch；Markdown 根部 ErrorBoundary + Retry；一条坏 token 不得拖垮整个会话。

正文以外、需要正文承载的 Codex 自定义 directive 分两类：可见组件（`::codex-file-citation`、`:::github-details`、`::task-stub`、`:::writing` 等）与隐藏副作用（`::git-stage` / `::git-commit` / `::git-create-pr` / `::code-comment` 等，渲染为 null 但驱动其他 UI）。desktop 对齐正文渲染时，可见类照做，隐藏类按 kimi-code 的能力裁剪。

### 设计 token

Codex 的设计 token 分三层：命名色板 → `--color-*` 语义层 → `--color-token-*` / `--vscode-*` 兼容层。以下数值直接从产物 CSS 提取，desktop 照抄即可保证风格一致。

命名色板（节选，light / dark 共用基底）：

| 变量 | 值 | 变量 | 值 |
| --- | --- | --- | --- |
| `--gray-0` / `50` / `75` / `100` | `#fff` / `#f9f9f9` / `#f3f3f3` / `#ededed` | `--gray-300` / `500` / `550` / `600` | `#afafaf` / `#5d5d5d` / `#4f4f4f` / `#414141` |
| `--gray-700` / `750` / `800` / `900` / `1000` | `#303030` / `#282828` / `#212121` / `#181818` / `#0d0d0d` | `--blue-300` / `400` / `500` | `#339cff` / `#0285ff` / `#0169cc` |
| `--green-400` / `500` | `#04b84c` / `#00a240` | `--red-400` / `500` | `#fa423e` / `#e02e2a` |
| `--orange-400` | `#fb6a22` | `--purple-400` | `#924ff7` |

语义层（亮色 / 暗色）：

| 语义变量 | 亮色 | 暗色 |
| --- | --- | --- |
| `--color-background-surface` | `#ffffff` | `#181818` |
| `--color-background-surface-under` | `#f9f9f9` | `#000000` |
| `--color-text-foreground` | `#1a1c1f` | `#ffffff` |
| `--color-background-editor-opaque` | — | `#212121` |
| 边框（普通 / heavy / light） | 前景色 8% / 12% / 5% 混合 | 白色 8% / 16% / 4% 混合 |
| accent（背景 / 文本） | `blue-50` / `blue-300` | `blue-900` / `blue-100` |
| 主按钮 | 黑底白字（前景色底） | `gray-1000` 底 |

排版与尺度：

| 类别 | 值 |
| --- | --- |
| 字体 | sans：`-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`；mono：`ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, monospace` |
| 聊天字号 | `--codex-chat-font-size: 13px`；代码 12px |
| 字号梯度 | xs 11 / sm 12 / base 14 / lg 16 / xl 28 / 2xl 36 / 3xl 48 / 4xl 72（px） |
| 圆角 | 基数 × `--corner-radius-scale`（桌面窗口为 1）：md 8 / lg 10 / xl 12 / 2xl 16 / 3xl 20（px）；药丸行 9999px |
| 间距 | 4px 基数（`--spacing: .25rem`）；toolbar padding 16px、panel 12px；会话组间距 16px、组内 4px |
| 布局 | 主窗口 1280×820；右侧面板最小宽 320px；线程内容最大宽 40rem（扩展窗口）；markdown 宽块上限 64rem |
| 阴影 | 面板分割 `-8px 0 16px -8px rgb(0 0 0 / .18)` |

Markdown 正文排版：正文色 `--color-token-text-primary`、`overflow-wrap: anywhere`；inline code 等宽、`border-radius: 6px`、`padding: 1px 6px`、`font-size: .92em`；code block `border-radius: 10px`、`padding: 8px`、`line-height: 20px`、横向滚动；列表 `padding-inline-start: 1.3125rem`；段落 / 列表间距 `.625rem`。

## 目标设计

综合协议能力与 Codex 的界面结论，本节给出 desktop 的目标设计：进程模型、渲染进程选型、数据层、界面映射表与窗口规格。

### 进程模型

Desktop 支持两种运行模式，默认内嵌：

1. **内嵌模式**：主进程 `startServer({host: '127.0.0.1', port: 0, hostIdentity: {name: 'kimi-code-desktop', ...}})`，`port: 0` 取临时端口后写入 instance registry；token 复用 `<KIMI_CODE_HOME>/server.token`（0600）。引擎与桌面同生命周期，退出时 `close()`。
2. **附着模式**：扫描 `<KIMI_CODE_HOME>/server/instances/` 发现已运行的 `kimi web` 实例，读取 token 直连——多窗口共享一个后端，也便于开发时对着 CLI 起的服务调试 UI。

渲染进程不持有 token 明文之外的网络权限，HTTP 走 `fetch`、WS 用 `kimi-code.bearer.<token>` 子协议。升级与版本兼容在启动时通过 `GET /api/v1/meta` 校验（`backend === 'v2'`、`server_version` 下限）。

### 渲染进程技术选型

与 Codex 对齐：React 19 + Vite + Tailwind v4 + CSS Modules；Composer 输入框用 Slate（或同等能力的富文本层）以承载 `@` / `$` / `/` 提及；Markdown 管线用 marked + 自定义扩展（directive、math、`【†L】` 引用），高亮用 Shiki，数学用 KaTeX 懒加载。契约层依赖 `@moonshot-ai/protocol`（REST / 事件 zod schema）与 `@moonshot-ai/transcript`（transcript 契约 + L2 reducer + view registry），不手写 wire 类型。

### 数据层与渲染管线

数据层照抄 kimi-inspect 验证过的模式，两条 WS + REST 基线：

1. **activity socket**：`client_hello` 后不订阅任何会话，只消费全局事件（`event.session.work_changed`、`session.meta.updated` 等）驱动侧栏徽章与列表失效。
2. **transcript socket**：服务当前会话，`subscribe_v2` grade 默认 `block`（要逐 token 打字机效果时切 `delta`），配合 `transcript_since` 与 `/transcript/ops` 补洞。
3. **REST 基线**：会话列表用 `GET /api/v2/sessions`；打开会话先 `GET .../snapshot`（或 transcript 最新页），向上滚动用 `before_turn` 翻页。

渲染管线：`transcript.ops` → L2 reducer（直接用 `@moonshot-ai/transcript` 的实现）→ store → view registry 按 key 分发到 React 组件 → 正文 frame 进 marked 管线。交互（审批 / 提问）以 transcript 的 `interactions` 为准渲染卡片，应答走 REST；重连后用 `GET .../approvals?status=pending` 兜底。

### 界面映射

Codex 时间线条目与 kimi-code 协议对象的对应关系（desktop 组件按此实现）：

| Codex item | kimi-code 来源 | 组件要点 |
| --- | --- | --- |
| `user-message` | `text` frame（`role: 'user'`）/ turn `prompt` | 用户气泡 |
| `assistant-message` | `text` frame（`role: 'assistant'`） | marked 正文管线 |
| `reasoning` | `thinking` frame | 弱化色、默认折叠 |
| `exec` | `tool` frame（`Bash` 等）/ `task`（`kind: 'shell'`） | 命令卡片 + 状态 footer |
| `patch` / `turn-diff` | `tool` frame（`Edit` / `Write` 等）+ `fs:diff` | 文件 diff 区块、turn 聚合 |
| `web-search` | `tool` frame（`WebSearch`） | 单行摘要 + 动画点 |
| `permission-request` | `interactions`（`approval`）+ `ApprovalRequest` | 审批卡片（Allow once / Always / Deny） |
| `todo-list` | 全局态 `todos` | 任务清单 |
| `proposed-plan` | plan 交互（`display.kind: 'plan_review'`）+ `GET .../transcript/plan` | 计划卡片（Accept / Revise） |
| `mcp-tool-call` | `tool` frame（MCP 工具） | 带 MCP server 标识 |
| `subagent-activity` | `subagent.*` 事件 + 子 Agent transcript | 活动行 + 可展开子转录 |
| `context-compaction` | `compaction.*` 事件 / marker | 分隔提示 |
| `worked-for` | turn 的 `startedAt` / `endedAt` / `durationMs` | turn 分隔线 |
| `generated-image` / `image-view` | `attachment` / `image` content | 图片展示 |
| `stream-error` / `system-error` | `notice` frame / `turn.ended` 的 `error` | 错误横幅 |

Codex 有而 kimi-code 暂无对应物的条目（如 `realtime-transcript`、`automation-update`、`pull-requests` 视图）首期不做；kimi-code 有而 Codex 没有的（goal、questions 提问卡片、skill 激活行）按 transcript 全局态正常渲染。

### 窗口与快捷键

主窗口默认 1280×820，macOS `titleBarStyle: 'hiddenInset'` + vibrancy；右侧面板（diff / 文件树 / 浏览器）最小宽 320px、宽度持久化；底部面板承载终端（`POST .../terminals` PTY，仅 loopback 可用）。快捷键对齐 Codex：`Cmd+B` 侧栏、`Cmd+J` 底部面板、`` Ctrl+` `` 终端、`Cmd+K` 搜索、`Cmd+Shift+E` 文件树、Enter 批准 / Esc 拒绝审批。

## 实现分期

按可验证的里程碑推进，每期结束都是可用状态：

1. **M0 脚手架与连接**：Electron 工程（electron-vite）、内嵌 `startServer`、token 管理、`GET /api/v1/meta` 校验、activity socket 连通。验收：窗口打开、侧栏显示后端版本。
2. **M1 会话列表**：`GET /api/v2/sessions` 分页列表、activity 徽章、新建 / 归档 / 搜索（`POST /api/v1/search`）、工作区选择器（`fs::browse`）。验收：完整管理会话。
3. **M2 聊天渲染**：transcript REST 分页 + `subscribe_v2`（block）+ L2 reducer + view registry；marked 正文管线（GFM + breaks + directive 容错 + Shiki + KaTeX + 文件引用 chip）；tool / thinking / notice 组件。验收：历史与流式渲染正确、断线重连无缝恢复。
4. **M3 Composer 与交互**：Slate 输入、`@` / `$` / `/` 提及、附件上传（`POST /files`）、发送 / 排队 / steer / 停止；审批卡片、提问卡片、plan 评审；权限模式与 effort 下拉（写回 `POST .../prompts` 与 profile）。验收：完成一轮含审批的完整任务。
5. **M4 面板系统**：右侧 diff（`fs:diff` / `fs:git_status`）、文件树（`fs:list` / `fs:read`）、底部终端（terminals REST + 独立 PTY 通道）、`open-in` 外部打开。验收：实现 Codex 的面板体验。
6. **M5 打磨**：设计 token 全量落地（亮暗主题）、快捷键、多窗口（附着模式共享后端）、导出（`POST .../export`，`desktop: true` 打包桌面日志）。

## 参考实现与物料

- **kimi-inspect**（`apps/kimi-inspect`）：现成的 Web 客户端，instance registry 发现、双 socket、transcript 渲染与补洞逻辑均可直接对照。
- **契约包**：`@moonshot-ai/protocol`（REST / WS / 事件）、`@moonshot-ai/transcript`（transcript 契约 + reducer + view registry）。
- **运行时契约**：`GET /openapi.json`、`GET /asyncapi.json`（需 token）。
- **OpenWork**（`.tmp/openwork`）：开源的 Codex 风格 Electron 桌面应用（React + Electron），其工程结构（主进程 /  preload / renderer 分层、打包）可作脚手架参照。

## Next steps

- [kimi 命令](/zh/reference/kimi-command) — `kimi web` 的启动参数与默认值
- [交互与输入](/zh/guides/interaction) — Kimi Code 的交互约定
- [内置工具](/zh/reference/tools) — 工具调用如何进入会话上下文
