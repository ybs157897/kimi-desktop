# 06 · 协议层（protocol / klient / node-sdk / transcript / acp）研究报告

> 分析对象：`packages/protocol`（5,394 行 src / 10,510 行含测试）、`packages/klient`（4,931 行）、`packages/node-sdk`（7,153 行）、`packages/transcript`（3,824 行）、`packages/acp-adapter`（5,534 行）、`packages/acp-server`（5,483 行）
> 报告日期：2026-08-06。行号引用均以本仓库当前 HEAD 为准；除标注外均为 src 下文件。

## 1. 子系统定位与职责

这六个包构成 Kimi Code 的"协议层"：一端定义 Kimi Code 引擎（agent-core / agent-core-v2）**对外线协议**的类型与契约，另一端把同一套引擎能力翻译成**第三方集成协议（ACP）**与**宿主 SDK 外观**。可以按"面向谁"把它们分成三组：

- **线协议规范（`protocol`）**：Kimi Code daemon 的 REST + WebSocket 协议 schema 库。它定义了信封（envelope）、错误码、分页、WS 控制帧、事件类型、消息/会话/任务/工具/FS 等全部线上数据形状。它是**纯类型与纯 schema**（zod），零运行时逻辑，唯一目的是让多个实现方（v1 引擎、v2 引擎、服务器、客户端、Web UI）对同一份协议说话。`kap-server` 是它的主要"消费者-镜像"：`packages/kap-server/src/protocol/` 存在一份**同名同构的协议拷贝**（含 `events-zod.ts`、`rest-*.ts`），且 kap-server 的 `package.json` 并不依赖本包——两处靠人工保持同步，这解释了为什么 protocol 包本身在 v2 时代处于"半冻结"状态。
- **客户端 SDK 双雄（`klient` + `node-sdk`）**：`klient` 是面向 **agent-core-v2 引擎**的传输无关客户端 facade（`global.*` / `session(id).*` / `agent(id).*`，ipc/memory 双传输）；`node-sdk`（`@moonshot-ai/kimi-code-sdk`）是**对外发布**的宿主 SDK，把 v1/v2 两代引擎统一成一套 `KimiHarness`/`Session` 外观。`klient` 是 v2 时代的"内网客户端"，`node-sdk` 是"公共入口"。
- **ACP 桥（`acp-adapter` + `acp-server`）**：Agent Client Protocol（ACP，Anthropic 主导的开放协议，见 <https://agentclientprotocol.com/>，Zed / JetBrains 等编辑器用它驱动编码 agent）的两种服务器实现。`acp-adapter` 桥接 **v1 引擎**（agent-core + node-sdk 的 KimiHarness），`acp-server` 桥接 **v2 引擎**（agent-core-v2 + klient），二者都是 `kimi acp` 子命令的后端，通过 `KIMI_CODE_LEGACY_FLAG` 切换。
- **转录层（`transcript`）**：会话转录（transcript）的**同构渲染数据层**——把引擎事件流投影为可渲染的回合制时间线（turn/step/frame 树），供 Web UI（经 kap-server REST/WS）消费。它是协议层里唯一"向下"消费引擎事件、向上提供渲染模型的包。

### 1.1 与 KAP / agent-core / agent-core-v2 的关系

"KAP"（Kimi Agent Protocol）不是一个独立协议文件，而是 **`/api/v1` REST + `/api/v1/ws` WebSocket 整套线协议的对外统称**（详见 04 号报告）。本层六个包与 KAP 的关系：

```
                     ┌────────────────── KAP（线协议，/api/v1 REST + WS）──────────────────┐
                     │                                                                     │
   @moonshot-ai/protocol  ── 定义信封/错误码/事件/请求响应 schema（规范源，纯 zod）          │
        ▲ 镜像（手工同步）        ▲ 定义事件帧类型                                   │
        │                        │                                                    │
 kap-server/src/protocol/ ── 服务器侧协议拷贝            agent-core(v1) rpc/* ── v1 引擎用 protocol 定义 RPC 线契约
        │                        │                                                    │
   kap-server（REST/WS 宿主）    agent-core-v2 ── 引擎侧（仅 tool display schema）        │
        │                        │                                                    │
        └── WS 事件流 ── 消费方：Web UI（浏览器）、klient 事件契约的镜像、pi-tui      │
                                                                                     │
   @moonshot-ai/klient  ── agent-core-v2 的客户端 facade（ipc/memory，契约驱动）      │
   @moonshot-ai/node-sdk ── 宿主 SDK（v1: agent-core createRPC；v2: klient/memory）   │
   @moonshot-ai/acp-adapter ── ACP stdio 服务器（v1 引擎）                             │
   @moonshot-ai/acp-server   ── ACP stdio 服务器（v2 引擎，native）                    │
   @moonshot-ai/transcript   ── 转录渲染数据层（被 kap-server 消费）                    │
```

关键架构事实：

1. **protocol 是"规范源"而非"运行依赖"**：v2 引擎链（agent-core-v2、kap-server、klient）几乎不 import 它——agent-core-v2 只用了 `ToolInputDisplay`（`tool/toolContract.ts:21`、`agent/toolExecutor/toolExecutorService.ts:23`），kap-server 完全用自己的拷贝，klient 仅把它作为 devDependency 做编译期 parity 断言。真正的运行依赖方是 **v1 引擎 agent-core**（rpc/core-api、rpc/events、rpc/core-impl 及 oauth/skill/config/fileStore/workspace/terminal/message 等服务的 wire 类型）和 **acp-server**（事件类型）。
2. **两代客户端是"同一协议、两个实现"**：node-sdk 的 v1 客户端走 agent-core 的 `createRPC`（进程内 + setTimeout/JSON 模拟网络），v2 客户端走 `bootstrap()` + klient memory 传输——但对外暴露**恒定的 v1 协议形状**（`Event`/`SessionSummary`/`KimiConfig`）。v1 语义兼容层被完整地搬进了 node-sdk 的 `v2/` 目录（event-mapper、session-mapper、config-mapper、resume-replay、import-context）。
3. **两个 ACP 实现是"迁移产物"**：`acp-adapter`（SDK ^0.23，旧 `AgentSideConnection` API，v1 引擎）是 reference implementation；`acp-server`（SDK ^1.3，新 `agent()` builder API，v2 引擎）是从前者移植的 native 版本，模块一一对应并新增 FS/终端反向 RPC。`kimi acp` 默认走 acp-server，仅 `KIMI_CODE_LEGACY_FLAG=1` 时回退 acp-adapter。
4. **transcript 是唯一被 kap-server 直接依赖的协议层包**：engine → kap-server → transcript 契约，方向单向；前端（Web UI）经 kap-server 的 REST/WS 面间接消费。

## 2. 包/目录清单与依赖关系

### 2.1 依赖关系总览（workspace 内部，`->` 表示依赖）

```
@moonshot-ai/protocol
  <- agent-core      (v1 引擎：rpc 层 + 各服务 wire 类型，运行依赖)
  <- agent-core-v2   (仅 ToolInputDisplay 类型，2 个文件)
  <- klient          (仅 devDependency：test/contract-parity.ts 编译期断言)
  <- acp-server      (事件类型：AssistantDeltaEvent/ToolCallStartedEvent/TurnEndReason 等)
  （kap-server 不依赖本包——自持 src/protocol/ 同名拷贝）

@moonshot-ai/klient
  -> agent-core-v2   (workspace:^，类型 + DI token，运行时)
  -> zod
  -> protocol        (devDep，parity 测试)
  <- acp-server      (组合根：createKlient({scope}) memory 传输)
  <- node-sdk        (sdk-rpc-client-v2.ts：createKlient memory 传输做 SDK RPC 客户端)

@moonshot-ai/kimi-code-sdk (node-sdk)
  -> agent-core / agent-core-v2 / kaos / kimi-code-oauth / kosong / klient (全 devDep，tsdown alwaysBundle 进发布产物)
  <- acp-adapter     (唯一 runtime 消费者：KimiHarness 注入)
  （工厂 createKimiHarness/createKimiHarnessV2 仓库内无人调用——留给外部 IDE 插件等宿主）

@moonshot-ai/transcript
  -> zod (仅此一个依赖，刻意"结构封闭、内容开放")
  <- kap-server      (coreEventMap.ts 投影 / transcriptService / sessionEventBroadcaster / routes/transcript)
  <- apps/kimi-inspect

@moonshot-ai/acp-adapter
  -> @agentclientprotocol/sdk ^0.23.0 / agent-core / kaos / kimi-code-sdk
  <- apps/kimi-code  (cli/sub/acp.ts legacy 路径，KIMI_CODE_LEGACY_FLAG)

@moonshot-ai/acp-server
  -> @agentclientprotocol/sdk ^1.3.0 / agent-core-v2 / klient / protocol
  <- apps/kimi-code  (cli/sub/acp-native.ts native 路径，动态 import)
```

### 2.2 目录/模块清单（按包）

| 包 | 目录 | 职责 |
|---|---|---|
| protocol | `src/`（根 14 文件） | 信封/错误码/分页/时间/request-id/事件/显示载荷/WS 控制帧/AsyncAPI |
| protocol | `src/rest/`（24 文件） | 每个 REST 域一套 `*Request/Response` zod schema（session/message/prompt/fs/approval/question/task/tool/skill/terminal/workspace/auth/oauth/meta/config/modelCatalog/file/fsBrowse/connection/guiStore/snapshot） |
| klient | `src/core/` | `KlientChannel` SPI、`createKlientFromChannel`、四相位校验、事件 hub、三个 facade |
| klient | `src/contract/` | 27 个 wire 服务的 zod 契约（global 16 文件 + session 7 + agent 4） |
| klient | `src/transports/ipc/` | unix socket NDJSON 传输（channel/codec/host） |
| klient | `src/transports/memory/` | in-process dispatcher（scope 解析 + 反射调用 + JSON 克隆） |
| node-sdk | `src/`（根 12 文件） | `SDKRpcClientBase`（~80 方法外观）、v1/v2 客户端、harness、session、auth、catalog、config-rpc、model-provider |
| node-sdk | `src/v2/`（7 文件） | 6 个 v1↔v2 映射层 + session-wiring 事件桥 |
| transcript | `src/model/`（11 文件） | 领域模型：turn/step/frame/item/interaction/task/todo/attachment/prompt/meta/ids |
| transcript | `src/ops/`、`src/store/` | L2 幂等操作（14 种 op + 纯函数 reducer）、L1 存储（AgentTranscript/TranscriptStore） |
| transcript | `src/granularity/`、`src/view/`、`src/pagination/`、`src/history/`、`src/contract/` | L3 订阅粒度、L4 视图注册表、turn-cursor 分页、冷重建、线上契约 schema |
| acp-adapter | `src/`（18 文件） | `AcpServer`/`AcpSession`/`events-map`/`convert`/`approval`/`question`/`mcp`/`modes`/`slash`/`kaos-acp`/`config-options`/`model-catalog`/`auth-methods`/`version`/`log-guard`/`marker` |
| acp-server | `src/`（19 文件 + 2 子目录） | `start`（组合根）/`server`/`session`/`events-map`/`convert`/`replay`/`interaction-bridge`/`approval`/`question`/`acp-client`/`acp-fs/`/`acp-terminal/` + 与 adapter 同名的支撑模块 |

## 3. 模块结构与核心类型

### 3.1 protocol：线协议 schema

**信封与错误（`envelope.ts`、`error-codes.ts`）**。所有 REST 响应统一 `{ code, msg, data, request_id }` 信封（`data` nullable，可选 `details`/`stack`）；`okEnvelope` 固定 `code:0, msg:'success'`。错误码按十进制前缀分区：`0` 成功、`4xxxx` 客户端错误（HTTP-4xx 类比）、`5xxxx` daemon 内部、`6xxxx` 工具运行时、`7xxxx` LLM provider 透传（msg 保留上游原文）、`8xxxx` MCP 透传、`9xxxx` 预留。细分包括：`40001/40002` 校验与畸形请求；`40110-40113` 认证（provisioning/token 缺失/401/模型无法解析）；`40401-40416` 十六种 not_found；`40901-40920` 冲突类（SESSION_BUSY、APPROVAL_ALREADY_RESOLVED、GOAL_* 系列等）；`41001-41003` 过期；`41301-41305` 超限（文件过大/FS 超 10MB/命中超限/路径越界/grep 超 30s）；`42902` WS watch 超限；`50001/50003` 兜底；`60001/60002` 工具错误。`ErrorCodeReason` 提供每码的稳定点分字符串（`session.not_found` 等），供日志与客户端分类。文件头还显式列了**保留不再复用**的码（40101-40103、42901、50002）。

**消息模型（`message.ts`）**。`Message { id, session_id, role(user/assistant/tool/system), content[], created_at, prompt_id?, parent_message_id?, metadata? }`；`content` 是 7 种块的判别联合：`text`/`tool_use`/`tool_result`/`image`/`video`/`file`/`thinking`。图片/视频共用 `ImageSource`（`url`/`base64`/`file` 三态，url 可带 provider 文件 id）；`file` 块只带元数据（`file_id/name/media_type/size`），字节永远走 `/files` 通道。

**会话与工作区（`session.ts`、`workspace.ts`）**。`Session` 是列表与详情共用的核心形状，含 `busy`（任一 agent 有活跃 turn 或后台租约）、`main_turn_active?`、`pending_interaction?`（`none/approval/question`）、`last_turn_reason?`、`agent_config`（model/system_prompt/tools/mcp_servers/thinking/permission_mode/plan_mode/swarm_mode/goal_*）、`usage`（token/成本/上下文）、`permission_rules`、`message_count`、`last_seq`。注意设计取舍：**`busy` 取代了旧的五值 `status` 枚举**——awaiting 状态改由 approval/question 通道表达，turn 结果由 `turn.ended` 事件表达，"客户端自行组合呈现"。`workspace_id` 强格式 `wd_<slug>_<hash12>`。

**任务/工具/审批/提问/FS/文件（`task.ts`、`tool.ts`、`approval.ts`、`question.ts`、`fs.ts`、`file.ts`）**。`Task { kind: subagent|bash|tool, status: running|completed|failed|cancelled, ... }` 并保留 `BackgroundTask*` 旧名别名（v1 引擎/TUI 仍用）；`ToolDescriptor { name, description, input_schema, source: builtin|skill|mcp, active? }`，`McpServer { transport: stdio|http|sse, status: connected|connecting|disconnected|error }`；`ApprovalRequest` 带 `expires_at`（60s），`ApprovalResponse { decision: approved|rejected|cancelled, scope?, feedback?, selected_label? }`；`QuestionRequest` 一次 1-4 问，答案五态（single/multi/other/multi_with_other/skipped），method 记录 `enter/space/number_key/click`；FS 域覆盖 `FsEntry`（含 etag/mime/git_status）、`FsSearchHit`（fuzzy 命中带 score 与 match_positions）、`FsGrepFileHit`（行/列/上下文）、`FsChangeEvent`（WS watch 变更，coalesced_window_ms）；`FileMeta` 带 `expires_at`。

**显示载荷（`display.ts`）**。`ToolInputDisplay` 14 种（command/file_io/diff/search/url_fetch/agent_call/skill_call/todo_list/task/task_stop/plan_review/goal_start/generic）与 `ToolResultDisplay` 12 种（command_output/file_content/diff/search_results/url_content/agent_summary/task/todo_list/structured/text/error/generic）——这是"工具调用如何呈现在 UI 上"的协议化描述，`plan_review` 的 options 直接承载 ExitPlanMode 的审批选项，`goal_start` 携带启动菜单所需的 permission mode。

**事件（`events.ts`，1,939 行，本包最大文件）**。两层结构：

- **TS 接口层**（1-991 行）：`AgentEvent` 是 51 种事件的判别联合（interface，含 `config.changed`），`Event = AgentEvent & { agentId, sessionId }`。按主题可分组：
  - turn 生命周期：`turn.started`（带 `PromptOrigin`——13 种来源：user/skill_activation/plugin_command/injection/shell_command/compaction_summary/system_trigger/task/background_task/cron_job/cron_missed/hook_result/retry）、`turn.ended`（reason: completed/cancelled/failed/blocked + KimiErrorPayload）、`turn.step.started/completed/retrying/interrupted`（step.completed 带细粒度 LLM 延迟拆分：llmFirstTokenLatencyMs 拆 client 构建 vs server 首 token，llmStreamDurationMs 拆 server decode vs client consume）；
  - 流式增量：`assistant.delta`、`thinking.delta`、`tool.call.delta`（argumentsPart）、`tool.call.started`（带 display）、`tool.progress`（ToolUpdate 五态）、`tool.result`（is_error/synthetic）；
  - agent 状态：`agent.status.updated`（model/thinkingEffort/contextTokens/usage/`phase`）、`AgentPhase` 是 8 态判别联合（idle/running/streaming/tool_call/retrying/awaiting_approval/interrupted/ended）——UI 渲染"agent 正在干什么"的权威来源；
  - 子代理：`subagent.spawned/started/suspended/completed/failed`（spawned 带 model/thinkingEffort/swarmIndex/runInBackground）；
  - 任务：`task.started/terminated`（TaskInfo 三态：process/agent/question）+ 旧名 `background.task.*` 别名；`shell.output/started/completed`（瞬态，`!` 命令流）；
  - 会话/全局：`session.work_changed`（busy/main_turn_active/pending_interaction/last_turn_reason）、`session.meta.updated`、`session.created`、`workspace.created/updated/deleted`、`config.changed`（注意：schema 定义了但**未并入 zod 判别联合**——`agentEventSchema` 只有 50 个成员，见 §6.1 索引）、`model_catalog.changed`（带 per-provider diff）；
  - 其余：`goal.updated`（GoalSnapshot + budget report）、`skill.activated`、`plugin_command.activated`、`compaction.*` 四件套、`cron.fired`、`prompt.submitted/completed/aborted/steered`、`hook.result`、`mcp.server.status`、`tool.list.updated`、`warning`、`error`（KimiErrorPayload：code/message/retryable/cause 递归）。
- **zod schema 层**（993-1939 行）：每个接口配一个 `*Schema`（`satisfies z.ZodType<...>` 保证形状同步），最后 `agentEventSchema = z.discriminatedUnion('type', [50 个])`、`eventSchema = agentEventSchema.and({agentId, sessionId})`。
- **volatile 分类**（1915-1939 行）：`VOLATILE_EVENT_TYPES` 列 8 种瞬态事件（三个 delta、tool.progress、shell.*、agent.status.updated）——不 journal、不推进 seq、断线不重放；已标记 deprecated，分类权移交 kap-server 的 `isVolatileSignal`。

**WS 控制面（`ws-control.ts`）**。`WS_PROTOCOL_VERSION = 2`（IM 式多端同步：游标 `{seq, epoch}`、seq 持久化、volatile 事件带 `volatile:true`、`resync_required` 增 `epoch_changed` 原因）。三类帧：事件帧 `{type, seq, epoch?, volatile?, offset?, session_id?, timestamp, payload}`（`offset` 是流式 delta 的累计字符偏移，客户端按 `snapshot.in_flight_turn.*_text.length` 对齐去重）、控制帧 `{type, id?, payload}`、ACK 帧 `{type:'ack', id, code, msg, payload}`。控制操作 12 种：`client_hello`（握手，订阅字段已 deprecated 移入 subscribe）、`subscribe/unsubscribe`（per-session 游标 + agent_filter + watch_fs）、`watch_fs_add/remove`、`abort`、`terminal_attach/detach/input/resize/close`、`pong`；系统帧 4 种：`server_hello`（ws_connection_id/protocol_version/heartbeat_ms/max_event_buffer_size/capabilities）、`ping`、`resync_required`、`error`。所有操作以 `WsOperationDefinition` 表驱动——`asyncapi.ts` 从同一张表生成 AsyncAPI 3.1.0 文档（`createAsyncApiDocument`，zod→JSON Schema draft-7）。

**REST 面（`rest/*.ts`）**。每文件头部注释即路由文档。要点：`rest/session.ts` 是路由最全的域（create/list/get/profile/fork/:btw/children/status/:compact/:undo/:archive/:restore/export）；`rest/prompt.ts` 定义 `PromptSubmission`（status: running/queued/blocked 三态 + steer/abort，abort 幂等返回 40903）；`rest/snapshot.ts` 定义 **IM 式初始同步**：`as_of_seq + epoch` 水位、`in_flight_turn`（assistant_text/thinking_text 累计 + running_tools + current_prompt_id）、subagents 花名册；`rest/fs.ts` 是最大的 REST 域（list/read/stat/search/grep/git_status/diff/mkdir/list_many/stat_many/open/reveal/open_in/download，全部带上限默认值）；`rest/meta.ts` 的 `MetaResponse.backend: 'v1'|'v2'` 让客户端探测引擎代数；`rest/oauth.ts` 的 `OAuthFlowStart` 双态（pending 设备码 / authenticated 短路）。

### 3.2 klient：契约驱动的 v2 客户端 facade

**分层（AGENTS.md 明示为铁律）**：Facade（唯一公共 API，禁止 service locator/escape hatch）→ Contract（zod 全量 schema）→ `KlientChannel`（唯一传输 SPI）→ ipc / memory。核心类型：

- `KlientChannel`（`core/channel.ts:35`）：`call(scope, service, method, args)` / `stream(...)` / `listen(scope, source, handler, onError)` / `close()`；`ScopeRef { workspaceId?, sessionId?, agentId? }`（空对象 = core/app scope）；`EventSourceRef = {kind:'stream', name} | {kind:'emitter', service, event}`——stream 镜像 kap-server WS 的 eventMap（core `events`、session `interactions`、agent `events`），emitter 指某个服务的 `onDid*` 属性。
- `Klient`（`core/klient.ts:38`）：`{ global: GlobalFacade, events, session(sessionId): SessionHandle, close() }`；`SessionHandle`/`AgentHandle` 各带 `events` hub。工厂 `createKlientFromChannel(channel, {validate=true})` 由各传输入口调用，因此**任何传输返回的 Klient 形状与行为完全一致**。
- `ProcedureContract`（`contract/types.ts`）：`{input: z.tuple, output}` / `{chunk, streaming:true}` / `EventRegistration`；`contract/index.ts` 聚合 27 个 wire 服务的 `globalContract` 查表。
- `EventHub`（`core/events/hub.ts`）：`keyOf` 把注册归并为三类订阅键（`bus`/`stream:<name>`/`emitter:<svc>:<event>`），`acquire/release` ref-count——最后一个监听器退订才 dispose 底层订阅；`deliver` 对 bus 类解包 `{type,payload}`、stream 类整条转发；监听器抛错与校验失败都进 `onError` 而不 kill 订阅流。
- Facade 三件套：`global.ts`（10 个子 facade：sessions/env/auth/config/models/providers/plugins/flags/workspaces/hostFs + capabilities）、`session.ts`（生命周期 + approvals/questions/interactions/skills + `status()` 派生）、`agent.ts`（RPC 通道 + 域服务直调 + `modelResolver.generate` 特判）。
- 契约校验（`core/validation.ts`）：四相位 `input/output/chunk/event`，`KlientValidationError` 带 phase/procedure/issues/payload。

### 3.3 node-sdk：双引擎统一宿主 SDK

`SDKRpcClientBase`（`rpc.ts:144`，~80 个方法的 v1 RPC 外观基类）是骨架：所有 session/agent 域方法 + 事件/审批/提问注册表 + `AsyncLocalStorage` 承载 `interactiveAgentId`（多 agent 复用客户端）。两个子类：

- `SDKRpcClient`（v1）：agent-core 的 `createRPC<CoreAPI, SDKAPI>()` 进程内 RPC 对 + `new KimiCore(coreRpc, ...)`，`ClientAPI`（emitEvent/requestApproval/requestQuestion/toolCall）承载引擎反向调用。
- `SDKRpcClientV2`（`sdk-rpc-client-v2.ts`，2,258 行）：`bootstrap()` 出 agent-core-v2 Scope → `createKlient({scope})`（memory 传输，仍穿契约校验 + JSON 往返）→ 每个 v1 方法 override 成 v2 服务调用；`engineAccessor` 是刻意标注的 in-process-only 逃生口（App 级服务直取）；未迁移方法落 `getRpc()` 抛 `not_implemented`。

`KimiHarness`（`kimi-harness.ts`）是宿主顶层门面：session 注册表（`Map<id, Session>`）+ 全局配置/插件/MCP/auth 操作 + telemetry。`Session`（`session.ts:789` 行）是单会话门面：prompt/工具/背景任务/目标/技能 + `closed` 状态机。`v2/` 目录 6 个映射层：`event-mapper`（v2 DomainEvent → v1 Event，丢弃 10 种 v2-only 类型、改名 2 种）、`session-wiring`（每活会话一份：agent bus 订阅→事件转发 + pending interaction 三路桥）、`session-mapper`/`config-mapper`（v2 分域 → v1 单文档）、`global-mcp`（v1 `<home>/mcp.json` 存储 CRUD）、`resume-replay`（一次性 v1 Agent 折叠 wire.jsonl）、`import-context`（字节级复刻 v1 import 消息）。

### 3.4 transcript：转录渲染数据层

**四层架构**：L1 `AgentTranscript`（单 agent 聚合态，`apply()` 批量收敛 + `onChange` 单次通知 + `snapshot(window)` 尾部窗口化）/ `TranscriptStore`（session 根，懒建 agent + roster 可观测）；L2 `operation.ts`（**14 种 op**：turn.upsert/step.upsert/frame.upsert/append/items.remove/marker/task.upsert/interaction.upsert/removal/prompt.upsert/meta.merge/reset/undo/clear——其中 `append` 是**唯一非幂等** op）+ `apply.ts`（纯函数 copy-on-write reducer，`applyOperation` 统一 switch）；L3 `grade.ts`（`TranscriptGradeSpec`：`'*'` 通配 + agent 覆盖，`needsResetOnTransition` 仅升级需 reset）+ `filterOps.ts`（按 op 种类裁剪 + `redactSnapshotForGrade` 脱敏）；L4 `view/registry.ts`（`view ?? name`/`origin.kind`/`marker`/`task.kind` 四类 key 的泛型注册表，`C` 承载宿主框架组件类型）。领域模型在 `model/`：turn 是自然键 `t<ordinal>`、step `t3.2`、frame `t3.2.f4`；frame 是叶子渲染单元（text/thinking/tool_call/notice），从不嵌套，靠 `taskId/approvalId/todoId/agentRefs` 交叉引用；interaction（审批/提问）**永不进分页时间线**。`contract/schema.ts` 独家拥有全部转录线上契约（`transcriptSeqSchema` op-batch 排序契约、REST 响应、`transcript.reset/ops` WS 事件）。

### 3.5 acp-adapter 与 acp-server：ACP 桥

两包模块一一对应（`server`/`session`/`events-map`/`convert`/`approval`/`question`/`modes`/`slash`/`config-options`/`model-catalog`/`auth-methods`/`version`/`marker`/`builtin-commands`），差异在接入面：

- **acp-adapter**：`AcpServer implements Agent`（SDK 0.23 `AgentSideConnection`），会话经 `harness.createSession({kaos, mcpServers})` 驱动 v1 引擎；`AcpKaos` 装饰 `LocalKaos`，`readText/writeText` 走 ACP `fs/readTextFile/writeTextFile` 反向 RPC（覆盖 Zed 未保存缓冲）；`log-guard` 把 console 重定向 stderr 保护 stdout JSON-RPC 通道；`version.ts` 是 Python kimi-cli version.py 的移植（协议协商整数 v1 / spec v0.10.x）。
- **acp-server**：组合根 `start.ts` 按 `bootstrap()` → `createKlient({scope})` → `core.accessor.get(IAcpConnection)` → `app.connect(stream)` → `acpClientFromContext` → `AcpServer` 顺序装配（`getServer()` 惰性解引用解决连接先于 server 的时序）；`acp-fs/acpFsService.ts` 在 **Session scope** 注册影子 `IHostFileSystem`（文本读写走 ACP fs 反向 RPC，append 用读-改-写模拟）；`acp-terminal/acpTerminalRunner.ts` 在 **Agent scope** 注册影子 `ISessionProcessRunner`（Bash 调用判别四元组 `args.length===3 && args[1]==='-c' && NO_COLOR==='1' && TERM==='dumb'`，`terminal/create` 执行、250ms 轮询输出、4MB 头部截断）；`interaction-bridge.ts` 把 v2 interaction kernel 的 pending 交互反向桥为 `requestPermission`/`elicitation/create`。

## 4. 关键数据流 / 状态机 / 时序

### 4.1 WS 多端同步协议（protocol 定义，kap-server 实现）

```
客户端                                    服务器（kap-server）
  │ 连接                                  │
  ├─ client_hello{client_id} ────────────►│ server_hello{ws_connection_id,
  │                                      │   protocol_version:2, capabilities}
  ├─ subscribe{session_ids,              │
  │    cursors:{sid:{seq,epoch}},        │ 校验游标 epoch 匹配 → 逐 session 分配
  │    agent_filter?, watch_fs?} ───────►│  ack{accepted[], not_found[],
  │                                      │       resync_required[], cursors[]}
  │                                      │
  │   ◄── 事件帧 {type, seq, epoch?, volatile?, offset?, payload}
  │         durable 事件：seq 单调递增（journal 偏移，重启幸存）
  │         volatile 事件：seq=当前持久水位 + volatile:true（断线不重放）
  │                                      │
  │   ◄── resync_required{reason: buffer_overflow|session_recreated|epoch_changed}
  │        客户端处理：GET /sessions/{sid}/snapshot → as_of_seq → 重新 subscribe
  │              （快照水位与 WS 流无缝衔接，无缺口无重复）
  │
  ├─ abort{session_id, prompt_id} ──────►│ ack{aborted, at_seq}
  ├─ terminal_attach{terminal_id, since_seq} ► ack{attached, replayed:N}
  │   ◄── terminal_output{seq, data} / terminal_exit{exit_code}
  ├─ ping ──► pong（非ce 回显）
```

**恢复协议（rest/snapshot.ts 定义）**：① `GET /sessions/{sid}/snapshot`（原子于水位 `as_of_seq`，含 `in_flight_turn` 的流式累计态）→ ② WS `subscribe` 带 `cursors[sid]={seq: as_of_seq, epoch}` → ③ 应用 `seq > as_of_seq` 的后续 durable 事件。服务器读取水位→组装→重读水位，若期间落入 durable 事件则有限重试（durable 低频，几乎立即收敛）。`offset` 字段让客户端对 volatile delta 做累计偏移对齐：`offset < 本地长度` 为重复（跳过），`offset > 本地长度` 为丢帧（重新快照）。

### 4.2 klient 双传输 RPC 路径

```
facade.method(args)
  → ScopedCaller（klient.ts:51）查 globalContract[service][method]
  → parseInput（input 校验）→ channel.call(scope, service, method, wireArgs)
       ├─ ipc: trimTrailingUndefined → {type:'call', id, scope, service, method, args}
       │        ── unix socket NDJSON ──▶ host.handleFrame → dispatcher.call
       │        ◀── {type:'result'|'error', id, data|code,msg}
       └─ memory: dispatcher.call → resolveScope → accessor.get(token)[method](...args)
  → wireClone(result)（memory 侧模拟 JSON 边界；ipc 天然 JSON）
  → parseOutput → 返回
```

**scope 解析语义**（memory dispatcher，镜像 kap-server）：`workspaceId` → `IWorkspaceLifecycleService.handlerFor({workspaceId})`；`sessionId` → `getLiveSessionById`（不存在抛 40404）；`agentId==='main'` → **`ensureMainAgent(session)` 现场物化**（无 agent 创建、首次使用物化）；其他 agentId → `IAgentLifecycleService.get()`。

**事件订阅路径**：引擎事件源 → dispatcher 逐 payload `wireClone` → ipc `{type:'event', id, data}` 帧（或 memory 同步回调）→ `EventHub.deliver(key, raw)` → 按注册表分类解包/转发 → `parseEvent` → 监听器。同一事件源多事件名共享一条底层订阅，ref-count 驱动释放。

**流式过程（双端队列）**：客户端 `stream()` 维护 `buffer` + `waiters`，`stream_data` 帧 push、`next()` 拉取、`return()` 发 `stream_cancel`；宿主端 `AbortController` 包住 `for await`，socket 断开即 abort；memory 端惰性启动（首个 `next()` 才取 `[Symbol.asyncIterator]`）。

### 4.3 node-sdk v2 会话接线（session-wiring）

```
createSession → wireSession()
  → 订阅 IAgentLifecycleService.onDidCreate（含未来 subagent）
      ├─ 每 agent: IEventBus.subscribe → translateDomainEvent → sink.receiveEvent
      └─ ISessionInteractionService.onDidChangePending → bridgeNewPendingInteractions
           （approval/question/user_tool 三路桥，bridgedInteractionIds 去重）
关闭：engine close → followWorkspaceHandlers.onDidCloseSession → unwireSession → wiring.dispose()
```

审批的 v1 push vs v2 pull 桥：v1 引擎同步调 `SDKAPI.requestApproval`；v2 引擎把审批"停放"在 interaction kernel，`onDidChangePending` 通知后由桥拉到同一条 `base.requestApproval`（继承 v1 的 no-handler 取消语义），结果写回 `ISessionApprovalService.decide(id, response)`——kernel 对已非 pending 的 id 是 no-op，取消后迟到回答安全。

### 4.4 transcript 数据流

```
live:  engine IEventBus (DomainEvent)
         → AgentTranscriptProjector.map()      [kap-server，事件→op]
         → ops[]（append 增量 / 边界 flush 全量 upsert）
         → AgentTranscript.apply()             [L1 唯一收敛路径]
             → 纯函数 applyOperation 逐 op 归约，gap 捕获
         → onChange(accepted ops)
             → TranscriptService.journalOps（每批 +1 seq）→ 广播
             → SessionEventBroadcaster 按连接粒度 filterOpsForGrade 扇出
                 → WS transcript.ops（volatile:true，载荷带 seq）
         → 客户端 AgentTranscript.apply() → UI

cold:  wire.jsonl → groupMessagesIntoSnapshot（context 消息→turn 树）
         → foldWireRecordFacts（非 context 记录→tasks/interactions/todos/meta/标记）
         → 以幂等 upsert 序列灌入 live store（绝不 reset，防覆盖直播 ops）
```

**订阅握手**：`subscribe_v2` 校验 → 升级（`needsResetOnTransition`）→ `redactSnapshotForGrade` → `transcript.reset`（带 seq 水位）；有 `transcript_since` 且日志覆盖 → 补发缺失批次；否则 reset；`transcriptSeeded` 门控后续 ops 扇出。

### 4.5 ACP 会话主流程（两包同构）

```
client ── session/new{cwd, mcpServers} ──▶ AcpServer.newSession
  1. auth 门（adapter: auth.status()；server: ensureReady() 双探针）
  2. 预铸 sessionId → 建 kaos/scope 注入 → 引擎 createSession
  3. 注册 approval/question 反向桥 → 构建 configOptions → 响应 {sessionId, configOptions}
  4. setTimeout(0) 推 available_commands_update（等生命周期响应先落地，Zed 静默丢帧）

client ── session/prompt{blocks} ──▶ AcpSession.prompt
  a. 图片压缩阶段注册 pendingPromptAborts（此窗口 cancel 可拦截）
  b. detectSlashIntent：/skill:X → activateSkill；builtin → 本地命令；否则 session.prompt
  c. runTurnBody：订阅引擎事件 → events-map 纯函数 → session/update 通知（fire-and-forget）
  d. turn.ended（匹配 turnId）→ settle：resolve({stopReason}) / reject(auth_required)
```

**TurnDriver 状态机**（acp-server，session.ts:150-175, 659-726）：

```
prompt → driveLaunch
  ├─ launched === undefined → 无 turn（hook-blocked）→ 立即结算 end_turn
  ├─ launched.turn_id 落地 → 若 cancelRequested 补发精确 cancel({turnId})（幂等）
  │       然后回放 early 缓冲中 turnId 匹配的事件（快 turn 先于 launch 返回结束）
  └─ launch reject → mapPromptLaunchError（auth→auth_required / busy→-32600 / 其余→internalError）
turn.ended(匹配) → settleDriver 一次 → resolve({stopReason}) / reject
cancel() → 压缩阶段标记 pendingPromptAborts → agent.cancel({turnId})；turnId 未知置 cancelRequested
```

**工具调用 wire 侧生命周期**（顺序修复是两包最出彩的防御）：

```
provider 流式 args → tool.call.delta（先到！）→ LAZY-CREATE tool_call(status:pending)
  → 后续 delta → tool_call_update（累积 REPLACE 语义 args 全文）
tool.call.started（后到）→ 已存在 → "upgrade" update（补 title/kind/rawInput, status→in_progress）
                        → 不存在 → CREATE tool_call(in_progress)
tool.progress → tool_call_update(title 刷新)
tool.result → tool_call_update(completed/failed, content=结果, rawOutput)
wire id 前缀 `${turnId}:${rawId}`（模型 retry 复用 rawId 也不冲突）
```

## 5. 重要实现细节

### 5.1 protocol

1. **schema 双轨制**：每个线上形状都有"TS 接口 + zod schema"两份定义，用 `satisfies z.ZodType<...>` 钉住同步；校验（zod）与类型（TS）分离，`discriminatedUnion('type'/'kind')` 提供穷举安全。
2. **流式 delta 的 offset 对齐契约**（ws-control.ts:44-52）：volatile 文本增量携带累计字符偏移，客户端与 `in_flight_turn` 快照长度比对——这是"快照 + 增量"恢复模型的粘合剂，缺失则重快照。
3. **快照水位一致性**（rest/snapshot.ts:1-22 注释）：REST 快照与 WS 事件流通过 `as_of_seq` 水位绑定，恢复流程"无缺口无重复 by construction"；服务器侧两读水位 + 有限重试处理并发 durable 事件。
4. **错误信封的字节稳定性**（envelope.ts:26-31）：`errEnvelope` 的 `stack` 为 `undefined` 时字段缺失，线上形状与旧版 `{code,msg,data:null,request_id}` 逐字节一致（`JSON.stringify` 丢弃 undefined）。
5. **兼容别名层**：`BackgroundTask*`（task.ts:41-43）、`DeleteSessionResponse`（rest/session.ts:202-205）、`helloAckPayloadSchema`——v1 引擎/TUI 仍在用旧名，v2 链用新名，协议层同时承载。
6. **prompt 三态与幂等 abort**（rest/prompt.ts）：submit 返回 `running/queued/blocked`；`abort` 幂等——已完成的 prompt 返回 `code:40903` + `{aborted:false, at_seq}`（而非错误）。
7. **capability 探测**（rest/meta.ts）：`backend: 'v1'|'v2'` 字段 + `dangerous_bypass_auth`——客户端无需探测路由即可识别引擎代数与鉴权模式。

### 5.2 klient

8. **双传输字节一致性**：memory dispatcher 对每个入参/返回值/事件载荷过 `wireClone = JSON.parse(JSON.stringify(v))`（dispatcher.ts:36-39），使 in-process 消费者与跨 socket 消费者观察到完全相同的形状，非序列化泄漏（如 scope handle 混入结果）提前失败；ipc 宿主与 memory 共享同一个 `createMemoryDispatcher`，两传输"按构造等价"。
9. **JSON 无 undefined 的三处处理**：`trimTrailingUndefined` 裁掉尾部可选参数（否则跨 wire 变 `null` 顶掉引擎默认参数）；`maybe()/noResult` 归一 HTTP 的 null-vs-undefined 双态；`config.replace` 把 `undefined` 显式编码为 `null`（"清空该域"语义）。
10. **契约即 drift tripwire**：`test/contract-parity.ts` 用 `AssertWire`（双向）/`AssertEngineToWire`（单向，深 union 镜像为 unknown 时用）在编译期钉住"引擎类型 ↔ wire schema"——引擎类型一改，tsc 先红。这是 klient 不 import protocol 却能保持线形状一致的机制。
11. **无自动重连**：ipc socket 关闭即 `failAll()`（拒绝全部 pending/error 全部 stream/清 listens），注释明说"WS 传输才拥有可恢复连接的故事"——重连职责不在本包。
12. **reflect 调用的两个特例**：非函数成员按属性读取返回（支撑 `bootstrapService` 逐属性读）；`modelResolver.generate` 引擎无此方法 → 特判路由到 `getRequester(modelId).request(input, signal, params)`，把 AbortSignal 传下去（dispatcher.ts:172-211）。
13. **`env()` 快照缓存**：bootstrap 时冻结进程快照，`envPromise ??=` 单次 Promise 复用（global.ts:277-294）。

### 5.3 node-sdk

14. **迁移地图式开发**：`sdk-rpc-client-v2.ts:1-127` 文件头注释即迁移清单（每个 override 对应 v1 语义、facade 方法、已知差异）；未迁移方法抛 `not_implemented`——v1 `getRpc()` 依赖随迁移完成整体删除。
15. **`engineAccessor` 逃生口**（:524-526）：v2 客户端持有 bootstrap Scope 可直取 App 级服务——in-process 传输独有，注释强制每个用法注明所替代的 klient facade 方法。
16. **`removeProvider` 原子级联**（:644-671）：v2 引擎只清默认指针，SDK 用 `planProviderRemoval` 计算完整 v1 级联（删 provider + 指向它的 models + 悬空默认指针），经 `replaceSections` 一次原子写——中途退出不留半级联文件。
17. **resume replay 复用 v1 恢复管线**（`resume-replay.ts:104-121`）：用一次性 v1 `Agent` 折叠 `wire.jsonl`，跑在只读内存 persistence 上（合成追加不落盘），任何失败降级为空结果——step.begin/content.part/compaction patch 等微妙语义全部继承。
18. **`contextUsage` 刻意不 clamp**（rpc.ts:637）：>100% 是 ACP 通道的文档化溢出信号（REST 侧则 clamp）。
19. **error 分类原则**（oauth-error.ts:20-23）：只映射可确定类别的 OAuth 错误，未识别错误原样重抛——避免把存储/锁错误误标为 `auth.login_required` 送用户走错修复路径。
20. **print 模式后台任务 drain**（:1994-2028）：suppress 终端通知 + `tasks.wait(taskId, min(deadline-now, 2^31-1))` 循环，定时器上溢钳制 `0x7fffffff`（≈24.8 天）。

### 5.4 transcript

21. **幂等机制**：14 种 op 中仅 `append` 非幂等（operation.ts:64）；其余全是 state-style upsert/merge，每个 upsert 前做**深度字段等价比较**（`turnEquals`/`stepEquals`/`frameEquals`），相等返回 `changed:false`——去重与"onChange 只发真变更"的依据；重复/乱序消费收敛到相同 store。
22. **append 四态对齐**（`appendAtOffset` apply.ts:379-399）：`offset > 本地长度` → gap（重新快照）；本地已完整包含 → 重复；部分重叠且一致 → 裁剪 novel 后缀合并；重叠不一致 → 也是 gap——**分流式流，绝不静默重写丢弃本地内容**。
23. **骨架自动补全**：`skeletonTurn`/`skeletonStep`（apply.ts:135,146）让 upsert 即使父级未到也能落地，任意 op 顺序自洽；但 append 找不到父 frame 返回 gap。
24. **粒度过滤"降级安全"设计**：`filterOpsForGrade` 只按 op 种类门控（append 仅 delta、step/frame.upsert 需 block、其余 turn 级即通）；安全性依据是 producer 在 step/turn 完成边界**重发整帧 flush upsert**，低粒度客户端自然重收敛；升级靠服务端 reset（`needsResetOnTransition`），过滤层绝不发明第二条投影路径。
25. **崩溃 == cancelled**（foldFacts.ts:514-518）：冷重建扫描结束仍 pending 的 interaction 一律置 cancelled，防幽灵 pending。
26. **冷重建 ordinal 对齐**（foldFacts.ts:253-262）：引擎 turnId 按 `turn.prompt` 记录顺序分配，hidden turn 使引擎 id 与分组 ordinal 漂移 → 用 `id - hiddenCount` 映射 `turn.ended`；`goal_continuation`/`subagent` 这类真实开 turn 的 system_trigger 必须开 turn（groupTurns.ts:87-97）。
27. **op-batch seq 契约**（contract/schema.ts:452-468）：per-(session, agent) 单调批次号，每派发一批 +1（非每 op）；reset/REST 响应上的 seq 是"含 ≤N 全部批次"的水位；seq 全部 optional——缺省即 pre-seq 旧协议，回退丢帧信号驱动刷新。

### 5.5 acp-adapter / acp-server

28. **流式事件乱序修复**（两包同构）：引擎的 `tool.call.delta` 先于 `tool.call.started` 到达（delta 来自模型参数流，started 来自循环派发）——naive 映射会让 `tool_call_update` 先于 CREATE 上 wire，Zed 报 "Tool call not found"。方案：wire id（`${turnId}:${rawId}`）簿记 + 首个 delta 懒建 `tool_call(status:pending)`，started 到达时降级为 upgrade update（adapter session.ts:1021,1169-1183；server session.ts:795-804）。
29. **`tool_call_update` 的 REPLACE 语义**：ACP 的 `ToolCallUpdate.content` 是整块替换，delta 累积器每次发累积 args 全文，started 时用完整 `stringifyArgs` 重置种子（否则首个 delta 吞掉初始 args）；`stringifyArgs` 对 BigInt/循环结构回退 `String()`，流式路径永不 crash。
30. **fail-safe 原则**：未知 approval optionId → rejected；反向 RPC 失败 → rejected/null（宁可拒绝不可误批，与 Python 参考实现一致）；`emit` 全部 best-effort 不 throw；notification（cancel/extNotification）错误只能 log 不能抛。
31. **错误映射防泄漏**：`auth.login_required`/`provider.auth_error` → `RequestError.authRequired()`（客户端自驱 re-auth）；其余 → `internalError`，细节只进日志——防栈帧/PII 泄漏到 wire。
32. **busy 本地拒绝**（server session.ts:631-638）：v2 引擎对活跃 turn 的 `agent.prompt` 会排队且返回 `undefined`（与 hook-blocked 不可区分），放行会覆盖唯一 driver 且第一个 prompt 永不结算——故同步抛 -32600（`turn.agent_busy`）。
33. **scope 注册位点选择**（acp-terminal/index.ts:4-10、acpFsService.ts:163-169）：`IHostFileSystem` 影子注册在 **Session scope**（shadow App-scope 本地实现，持久化消费者不受影响）；`ISessionProcessRunner` 必须注册在 **Agent scope**——Session-scope 注册会输给 `sessionLifecycleService` 的 seed，子 scope 集合优先于父 scope。这是 DI×Scope 引擎"影子服务"注入的教科书示例。
34. **终端输出去重**（server session.ts:828-843 + marker.ts）：terminal-backed 工具调用的卡片只放 `{type:'terminal'}`（模型仍收全文）；`HideOutputMarker` 哨兵（引用相等或 `__kind` 结构匹配，兼容 structured clone）让文本输出短路为 `[]` 防双渲染。
35. **版本协商容错**（version.ts:39-51）：客户端版本低于 MIN 仍回当前版本让客户端决定断开；客户端广告更高 major 也回自身版本。
36. **KLIENT-GAP 记录**（server session.ts:16-21）：无 session MCP 连接视图/compaction 服务（`/mcp`、`/compact` 只回说明文本）；`exitPlan` 用 `cancelPlan` 替代（状态效果相同）；无 `Turn.result` promise，结算只靠 `turn.ended`。

## 6. 关键代码位置索引

### 6.1 protocol

- `packages/protocol/src/envelope.ts:3-11` — `envelopeSchema`：所有 REST 响应统一信封 `{code,msg,data,request_id}`
- `packages/protocol/src/envelope.ts:33-39` — `errEnvelope`：stack 可选且字节稳定
- `packages/protocol/src/error-codes.ts:12-138` — `ErrorCode`：0/4xxxx/5xxxx/6xxxx/7xxxx/8xxxx 命名空间
- `packages/protocol/src/error-codes.ts:151-218` — `ErrorCodeReason`：每码稳定点分字符串
- `packages/protocol/src/events.ts:145-158` — `PromptOrigin`：13 种 turn 来源判别联合
- `packages/protocol/src/events.ts:447-508` — `AgentPhase`：8 态 agent 运行阶段状态机
- `packages/protocol/src/events.ts:629-642` — `turn.started`/`turn.ended` 事件
- `packages/protocol/src/events.ts:651-676` — `turn.step.completed`：LLM 延迟四分拆
- `packages/protocol/src/events.ts:938-991` — `AgentEvent` 联合 + `Event = AgentEvent & {agentId, sessionId}`
- `packages/protocol/src/events.ts:1837-1895` — `agentEventSchema` 判别联合（50 个 schema，注意 `config.changed` 未并入）
- `packages/protocol/src/events.ts:1915-1924` — `VOLATILE_EVENT_TYPES`：8 种瞬态事件（已 deprecated）
- `packages/protocol/src/ws-control.ts:18` — `WS_PROTOCOL_VERSION = 2`
- `packages/protocol/src/ws-control.ts:27-36` — `sessionCursorSchema`：`{seq, epoch}` IM 式游标
- `packages/protocol/src/ws-control.ts:38-56` — `wsEventEnvelopeSchema`：事件帧（含 delta offset 对齐字段）
- `packages/protocol/src/ws-control.ts:379-393` — `resync_required` 三原因
- `packages/protocol/src/ws-control.ts:481-622` — `WsOperationDefinition` 操作表（12 控制 + 4 系统 + 1 事件）
- `packages/protocol/src/message.ts:76-96` — `MessageContent` 七种内容块 + `Message`
- `packages/protocol/src/session.ts:81-116` — `Session`（busy 取代 status 枚举）
- `packages/protocol/src/rest/session.ts:1-16` — 会话路由全景注释
- `packages/protocol/src/rest/prompt.ts:46-65` — `PromptSubmission`（含 profile/model/thinking/disabled_tools）
- `packages/protocol/src/rest/prompt.ts:99-103` — `PromptAbortResponse`（幂等 abort）
- `packages/protocol/src/rest/snapshot.ts:1-22` — 快照-订阅恢复协议设计注释
- `packages/protocol/src/rest/snapshot.ts:50-61` — `in_flight_turn`（流式累计态）
- `packages/protocol/src/rest/fs.ts:86-129` — `FsListRequest`/`FsReadRequest`（上限默认值）
- `packages/protocol/src/rest/meta.ts:26-46` — `MetaResponse`（backend v1/v2 + bypass_auth）
- `packages/protocol/src/rest/oauth.ts:37-61` — `OAuthFlowStart` 双态（设备码/短路）
- `packages/protocol/src/display.ts:3-92` — `ToolInputDisplay` 14 种
- `packages/protocol/src/display.ts:94-159` — `ToolResultDisplay` 12 种
- `packages/protocol/src/asyncapi.ts:21-77` — `createAsyncApiDocument`：从操作表生成 AsyncAPI 3.1.0
- `packages/protocol/src/task.ts:41-43` — `BackgroundTask*` 旧名别名
- `packages/protocol/src/pagination.ts:5-20` — 游标分页（before/after 互斥）
- `packages/protocol/src/time.ts:3-21` — ISO-8601 时间 schema（正则 + 归一化）

### 6.2 klient

- `packages/klient/src/core/channel.ts:35-57` — `KlientChannel` SPI（call/stream/listen/close）
- `packages/klient/src/core/klient.ts:45-64` — `createKlientFromChannel` + `ScopedCaller`（契约查表 + 双相位校验）
- `packages/klient/src/core/klient.ts:66-97` — `callStream`：流式 chunk 逐条校验包装
- `packages/klient/src/core/validation.ts:15-31` — `KlientValidationError` 四相位
- `packages/klient/src/core/events/hub.ts:38-47` — `keyOf` 三类事件源归一
- `packages/klient/src/core/events/hub.ts:120-147` — 订阅 ref-count 共享
- `packages/klient/src/core/facade/global.ts:273-294` — `env()` 扇出聚合 + Promise 缓存
- `packages/klient/src/core/facade/global.ts:303-317` — `sessions.create` 三步编排
- `packages/klient/src/core/facade/session.ts:142-166` — `status()` 派生优先级
- `packages/klient/src/transports/ipc/channel.ts:304-360` — `onFrame` 帧分派（result/error/event/stream_data/...）
- `packages/klient/src/transports/ipc/host.ts:100-201` — `handleFrame`：hello 门禁 + dispatcher 桥接
- `packages/klient/src/transports/ipc/codec.ts:31-48` — `NdjsonDecoder` 增量解码（坏行丢弃）
- `packages/klient/src/transports/memory/dispatcher.ts:36-39` — `wireClone`：JSON 往返模拟网络边界
- `packages/klient/src/transports/memory/dispatcher.ts:64-85` — `resolveScope` 四层解析 + main-agent 物化
- `packages/klient/src/transports/memory/dispatcher.ts:172-211` — `modelResolver.generate` 特判（AbortSignal 传递）
- `packages/klient/src/transports/memory/serviceRegistry.ts:44-75` — wire 服务名→DI token 白名单（27 项）
- `packages/klient/src/transports/args.ts:7-11` — 尾部 undefined 裁剪
- `packages/klient/src/contract/helpers.ts:19-28` — `maybe()/noResult` null 归一
- `packages/klient/test/contract-parity.ts:298-309` — 编译期 parity 断言工具

### 6.3 node-sdk

- `packages/node-sdk/src/rpc.ts:144` — `SDKRpcClientBase`：~80 方法 v1 外观基类
- `packages/node-sdk/src/rpc.ts:145-156` — `AsyncLocalStorage` 承载 interactiveAgentId
- `packages/node-sdk/src/rpc.ts:637` — `contextUsage` 不 clamp（溢出信号语义）
- `packages/node-sdk/src/rpc.ts:913-938` — `requestApproval`：无 handler 自动取消/异常转 error 事件
- `packages/node-sdk/src/sdk-rpc-client.ts:77-89` — v1 接线：`createRPC` 对 + `KimiCore`
- `packages/node-sdk/src/sdk-rpc-client-v2.ts:1-127` — v2 迁移地图（override 清单 + 已知差异）
- `packages/node-sdk/src/sdk-rpc-client-v2.ts:408-474` — v2 构造：bootstrap + klient memory + ready 门
- `packages/node-sdk/src/sdk-rpc-client-v2.ts:524-526` — `engineAccessor` 逃生口
- `packages/node-sdk/src/sdk-rpc-client-v2.ts:644-671` — `removeProvider` 原子级联
- `packages/node-sdk/src/sdk-rpc-client-v2.ts:1287-1313` — 惰性 main agent 物化（无模型静默 unbound）
- `packages/node-sdk/src/sdk-rpc-client-v2.ts:1994-2028` — print 模式后台任务 drain
- `packages/node-sdk/src/sdk-rpc-client-v2.ts:2103-2147` — 全局 MCP OAuth flow 状态机
- `packages/node-sdk/src/v2/event-mapper.ts:31-53` — v2→v1 事件丢弃/改名集
- `packages/node-sdk/src/v2/session-wiring.ts:147-160` — 每 agent `IEventBus` 订阅 + status 快照折叠
- `packages/node-sdk/src/v2/session-wiring.ts:169-259` — pending interaction 三路桥
- `packages/node-sdk/src/v2/resume-replay.ts:104-121` — 一次性 v1 Agent 折叠 wire.jsonl
- `packages/node-sdk/src/v2/global-mcp.ts:42-143` — `<home>/mcp.json` CRUD（v1 schema + v2 atomicWrite）
- `packages/node-sdk/src/kimi-harness.ts:119-141` — `createSession`：RPC→Session→注册表→telemetry

### 6.4 transcript

- `packages/transcript/src/ops/operation.ts:36` — op 联合类型起点
- `packages/transcript/src/ops/operation.ts:64` — `append` 是唯一非幂等 op 的契约声明
- `packages/transcript/src/ops/apply.ts:67` — `applyOperation`：14 种 op 唯一归约入口
- `packages/transcript/src/ops/apply.ts:135,146` — `skeletonTurn`/`skeletonStep` 骨架自动补全
- `packages/transcript/src/ops/apply.ts:379-399` — `appendAtOffset` 四态对齐
- `packages/transcript/src/ops/apply.ts:452-488` — `items.remove` 级联清理锚定 interaction
- `packages/transcript/src/ops/apply.ts:602-630` — `meta.merge` 浅合并 + null 清徽章
- `packages/transcript/src/store/agentTranscript.ts:58` — `apply`：批量归约 + 单次 onChange + gap 冒泡
- `packages/transcript/src/store/agentTranscript.ts:151` — `snapshot({tailTurns})` 尾部窗口化
- `packages/transcript/src/granularity/filterOps.ts:20` — 按 op 种类裁剪的粒度过滤
- `packages/transcript/src/granularity/filterOps.ts:58` — reset 快照按粒度脱敏
- `packages/transcript/src/granularity/grade.ts:41` — `needsResetOnTransition` 仅升级需 reset
- `packages/transcript/src/pagination/paginate.ts:53,77` — segment 划分：marker 不孤悬、head 只随最老页
- `packages/transcript/src/contract/schema.ts:468` — `transcriptSeqSchema`：op-batch 排序契约权威定义
- `packages/transcript/src/contract/schema.ts:489` — `transcriptSubscribeV2PayloadSchema`
- `packages/transcript/src/history/groupTurns.ts:86-97` — 隐藏 origin 与开-turn system_trigger 判定
- `packages/transcript/src/history/foldFacts.ts:253-262` — turn-clock 重放（序号漂移补偿）
- `packages/transcript/src/history/foldFacts.ts:514-518` — 崩溃 == cancelled 收尾
- `packages/transcript/src/view/registry.ts:39` — `ViewRegistry<C>` 四类 key 分发
- `packages/transcript/src/store/transcriptStore.ts:34` — `ensureAgent` 懒创建 + roster 可观测

### 6.5 acp-adapter

- `packages/acp-adapter/src/server.ts:221` — `AcpServer implements Agent`（会话 Map + kaos 懒建单例）
- `packages/acp-adapter/src/server.ts:305-339` — `initialize`：版本协商 + 能力广告
- `packages/acp-adapter/src/server.ts:341-428` — `newSession`：auth 门 → 预铸 id → AcpKaos → createSession
- `packages/acp-adapter/src/server.ts:453-616` — `load/resume`：replayHistory 差异
- `packages/acp-adapter/src/server.ts:1082-1176` — `runAcpServer`：stdio 桥 + 幂等信号清理
- `packages/acp-adapter/src/session.ts:97` — `currentTurnId`：`${turnId}:${rawId}` 前缀来源
- `packages/acp-adapter/src/session.ts:593-717` — `replayHistory`：合成 turnId + toolCallTurnIds
- `packages/acp-adapter/src/session.ts:797-854` — `prompt`：压缩 token + slash 拦截三分支
- `packages/acp-adapter/src/session.ts:987-1283` — `runTurnBody`：事件分发 + 懒建/升级
- `packages/acp-adapter/src/session.ts:1307-1348` — `handleApproval`：requestPermission 阻塞往返，失败→rejected
- `packages/acp-adapter/src/session.ts:1595-1658` — 错误映射（authRequired / internalError 防泄漏）
- `packages/acp-adapter/src/events-map.ts:93-95` — `acpToolCallId` wire id 前缀规则
- `packages/acp-adapter/src/events-map.ts:251-272` — `toolCallLazyCreateToSessionUpdate`
- `packages/acp-adapter/src/events-map.ts:291-320` — `toolCallStartedUpgradeToSessionUpdate`
- `packages/acp-adapter/src/convert.ts:25-81` — `acpBlocksToPromptParts`（resource_link 降级为文本）
- `packages/acp-adapter/src/convert.ts:181-224` — `fileLinkToTextRef`（file:// → 路径文本）
- `packages/acp-adapter/src/approval.ts:64-72` — `CANONICAL_OPTIONS`（UI 顺序即契约）
- `packages/acp-adapter/src/approval.ts:160-170` — 旧 optionId `'approve'`/`'approve_for_session'` 兼容
- `packages/acp-adapter/src/question.ts:19-25` — `q{n}_opt_{i}`/`q{n}_skip` 命名空间
- `packages/acp-adapter/src/kaos-acp.ts:125-136` — `readText` 走 ACP fs 反向 RPC
- `packages/acp-adapter/src/kaos-acp.ts:280-293` — append 读-改-写 + `-32002` 判不存在
- `packages/acp-adapter/src/log-guard.ts:1-12` — console 重定向（`console.error` 刻意不动）
- `packages/acp-adapter/src/version.ts:39-51` — 版本协商容错
- `apps/kimi-code/src/cli/sub/acp.ts:40-44` — legacy 开关：`isLegacyEnabled()` 决定注册哪个实现

### 6.6 acp-server

- `packages/acp-server/src/start.ts:87-179` — `runAcpServerWithStream` 组合根（bootstrap→klient→绑定→close 顺序）
- `packages/acp-server/src/start.ts:128-135` — 惰性 `getServer()` 时序论证
- `packages/acp-server/src/server.ts:677-698` — `createAcpAgentApp`：SDK `agent()` builder 全方法路由
- `packages/acp-server/src/server.ts:179-226` — `initialize`：capability 声明（fs/terminal/mcp/fork）
- `packages/acp-server/src/server.ts:603-623` — `ensureAuthed` 双探针
- `packages/acp-server/src/session.ts:150-175` — `TurnDriver` 接口（early 缓冲/cancelRequested）
- `packages/acp-server/src/session.ts:631-638` — busy 本地拒绝（-32600）
- `packages/acp-server/src/session.ts:659-702` — `driveLaunch`：无 turn 结算/early 回放/延迟 cancel
- `packages/acp-server/src/session.ts:747-787` — `onToolCallStarted`：lazy-create + Bash 登记
- `packages/acp-server/src/session.ts:858-874` — `onTerminalCreated`：shellCommand 后缀匹配关联
- `packages/acp-server/src/session.ts:980-1010` — `cancel`：压缩阶段标记 + cancelRequested
- `packages/acp-server/src/events-map.ts:59-74` — `turnEndReasonToStopReason` 四路映射
- `packages/acp-server/src/events-map.ts:104-106` — wire toolCallId 前缀合成
- `packages/acp-server/src/events-map.ts:265-286` — `toolCallLazyCreateToSessionUpdate`
- `packages/acp-server/src/convert.ts:105-162` — `compressPromptImageParts`（gate→压缩→caption+持久化）
- `packages/acp-server/src/convert.ts:172-201` — mcpServers 转换（acp transport 丢弃）
- `packages/acp-server/src/interaction-bridge.ts:85-131` — pending 全量推送 + inFlight 防重入
- `packages/acp-server/src/replay.ts:36-76` — 历史→通知投影 + 合成 turnId
- `packages/acp-server/src/acp-terminal/acpTerminalRunner.ts:63-70` — Bash 调用判别四元组
- `packages/acp-server/src/acp-terminal/acpTerminalRunner.ts:205-232` — waitForExit/轮询泵/截断跳进
- `packages/acp-server/src/acp-fs/acpFsService.ts:68-106` — readText/writeText 反向 RPC + append 模拟
- `packages/acp-server/src/acp-fs/acpFsService.ts:163-169` — Session-scope 注册位点论证
- `packages/acp-server/src/modes.ts:72-87` — 4 模式→引擎双开关穷举映射

## 7. 与其它子系统的接口

### 7.1 向外暴露的 API

- **protocol**：纯类型 + zod schema 的全量 re-export（`src/index.ts`）。运行依赖方：agent-core（v1 引擎的 RPC 线契约）、acp-server（事件类型）；devDependency：klient（parity 断言）。kap-server 用自持拷贝，不依赖本包。
- **klient**：运行时仅 `RPCError`/`KlientValidationError`/`createKlientFromChannel` + 全量 type-only facade 面；子路径入口 `@moonshot-ai/klient/ipc`（`createKlient({socketPath,token,callTimeoutMs})` + `serveKlientIpc`）、`@moonshot-ai/klient/memory`（`createKlient({scope})`）。调用方：acp-server（组合根）、node-sdk（v2 RPC 客户端）。
- **node-sdk**：`KimiHarness`/`Session`/`KimiAuthFacade`/`SDKRpcClient`+`createKimiHarness`/`SDKRpcClientV2`+`createKimiHarnessV2`/`KimiConfigRpcClient`/`KimiForCodingProvider`/catalog 全套 + agent-core 精选 re-export（KimiError/ErrorCodes/Event 类型等）。调用方：acp-adapter（唯一 runtime 消费者）；工厂供外部 IDE 插件宿主使用。
- **transcript**：`EMPTY_AGENT_STATE`/`applyOperation`/`appendAtOffset`/`AgentTranscript`/`TranscriptStore`/grade/filter/registry/paginate/groupTurns/foldFacts + 全部契约 schema 与事件类型。调用方：kap-server（coreEventMap 投影、transcriptService、sessionEventBroadcaster、routes/transcript）、kimi-inspect。
- **acp-adapter / acp-server**：`runAcpServer`/`runAcpServerWithStream`/`AcpServer`/`AcpSession` + 全部映射纯函数。调用方：apps/kimi-code 的 `kimi acp` 子命令（adapter 走 legacy 标志，server 走 native 动态 import）。

### 7.2 与其它子系统的关键接口面

| 接口面 | 提供方 | 消费方 | 载体 |
|---|---|---|---|
| KAP 线协议 schema | protocol / kap-server/src/protocol | agent-core(v1)、kap-server、Web UI、pi-tui | npm 依赖 / 拷贝 |
| v2 引擎客户端 facade | klient | acp-server、node-sdk | `KlientChannel` SPI |
| v1 协议形状宿主 SDK | node-sdk | acp-adapter、外部 IDE 插件 | `KimiHarness`/`Session` |
| 转录契约与 op 投影 | transcript | kap-server | REST `/transcript*` + WS `transcript.ops/reset` |
| ACP stdio 服务器 | acp-adapter/acp-server | Zed / JetBrains 等 ACP 客户端 | JSON-RPC over stdio |

### 7.3 演进观察

1. **协议所有权的漂移**：v1 时代 protocol 是引擎 RPC 的直接线契约（agent-core 大量 import）；v2 时代引擎自持服务接口，protocol 降级为"类型镜像"（agent-core-v2 仅 2 处 import、klient 仅 devDep），kap-server 甚至自持拷贝——协议事实上的权威已从"共享包"漂移到"引擎接口 + kap-server 实现"。
2. **兼容层的位置**：v1 协议形状的兼容包袱（`BackgroundTask*`、`session.status_changed`、`event.config.changed` 游离于判别联合、`client_hello` 内联订阅、volatile 分类等）全部以"deprecated + 别名 + 可选项"形式沉淀在 protocol 里——它既是规范也是"历史档案"。
3. **两代 ACP 的并存**是引擎迁移的切片标本：同一 ACP 表面（版本协商、事件映射、批准桥、模式系统）在两代引擎上各实现一遍，差异精确对应引擎代差（构造器注入 vs Scope 服务注入、SDK 0.23 vs 1.3、新增终端/FS 反向 RPC）。`kimi acp` 的 `KIMI_CODE_LEGACY_FLAG` 是迁移期的总开关，v1 核心退役时 acp-adapter 与 node-sdk 的 v1 路径可整体删除。
