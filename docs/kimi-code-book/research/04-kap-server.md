# 04. kap-server + kosong：Kimi Code 的服务端外壳与 LLM 抽象层

> 本文基于 `/Users/yin/Documents/ybs/code/proxy/kimiwork/kimi-code` 的 `packages/kap-server`（约 2.9 万行 TS）与 `packages/kosong`（约 9.2 千行 TS）源码分析。
> 报告日期：2026-08-06。行号引用均以本仓库当前 HEAD 为准。

## 1. 子系统定位与职责

### 1.1 kap-server：Kimi Code 的 HTTP/WS 服务端外壳

kap-server（`@moonshot-ai/kap-server`，v0.2.1，private）是 Kimi Code 的**网络服务端形态**：它把 `agent-core-v2`（DI × Scope 引擎）整体暴露为一套 REST + WebSocket 接口，供浏览器 Web UI、IDE 集成、远程开发场景（`kimi web`）与调试工具（kimi-inspect）使用。包描述自述为 "Kimi Code server backed by the DI × Scope agent engine (agent-core-v2)"。

关键事实：

- **它不是协议规范库，而是可嵌入的服务器组合根**。对外暴露的是 `startServer(opts)` 一个入口，返回 `{ app, core, connectionRegistry, authTokenService, host, port, close }`。宿主进程（`apps/kimi-code` 的 `kimi web` 命令）负责传 `hostIdentity`（产品名/版本/平台）、`webAssetsDir`（编译好的 Web UI）、`debugEndpoints` 等选项。
- **KAP 的含义**：包名 `kap-server` = "Kimi Agent Protocol" server。但代码中并没有一个独立命名的 "KAP" 协议文件——实际协议就是 `/api/v1` REST（携带 `{ code, msg, data, request_id }` 信封）加 `/api/v1/ws` WebSocket（`server_hello`/`subscribe`/`ack`/事件流）与 `/api/v2` 实验面。KAP 是这整组线协议的对外统称；同一套协议也被 v1 的 `packages/server` 实现过（注释中大量 "mirrors v1"、"port of v1" 可证）。
- **与 agent-core-v2 的关系**：kap-server 是 agent-core-v2 的**传输适配层**。它不实现任何 agent 逻辑——会话生命周期、prompt 提交、工具执行、审批/提问内核全部在 agent-core-v2 的 Service 里；kap-server 只是把 `IWorkspaceLifecycleService.handlerFor` → `ISessionLifecycleService` 的 scope 组合映射成 URL，把 v2 的 `DomainEvent`/`IEventBus` 事件流投影成 v1 兼容的 WS 事件帧，把 v2 的 `Error2` 错误码翻译成信封 `code`。
- **与 agent-core（v1 引擎）的关系**：kap-server 是 v2 引擎对外的"同一套 `/api/v1` 接口"的宿主。v1 时代这套协议由 `packages/server` 承载（`WsBroadcastService`、`SessionEventJournal`、`wsGatewayService` 等），v2 时代 kap-server 逐模块移植并保持**线上字节级兼容**（如 `agent.status.updated` 的 phase 语义、`background.task.*` 别名、空 `agent_config:{model:''}` 占位）。
- **与 klient / node-sdk 的关系**：klient 是面向 agent-core-v2 进程内/内存的客户端 SDK，kap-server 是面向网络的服务器；两者共享 agent-core-v2 作为服务源。node-sdk 则面向 v1 协议。

### 1.2 kosong：统一的 LLM provider 抽象层

kosong（`@moonshot-ai/kosong`，v0.5.5，private，license MIT）自述为 "The LLM abstraction layer for modern AI agent applications"。名字 "kosong" 是马来语/印尼语的"空"——呼应其设计哲学：它只提供**一个尽可能薄而中立的对话生成抽象**（统一消息模型 + 统一流式接口 + 归一化 finish reason + 能力矩阵 + 错误体系），把重试策略、并发、预算管理、循环控制全部留给上层（agent-core 的 turn 循环）。

- **被谁依赖**：`packages/agent-core`（49 个源文件直接 import，核心消费点是 `src/agent/turn/kosong-llm.ts`——把 kosong 的 `generate()` 桥接成 loop 的 `LLM` 接口）、`packages/node-sdk`、`apps/vis/server`。
- **与 agent-core-v2 / kap-server 的关系**：kosong 位于依赖链最底层（只依赖各家官方 SDK + zod）。agent-core 在 turn 循环里用 `createProvider` 构造 `ChatProvider`，用 `kosongGenerate` 流式生成，用 `isRetryableGenerateError` 决定重试；kap-server 本身不直接依赖 kosong（它把 provider 配置解析交给 agent-core-v2 的 `IProviderDiscoveryService`/`IConfigService`）。kap-server 侧唯一的 kosong 痕迹是 `/api/v1/modelCatalog` 路由消费的 `@moonshot-ai/kosong` catalog 类型（`catalog.ts` 的 models.dev 风格目录解析，被 agent-core-v2 的 provider 配置模块复用）。

## 2. 包/目录清单与依赖关系

### 2.1 依赖关系总览（workspace 内部）

```
apps/kimi-code ──> @moonshot-ai/kap-server（startServer，`kimi web`/tui web 命令）
apps/kimi-inspect ──> kap-server 的 /api/v1/debug RPC 面（运行时，非 npm 依赖）
kap-server ──> agent-core-v2 (workspace:^)   # 引擎：Scope/Service/事件/会话
kap-server ──> transcript (workspace:^)      # transcript 契约与 grade 过滤
kap-server ──> minidb (workspace:*)          # 全局搜索索引
kap-server ──> kimi-code-oauth (workspace:^) # 宿主身份头、OAuth 设备流
kap-server ──> fastify / @fastify/swagger / @fastify/multipart / ws / zod / pino / smol-toml / bcryptjs / ulid

agent-core ──> kosong (workspace:^)          # 49 个文件的 provider 消费
node-sdk   ──> kosong                        # SDK 侧 provider 直用
apps/vis/server ──> kosong

kosong ──> @anthropic-ai/sdk / @google/genai / openai / zod / zod-to-json-schema
```

`kap-server` 的 `exports` 有两个子路径：`.`（`startServer` 等）与 `./contract`（RPC channel 描述符类型，供工具/测试用）。`kosong` 的 `exports` 有 `.`（根 barrel）与 `./providers/*`（各 adapter 子路径）——根 barrel 刻意不导出具体 provider 类，避免 SDK 类型图污染下游声明包；`KimiChatProvider` 是唯一例外（调用方需要 `instanceof` 收窄）。

### 2.2 kap-server 目录清单

| 目录/文件 | 职责 |
|---|---|
| `src/start.ts` | 组合根：`bootstrap()` 建 Core Scope、装 Fastify、注册 hook/路由/WS、端口重试、实例注册表 |
| `src/contract.ts` | 公共 RPC 线契约（= 整个 scoped DI 注册表，无白名单） |
| `src/envelope.ts` | 信封 `okEnvelope`/`errEnvelope` 重导出 shim（实现在 `protocol/envelope.ts`） |
| `src/protocol/` | 线协议目录：信封、错误码表、REST 各域 zod schema（session/message/prompt/fs/approval/question/task/tool/terminal/…）、WS 控制帧、pagination、asyncapi 文档 |
| `src/transport/` | WS 传输层（`ws/v1/`）、RPC 反射面（channel/dispatcher/debug routes）、连接注册表、bearer 协议 |
| `src/routes/` | `/api/v1` 全部路由 + `/api/v2/sessions` |
| `src/services/` | transcript 服务、消息投影/历史、auth（token/password/credentials）、guiStore、legacyStatus、modelCatalog 刷新调度、telemetry、pino logger |
| `src/middleware/` | auth hook、host 检查、origin/CORS、安全头、限流、`defineRoute`（单点声明 + 校验 + OpenAPI） |
| `src/security/` | `bindClassify`（loopback/lan/public 绑定分级） |
| `src/openapi/` | swagger 文档后处理 transform |
| `src/search/` | `IGlobalSearchService`（minidb 全文检索 + live transcript 检索） |
| `src/instanceRegistry.ts` | 多实例发现：`<home>/server/instances/<id>.json` + 心跳 |

### 2.3 kosong 目录清单

| 文件 | 职责 |
|---|---|
| `src/message.ts` | 统一消息模型：`Message`/`ContentPart`/`ToolCall`/`StreamedMessagePart` + 原地合并 `mergeInPlace` |
| `src/provider.ts` | `ChatProvider` 接口、`StreamedMessage`、`FinishReason`、`GenerateOptions`、解码统计 |
| `src/generate.ts` | 流式组装循环：part 合并、并行工具调用路由、abort、空响应判定 |
| `src/tool.ts` | 统一工具定义（`deferred` 标记） |
| `src/capability.ts` | `ModelCapability` 能力矩阵 + `UNKNOWN_CAPABILITY` 哨兵 |
| `src/catalog.ts` | models.dev 风格目录：provider/model 元数据 → 能力 + 思考档位解析 |
| `src/errors.ts` | 错误体系：`ChatProviderError` → 连接/超时/状态/上下文溢出/配额/限流… + 可重试判定 |
| `src/usage.ts` | token 用量聚合 |
| `src/providers/` | 五个 adapter：`kimi.ts`、`openai-legacy.ts`、`openai-responses.ts`、`anthropic.ts`、`google-genai.ts`（含 vertexai），加共享工具（`openai-common`、`chat-completions-stream`、`capability-registry`、`request-auth`、`kimi-schema`、`tool-call-id`、`reasoning-key`、`merge-user-messages`、`kimi-files`、`kimi-errors`、`anthropic-profile`） |

## 3. 模块结构与核心类型

### 3.1 kap-server 核心类型

**组合根（`start.ts`）**

- `ServerStartOptions`：`host`/`port`（默认 `127.0.0.1:58627`）、`homeDir`、`configPath`、`logLevel`、`debugEndpoints`、`bindClass`、`allowedHosts`、`corsOrigins`、`insecureNoTls`、`allowRemoteShutdown`/`allowRemoteTerminals`、`authTokenService`（可注入，测试用）、`disableAuth`、`rpcToken`（RPC 面附加凭证）、`seeds`（额外 ScopeSeed）、`hostIdentity`（必填：产品名/版本/平台/displayName/replyStyleGuide）、`skillDirs`、`webAssetsDir`、`serverVersion`、`telemetry`。
- `RunningServer`：`{ app: FastifyInstance, core: Scope, connectionRegistry, authTokenService, host, port, close() }`。
- 安全推导链：`classify(host, { bindClass })` → 非 loopback 无 TLS 直接拒绝启动（`insecureNoTls` 可豁免）→ `enableShutdown`/`enableTerminals`/`debugEndpoints` 各自按暴露等级收紧 → 非 loopback 才挂认证失败限流与安全头。

**信封（`protocol/envelope.ts`）**

- `Envelope<T> = { code, msg, data: T|null, request_id, details?, stack? }`。`okEnvelope` → `code: 0`；`errEnvelope(code, msg, requestId, stack?)`。HTTP 状态几乎恒为 200，业务结果全在 `code`——这是整条协议线（v1 与 v2 共用）的基石。
- `ErrorCode` 命名空间：`0` 成功；`4xxxx` 客户端错误（`40001` 校验失败带 `details` 路径列表、`40110-40113` 认证供给、`40401-40417` 各类 not_found、`40901-40922` 冲突/状态、`41001-41003` 过期、`41301-41305` 过大/超限、`42902` watch 超限）；`5xxxx` 服务端（`50001` 兜底、`50003` 持久化、`50004` 目录不可用）；`6xxxx` 工具运行时；`7xxxx`/`8xxxx` 为 provider/MCP 透传（msg 保留上游原文）。核心 `Error2` 字符串码到数字码的映射在 `transport/errors.ts` 的 `KIMI_TO_PROTOCOL`。

**WS v1（`transport/ws/v1/`）**

- `WsConnectionV1`（实现 `BroadcastTarget`）：单连接对象。持有 `subscriptions: Map<sessionId, { agentFilter?, transcriptGrades? }>`；`controlQueue` 串行化全部控制帧（`client_hello`/`subscribe`/`subscribe_v2`/`unsubscribe`/`unsubscribe_v2`/`watch_fs_add|remove`）；出站缓冲 + 16ms 合并窗口 + 64 帧批量 + 1 MiB 高水位背压 + `coalesceFrames` 相邻 volatile delta 合并；**服务端从不主动断连**（无 ping/pong）。
- `SessionEventBroadcaster`：每会话单扇出点。订阅每 agent 的 `IEventBus` + 会话的 `ISessionInteractionService` + 核心 `ISessionActivityView`；durable 事件 → `journal.nextSeq()` + 写盘 + 内存 tail + 扇出；volatile 事件 → 以当前 watermark 为 `seq` 打 `volatile:true` 直接扇出。全局事件（`event.session.*`/`event.workspace.*`/`event.config.*`/`event.di.*`/`session.meta.updated`）扇给 `globalTargets` 并集所有订阅目标；`event.di.*` 只发给 `addDiEventTarget` 选入的连接（`client_hello.client_id === 'kimi-inspect'`）。transcript 帧走独立通道，按 grade 过滤、绕过 agent filter。
- `SessionEventJournal`：每会话 `<eventsDir>/<sessionId>.jsonl`，首行 `journal_header`（`epoch: "ep_<ulid>"`），后续 `{"kind":"event","seq":N,"envelope":{...}}`。`seq` 跨重启单调（open 时扫盘恢复）；`epoch` 在文件损坏时轮换（旧游标收到 `resync_required(epoch_changed)`）。写路径同步入队、微任务批量落盘；`readSince` 先 flush。
- `InFlightTurnTracker` / `SubagentRosterTracker`：快照路由用的增量状态（in-flight turn 的 `offset` 注解、子 agent 名单）。
- `protocol.ts`：`server_hello`（带 `ws_connection_id`/`protocol_version=2`/能力声明）、`ack`（`{id, code, msg, payload}`）、`resync_required`（`buffer_overflow`/`session_recreated`/`epoch_changed`）。

**RPC 反射面（`transport/`）**

- `IChannel`：`call<T>(command, arg?)` / `listen(event, arg?)`。
- `ChannelDescriptor`：`{ name, scope: 'app'|'workspace'|'session'|'agent', domain, methods }`；`describeMethods` 沿原型链（止于 `Disposable.prototype`）枚举公开方法，`Function#toString` 提取参数名做 UI 提示。
- `dispatch()`：`resolveScope`（core/workspace/session/agent 四级，`getLiveSessionById` + `IWorkspaceLifecycleService.handlerFor` + `IAgentLifecycleService`）→ `resolveService`（名字 → `ServiceIdentifier`，`accessor.get`）→ 反射调用方法或读属性；`GOAL_UNSUPPORTED_AGENT` 只拦非主 agent 访问 `IAgentGoalService`；`assertSerializable` 保证 JSON 可回传；30s `withTimeout`。
- 路由形态：`GET|POST /debug/:service/:method`、`/debug/workspace/:workspace_id/...`、`/debug/session/:session_id/...`、`/debug/session/:session_id/agent/:agent_id/...` + `GET /debug/channels`（自省）。

**路由层（`routes/`）**

- `defineRoute`（`middleware/defineRoute.ts`）：单对象声明 runtime Zod 校验（preHandler）+ Swagger schema；200 响应自动展开为 `oneOf`（成功信封 + 各错误码信封）；OpenAPI `{param}` 语法自动转 Fastify `:param`。
- `registerApiV1Routes`：注册 healthz、debug（条件）、meta、auth、oauth、config、modelCatalog、sessions、sessionExport、skills、messages、search、tasks、approvals、questions、prompts、workspaces、workspaceFs、files、fs、guiStore、tools、terminals（条件）、connections、snapshot、transcript、shutdown（条件），全部挂在 `{ prefix: '/api/v1' }`。
- `sessions.ts`：`POST /sessions`（workspace 注册 → `handlerFor` → `ISessionLifecycleService.create`）、`GET /sessions`（keyset 分页 + 边缘过滤）、`GET /sessions/{id}`、`POST /sessions/{tail}` 动作分发器（`parseActionSuffix` 解析 `{id}:{action}` 尾部，支持 fork/compact/undo/abort/btw/archive/restore）、children、profile、status、goal、warnings。`toWireSession` 只投影 index/metadata 字段，重型字段用占位符（`agent_config:{model:''}`、`usage` 全零、`message_count:0`）——与 v1 的 `toProtocolSession` 字节级对齐；`busy`/`last_turn_reason` 由 `resolveSessionFacts`（核心 `ISessionActivityView`）投影为真实值。
- `v2/sessions.ts`：`GET /api/v2/sessions`，域分组（workspace/meta/activity 恒有，git 走 `include=git` + 60s TTL 缓存）；`page_token` = base64url JSON（版本 + sha256 查询条件指纹 + keyset 位置），条件翻转 → `40922`；三种排序共享一个比较器 + 游标编码。
- `fs.ts`：会话文件系统路由，`POST /sessions/{id}/fs:read` 等一组 `fs:<action>` 动作，直接派发到 Workspace-scope 的 `IWorkspaceFsService`（"session → handler → workspace fs"链，chdir 已废除，handler root 即唯一 fs root）；线 schema 复用引擎的 `workspaceFs` 域契约。两个会话外变体：draft-session 回退（无 session id 时把 workspace 引用塞进 `{session_id}` 槽，仅 `fs:search` 服务，让新建会话草稿的 `@` 文件提及可用）与一等公民 `POST /workspace/fs:search`（workspace 引用走 body，kimi-web 的 `@` 提及用它）。`fs:read` 支持 HTTP Range 头断点读（`lib/httpRange.ts`），`fs:open`/`fs:open_in`/`fs:reveal` 通过 `lib/fileLaunch.ts` 做平台化文件打开（macOS `open` 等）。
- `transport/mainAgent.ts`：主 agent **惰性实体化**——会话创建时不建 main agent，首个请求定位到 `main` 时才 `ensureMainAgent`；主 agent 出生即"未绑定"（无 Profile/Model），由 `profile:setModel`、prompt 的 `body.model` 覆盖或恢复 wire log 时绑定模型才可运行。有意不内置默认模型。
- `transport/ws/v1/fsWatchBridge.ts`：WS 文件监视桥。客户端 `watch_fs_add/remove` 控制帧 ↔ `event.fs.changed` 帧（volatile，直写 socket，不进 journal）；核心 `IWorkspaceFsWatchService` 是 Workspace-scope 的（每 handler 一个 OS watcher，同 workspace 会话共享），桥每会话持**一个**订阅（各连接路径的并集驱动），出站按连接路径再过滤——避免一个 workspace 挂多个 OS watcher；每连接上限 100 条路径（`42902`）。
- `transport/ws/v1/inFlightTurnTracker.ts`：增量跟踪当前 turn 的易失流状态（assistant/thinking 文本、运行中工具），供快照路由重建 mid-turn UI（delta 不落盘不可重放）。**step 相对**：`assistantText`/`thinkingText` 在 `turn.step.started` 时重置（已完成 step 已进快照 transcript），delta 的 `offset` 是当前 step 内的前置偏移；只跟踪主 agent（子 agent delta 共享 session id 但属于另一条流，会污染累加）。
- `routes/action-suffix.ts`：`:action` URL 约定（REST.md §1.6）。Fastify 路径语法无法在同一前缀区分 `:resource_id` 与 `:resource_id:action`，故路由注册 `/.../:tail` 再由 `parseActionSuffix` 解析：`lastIndexOf(':')` 取最后一段冒号（资源 id 本身可含冒号，如 `mcp:lark:search`）；返回 `bare`/`action`/`invalid` 三态，`bare` 仅在 `defaultAction` 声明时允许。
- `protocol/` 域 schema 清单：`rest-session`（会话生命周期）、`rest-message`、`rest-prompt`（提交/中止）、`rest-fs`、`rest-terminal`、`rest-approval`/`approval`、`rest-question`/`question`、`rest-task`/`task`、`rest-tool`/`tool`、`rest-skill`/`skill`、`rest-config`、`rest-oauth`、`rest-snapshot`（快照：in_flight_turn + pending 交互）、`rest-meta`、`rest-modelCatalog`、`rest-search`、`rest-guiStore`、`rest-file`、`rest-connection`、`goal`、`display`、`message`、`session`、`workspace`、`pagination`、`events-zod`（事件帧 schema）、`ws-control`（WS 控制帧 schema）、`error-codes`、`asyncapi`（WS 的 AsyncAPI 文档生成器）。

**服务层（`services/`）**

- `TranscriptService`：见 §4.3。
- `auth/`：`AuthTokenService`（持久化 token 校验）、`persistentToken`（`rotateServerToken`/`serverTokenPath`）、`credentials`（统一 `validateCredential` = token + 可选 rpcToken + 密码）、`password`（bcryptjs 密码哈希）、`tokenStore`（token 落盘）。
- `messages/messageHistory.ts` + `messageProjection.ts`：历史消息读取与 v1 协议投影。
- `legacyStatus/legacyStatus.ts`：把 v2 的 `AgentActivityState` 折叠成 v1 的 `agent.status.updated` phase 切片。
- `modelCatalog/modelCatalogRefreshScheduler.ts`：定时刷新 provider 模型目录。
- `guiStore/`：GUI 状态存储服务。
- `pinoLoggerService.ts`、`telemetry.ts`：日志与云遥测 appender。

**安全/中间件（`middleware/` + `security/`）**

- `auth.ts`：全局 Bearer hook。`defaultIsBypassed` 放行 OPTIONS、`GET /api/v1/healthz`、非 `/api/` 静态资源；`/openapi.json` 与 `/asyncapi.json` **不放行**（防泄露 API 形状）。解码路径后再判断（防 `/%61pi/` 编码绕过），无法解码 fail-closed。校验失败回 401 + 记 `recordFailure`，通过后把 `Authorization` 头替换为 `[redacted]`（防日志泄漏）。
- `hostnames.ts`/`origin.ts`：Host 白名单 + CORS Origin 校验。
- `rateLimit.ts`：每源（IP）滑动窗口失败计数 → 10 次/60s 封禁 60s，封禁期一律 429（即使带有效 token）。
- `securityHeaders.ts`：非 loopback 时追加安全头。
- `bindClassify.ts`：`classify(host)` 把绑定地址分级为 loopback/lan/public（IPv4 CIDR 手算 + IPv6 `::` 展开 + link-local `fe80::/10`）；通配符绑定默认按 public 处理。

**搜索（`search/`）**

- `IGlobalSearchService`（App scope，模块副作用注册）：minidb 库 `<homeDir>/search-index`；`terms`（倒排词项 AND）与 `literal`（2/3-gram 候选 + `includes` 确认，零误报）双模式；"请求服务已发布 generation、永不等待同步" + 单飞/防抖后台协调器；`page_token` 绑定 generation；`index_state.stale/degraded/building` 上报；live 会话走内存 transcript 检索（`source: 'live' | 'index'`）。预算：max terms、postings 访问上限、候选上限、确认文本量、match 截止时间，超额页标 `incomplete`。

**其它**

- `instanceRegistry.ts`：`<home>/server/instances/<serverId>.json`（snake_case 磁盘格式 + camelCase 内存格式），15s 心跳，`kill(pid,0)` 探测清僵尸；`register`/`listLive`/`getLiveServerInstance`。
- `error-handler.ts`：catch-all 把未处理异常折成 `50001` 信封。
- `request-id.ts` / `requestLogging.ts`：`X-Request-Id` 解析与每请求日志（禁用 Fastify 默认访问日志，自己打一行，因为 HTTP 恒 200 无信息量）。

### 3.2 kosong 核心类型

- `Message`：`{ role: 'system'|'user'|'assistant'|'tool', content: ContentPart[], toolCalls: ToolCall[], toolCallId?, partial?, tools? }`。`tools` 只在 system 消息上有意义——**消息级工具声明**（`messages[].tools`）是动态加载工具的原语：顶层 `tools[]` 必须字节稳定以保 prompt cache，新工具用一条只含 `tools` 的 system 消息注入；`isToolDeclarationOnlyMessage` 让其它 provider 跳过这类消息。
- `ContentPart`：`text`/`think`（带 `encrypted` 推理签名）/`image_url`/`audio_url`/`video_url`。
- `StreamedMessagePart = ContentPart | ToolCall | ToolCallPart`；`ToolCallPart` 带 `index`（provider 流式索引）与 `_streamIndex`（内部路由字段，落库前剥离）。
- `ChatProvider`：`generate(systemPrompt, tools, history, options) → Promise<StreamedMessage>`；`withThinking(effort)`（浅拷贝换思考档位）；`withMaxCompletionTokens?`（浅拷贝 + 钳制，**不得替换 HTTP 客户端**，共享传输状态）；`uploadVideo?`；只读字段 `name`/`modelName`/`thinkingEffort`/`maxCompletionTokens`。
- `StreamedMessage`：`[Symbol.asyncIterator]()` + 流结束后才填充的 `id`/`usage`/`finishReason`/`rawFinishReason`/`traceId`（`x-trace-id` 头，Kimi/KFC 专用，头一到就可用——断流也能归因）。
- `FinishReason` 归一化：`completed`/`tool_calls`/`truncated`/`filtered`/`paused`/`other`（`rawFinishReason` 保留原文作逃生舱）。
- `ModelCapability`：`image_in/video_in/audio_in/thinking/tool_use/max_context_tokens/max_input_tokens?/dynamically_loaded_tools?`；`UNKNOWN_CAPABILITY` 是冻结哨兵，`isUnknownCapability` 兜底判空。
- `GenerateResult`：组装好的 assistant 消息 + usage + finishReason + traceId。
- 错误体系：`ChatProviderError` 基类 → `APIConnectionError`/`APITimeoutError`/`APIStatusError`（`statusCode`/`requestId`/`retryAfterMs`/`traceId`）→ `APIContextOverflowError`/`APIRequestTooLargeError`/`APIProviderQuotaExhaustedError`/`APIProviderRateLimitError`/`APIEmptyResponseError` 等；`isRetryableGenerateError`/`isContextOverflowStatusError`/`isProviderRateLimitError` 供上层重试决策。

## 4. 关键数据流 / 状态机 / 时序

### 4.1 服务器启动时序（`start.ts`）

```
startServer(opts)
  ├─ 实例注册：<home>/server/instances/<id>.json（先注册，失败即释放）
  ├─ classify(host) ──非 loopback 且 !insecureNoTls → 拒绝启动
  ├─ auth 装配：tokenStore + passwordHash → AuthTokenService → validateCredential(token|password|rpcToken)
  ├─ bootstrap({homeDir, configPath, clientIdentity, args}) → Core Scope
  │     （注册 IFileSystemStorageService 根在 homeDir；logSeed 保证 Session scope 可建）
  ├─ （opt）telemetry appender（必须在首个 session 创建前）
  ├─ workspace 目录一次性同步（v1 TUI 会话 → workspace）
  ├─ ISessionIndex.prepare()（flag 门控的读模型预热，失败降级为按需读）
  ├─ Fastify 实例：disableRequestLogging + genReqId=resolveRequestId
  │     + setValidatorCompiler/SerializerCompiler 全透传（校验全在 defineRoute 的 Zod）
  ├─ hooks：hostCheck.onRequest → originHook → authHook（可 disable，附危险警告）
  │     非 loopback 再挂 securityHeaders（onSend）
  ├─ 注册 @fastify/swagger（transformObject → transformOpenApiDocument）— 必须在路由前
  ├─ registerApiV1Routes / registerApiV2Routes / registerWsV1
  ├─ app.server.on('upgrade')：手动 host/origin 检查 → bearer 校验（401）→ wss.handleUpgrade
  ├─ （opt）webAssets 注册在最后（/* SPA fallback 兜底）
  └─ listenWithPortRetry：EADDRINUSE → port+1（上限 100，port 0 不重试）
        └─ 成功后再 update({port}) 修正实例注册表；失败则 close() 全部回滚
```

设计要点：**没有单实例锁**——多进程共享 homeDir 时 `port+1` 步进本身就是共存机制；实例注册表是唯一发现手段（CLI `server ps/kill`、kimi-inspect 靠它）。

### 4.2 WS 事件流（核心数据路径）

```
agent-core-v2 内部                          kap-server 传输层                     客户端
───────────────                          ──────────────────                     ─────
per-agent IEventBus
  │  DomainEvent（turn.*/assistant.delta/…）
  ▼
SessionEventBroadcaster.attachAgent
  ├─ agent.status.updated → readLegacyStatus 折叠 phase 切片（丢弃核心的 phase 事件，防重复）
  ├─ task.* → 额外派发 legacy 别名 background.task.*（v1 兼容，同 volatility）
  ▼
onAgentEvent → state.queue（per-session 串行派发链）
  ▼
dispatch(state, event, volatile)
  ├─ volatile（assistant.delta/thinking.delta/tool.call.delta/tool.progress/shell.*/agent.status.updated）
  │     seq = journal.seq（当前 watermark，不推进），volatile:true，[offset 注解]
  │     不写盘、不入 tail、不可重放
  └─ durable（其余全部）
        seq = journal.nextSeq() → journal.append()（异步批量落盘）→ tail.push（上限 1000）
  ▼
扇出
  ├─ isGlobalEvent（session.meta.updated / event.session.* / event.workspace.* / event.config.* / event.di.*）
  │     → globalTargets ∪ 所有 subscribed targets；event.di.* 仅 diEventTargets
  │     （session.meta.updated/event.session.created 走 dispatchSessionEvent，
  │       借真实 session 的 watermark 让信封带真实 session_id，而非 __global__）
  └─ 会话事件 → targets（该会话订阅者）
        → matchesAgentFilter（agent 白名单，global/生命周期事件恒过）
        → suppressedByTranscript（transcript grade 非 off 且类型在投影表 → 抑制去重）
  ▼
target.send(envelope, 'subscription'|'immediate')
  └─ WsConnectionV1：入 outbound FIFO → 16ms 定时 flush / 满 64 帧即刷
        ├─ bufferedAmount > 1MiB → 背压重试（5ms），超 100ms 强制刷
        └─ coalesceFrames：相邻同 session/agent/turn 的 volatile 文本 delta 合并（保留首个 seq/offset）
```

连接生命周期（`WsConnectionV1`）：

```
upgrade（401 把关）→ server_hello
  → client_hello（present-only token 复查；client_id==='kimi-inspect' 加入 diEventTargets）
  → subscribe{subsession_ids, cursors, agent_filter} / subscribe_v2{session_id, transcript, transcript_since}
      └─ attachSession：broadcaster.subscribe（激活会话=建 journal+挂订阅）
           ├─ 有 cursor → getBufferedSince 重放（tail 或盘上）
           │     ├─ 可覆盖 → 事件帧逐条发（filter 裁剪），transcript seed 延后到重放后
           │     └─ 不可覆盖 → resync_required（buffer_overflow / epoch_changed / session_recreated）
           └─ 无 cursor → 返回当前 {seq, epoch}
  → ack{accepted, not_found, resync_required, cursors}
  → 持续事件帧；unsubscribe/unsubscribe_v2 解除订阅（v2 按 agent 粒度降级）
  → close：flush(true) 推尾 → socket.close（服务端从不主动断）
```

**快照/游标一致性**：`getSnapshotState`/`getCursor`/`getBufferedSince` 都先 `await state.queue`，保证读到的 watermark、in-flight turn、roster 是派发链上的原子快照；`InFlightTurnTracker` 为每个 delta 注解累计字符 `offset`，客户端用 `snapshot.in_flight_turn.*_text.length` 对齐（`offset < local` 跳过、`offset > local` 说明丢帧需重快照）。

### 4.3 Transcript 双通道（REST 历史 + WS 实时 ops）

```
TranscriptService（每 live 会话一个 store）
  ├─ 首次访问：forSessionLive → 建 TranscriptStore + bindSessionTranscript（投影 agent 事件→op）
  │     └─ ready = backfillMain：readColdSnapshot(wire.jsonl) → snapshotToOps（全部 upsert，永不 reset）
  │           → store.apply + dispatchOps（按 per-agent seq 入 journal，容量 2000）
  ├─ 每批 op：journalOps（seq 递增，watermark = nextSeq-1）→ 扇给 onSessionOps 监听者（broadcaster）
  ├─ 终端 turn（turn.upsert + state∈{completed,failed,cancelled}）：250ms 防抖 → healEndedTurns
  │     └─ 重新读盘 → healTurnOps 保守合并（live 状态优先，仅补长文本/丢帧/丢 tool.result）
  └─ 会话 close/archive → dropSession（store+binding 一起销毁）

WS 侧（broadcaster.subscribeTranscript）
  ├─ grade 非 off 的 agent → ensureAgentHistory → 每个新 agent 发 transcript.reset（items 空快照 + watermark）
  ├─ transcript_since 游标 → journal 覆盖则回放批次（complete:false 则退化为 reset）
  └─ 后续 op 批 → transcript.ops（volatile，seq=watermark，按 grade 过滤）
        └─ 同一连接收到 transcript 的事件类型不再发 session_event（suppressedByTranscript）
```

transcript 与 durable 事件流**完全正交**：transcript 帧永不推进 seq、永不落 journal；丢帧通过普通背压 → `resync_required` → REST 分页补历史的路径自然恢复。

### 4.4 会话生命周期数据流（REST）

```
POST /api/v1/sessions{workspace_id | metadata.cwd}
  → IWorkspaceService.createOrTouch(workDir)（注册/刷新 workspace）
  → IWorkspaceLifecycleService.handlerFor({root}) → handler.accessor.get(ISessionLifecycleService).create
  → ISessionMetadata.setTitle/read → toWireSession(meta, cwd, facts)
  → IEventService.publish(event.session.created) → broadcaster 扇给所有连接
GET /api/v1/sessions → ISessionIndex.listRecent（keyset）→ 边缘过滤（cwd 可恢复性/exclude_empty/busy）→ 投影
POST /sessions/{id}:fork|compact|undo|abort|btw|archive|restore
  ├─ fork/archive/restore/children → handlerForSession → ISessionLifecycleService.*
  ├─ compact → ensureMainAgent → IAgentFullCompactionService.begin
  ├─ undo → IAgentConversationUndoService.undo → 重读历史投影消息页
  ├─ abort → IAgentRPCService.cancel
  └─ btw → resumeSessionById → ISessionBtwService.start
```

注意：**不存在 App 级会话生命周期门面**——所有会话操作都从 `ISessionIndex`（或 session_id）→ `handlerForSession` → Workspace handler 组合而来；冷会话由 `resumeSessionById` 惰性实体化。

### 4.5 RPC 反射面数据流

```
GET/POST /api/v1/debug[/workspace/:wid|/session/:sid[/agent/:aid]]/:service/:method
  → 全局 bearer hook 已把关（与所有 /api/* 同门）
  → GET ?arg=<json> / POST body → dispatch(core, scopeKind, params, service, method, arg)
      ├─ resolveScope：core / handlerFor({workspaceId}) / getLiveSessionById / IAgentLifecycleService.get
      ├─ resolveService：channelRegistry（全 scoped DI 注册表，名字→ServiceIdentifier）
      │     └─ 特例：非主 agent 访问 goal service → 40920
      ├─ 反射调用：属性直读 / 方法 apply（数组 arg 展开）
      └─ assertSerializable → okEnvelope；Error2 → KIMI_TO_PROTOCOL 映射；超时/未知 → 50001
```

### 4.6 kosong 生成数据流

```
createProvider(config) → ChatProvider（kimi/openai/anthropic/google-genai/openai_responses/vertexai）
agent-core turn 循环
  → kosongGenerate(provider, system, wireTools, history, {signal, onMessagePart, onToolCall})
      ├─ 预检 signal.aborted → AbortError（不发请求）
      ├─ 剥离 deferred tools（顶层 tools[] 保字节稳定 → prompt cache）
      ├─ provider.generate() → StreamedMessage（adapter 把统一 Message/Tool 转成各厂商线格式）
      ├─ for await part：
      │     ├─ 解码统计：等待下一 part = serverDecodeMs；处理 part = clientConsumeMs
      │     ├─ onMessagePart(structuredClone)（宿主转发给 UI delta 回调）
      │     ├─ 并行工具路由：ToolCallPart.index → toolCallIndexMap → 直接追加到目标 call
      │     └─ 顺序合并兜底：mergeInPlace（Text+Text / Think+Think / ToolCall+ToolCallPart）
      │          无法合并 → flushPart 收编 pending（ToolCall 入 message.toolCalls，剥 _streamIndex）
      ├─ 流尾：抛空响应（无 content 无 tool calls / 只有 think）→ APIEmptyResponseError
      └─ onToolCall 逐个回调（全部收齐后才触发，防并行参数交错导致半解析）
  → GenerateResult{id, message, usage, finishReason, rawFinishReason, traceId?}
  → 上层按 finishReason/错误类型决策（重试/截断处理/上下文溢出压缩）
```

### 4.7 文件监视数据流（WS 旁路）

```
客户端                          FsWatchBridge                      核心（Workspace scope）
│ watch_fs_add{paths} (≤100/连接) │                                    │
├───────────────────────────────►│                                    │
│                                ├─ 校验路径（越界→41304；超限→42902）  │
│                                ├─ 并集进会话订阅路径集               │
│                                ├─ 建/更新 IWorkspaceFsWatchSubscription（每会话恰一个）
│                                │───────────────────────────────────►│
│                                │                                    ├─ OS 级 fs.watch（每 handler 一个）
│                                │◄─── FsChangeEvent ─────────────────┤
│                                ├─ 按本连接路径集过滤                  │
│                                ├─ 打 per-session 单调 seq（不进 journal，volatile）
│ ack{watched_paths,current_count}│                                    │
│◄───────────────────────────────┤                                    │
│ event.fs.changed{seq,payload}   │                                    │
│◄───────────────────────────────┤                                    │
│ watch_fs_remove{paths} → 订阅路径集收缩；空则释放订阅（watcher 仍在，属 handler）
```

两条旁路与主事件流的关系：fs 帧**不经过** broadcaster 的 seq/journal（`InFlightTurnTracker`/`SubagentRosterTracker` 也只在会话状态里，与 fs 无关），因此溢出时客户端通过帧内 `truncated` 标记自愈，无需 `resync_required` 机制。

## 5. 重要实现细节

### 5.1 安全模型：按绑定暴露等级渐进加固

kap-server 的安全设计不是"一套开关"，而是**按 `classify(host)` 推导出的暴露等级分层**：

| 机制 | loopback | lan | public |
|---|---|---|---|
| bearer token（全局，含 WS upgrade 与 debug RPC） | 是 | 是 | 是 |
| 无 TLS 启动 | 允许 | 拒绝（`--insecure-no-tls` 可豁免） | 拒绝 |
| auth 失败限流（10 次/60s 封 60s） | 否 | 是 | 是 |
| security headers | 否 | 是 | 是 |
| shutdown/terminals 端点 | 开 | 关（`--allow-remote-*` 可开） | 关 |
| debug RPC（`/api/v1/debug`） | 开（`--debug-endpoints`） | 关 | 关 |

细节：WS `upgrade` 事件绕过 Fastify hooks，所以 host/origin/auth 检查在 `handleUpgrade` 里**手工复刻**（顺序：host → origin → credential），且要写在 token 校验之前；`sec-websocket-protocol` 是浏览器 WebSocket 无法自定义 header 时携带 bearer 的通道（`extractWsBearerToken`/`selectWsBearerProtocol`）。`client_hello` 里的 token 只做 **present-only** 复查（升级时已认证，握手 token 缺失也放行——生产 Web 客户端就是这么做的），这是防御纵深而非主门。

### 5.2 事件流的三个一致性机制

1. **per-session 派发链（`state.queue`）**：所有事件（agent 事件、交互合成事件、work_changed、core 全局事件）都通过 `state.queue = state.queue.then(dispatch)` 串行化。这保证 seq 单调、journal 顺序与扇出顺序一致、快照读取原子。volatile 与 durable 在**同一把锁**里——volatile 帧的 `seq`（watermark）永远不超前于其前一个 durable 帧。
2. **会话激活的单飞（`pendingStates`）**：WS subscribe 与 REST snapshot 并发激活同一会话时会各建一份 SessionState；注释明确记录了曾出现的 `AABBCC` 双倍 delta bug——单飞保证一个会话只有一个 journal writer 与一组总线订阅。
3. **`turn_ended` 帧序**：`ISessionActivityView` 的 full-stream 订阅者先于 per-type 订阅者触发，所以 `busy:false` 的 work_changed 必须缓冲到微任务里，等 `turn.ended` 帧已入队后再发——微任务必然落在同一同步发布之后。

### 5.3 日志的持久性与崩溃容错

`SessionEventJournal`：`append()` 同步入队（调用方要立刻拿到 seq 用于扇出），写盘是**微任务调度的一次异步批量 appendFile**；`readSince` 先 `flush()` 再读，保证重放不丢排队行；崩溃产生的 torn 尾行在 open 时静默跳过；整个文件不可读 → 新 epoch 轮换（旧游标统一 `epoch_changed`，避免逐条错位）。写失败降级为"本轮 live-only"，不阻塞事件流。

### 5.4 出站背压与合并

WS 出站是"合并窗口 + 批量 + 高水位"三级：订阅帧进 FIFO，16ms 定时刷或满 64 帧即刷；`socket.bufferedAmount > 1 MiB` 时延后重试（5ms，上限 100ms 后强制刷，防饿死）。`coalesceFrames` 把相邻且同 (type, session, agent, turn) 的 volatile 文本 delta 合并成一条（保留首帧 seq/offset/timestamp，payload.delta 拼接）——客户端 offset 对齐仍正确，因为 per-session 派发链保证同 turn 的 delta offset 连续。合并永不跨越不可合并帧，整体顺序不变。

### 5.5 transcript 的"活数据优先"哲学

`backfill` 与 `heal` 全部用 **idempotent upsert op** 而非 `reset`：重放历史时并发到达的 live op 不会被覆盖；`healTurnOps` 的合并规则精心保守——header 以 snapshot 为准补 `prompt`（mid-turn 附加的投影器没看到用户消息），但 state/时间戳以 live 为准；text/thinking 帧仅在持久化版本**更长**时才重发（防 lagging flush 回退）；tool 帧在 live 缺 outcome 时补发（attach 竞态丢的 `tool.result` 只能靠这个救回），且保留 live 的 display/agentRefs/approvalId 附加字段；interactions 永不重放（全局实体，live 内核桥更全）。`liveTurnOverlay` 还在 backfill 后把 loop 实际 running 的 turn 头重新断言为 running（冷分组只能看到 completed）。ops journal 是**有界内存**（2000 批），`transcript_since` 覆盖不了就诚实报告 `complete:false` 让客户端全量刷新——绝不撒谎。

### 5.6 搜索的"generation 发布"模型

`searchService.ts` 的核心权衡是**请求永不等待**：请求读当前已发布的 index generation（内存视图），后台协调器（单飞 + 防抖 + 一个排队跟进）检测 wire.jsonl 变化增量投影；读多进程通过 WAL 指纹（`db.wal`/`db.snapshot`/`db.textindexes.json`）判断是否要 `catchUpFromWal` 或换库（换库失败继续服务旧 generation 并报 degraded）。增量锚点是 `\0meta\file\<sessionId>\<pathHash>` 键（记录字节偏移 + size/mtime/inode），只重读新增字节区间；pre-v2 的 hash-only 键由一次性后台迁移。terms 模式用 minidb 倒排（ASCII 词 + CJK 单/双字、term 级 AND、无位置）；literal 模式用 2/3-gram 候选 + 逐条 `includes` 确认（零误报）。所有查询都带预算，超预算页标记 `incomplete` 而非假报完整。

### 5.7 kosong 的流式组装细节

- **并行工具调用的防串扰**：OpenAI 系流式多工具时参数 delta 跨调用交错（tc0-header → tc1-header → tc0-args → tc1-args）。`generate()` 用 `ToolCallPart.index`（Chat 的 `index` / Responses 的 `item_id`）经 `toolCallIndexMap` 直接路由到已收编的 ToolCall，顺序合并只作 fallback；`_streamIndex` 在收编时剥掉，绝不落库。
- **`onToolCall` 延迟到流尾**：中途触发会把半解析参数交给工具调度器 → `toolParseError`。
- **空响应语义**：无 content 无 toolCalls → 抛错；**只有 think 没有 text/tool** 也抛错（通常是流中断或推理时 token 预算耗尽）——错误消息里带 finishReason 提示便于归因。
- **abort 三处检查**：请求前（不发网络请求）、`provider.generate()` 返回后（不 drain）、每 part 间（`cancelStream` 尽力取消后抛 `AbortError`）。
- **prompt cache 保全**：`deferred` 工具从顶层 `tools[]` 剥离（generate 是唯一剥离点，注释明确这是字节稳定防线）；消息级 `tools` 声明是动态加载工具的另一个通道（仅 Kimi 线支持）。
- **解码统计**：`serverDecodeMs`/`clientConsumeMs` 分离等待与处理耗时——`clientConsumeMs` 占比大是宿主每 part 处理（deep copy、回调）拖慢解码的无歧义信号。

### 5.8 kosong 的 provider 适配差异

- `kimi.ts`：基于 OpenAI SDK，`max_tokens`/`max_completion_tokens` 归一化（推理模型两者共享预算，小 `max_tokens` 会拿到 200 空响应，故只发 `max_completion_tokens`）；`reasoning_content` 双向转换（think part ↔ wire 字段）；`extra_body.thinking`（effort/keep）；tool call id 长度策略（64 上限消毒）；`x-trace-id` 解析。
- `openai-legacy`（Chat Completions）与 `openai-responses`（Responses API）是两个独立 adapter；`google-genai` 兼 vertexai（同一构造器）。
- `capability-registry`：**静态前缀表**能力判定（Claude 按能力组而非版本族分组——Fable 与 Opus/Sonnet/Haiku 4 同组），Kimi wire 恒返回 `UNKNOWN_CAPABILITY`（能力来自宿主 catalog/配置而非模型名）。
- `catalog.ts`：models.dev 风格目录解析——`reasoning_options` 里只有 `{type:'effort', values}` 能映射出思考档位（`toggle`/`budget_tokens` 不行），`'none'` 值映射为 `offEffort`，有档位无开关的模型标 `alwaysThinking`；`status:'deprecated'` 导入时丢弃；gateway provider 的 `provider.npm/api` 覆盖映射为 `protocol:'anthropic'` + baseUrl。

### 5.9 `:action` URL 约定与路由分发

v1 时代 `/sessions/{id}/prompts` 这类"资源 + 动作"形态在 REST 上表现为 `POST /sessions/{id}:compact` 等**冒号动作后缀**。Fastify 的 `find-my-way` 无法在同路径前缀上同时匹配 `:resource_id` 与 `:resource_id:action`，所以所有动作路由统一注册为 `/.../:tail`，`parseActionSuffix` 负责切分。要点：用 `lastIndexOf(':')` 而非 `indexOf`——资源 id 本身可以含冒号（如 MCP 工具限定名 `mcp:lark:search` 出现在路径位置时），只有**最后一个**冒号是动作分隔符；`bare` 形态（无后缀）只有当路由声明 `defaultAction` 时才合法（如 question 默认 resolve、approval 默认 respond），否则报 `unsupported action`；空 id 报 `invalid <resource>_id in path`。该 helper 从 v1 逐字移植，`{tail}` 动作在 sessions、approvals、questions、prompts、tasks、terminals、skills 等多组路由共用。

### 5.10 文件监视的共享订阅模型

`FsWatchBridge` 解决的是"OS watcher 数量"与"每连接路径过滤"的张力：核心 `IWorkspaceFsWatchService` 是 Workspace-scope，一个 handler 挂一个 OS watcher 并服务于该 workspace 的所有会话；桥为**每个会话**持有恰好一个 `IWorkspaceFsWatchSubscription`，其路径集是连接到该会话的所有连接路径的并集；出站时再按各连接的路径集过滤。这样两个会话共享同一 handler 的 watch 而不新增 watcher，连接增减只改订阅路径集。每连接路径上限 100（`42902 FS_WATCH_LIMIT_EXCEEDED`），路径越界报 `41304`。`event.fs.changed` 帧是 **volatile**（直写 socket，不进 broadcaster/journal），溢出时客户端看到 `truncated` 标记自行重同步——文件监视对丢帧有天然的自愈性（下个事件就是完整快照语义）。

### 5.11 kosong 的协议错误分类与 Anthropic 适配

- **错误分类是"协议知识"**：`openai-common.ts` 里 `insufficient_quota` 是 OpenAI 线自己的 429 语义（`error.type` 与 `error.code` 都写该值）——配额耗尽在充值前是确定性失败，**不能**归类为可重试的限流，必须映射成 `APIProviderQuotaExhaustedError`；`Retry-After` 头被解析为 `retryAfterMs` 供上层重试循环优先遵循（服务端指令覆盖本地指数退避）。`normalizeAPIStatusError`/`classifyBaseApiError`/`parseRetryAfterMs` 是全部 adapter 共享的归一化入口。
- **Anthropic adapter**（1334 行，最复杂的适配）：`stop_reason` → 统一 `FinishReason` 的映射表（`end_turn`/`stop_sequence` → `completed`、`max_tokens` → `truncated`、`pause_turn` → `paused`、`refusal` → `filtered` 等）；`anthropic-profile.ts` 从模型名推断 `AnthropicModelProfile`（版本解析 + 能力画像），支持 `BUDGET_THINKING_EFFORTS`（预算思考档位）；思考块用 `ThinkingBlockParam` 映射 think part（含签名/密文）；工具结果块做 `tool_use_id` 回链；连续 user 消息用 `mergeConsecutiveUserMessages` 合并（Anthropic 线不允许多条 user 连续出现）；`max_tokens` 是 Anthropic 的必填字段，由 `withMaxCompletionTokens` 或构造默认值保证。
- **工具 ID 卫生**：`tool-call-id.ts` 为每家 provider 定义 `ToolCallIdPolicy`（Kimi 64 上限消毒、Anthropic/OpenAI 各自限制），`normalizeToolCallIdsForProvider` 在请求构造时统一处理——因为各家对 tool_call_id 的字符集/长度约束不同，而同一个 id 会在用户消息里往返。

## 6. 关键代码位置索引

### 6.1 kap-server

| 位置 | 说明 |
|---|---|
| `src/start.ts:186` | `startServer` 组合根：安全分级、auth 装配、Core bootstrap、hook、路由、WS、端口重试 |
| `src/start.ts:714` | `listenWithPortRetry`：EADDRINUSE → port+1 步进（多实例共存机制） |
| `src/start.ts:522` | `handleUpgrade`：手工复刻 host/origin/bearer 检查（upgrade 绕过 Fastify hooks） |
| `src/security/bindClassify.ts:90` | `classify`：绑定地址分级（IPv4 CIDR 手算 + IPv6 展开 + fe80::/10） |
| `src/protocol/envelope.ts:9` | 信封 schema 工厂（所有响应的统一形状） |
| `src/protocol/error-codes.ts:17` | 完整数字错误码表（4xxxx/5xxxx/6xxxx/7xxxx/8xxxx） |
| `src/middleware/auth.ts:64` | 全局 bearer hook + 解码路径防编码绕过 + fail-closed + 头脱敏 |
| `src/middleware/rateLimit.ts:55` | 认证失败滑动窗口封禁（非 loopback 启用） |
| `src/middleware/defineRoute.ts:233` | 单点路由声明：Zod 校验 + OpenAPI oneOf 响应展开 |
| `src/routes/registerApiV1Routes.ts:87` | `/api/v1` 全部路由注册（含条件挂载 debug/terminals/shutdown） |
| `src/routes/sessions.ts:257` | 会话 CRUD + `{tail}` 动作分发器 |
| `src/routes/sessions.ts:1114` | `toWireSession`：v1 字节级占位投影（heavy 字段占位 + 真实 busy/last_turn_reason） |
| `src/routes/v2/sessions.ts:1` | v2 域分组列表 + page_token（版本+指纹+keyset，40922） |
| `src/transport/ws/v1/wsConnectionV1.ts:101` | 连接对象：控制帧串行队列、出站缓冲/背压/合并、重放 |
| `src/transport/ws/v1/wsConnectionV1.ts:706` | `coalesceFrames`：相邻 volatile delta 合并 |
| `src/transport/ws/v1/sessionEventBroadcaster.ts:218` | 每会话单扇出点：durable/volatile 分类、seq、global 扇出、transcript 通道 |
| `src/transport/ws/v1/sessionEventBroadcaster.ts:1252` | `dispatch`：核心派发（journal/tail/扇出/抑制） |
| `src/transport/ws/v1/sessionEventBroadcaster.ts:1439` | `TRANSCRIPT_PROJECTED_EVENT_TYPES`：transcript 已投影事件表（去重依据） |
| `src/transport/ws/v1/sessionEventJournal.ts:75` | JSONL 日志：epoch 恢复、seq 跨重启单调、异步批量落盘 |
| `src/transport/ws/v1/registerWsV1.ts:37` | WS 服务器装配（noServer + 协议协商） |
| `src/transport/channelRegistry.ts:145` | `describeAllChannels`：全注册表自省（原型链 + toString 参数名） |
| `src/transport/dispatcher.ts:124` | 反射派发：scope 解析 → 服务解析 → 调用 |
| `src/transport/serviceDispatcherRoutes.ts:70` | RPC 路由注册（四级 scope 路径 + channels 自省） |
| `src/transport/errors.ts:66` | `mapError`：Error2 码 → 信封码映射表 |
| `src/services/transcript/transcriptService.ts:126` | transcript 所有者：backfill/ops journal/heal/cold rebuild |
| `src/services/transcript/transcriptService.ts:701` | `healTurnOps`：持久化与 live 的保守合并规则 |
| `src/services/legacyStatus/legacyStatus.ts` | v2 活动状态 → v1 phase 折叠 |
| `src/services/messages/messageProjection.ts` | 历史消息 → v1 协议消息投影 |
| `src/search/searchService.ts:1` | 全局搜索：generation 发布 + 双模式 + 预算 + live 检索 |
| `src/openapi/transforms.ts:118` | swagger 后处理（{tail} 分发、multipart、binary） |
| `src/instanceRegistry.ts:1` | 实例注册表（心跳 + pid 探活 + 僵尸清扫） |
| `src/error-handler.ts` | catch-all → 50001 信封 |
| `src/routes/fs.ts:1` | 会话文件系统动作路由（draft-session 回退 + workspace fs:search + Range 下载） |
| `src/routes/action-suffix.ts:44` | `parseActionSuffix`：`:action` URL 切分（lastIndexOf 容错冒号 id） |
| `src/transport/mainAgent.ts:1` | 主 agent 惰性实体化（`ensureMainAgent` 重导出） |
| `src/transport/ws/v1/fsWatchBridge.ts:1` | 文件监视桥：共享订阅 + 每连接过滤 + volatile 帧 |
| `src/transport/ws/v1/inFlightTurnTracker.ts:24` | 当前 turn 易失状态累加（step 相对 offset） |
| `src/protocol/ws-control.ts:1` | WS 控制帧 schema（协议版本 2：{seq,epoch} 游标 + volatile） |

### 6.2 kosong

| 位置 | 说明 |
|---|---|
| `src/provider.ts:220` | `ChatProvider` 接口（生成/思考档位/预算钳制/视频上传） |
| `src/provider.ts:93` | `StreamedMessage`（异步迭代 + 流后元数据 + traceId） |
| `src/generate.ts:87` | 流式组装主循环（合并/路由/abort/空响应） |
| `src/generate.ts:317` | `flushPart`：part 收编 + `_streamIndex` 剥离 |
| `src/message.ts:171` | `mergeInPlace`：原地合并规则 |
| `src/message.ts:134` | `isToolDeclarationOnlyMessage`：消息级工具声明判定 |
| `src/capability.ts:43` | `UNKNOWN_CAPABILITY` 冻结哨兵 + 兜底判定 |
| `src/catalog.ts:68` | `CatalogModel`：目录条目 → 能力 + 思考档位（offEffort/alwaysThinking） |
| `src/errors.ts:6` | 错误体系与可重试判定 |
| `src/providers/kimi.ts:46` | Kimi adapter（kwargs 归一化、thinking、消息级 tools、reasoning_content） |
| `src/providers/openai-legacy.ts` / `openai-responses.ts` | Chat Completions 与 Responses 双 adapter |
| `src/providers/anthropic.ts` | Anthropic adapter（最大 1334 行，最复杂的适配） |
| `src/providers/capability-registry.ts:1` | 静态能力前缀表 |
| `src/providers/chat-completions-stream.ts` | Chat 流式工具调用缓冲 |
| `src/providers/tool-call-id.ts` | 工具调用 ID 消毒策略 |

## 7. 与其它子系统的接口

### 7.1 kap-server 对外暴露

**npm 导出（`packages/kap-server/package.json`）**

- `.`：`startServer`、`ServerHostIdentity`/`ServerStartOptions`/`RunningServer`、`okEnvelope`/`errEnvelope`/`Envelope`、`classify`/`BindClass`、`rotateServerToken`/`serverTokenPath`、`createServerLogger`、实例注册表全套（`createInstanceRegistry`/`listLiveServerInstances`/`getLiveServerInstance`/…）。
- `./contract`：`ChannelDescriptor`/`ChannelMethodDescriptor`/`IChannel`/`ScopeKind`——RPC 契约类型（仅工具/测试消费）。

**调用方**

- `apps/kimi-code`：`kimi web`（`src/cli/sub/web/run.ts:275`）与 TUI 的 web 命令调用 `startServer`，传 `hostIdentity`、`webAssetsDir`、`debugEndpoints` 等；CLI 的 `server ps/kill` 通过实例注册表发现进程；`server rotate-token` 用 `rotateServerToken`。
- `apps/kimi-inspect`：运行时消费 `/api/v1/debug/*`（WS 事件面 + REST RPC 面），WS `client_hello` 带 `client_id:'kimi-inspect'` 解锁 `event.di.*` 调试流。
- Web UI（`apps/kimi-code/dist-web`）：消费 `/api/v1` REST（信封协议）+ `/api/v1/ws`（v1 WS 协议，subscribe_v2 订阅 transcript）。
- v1 协议客户端（TUI/`kimi -p`/node-sdk）：经 `background.task.*` 别名、phase 折叠、占位字段保持兼容。

**kap-server 消费的外部服务**：agent-core-v2（引擎一切）、transcript（契约 + grade）、minidb（搜索索引）、kimi-code-oauth（默认请求头 + OAuth 路由）。搜索服务通过 `setLiveTranscriptSource(transcriptService)` 把 live 会话检索接到 transcript 存储上。

### 7.2 kosong 对外暴露

- 根 barrel：`Message`/`ContentPart`/`ToolCall`/`mergeInPlace`、`ChatProvider`/`StreamedMessage`/`FinishReason`、`createProvider`/`getModelCapability`、`generate`/`GenerateCallbacks`/`GenerateResult`、`KimiChatProvider`（唯一收进 barrel 的具体类）、`classifyKimiQuotaError`、`ModelCapability`/`UNKNOWN_CAPABILITY`、catalog 全套解析函数、`Tool`、`TokenUsage`、全部错误类与判定函数。
- 子路径：`@moonshot-ai/kosong/providers/{kimi,openai-legacy,openai-responses,anthropic,google-genai,index}`。
- **主要消费方**：agent-core 的 turn 循环（`src/agent/turn/kosong-llm.ts`——把 kosong 的 per-part 回调转发为 loop 的 delta 回调，块级回调等流排空后再发；`isRetryableGenerateError` 供重试决策；`applyCompletionBudget` + `ModelCapability` 做上下文预算）；agent-core 的工具/媒体工具（video/image 上传）；`node-sdk` 与 `apps/vis/server` 直接使用 provider。

### 7.3 关键边界与已知取舍

- kap-server 的 `/api/v1/debug` 是**有意无白名单**的反射面——安全靠部署形状（loopback + `--debug-endpoints` + 全局 bearer）而非接口枚举；代码注释反复强调这一设计并给出 kimi-inspect 之外的接入警示。
- transcript 流仅覆盖**本进程内 live 会话**；冷会话只有 REST 分页。WS `subscribe_v2` 的 `transcript_since` 回放依赖有界内存 journal，覆盖不了就诚实降级为全量 reset。
- 事件日志（`SessionEventJournal`）是 best-effort 持久化：写盘失败时事件仍 live 扇出，但不可重放——客户端只能靠 `resync_required` 路径兜底。
- **多实例共享 homeDir 是显式支持的拓扑**（`port+1` 步进 + 实例注册表），但 WS 连接与 journal 是进程本地的——客户端不能假设跨进程的订阅连续性，`epoch_changed`/冷 watermark 路径就是为这种漂移准备的。
- **auth 的 loopback 默认**：localhost 绑定下无限流、无安全头、token 是唯一门；`--dangerous-bypass-auth` 会把 `/api/v1/meta` 里的 `dangerous_bypass_auth` 置真并打印醒目警告（供无 token 的 Web UI 连接），这是操作员显式选择的降级，不是默认路径。
- **`openapi.json` 与 `/asyncapi.json` 刻意在 auth 之外**（即使 loopback 也是"静态资源放行、meta 文档把关"的例外）：API 形状属于敏感面，与 `/api/` 一样要 token。
- kosong 刻意不含重试/循环/预算逻辑（那属于 agent-core），`FinishReason` 与错误码是两层之间的唯一控制面；`max_context_tokens: 0` 表示"未知"，调用方不得据此硬性裁剪。
- kosong 的 `UNKNOWN_CAPABILITY` 设计是"非致命降级"：未入目录的模型默认无视觉/思考/工具能力声明，宿主可以照常发请求让上游拒绝，而不是本地硬拦——能力表是提示不是强制。
