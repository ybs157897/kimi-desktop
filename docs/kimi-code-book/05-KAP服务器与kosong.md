# 第 5 章 KAP 服务器与 kosong：服务端外壳与 LLM 抽象

> 研究对象：`packages/kap-server`（约 2.9 万行 TS）与 `packages/kosong`（约 9.2 千行 TS）。
> 学习目标：理解 Kimi Code 的网络服务端形态（REST + WS + 反射 RPC），以及"空"——最薄的 LLM 抽象层。

## 5.1 kap-server：Kimi Code 的 HTTP/WS 服务端外壳

kap-server（"Kimi Agent Protocol" server）把 `agent-core-v2`（DI × Scope 引擎）整体暴露为一套 REST + WebSocket 接口，供浏览器 Web UI、IDE 集成、远程开发场景（`kimi web`）与调试工具（kimi-inspect）使用。

**它不是协议规范库，而是可嵌入的服务器组合根**：对外暴露 `startServer(opts)` 一个入口，返回 `{ app, core, connectionRegistry, authTokenService, host, port, close }`。宿主进程负责传 `hostIdentity`、`webAssetsDir`、`debugEndpoints` 等选项。

**与 agent-core-v2 的关系**：kap-server 是 v2 引擎的**传输适配层**，不实现任何 agent 逻辑——会话生命周期、prompt 提交、工具执行、审批/提问内核全部在 agent-core-v2 的 Service 里；kap-server 只是把 `IWorkspaceLifecycleService.handlerFor → ISessionLifecycleService` 的 scope 组合映射成 URL，把 v2 的 `DomainEvent` 事件流投影成 v1 兼容的 WS 事件帧，把 v2 的 `Error2` 错误码翻译成信封 `code`。

实际协议 = `/api/v1` REST（`{ code, msg, data, request_id }` 信封）+ `/api/v1/ws` WebSocket（`server_hello`/`subscribe`/`ack`/事件流）+ `/api/v2` 实验面。同一套协议 v1 时代由 `packages/server` 实现过，kap-server 逐模块移植并保持**线上字节级兼容**。

## 5.2 服务器启动时序（start.ts）

```
startServer(opts)
  ├─ 实例注册：<home>/server/instances/<id>.json（先注册，失败即释放）
  ├─ classify(host) ──非 loopback 且 !insecureNoTls → 拒绝启动
  ├─ auth 装配：tokenStore + passwordHash → AuthTokenService
  ├─ bootstrap({homeDir, configPath, ...}) → Core Scope
  ├─ workspace 目录一次性同步（v1 TUI 会话 → workspace）
  ├─ Fastify 实例（校验/序列化全透传，校验在 defineRoute 的 Zod）
  ├─ hooks：hostCheck → originHook → authHook；非 loopback 再挂安全头
  ├─ 注册 @fastify/swagger（必须在路由前）
  ├─ registerApiV1Routes / registerApiV2Routes / registerWsV1
  ├─ app.server.on('upgrade')：手动 host/origin 检查 → bearer 校验 → wss.handleUpgrade
  ├─ （opt）webAssets 注册在最后（/* SPA fallback）
  └─ listenWithPortRetry：EADDRINUSE → port+1（上限 100）——多实例共存机制
```

设计要点：**没有单实例锁**——多进程共享 homeDir 时 `port+1` 步进本身就是共存机制；实例注册表（15s 心跳 + `kill(pid,0)` 探活）是唯一发现手段。

### 5.2.1 安全模型：按绑定暴露等级渐进加固

`classify(host)` 把绑定地址分级为 loopback/lan/public（IPv4 CIDR 手算 + IPv6 `::` 展开 + link-local `fe80::/10`；通配符绑定默认按 public 处理）：

| 机制 | loopback | lan | public |
|---|---|---|---|
| bearer token（全局，含 WS upgrade 与 debug RPC） | 是 | 是 | 是 |
| 无 TLS 启动 | 允许 | 拒绝（`--insecure-no-tls` 豁免） | 拒绝 |
| auth 失败限流（10 次/60s 封 60s） | 否 | 是 | 是 |
| security headers | 否 | 是 | 是 |
| shutdown/terminals 端点 | 开 | 关（`--allow-remote-*` 可开） | 关 |
| debug RPC（`/api/v1/debug`） | 开（`--debug-endpoints`） | 关 | 关 |

细节：WS `upgrade` 事件**绕过 Fastify hooks**，所以 host/origin/auth 检查在 `handleUpgrade` 里手工复刻（顺序：host → origin → credential，且先于 token 校验）；`sec-websocket-protocol` 是浏览器 WebSocket 无法自定义 header 时携带 bearer 的通道。auth hook 会先解码路径再判断（防 `/%61pi/` 编码绕过），无法解码 fail-closed；校验通过后把 `Authorization` 头替换为 `[redacted]`（防日志泄漏）。

### 5.2.2 信封与错误码

`Envelope<T> = { code, msg, data, request_id, details?, stack? }`。**HTTP 状态几乎恒为 200，业务结果全在 `code`**——这是整条协议线的基石（v1 与 v2 共用）。

错误码命名空间：`0` 成功；`4xxxx` 客户端（`40001` 校验失败、`40110-40113` 认证、`40401-40417` not_found、`40901-40922` 冲突、`41301-41305` 过大、`42902` watch 超限）；`5xxxx` 服务端；`6xxxx` 工具运行时；`7xxxx`/`8xxxx` 为 provider/MCP 透传（msg 保留上游原文）。

## 5.3 WS 事件流：核心数据路径

```
agent-core-v2 内部                          kap-server 传输层                     客户端
per-agent IEventBus
  │  DomainEvent（turn.*/assistant.delta/…）
  ▼
SessionEventBroadcaster.attachAgent
  ├─ agent.status.updated → readLegacyStatus 折叠 phase 切片
  ├─ task.* → 额外派发 legacy 别名 background.task.*（v1 兼容）
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
  ├─ isGlobalEvent → globalTargets ∪ 所有 subscribed targets；event.di.* 仅 diEventTargets
  └─ 会话事件 → targets → matchesAgentFilter → suppressedByTranscript（去重）
  ▼
target.send(envelope)
  └─ WsConnectionV1：入 outbound FIFO → 16ms 定时 flush / 满 64 帧即刷
        ├─ bufferedAmount > 1MiB → 背压重试（5ms），超 100ms 强制刷
        └─ coalesceFrames：相邻同 session/agent/turn 的 volatile 文本 delta 合并
```

### 5.3.1 三个一致性机制

1. **per-session 派发链（`state.queue`）**：所有事件都通过 `state.queue = state.queue.then(dispatch)` 串行化——保证 seq 单调、journal 顺序与扇出顺序一致、快照读取原子。volatile 与 durable 在**同一把锁**里：volatile 帧的 seq（watermark）永远不超前于其前一个 durable 帧。
2. **会话激活的单飞（`pendingStates`）**：WS subscribe 与 REST snapshot 并发激活同一会话时各建一份 SessionState 会出 `AABBCC` 双倍 delta bug——单飞保证一个会话只有一个 journal writer。
3. **`turn_ended` 帧序**：full-stream 订阅者先于 per-type 订阅者触发，所以 `busy:false` 的 work_changed 必须缓冲到微任务里，等 `turn.ended` 帧已入队后再发。

### 5.3.2 SessionEventJournal

每会话 `<eventsDir>/<sessionId>.jsonl`，首行 `journal_header`（`epoch: "ep_<ulid>"`），后续 `{"kind":"event","seq":N,"envelope":{...}}`。`seq` **跨重启单调**（open 时扫盘恢复）；`epoch` 在文件损坏时轮换（旧游标收到 `resync_required(epoch_changed)`）。`append()` 同步入队（调用方要立刻拿到 seq 用于扇出），写盘是**微任务调度的一次异步批量 appendFile**；`readSince` 先 flush 再读；崩溃产生的 torn 尾行静默跳过；写失败降级为"本轮 live-only"，不阻塞事件流。

### 5.3.3 快照/游标一致性

`getSnapshotState`/`getCursor`/`getBufferedSince` 都先 `await state.queue`——读到的 watermark、in-flight turn、roster 是派发链上的原子快照；`InFlightTurnTracker` 为每个 delta 注解累计字符 `offset`（**step 相对**：在 `turn.step.started` 时重置），客户端用 `snapshot.in_flight_turn.*_text.length` 对齐（`offset < local` 跳过、`offset > local` 说明丢帧需重快照）。

## 5.4 反射 RPC 面（/api/v1/debug）

**有意无白名单的反射面**：整个 scoped DI 注册表即公共契约，安全靠部署形状（loopback + `--debug-endpoints` + 全局 bearer）而非接口枚举。

```
GET/POST /api/v1/debug[/workspace/:wid|/session/:sid[/agent/:aid]]/:service/:method
  → dispatch(core, scopeKind, params, service, method, arg)
      ├─ resolveScope：core / handlerFor({workspaceId}) / getLiveSessionById / IAgentLifecycleService.get
      ├─ resolveService：channelRegistry（全 scoped DI 注册表，名字→ServiceIdentifier）
      │     └─ 特例：非主 agent 访问 goal service → 40920
      ├─ 反射调用：属性直读 / 方法 apply（数组 arg 展开）
      └─ assertSerializable → okEnvelope；Error2 → KIMI_TO_PROTOCOL 映射
```

`ChannelDescriptor` 的 `describeMethods` 沿原型链（止于 `Disposable.prototype`）枚举公开方法，`Function#toString` 提取参数名做 UI 提示；`GET /debug/channels` 动态自省全部服务。

## 5.5 Transcript 双通道

```
TranscriptService（每 live 会话一个 store）
  ├─ 首次访问：forSessionLive → 建 TranscriptStore + bindSessionTranscript（投影 agent 事件→op）
  │     └─ ready = backfillMain：readColdSnapshot(wire.jsonl) → snapshotToOps（全部 upsert，永不 reset）
  ├─ 每批 op：journalOps（seq 递增）→ 扇给 onSessionOps 监听者
  ├─ 终端 turn：250ms 防抖 → healEndedTurns（重新读盘 → 保守合并，仅补长文本/丢帧/丢 tool.result）
  └─ 会话 close/archive → dropSession

WS 侧（broadcaster.subscribeTranscript）
  ├─ grade 非 off 的 agent → 每个新 agent 发 transcript.reset（items 空快照 + watermark）
  ├─ transcript_since 游标 → journal 覆盖则回放批次（complete:false 则退化为 reset）
  └─ 后续 op 批 → transcript.ops（volatile，按 grade 过滤）
        └─ 同一连接收到 transcript 的事件类型不再发 session_event（suppressedByTranscript）
```

**transcript 与 durable 事件流完全正交**：transcript 帧永不推进 seq、永不落 journal；丢帧通过普通背压 → `resync_required` → REST 分页补历史的路径自然恢复。

**"活数据优先"哲学**：backfill 与 heal 全部用 idempotent upsert op 而非 reset——重放历史时并发到达的 live op 不会被覆盖；`healTurnOps` 的合并规则精心保守（header 以 snapshot 为准补 prompt、state/时间戳以 live 为准、text 仅在持久化版本更长时才重发、tool 帧在 live 缺 outcome 时补发、interactions 永不重放）；ops journal 有界内存（2000 批），覆盖不了就诚实报告 `complete:false`——绝不撒谎。

## 5.6 搜索服务（minidb 全文检索）

`IGlobalSearchService`：minidb 库 `<homeDir>/search-index`；**请求永不等待**——请求读当前已发布的 index generation（内存视图），后台协调器（单飞 + 防抖）检测 wire.jsonl 变化增量投影；多进程通过 WAL 指纹（`db.wal`/`db.snapshot`/`db.textindexes.json`）判断是否要 `catchUpFromWal` 或换库（换库失败继续服务旧 generation 并报 degraded）。

- `terms` 模式：minidb 倒排（ASCII 词 + CJK 单/双字、term 级 AND、无位置）；
- `literal` 模式：2/3-gram 候选 + 逐条 `includes` 确认（**零误报**）；
- 增量锚点是 `\0meta\file\<sessionId>\<pathHash>` 键（记录字节偏移 + size/mtime/inode），只重读新增字节区间；
- 所有查询都带预算（max terms、postings 访问上限、候选上限、match 截止时间），超额页标 `incomplete` 而非假报完整；
- live 会话走内存 transcript 检索（`source: 'live' | 'index'`）。

## 5.7 文件监视（WS 旁路）

`FsWatchBridge` 解决"OS watcher 数量"与"每连接路径过滤"的张力：核心 `IWorkspaceFsWatchService` 是 Workspace-scope，一个 handler 挂一个 OS watcher 服务于该 workspace 的所有会话；桥为**每个会话**持有恰好一个订阅（路径集 = 所有连接的并集），出站时再按各连接的路径集过滤。每连接路径上限 100（`42902`）。`event.fs.changed` 帧是 **volatile**（直写 socket，不进 journal）——文件监视对丢帧有天然自愈性（下个事件就是完整快照语义）。

## 5.8 路由层细节

- **`defineRoute`**（middleware/defineRoute.ts:233）：单对象声明 runtime Zod 校验（preHandler）+ Swagger schema；200 响应自动展开为 `oneOf`（成功信封 + 各错误码信封）。
- **`:action` URL 约定**：Fastify 路径语法无法在同一前缀区分 `:resource_id` 与 `:resource_id:action`，所有动作路由统一注册为 `/.../:tail`，`parseActionSuffix` 负责切分。用 `lastIndexOf(':')` 而非 `indexOf`——资源 id 本身可以含冒号（如 MCP 工具限定名 `mcp:lark:search`），只有**最后一个**冒号是动作分隔符；`bare` 形态只有路由声明 `defaultAction` 时才合法。
- **`toWireSession` 占位投影**：只投影 index/metadata 字段，重型字段用占位符（`agent_config:{model:''}`、`usage` 全零）——与 v1 字节级对齐；`busy`/`last_turn_reason` 由 `resolveSessionFacts`（`ISessionActivityView`）投影为真实值。
- **主 agent 惰性实体化**（transport/mainAgent.ts）：会话创建时不建 main agent，首个请求定位到 `main` 时才 `ensureMainAgent`；主 agent 出生即"未绑定"（无 Profile/Model），由 `profile:setModel`、prompt 的 `body.model` 覆盖或恢复 wire log 时绑定——**有意不内置默认模型**。
- **v2 sessions 分页**：`page_token` = base64url JSON（版本 + sha256 查询条件指纹 + keyset 位置），条件翻转 → `40922`。
- **fs 路由**：`fs:read` 支持 HTTP Range 头断点读；draft-session 回退（无 session id 时让 `@` 文件提及可用）；一等公民 `POST /workspace/fs:search`。

## 5.9 kosong："空"——最薄的 LLM 抽象

kosong（马来语/印尼语的"空"）自述 "The LLM abstraction layer for modern AI agent applications"。它只提供**一个尽可能薄而中立的对话生成抽象**，把重试策略、并发、预算管理、循环控制全部留给上层（agent-core 的 turn 循环）。

### 5.9.1 统一模型

- **`Message`**：`{ role, content: ContentPart[], toolCalls, toolCallId?, partial?, tools? }`。`tools` 只在 system 消息上有意义——**消息级工具声明**（`messages[].tools`）是动态加载工具的原语：顶层 `tools[]` 必须字节稳定以保 prompt cache，新工具用一条只含 `tools` 的 system 消息注入。
- **`ContentPart`**：`text`/`think`（带 `encrypted` 推理签名）/`image_url`/`audio_url`/`video_url`。
- **`ChatProvider`**：`generate(systemPrompt, tools, history, options)`；`withThinking(effort)`（浅拷贝换思考档位）；`withMaxCompletionTokens?`（浅拷贝 + 钳制，**不得替换 HTTP 客户端**——共享传输状态）；`uploadVideo?`。
- **`StreamedMessage`**：异步迭代 + 流结束后才填充的 `id`/`usage`/`finishReason`/`traceId`（`x-trace-id` 头，头一到就可用——断流也能归因）。
- **`FinishReason` 归一化**：`completed`/`tool_calls`/`truncated`/`filtered`/`paused`/`other`（`rawFinishReason` 保留原文作逃生舱）。
- **`UNKNOWN_CAPABILITY`**：冻结哨兵——未入目录的模型默认无视觉/思考/工具能力声明，宿主照常发请求让上游拒绝，而不是本地硬拦（能力表是提示不是强制）。

### 5.9.2 流式组装（generate.ts）

```
kosongGenerate(provider, system, wireTools, history, {signal, onMessagePart, onToolCall})
  ├─ 预检 signal.aborted → AbortError（不发请求）
  ├─ 剥离 deferred tools（顶层 tools[] 保字节稳定 → prompt cache；generate 是唯一剥离点）
  ├─ provider.generate() → StreamedMessage（adapter 转各厂商线格式）
  ├─ for await part：
  │     ├─ 解码统计：等待下一 part = serverDecodeMs；处理 part = clientConsumeMs
  │     ├─ onMessagePart(structuredClone)（宿主转发给 UI delta 回调）
  │     ├─ 并行工具路由：ToolCallPart.index → toolCallIndexMap → 直接追加到目标 call
  │     └─ 顺序合并兜底：mergeInPlace（Text+Text / Think+Think / ToolCall+ToolCallPart）
  ├─ 流尾：抛空响应（无 content 无 tool calls / 只有 think）→ APIEmptyResponseError
  └─ onToolCall 逐个回调（全部收齐后才触发，防并行参数交错导致半解析）
```

- **并行工具调用的防串扰**：OpenAI 系流式多工具时参数 delta 跨调用交错（tc0-header → tc1-header → tc0-args → tc1-args）。用 `ToolCallPart.index` 经 `toolCallIndexMap` 直接路由到已收编的 ToolCall，顺序合并只作 fallback；`_streamIndex` 在收编时剥掉，绝不落库。
- **`onToolCall` 延迟到流尾**：中途触发会把半解析参数交给工具调度器 → `toolParseError`。
- **abort 三处检查**：请求前、`provider.generate()` 返回后、每 part 间（`cancelStream` 尽力取消后抛 `AbortError`）。
- **错误分类是"协议知识"**：`insufficient_quota` 是 OpenAI 线自己的 429 语义——配额耗尽在充值前是确定性失败，**不能**归类为可重试限流，必须映射成 `APIProviderQuotaExhaustedError`；`Retry-After` 解析为 `retryAfterMs` 供上层优先遵循（服务端指令覆盖本地指数退避）。

### 5.9.3 五个 provider adapter

| adapter | 要点 |
|---|---|
| `kimi.ts` | 基于 OpenAI SDK；`max_tokens`/`max_completion_tokens` 归一化（推理模型两者共享预算，小 `max_tokens` 会拿到 200 空响应，故只发 `max_completion_tokens`）；`reasoning_content` 双向转换；`extra_body.thinking`；工具 id 64 上限消毒 |
| `openai-legacy.ts` | Chat Completions |
| `openai-responses.ts` | Responses API |
| `anthropic.ts` | 最复杂（1334 行）：`stop_reason` 映射表（`end_turn`→completed、`max_tokens`→truncated、`pause_turn`→paused、`refusal`→filtered）；`ThinkingBlockParam` 映射 think part（含签名/密文）；连续 user 消息合并（Anthropic 线不允许多条 user 连续）；`max_tokens` 是必填字段 |
| `google-genai.ts` | 兼 vertexai（同一构造器） |

- **`capability-registry`**：静态前缀表能力判定（Claude 按能力组而非版本族分组——Fable 与 Opus/Sonnet/Haiku 4 同组）；Kimi wire 恒返回 UNKNOWN（能力来自宿主 catalog）。
- **`catalog.ts`**：models.dev 风格目录——`reasoning_options` 里只有 `{type:'effort', values}` 能映射出思考档位（`toggle`/`budget_tokens` 不行），`'none'` 映射为 `offEffort`，有档位无开关的模型标 `alwaysThinking`；`status:'deprecated'` 导入时丢弃。
- **工具 ID 卫生**（tool-call-id.ts）：每家 provider 定义 `ToolCallIdPolicy`（Kimi 64 上限消毒、Anthropic/OpenAI 各自限制），请求构造时统一处理——同一个 id 会在用户消息里往返。

## 5.10 关键代码位置索引

### kap-server

| 位置 | 说明 |
|---|---|
| `src/start.ts:186` | `startServer` 组合根 |
| `src/start.ts:714` | `listenWithPortRetry`：port+1 步进 |
| `src/start.ts:522` | `handleUpgrade`：手工复刻 host/origin/bearer |
| `src/security/bindClassify.ts:90` | `classify` 绑定分级 |
| `src/protocol/envelope.ts:9` | 信封 schema |
| `src/protocol/error-codes.ts:17` | 数字错误码表 |
| `src/middleware/auth.ts:64` | 全局 bearer hook（防编码绕过 + fail-closed） |
| `src/middleware/defineRoute.ts:233` | 单点路由声明 |
| `src/routes/sessions.ts:257` | 会话 CRUD + `{tail}` 动作分发 |
| `src/routes/action-suffix.ts:44` | `parseActionSuffix`（lastIndexOf 容错） |
| `src/transport/ws/v1/wsConnectionV1.ts:101` | 连接对象：控制帧/背压/合并 |
| `src/transport/ws/v1/wsConnectionV1.ts:706` | `coalesceFrames` |
| `src/transport/ws/v1/sessionEventBroadcaster.ts:218` | 每会话单扇出点 |
| `src/transport/ws/v1/sessionEventBroadcaster.ts:1252` | `dispatch`：durable/volatile 分类 |
| `src/transport/ws/v1/sessionEventJournal.ts:75` | JSONL 日志（epoch/seq 恢复） |
| `src/transport/channelRegistry.ts:145` | `describeAllChannels` 自省 |
| `src/transport/dispatcher.ts:124` | 反射派发 |
| `src/transport/errors.ts:66` | Error2 → 信封码映射 |
| `src/services/transcript/transcriptService.ts:126` | transcript 所有者 |
| `src/services/transcript/transcriptService.ts:701` | `healTurnOps` 保守合并 |
| `src/services/legacyStatus/legacyStatus.ts` | v2 状态 → v1 phase 折叠 |
| `src/search/searchService.ts:1` | 全局搜索（generation 发布） |
| `src/transport/mainAgent.ts:1` | 主 agent 惰性实体化 |
| `src/transport/ws/v1/fsWatchBridge.ts:1` | 文件监视桥 |
| `src/transport/ws/v1/inFlightTurnTracker.ts:24` | 易失状态累加（step 相对 offset） |

### kosong

| 位置 | 说明 |
|---|---|
| `src/provider.ts:220` | `ChatProvider` 接口 |
| `src/generate.ts:87` | 流式组装主循环 |
| `src/generate.ts:317` | `flushPart`（`_streamIndex` 剥离） |
| `src/message.ts:171` | `mergeInPlace` |
| `src/message.ts:134` | `isToolDeclarationOnlyMessage` |
| `src/capability.ts:43` | `UNKNOWN_CAPABILITY` 哨兵 |
| `src/catalog.ts:68` | 目录 → 能力 + 思考档位 |
| `src/errors.ts:6` | 错误体系与可重试判定 |
| `src/providers/kimi.ts:46` | Kimi adapter |
| `src/providers/anthropic.ts` | Anthropic adapter（1334 行） |
| `src/providers/capability-registry.ts:1` | 静态能力前缀表 |
| `src/providers/tool-call-id.ts` | 工具调用 ID 消毒策略 |

## 5.11 本章小结

- kap-server 是 v2 引擎的"纯传输外壳"：不含 agent 逻辑，事件流核心是 per-session 串行派发链 + durable/volatile 二分（volatile 不落盘不可重放，durable 进 JSONL journal 跨重启单调）。
- 安全模型按绑定暴露等级渐进加固（loopback/lan/public），WS upgrade 手工复刻 host/origin/credential 检查。
- `/api/v1/debug` 是有意无白名单的反射 RPC 面——整个 scoped DI 注册表即公共契约（"注册的服务就是公共契约"的落地）。
- kosong 是最薄的 LLM 抽象：统一消息模型 + 流式 part 原地合并 + 并行工具 index 路由 + 归一化 FinishReason；刻意不含重试/预算/循环（那是引擎的事）；deferred 工具剥离保 prompt-cache 字节稳定。
