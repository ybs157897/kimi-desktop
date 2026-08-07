# 02 · agent-core-v2：DI × Scope 新架构 agent 引擎

> 调研对象：`packages/agent-core-v2`（约 10.6 万行 TS，src 下 16 个一级目录、~750 个文件）。
> 调研方式：静态阅读 + 子代理并行深挖；所有时序图为代码路径推演，未运行测试。
> 配套：本仓库根 `AGENTS.md`、`packages/agent-core-v2/AGENTS.md`（权威）、`docs/di.md`（DI 场景化教程）、`docs/service-design.md`（服务设计规则）。

## 1. 子系统定位与职责

### 1.1 一句话定位

`@moonshot-ai/agent-core-v2` 是 Kimi Code 的**第二代统一 agent 引擎**（"The unified agent engine for Kimi (v2 — DI Scope architecture)"），以「四层 `LifecycleScope` 作用域树 + L3 Fiber 单元层（Service/Feature）+ Ledger/Cascade 生命周期管理」为骨架，承载从 LLM 请求、回合循环、工具执行、权限审批，到会话/工作区/持久化/协议适配的全部核心能力。它是 kap-server（Kimi Code 服务器）背后的引擎，也是 `klient`（客户端 SDK）与 `kimi-inspect`（调试台）的契约来源。

### 1.2 在 Kimi Code 整体中的角色

```
apps/kimi-code (CLI/TUI) ── 走 node-sdk，不直接依赖 agent-core（v1 时代产物）
packages/kap-server ────── 服务器：REST + WS (/api/v1) + debug 反射面；引擎 = agent-core-v2
packages/klient ────────── 客户端 SDK：global.* / session(id).* / agent(id).*，zod 校验
packages/acp-server ────── ACP (Agent Client Protocol) 适配，也是 agent-core-v2 的消费者
packages/kimi-inspect ──── 调试台：workspace/session/agent 浏览器、per-scope Service 面板
```

- **引擎边界**：agent-core-v2 只提供"能力与生命周期"，**不提供传输**。REST/WS 由 kap-server 承担；引擎内 `app/gateway` 只是把 RPC 语义翻译成原生调用的边缘适配层（WS 扇出刻意留在 kap-server）。kap-server 的契约设计是"**注册的服务就是公共契约**"——`GET /api/v1/debug/channels` 反射出整个 scoped DI 注册表，通道按 `ScopeKind` 寻址，客户端动态加载方法面，没有静态白名单。
- **与 agent-core（v1）的关系**：同仓并存、仍在演进中的 WIP port（`AGENTS.md` 明示 "work-in-progress port of packages/agent-core"，配套 `plan/PLAN.md` 与 `GAP_ANALYSIS.md`）。v1 是"Agent/Session 门面 + in-process DI（`src/services/`）"；v2 把作用域提升为第一公民（App/Workspace/Session/Agent 四层拓扑由 `src/app/scopes.ts` 声明），会话/Agent 不再有 App 级门面，调用方必须组合 `ISessionIndex → IWorkspaceLifecycleService.handlerFor → workspace 的 sessionLifecycle`。二者共享磁盘布局（`workspaces.json`、`state.json`、`session_index.jsonl`），v1 TUI 与 v2 服务器可共存读写（workspace 注册表因此"无内存写缓存"）。
- **与 kap-server 的关系**：kap-server 依赖 `workspace:^` 引用 agent-core-v2，只 import 其公共面；`transport/mainAgent.ts` 直接 re-export `ensureMainAgent`/`MAIN_AGENT_ID`，实现"会话创建时没有 main agent，首次请求按需物化"。
- **与 kosong 的关系**：`src/kosong/` 是独立包 `packages/kosong`（v0.5.5）的 **DI-Scope 重构版**，不是依赖关系（agent-core-v2 不 import 外部 kosong 包）。见 §5.6。

### 1.3 四个作用域层

| 层 | 生命周期 | 代表服务 |
|---|---|---|
| `App`（app） | 进程级，`Scope.createApp` | bootstrap、config、workspace 注册表、`workspaceLifecycle`（handler 注册表）、feature manager、telemetry、auth |
| `Workspace`（workspace） | 每工作区一个 handler，**create-or-get、永不关闭**（随 App 级联销毁） | `workspaceContext`/`workspaceFs`/`workspaceGit`/`workspaceProcess`/`workspaceMcp`/`workspaceMcpConfig`/`workspaceSkillCatalog`/`workspaceToolPolicy`/`workspaceTrust`/`sessionLifecycle` |
| `Session`（session） | 会话开闭（create/resume/fork/close/delete/archive） | `agentLifecycle`、`sessionMetadata`、`sessionActivity`、`interaction`、`approval`、`question`、`sessionInit`、`subagent`、`btw`、`todo`、`terminal` |
| `Agent`（agent） | 每 agent（main/sub）一个，`wire.seal→restore→bind→activate` | `loop`、`prompt`、`llmRequester`、`contextMemory`、`toolRegistry`/`toolExecutor`、`permissionGate`、`profile`、`rpc`、`undo`、`fullCompaction` |

拓扑由模块副作用 `setScopeTopology(SCOPE_TOPOLOGY)` 声明（`app/scopes.ts:26`）；`Scope.createChild` 强校验 kind 必须严格大于父层（`_base/di/scope.ts:214-222`），同一 id 的子 scope 重复创建抛错。

## 2. 包/目录清单与依赖关系

### 2.1 包内目录清单（src/，文件数）

```
_base/        62  基础层：di（Scope/Fiber/Instantiation/Ledger/Cascade/Collection）、
                    state（defineState）、log、event、errors、contribution、utils
agent/       257  Agent 作用域全部能力：loop、prompt、llmRequester、contextMemory、
                    contextProjector、contextInjector、contextSize、toolRegistry、
                    toolActivation、toolExecutor、toolDedupe、toolSelect、toolResultTruncation、
                    userTool、permissionGate/Policy/Rules/Mode、toolApproval、toolPolicy、
                    profile、rpc、command、undo、fullCompaction、stepRetry、usage、
                    mcp、media、goal、swarm、task、externalHooks、systemReminder、tools/*（内置工具）
session/      71  Session 作用域：agentLifecycle、subagent、interaction、approval、question、
                    btw、todo、terminal、sessionInit、sessionMetadata、sessionActivity、
                    sessionContext、sessionSeed（workspace→session 适配）、sessionSkillCatalog、
                    sessionToolPolicy、sessionToolPolicyGate、sessionInstructions、mcp、cron、state
workspace/    56  Workspace 作用域：workspaceContext、workspaceFs、workspaceGit、
                    workspaceProcess、workspaceMcp、workspaceMcpConfig、workspaceDirs、
                    workspaceSkillCatalog、workspaceInstructions、workspaceToolPolicy、
                    workspaceTrust、sessionLifecycle（会话编排）、state
app/         181  App 作用域：bootstrap、config、event、state、telemetry、workspace、
                    workspaceLifecycle、workspaceSessions、sessionIndex、sessionExport、
                    sessionLegacy、kosongConfig、auth、authLegacy、web、edit、git、
                    plugin、capability、feature、flag、cron、task、gateway、mcpConfig、
                    agentProfileCatalog、skillCatalog、bashParser、externalHooksRunner、
                    hostFolderBrowser、projectLocalConfig、workspaceAliases、file、state
tool/          8  工具契约：toolContract、rule-match、path-access、args-validator、result-builder
mcpCore/      14  scope-agnostic MCP 客户端：types、client-stdio/http/sse、client-remote、
                    client-shared、connection-manager、config-schema、tool-naming、oauth/*
kosong/       59  LLM/供应商抽象（外部 kosong 包的 DI 重构）：contract/、protocol/、model/、
                    provider/、recordDiff
features/     16  Feature 单元（可插拔内置能力）：feature、featureRegistry、
                    featureAssembly、featureAssemblyService、plan/（首个 Feature）
persistence/  13  持久化：interface/（storage、appendLog、atomicDocument、query、blob）
                    与 backends/（node-fs、minidb、memory）
wire/         14  每个 Agent 的可重放状态机 + JSONL journal：wire、wireService、op、model、
                    record、types、errors、wireContribution、migration/*
os/           16  主机抽象：interface/（hostFileSystem、hostProcess、hostClock、hostFsWatch、
                    hostEnvironment、terminal）+ backends/node-local/*
debug/         9  调试反射面（kimi-inspect 用）
```

### 2.2 workspace 内部依赖（谁依赖谁）

```
packages/agent-core-v2
  ├─→ @moonshot-ai/kimi-code-oauth (workspace:^)   OAuth 令牌管理（mcpCore/oauth 与 kosong modelOAuth 用）
  ├─→ @moonshot-ai/minidb          (workspace:^)   嵌入式 JSON 文档库（persistence/backends/minidb 读模型）
  ├─→ @moonshot-ai/protocol        (workspace:^)   协议线类型（ToolInputDisplay 等）
  └─→ @moonshot-ai/tree-sitter-bash(workspace:^)   纯 TS bash 解析器（bashParser/应用）

被依赖方（均 workspace:^）：
  packages/kap-server ── 引擎本体（REST/WS 服务器）
  packages/klient ────── 契约驱动客户端（zod 校验 global/session/agent 面）
  packages/acp-server ── ACP 适配服务器
  packages/node-sdk ──── 公共 SDK/harness
  apps/kimi-code ─────── CLI/TUI（经 node-sdk 间接）
  apps/kimi-inspect ──── 调试台（反射 RPC 面）
```

重要外部依赖：`@anthropic-ai/sdk` / `@openai`（openai sdk）/ `@google/genai`（三个方言 SDK，仅 provider 基座内部使用）、`@modelcontextprotocol/sdk`（MCP 客户端）、`node-pty`（终端）、`chokidar`（文件 watch）、`ajv`（工具参数校验）、`zod`（所有 schema）、`linkedom`/`@mozilla/readability`（网页提取）、`undici`（HTTP）、`jimp`/`@jsquash/webp`（图片处理）、`socks`（代理）、`yazl`/`yauzl`（zip，会话导出）、`ulid`（id）、`smol-toml`（TOML）。

### 2.3 导入约定

包内用 `#/` 别名（`imports: {"#/*": "./src/*.ts"}`，package.json:29）跨域导入；`scripts/check-import-boundaries.mjs` 强制导入边界（不能越层反向依赖）。模块加载即注册（import = register）：`registerScopedService`/`registerConfigSection`/`registerAgentToolService`/`defineOp`/`defineModel`/`registerFeature`/`registerAgentProfile` 都是模块顶层副作用——因此 `index.ts` 全部是 re-export + 裸 `import`（655 行，几乎覆盖所有域 barrel）。

## 3. 模块结构与核心类型

### 3.1 `_base/di/` — DI Scope 内核（L0/L3）

- `scope.ts` — Scope 树与 scoped 服务注册表。`registerScopedService(scope, id, ctor, activation, domain)`（:54）写入进程级 `_scopedRegistry`；`createScopedChildHandle`/`Scope.createApp`/`createChild`（:134/:190/:212）是仅有的三个 scope 创建点：构造 ServiceCollection（`extra` seed 覆盖注册表）→ `createChild` → `watchScopeUnits`（物化该层的 `ScopeUnits(kind)` 记录）→ `options.assemble`（session seed 适配器挂钩点）→ `provideScopeServices`（把该 kind 全部注册作为**一个级联事务** `provideAll` 提交）→ 立即激活 `OnScopeCreated` 服务。激活失败整体 dispose 回滚。
- `service.ts` — `Service` 单元基类（extends Disposable）。能力都在 `this` 上：`provide`/`effect`/`on`/`get`/`ref` + `name`/`state`/`config`。**两阶段构造**：ctor 内 provide/on/effect 只是缓冲（get/ref 会抛错，依赖全部走构造参数装饰器）；内核在 `Reflect.construct` 后绑定运行时、按写入序 flush；手动 `new` 的实例任何能力调用都抛错。`extends Disposable` + NOTE 注释的服务（如 loop 的 `AgentLoopService`）同样是完全的 DI 单元。
- `fiber.ts` — Fiber 能力接口 + `FiberHandle`（thenable/state/uid/update/dispose）+ `ServiceRecipe` + **`FiberState` 五态机**（`Pending/Activating/Active/Unloading/Failed`）+ `ScopeUnits(kind)` 物化集合 token + `setFiberEventResolver`（字符串事件名解析挂钩，生产实现见 `app/event/fiberEventResolver.ts`）。
- `collection.ts` — `collection<T>(name)` 贡献点 token：`provide(token, value)` 贡献，构造函数声明 token 参数收到 `CollectionView<T>`（items/records/增量 onDidChange）。可见性规则：**provider 的祖先与后代可见，兄弟子树不可见**；provider 死亡即撤回；集合边进依赖图供内省但永不进级联传染集。
- `cascadeEngine.ts` — 每容器一个的树级编排引擎：provide/unprovide/update 以事务运行（传染集来自持久依赖图 → abort hook → 全局逆拓扑拆除 → apply → 等待区重查到不动点 → 历史环）。依赖不满足的单元停在等待区，依赖到达后跨 scope 自动激活。`ondemand` 单元视为"可用"，消费者物化时传递拉取。
- `scopeUnits.ts` — 内核折叠：每个 scope 创建点在 eager 激活前跑 `watchScopeUnits(container, kind)`，把可见的每个 `ScopeUnits(kind)` 记录的 recipe 物化为单元（disposal 挂在提供者账上——**提供者死亡连坐拆掉整棵树的物化单元**）。
- `instantiation.ts` — `@ref(IX)` 装饰器工厂（`LiveRef<T>`：`current` 实时读 + `onDidChange` 可用性事件；观察不建绑定、不加图边）、`ScopeActivation`、`createDecorator`。
- `ledger`（`_base/lifecycle/ledger.ts`）— L0 双轨（sync/async disposable）效应记账，严格逆序串行拆除，reason 透传（`'scope-close'|'cascade'|'unload'`）；Scope/容器/单元全部锚在此。

### 3.2 `agent/loop/` — 回合/步骤驱动（主循环）

- `loop.ts` — 契约：`IAgentLoopService`（enqueue/run/cancel/status/tryAcquireQuiescence/settled/registerLoopErrorHandler/hooks）。`Turn`（id/state/signal/ready/result/cancel）、`Step`（id/state/signal/result/cancel）、`StepAssignment`、`EnqueueReceipt`、`LoopRunResult`（completed/failed/cancelled）、`LoopErrorContext`（含 `retry(request)` 闭包——恢复插件唯一的重新排队通道）、`LoopErrorHandler`（first-match wins）。
- `stepRequest.ts` — `StepRequest` 抽象：`id`(uuid)/`kind`/`mergeable`/`turnScoped`/`admission`（`newTurn|activeOrNewTurn|activeOrNextTurn|activeTurnOnly`）/状态机 `pending→materialized|aborted`。**惰性物化**：`resolveContextMessages()` 在 pop 时才调用，aborted 请求不触碰上下文（零污染、无需补偿 undo）。子类 `MessageStepRequest`（携带消息 + turnSeed）/`ContinuationStepRequest`（空消息，纯驱动下一轮）。
- `stepRequestQueue.ts` — 每 Turn 一个队列；`takeNextBatch()` 产出 `StepRequestBatch = {driver, merged[]}`——driver + 所有可合并请求折叠进同一 LLM 请求。
- `loopService.ts`（1221 行）— Turn FIFO + 每 Turn 一个 StepRequestQueue；admission 决定请求进活跃 turn/新 turn/standalone 队列。`run()` 一次跑完一个 turn 的所有 batch：`beginLoopStep`（batch 弹出、step 编号、`AbortSignal.any([turnSignal, stepSignal])`、**materializeBatch**）→ `executeLoopStep`（`onWillBeginStep` hooks → `llmRequester.start` → 流式 part → 工具执行 → `step.end`）→ `completeLoopStep`/`handleLoopStepError`（取消/恢复/失败三分支）。loop **自己从不 enqueue**，只跑请求和分发错误。`tryAcquireQuiescence`（:271）供 undo/compaction 在空闲窗口加锁（quiescence 期间新请求进 `heldAdmissions`）。纯数据状态（`nextReservedTurnId`/`lastRequestTraceId`/`disposing`）注册进 `IAgentStateService`；含资源的机制字段（AbortController/受控 promise/队列）留在实例。
- `turnOps.ts` — wire 侧 Turn 模型与 `promptTurn`/`steerTurn`/`cancelTurn`/`endTurn` Op；`turnEvents.ts` — `turn.started/ended` 事件与 PromptOrigin 显示判定。

### 3.3 `agent/llmRequester/` + `agent/contextMemory/` — 请求管线与上下文

- `llmRequesterService.ts`（849 行）— 每 turn 组装请求：`prepareTurnConfig`（turn 边界配置快照：resolved profile/systemPrompt/params，同一 turn 内重试共享）→ `resolveRequest`（模型目录取 requester、completion 预算折叠、工具列表 shape）→ `runRequest`（投影选择 + **降级重发链**：normal → media-degraded → media-stripped / strict，见 §5.5）→ 流式事件转发。`AgentLLMRequestFinish` = message/usage/model/providerFinishReason/traceId/timing。
- `contextMemory/contextOps.ts` — `ContextModel` + 5 个 Op：`append_message`/`append_loop_event`/`clear`/`apply_compaction`/`undo`。`computeUndoCut`（:308）撤销切割算法；`contextAppendMessage` 带 blob 编解码（dehydrate/rehydrate 把超大 data URI 搬运到 `blobref:`）。
- `contextMemory/loopEventFold.ts` — 把 `append_loop_event` 流（step.begin/content.part/tool.call/tool.result/step.end）**实时折叠**成 assistant/tool 消息（live 与 replay 共用同一归约，v1 磁盘格式字节兼容）。折叠上下文存 `WeakMap<stateArray, FoldCtx>`（并发还原不同 Agent 不串扰）。关键规则：`tool.result` 未闭合时 `append_message` 被 deferred（保证 assistant↔tool 邻接）；step.end 时为空且无 toolCalls 的 assistant 整体丢弃；被中断的 tool call 补 `<system>Tool execution was interrupted...` 错误消息。
- `contextMemory/compactionHandoff.ts` — 压缩落地形状：head/tail 用户消息保留（20k token 预算）、省略标记、legacy 兼容三态 union。
- `contextMemory/conversationTime.ts` — 会话时钟：`isUndoAnchor`（唯一 tick 谓词：user 消息 / user-slash 触发的 skill_activation、plugin_command）、`defineCheckpointedModel`（检查点模型工厂，经交叉 reducer 实现）、`CHECKPOINTED_MODELS` 注册表。
- `contextMemory/contextTranscript.ts` — 从 journal 重建**全量**显示历史的第二归约器（含被压缩掉的部分，供 `/messages`）。
- `contextProjector/contextProjectorService.ts` — 历史→wire 消息投影修复：openSlots 槽位机保证 tool 结果归位（assistant↔tool 邻接）、中断结果合成、孤儿 tool 结果丢弃、`projectStrict`（去重+合并连续 assistant+丢前导）；媒体降级投影（degradeOlderMediaParts 保留最近 2 个 / stripMediaPartsBySnapshot）。
- `contextInjector/contextInjectorService.ts` — 挂 `onWillBeginStep`，每 step 请求前注入 provider 输出（systemReminder 或 user 消息），`context.spliced` 事件做注入位置区间平移。
- `contextSize/` — `ContextModel` 测量 + 估算混合读数（`get(start,end)`）。
- `fullCompaction/fullCompactionService.ts`（900 行）+ `compactionOps.ts` — 全量压缩编排（见 §4.4）。
- `stepRetry/stepRetryService.ts` — loop 错误处理器：可重试错误（连接/超时/空响应/429/5xx）指数退避后 `retry(driver, {at:'head'})`，重试是**独立 step**（新 step.begin/end，占 maxSteps 预算）。

### 3.4 `agent/tool*` — 工具注册/执行/权限

- `tool/toolContract.ts` — 基础契约：`ExecutableTool<Input>`（`resolveExecution(input)` 是唯一入口）、`RunnableToolExecution`（`accesses`/`approvalRule`/`matchesRule`/`display`/`stopBatchAfterThis`/`execute`）、`ExecutableToolContext`（turnId/toolCallId/trace/signal/onUpdate/onForegroundTaskStart）、`ToolUpdate`（stdout/stderr/progress/status/custom）、`ToolAccesses`（`none/all/file(op,path,{recursive})` + `conflict()` 冲突语义：仅"至少一方写 + 路径重叠（同路径或 recursive 前缀）"才冲突，路径判定小写化+分隔符归一）、`isMcpToolName`（`mcp__` 前缀）。
- `toolRegistry/toolContribution.ts` — 双注册贡献表：`registerAgentToolService(id, ctor, {name, source, disclosure, when, domain})` = `registerScopedService(Agent, OnDemand)` + 模块贡献表 push。`AgentToolContribution` 是 `IAgentToolActivationService` 的 fold 记录（built-in 由 App 级 `builtinToolAssemblyService` 一次性提供；静态通道 `registerAgentToolService` 仍是模块表 + Agent 级 `OnDemand` 注册）。
- `toolActivation/toolActivationService.ts` — 激活一趟：`resolve(name)` 已存在跳过（幂等）→ profile 工具策略 `isToolActive` → `when(accessor)` → `accessor.get(id)`（此刻才构造工具实例）→ `registry.register`。订阅 `agent.status.updated`（profile 变更）重跑，**只增不删**。
- `toolRegistry/toolRegistryService.ts` — 每 Agent 运行时表 `Map<name, ExecutableTool>`；同名覆盖 + 引用守卫 disposable（过期 handle 不误删新工具）。
- `toolExecutor/toolExecutorService.ts`（985 行）— 总执行器：preflight（参数 JSON 解析/AJV zod 校验/ToolCallGuard/未加载描述器）→ 顺序 prepare（`resolveExecution` + **veto 事件** `onBeforeToolExecute` + waitUntil 就绪）→ `ToolScheduler` 冲突感知并发执行 → finalize（`onDidExecuteTool` hooks 可改写结果/置 stopTurn → `resultTruncation.truncateForModel`）→ 按**完成顺序** yield。
- `toolExecutor/beforeToolExecuteEvent.ts` — 两阶段 veto 事件：立即语句（`veto`（首个生效）/`allow`（终局）/`pass`（放行留 trace）/`waitUntil`（冷工厂，仅无人 veto/allow 后被调用）），`closeRegistration()` 后异步调用即抛。
- `toolExecutor/toolScheduler.ts` — `add` 时与 active/queued 冲突（`ToolAccesses.conflict`）则入队；`start` 链受控 promise，finish 时重扫整个队列批量启动不再阻塞的任务。Read 类工具天然并行，Bash/Write 同类串行。
- `permissionGate/permissionGateService.ts` — 注册为 veto listener，把 12 策略链的决策翻译成事件语句。
- `permissionPolicy/` — `permissionPolicyService.ts:46` 静态有序 12 策略链，首个非 undefined 胜出（见 §4.5）；`types.ts` 的 `PermissionPolicyResult` = `approve|deny|ask`（ask 带 resolveApproval/resolveError 续体回调）。
- `permissionRules/` — 用户规则表 + session 审批记忆：wire Model + 2 个 Op（`addPermissionRules` transient / `recordApprovalResult` persisted）；`matchesRule.ts` 的 `Tool(args)` pattern 解析 + picomatch 匹配 + 工具自带 `matchesRule` 主题谓词。
- `permissionMode/` — `manual/yolo/auto` 模式 wire 模型 + `permission.set_mode` Op + 模式 reminder 注入。
- `toolApproval/toolApprovalService.ts` — 审批往返：经 `session/approval` broker（interaction kernel kind='approval'），approved+session 作用域时记录工具 `approvalRule` 串；无 broker 自动批准。
- `toolPolicy/` — Profile × 全局 `[tools]` × Session denylist 三层求交（`isToolActiveComposed`），执行期装 ToolCallGuard 兜底（"schema 过滤可被绕过"的防护）。
- `toolSelect/` — 渐进式工具披露：`shapeTools`（deferred 标记）/`shapeHistory`（剥离未激活工具 schema）/`load`（schema 注入 contextMemory，**无独立持久化账本**，靠重折叠历史自愈）。
- `userTool/` — 宿主注册的用户工具：wire 持久化 + 经 interaction kernel 转发执行请求。
- `toolDedupe/toolDedupeService.ts` — 同 step 重复调用 veto 去重；跨 step 连续重复 3/5/8/12 档 system-reminder，12 次强制 stopTurn。
- `toolResultTruncation/` — 结果 >50k 字符落盘，2k 预览 + `output_path` 替代。

### 3.5 `session/` 与 `workspace/` — 生命周期

- `app/workspaceLifecycle/workspaceLifecycleService.ts` — Workspace handler 注册表 `Map<workspaceId, IWorkspaceScopeHandle>`；`handlerFor` 是 create-or-get + in-flight 单飞（别名拼写收敛同一 handler）；**handler 永不关闭**，随 App 级联销毁。App 层没有会话门面——调用方组合 `ISessionIndex → handlerFor → sessionLifecycle`。
- `workspace/sessionLifecycle/sessionLifecycleService.ts`（742 行）— 每 handler 的 Session 子 scope 注册表：create/resume/fork/close/delete/archive/restore；Session scope 用 `assembleSessionSeedAdapters`（`session/sessionSeed/sessionSeedAdapters.ts`）把 workspace 共享资源投影为纯数据 seed（skill catalog/AGENTS.md 快照/MCP 句柄/additionalDirs/tool veto），adapter 提供 live 读 + `onDidChange` 转发 + 上游重建时 re-fire；无 workspace 层的宿主（测试）返回 early 保留默认注册。fork 快照切片（`app/sessionStore/sessionSnapshotStoreService.ts`，按 user-visible turn 切片重写 main wire）。
- `session/agentLifecycle/agentLifecycleService.ts` — 扁平 agent 注册表（无父子嵌套，`forkedFrom` 仅溯源）：create-or-get（`creating` 表单飞）、restore（按持久化 meta）、fork、remove（优雅退出：stopAllOnExit → cancel turns → `loop.settled()` → extension.shutdown → dispose）。`doCreate` 时序：Agent scope 建立（seed `IAgentScopeContext` + 带 agent_id 的 telemetry 视图）→ `wire.seal()` → `registerAgent` metadata → onDidCreate → `wire.restore()` → `bindBootstrap`（profile.bind + 默认 permission mode）→ toolActivation.activate → extension.activate。
- `session/subagent/` — `runAgentTurn.ts` 纯函数（在目标 agent 上跑一轮 prompt，蒸馏 summary）；`mirrorAgentRun.ts` 请求方侧镜像（spawned/started/completed/failed 事件发到父代理记录流）。
- `session/interaction/interactionService.ts` — 阻塞式 HITL 内核（approval/question/user_tool 三类）：pending 集合、turn 结束自动取消、wire journal；`approvalService`/`questionService` 是其 typed facade。
- `session/btw/` — "顺带问一句"：fork 主代理成禁用工具的子代理。
- `session/sessionInit/` — `/init`：spawn coder 子代理生成 AGENTS.md，结果以 init 变体 system reminder 注入主代理。
- `session/sessionMetadata/` — `state.json` 原子文档（SESSION_META_VERSION=2）+ 串行 updateQueue + read-model 镜像。
- `session/sessionActivity/` — 会话级"在做什么"聚合（从各 agent 事件折叠，可随时重建）。
- `workspace/workspaceFs/` — `IWorkspaceFsService`：内容搜索/ripgrep/git status-diff，wire 形状 zod DTO；内部 `fsSearch.ts`/`runRg.ts`/`rgLocator.ts` 走 `ISessionProcessRunner` 跑 `rg`（不用 node 库，与宿主进程隔离）。**没有 apply_patch**——编辑走 `agent/tools/edit`（Edit 工具：TextModel CRLF 归一 + 唯一性/replace_all 三态规则）与 `agent/tools/os/write`。
- `workspace/workspaceGit/` — 每 handler 一个 git 服务（status/diff/gh pr view）；`workspaceTrust`/`workspaceToolPolicy`/`workspaceDirs`（`local.toml` 的 `workspace.additional_dir`）等见 §5。

### 3.6 `kosong/`、`mcpCore/`、`wire/`、`persistence/`、`features/`、`app/`

- 详见 §5 各小节与 §6 索引。要点：`kosong/` 四层（contract→protocol→model→provider）；`mcpCore/` 是 scope-agnostic 客户端（`MCPClient` = listTools/callTool/ping）；`wire/` 是每 Agent 的可重放状态机 + JSONL journal；`persistence/` 是四类访问模式存储；`features/` 是 Feature 单元；`app/` 是 App 作用域服务大杂烩。

### 3.7 `hooks.ts` — 生命周期钩子（跨域工具设施）

`OrderedHookSlot<TContext>`：`register(id, handler, {before|after})`（同 id 先删后插；before+after 同给报错）→ disposable；`run(ctx, terminal?)` 递归分发——每个 handler `(ctx, next(overrideCtx?))` 可 fork 上下文传给后续，走到头调 terminal。`createHooks(keys)` 批量建槽。**它不是"生命周期钩子"的意思**，而是链式责任链原语，被 loop（onWillBeginStep/onDidFinishStep）、toolExecutor（onDidExecuteTool）、wire（onDidRestore）、prompt（onBeforeSubmitPrompt）、sessionLifecycle（onWillCloseSession 等）、subagent 使用。真正的"生命周期钩子"（用户配置的 shell 命令钩子）在 `agent/externalHooks/` + `app/externalHooksRunner/`（Percy 风格外部钩子执行器）。

## 4. 关键数据流 / 状态机 / 时序

### 4.1 DI 单元生命周期（FiberState 五态机 + 级联）

```
                        ┌───────────── 传染集（依赖图可达闭包）─────────────┐
provide(unit) ──► 事务开始 ──► abort hook（veto）──► 全局逆拓扑 teardown
                        │  （卸载依赖此单元的单元）
                        ▼
                   apply 变更 ──► 等待区重查（依赖已满足的挂起单元自动激活）
                        │
                        ▼
                   FiberState: Pending → Activating → Active → Unloading → Failed
                        │             ▲              │           │
                        │             └── 依赖到达(跨 scope) ──┘           │
                        └── 构造失败 = sticky Failed（不自动重试；update() 重载；
                              解析 Failed 单元 rethrow 其错误；等待区单元自动激活）
```

- 静态与动态共享同一 provide 路径：scope 创建时该 kind 的**整批** `registerScopedService` 作为**一个**级联事务 `provideAll` 提交——全部 token 先注册再激活，注册顺序无关紧要；seed 占用某 token 即覆盖静态注册。

### 4.2 一个回合的完整时序（核心管线）

```
调用方（prompt 服务 / steer / 外部 hooks / goal 调度 / task 通知）
   │  new MessageStepRequest(msg) / ContinuationStepRequest / SteerStepRequest
   ▼  IAgentLoopService.enqueue(request, {at})          （admission 决定去向）
TurnJob.queue（StepRequestQueue）
   │  beginLoopStep → takeNextBatch() = {driver + merged[]}
   ▼
materializeBatch ──► 每个 request：onWillMaterialize → resolveContextMessages() → context.append()
   │                  （消息此刻才进 ContextModel；aborted 请求在此前被丢弃，上下文零污染）
   ▼
onWillBeginStep hooks（contextInjector 注入 / fullCompaction beforeStep / stepRetry 复位）
   ▼
llmRequester.start({source:{type:'turn',turnId,step}}, streamParts, signal)
   │  resolveRequest：turn 配置快照（systemPrompt/params 冻结）→ completion 预算折叠
   │                 → requester = modelCatalog.getRequester(alias) → messages = context.get()
   │                 → tools = toolSelect.shapeTools(toolRegistry.list())
   ▼
runRequest（投影 normal/media-degraded/media-stripped/strict 选择 + 降级重发循环）
   │  videoResolver.resolve（kimi-file:// 视频改写）→ logRequest/recordRequest
   │  for await (requester.request(...))：
   │      'part'   → onPart：loop 转 assistant.delta / thinking.delta / tool.call.delta 事件
   │      'usage'  → 暂存（finish 前最后一次覆盖）
   │      'finish' → 记录 message/traceId；'timing' → 暂存
   │  usage.record + contextSize.measured
   ▼
loop.executeLoopStep
   ├─ appendResponseContent：每个 content part → context.appendLoopEvent('content.part')（实时折入）
   ├─ executeStepTools：toolExecutor.execute(toolCalls) → 每结果 appendLoopEvent('tool.call'/'tool.result')
   │      stopTurn → finishReason='completed'（否则 'tool_calls' → 下一轮）
   └─ finishStep：appendLoopEvent('step.end') + turn.step.completed 事件（usage/timing/finishReason）
   ▼
onDidFinishStep hooks（fullCompaction afterStep / stepRetry 清失败计数）
   │  队列空 → turn 完成；onDidFinishStep 置 stopTurn → 提前结束
   ▼
releaseActiveTurn → wire.dispatch(endTurn) → turn.ended 事件 → telemetry → pumpTurns（下一个 Turn）
```

### 4.3 上下文折叠（loopEventFold，live 与 replay 同一路径）

```
step.begin ──► settleOpenStep（上一 step 未 settle 先补）──► 开 partial:true assistant
content.part / tool.call ──► 追加进打开的 assistant
tool.result ──► push tool 消息；pending 记账（非空时 append_message 被 deferred）
step.end ──► closePending（中断 tool call 补错误消息）
             ──► 无 toolCalls 且内容全 vacuous → 整条丢弃（否则违反 provider 消息校验）
             ──► 否则 partial 封口
clear / apply_compaction / undo ──► resetFold（折叠态清零）
```

### 4.4 全量压缩（fullCompaction）状态机与流程

```
wire CompactionModel：idle ⇄ running（begin/complete/cancel 三 Op；崩溃遗留 running 由 onDidRestore 归 idle）

触发：① auto：每 step 前 checkAutoCompaction（used ≥ max×triggerRatio(0.85) 或 used+reserved ≥ max）
     ② overflow：loop 错误处理器 recoverFromContextOverflow（CONTEXT_OVERFLOW | 413 且估算≥max×0.5）

begin(input)：_compacting 非空→false；reserveCompactionSlot（per-turn 计数，超 maxCompactionPerTurn 抛
              CONTEXT_OVERFLOW）；validate（历史非空 / manual 要求 loop idle）；wire begin → compactionWorker
compactionRound：
  1. hooks.onWillCompact
  2. 组装压缩专用请求（显式 messages=[history, user(instruction)]，maxOutputSize=min(max,128KiB)）
  3. collectSummary（truncated → CompactionTruncatedError；空 → APIEmptyResponseError）
  4. 失败分流：overflow → observeContextOverflow(估算×0.85) → shrink（0.7/0.5/0.35，≤3 次）重发；
     truncated/empty → 丢最旧消息（≤5 次）；retryable → 指数退避（≤5 次）
  5. historySafeToCompact：压缩期间历史被并发 append（引用变化）→ 取消压缩，绝不覆盖新输入
  6. postProcessSummary：追加当前 TODO List
  7. context.applyCompaction：buildContextCompactionShape ——
     真 user 消息按 20k token 预算选 head(≤2k)+tail（跨界消息尾部截断、前缀进 head 候选），
     中间插 elision system reminder；末尾追加 compaction_summary user 消息；
     injection/shell/task/cron/hook/retry/team 来源消息全部丢弃
     → wire apply_compaction + context_size.measured + context.spliced
  8. profile.refreshSystemPrompt → contextInjector.injectAfterCompaction
  9. wire full_compaction.complete → compaction.completed 事件
block（被 turn 阻塞时）：blockedByTurn=true，await active.promise；turn abort 级联压缩 abort
防抖：lastCompactedTokenCount —— 上下文没增长不重复压缩；每 turn 重置计数
```

### 4.5 工具调用：执行 + 权限决策链

```
LLM toolCalls[] → loop.executeStepTools → toolExecutor.execute(calls)
   [preflight] parse args（JSON 失败→{} + parseFailed）→ resolve（未找到→rejected 文案）
              → ToolCallGuard（toolPolicy 兜底）→ UnavailableToolDescriber（toolSelect）
              → AJV 参数校验（WeakMap 缓存 validator）
   [prepare×N 顺序] resolveExecution(args) ← 工具返回 accesses/approvalRule/matchesRule/execute
              → onBeforeToolExecute veto 事件 ← permissionGate 在此裁决：
                    deny    → event.veto(denyToolExecution(msg))
                    approve → event.pass(executionMetadata)
                    ask     → event.waitUntil(() => toolApproval.requestToolApproval(...))
                              （冷工厂：仅当所有 listener 未 veto/allow 后才弹审批 → 审批不发空枪）
              → onWillExecuteTool waitUntil（MCP 首载等就绪工作）
              → tool.call.started 事件 → task = {accesses, execute}
   [executeBatch] ToolScheduler：冲突（写-写/写-递归重叠）串行、不冲突并行；按完成顺序 yield
              → execute(ctx)：onUpdate → tool.progress 事件；raceWithAbortGrace（2s 宽限）
   [finalize] onDidExecuteTool hooks（可改写 result/置 stopTurn）→ stopTurn 三源 OR
            → resultTruncation.truncateForModel（>50k 落盘 + 2k 预览）
            → tool.result 事件 → telemetry tool_call（outcome/dup_type）
   loop：result.stopTurn → finishReason='completed'
```

12 策略静态链（首个非 undefined 胜出，`permissionPolicyService.ts:46`）：

```
1 auto-mode-ask-user-question-deny（auto 禁 AskUserQuestion）
2 user-configured-deny（turn-override/project/user 作用域）
3 auto-mode-approve
4 session-approval-history（"approve for session" 记忆 → 直接批）
5 user-configured-ask
6 user-configured-allow
7 sensitive-file-access-ask（.env/SSH key/密钥变体）
8 git-control-path-access-ask（.git/工作树控制文件）
9 yolo-mode-approve
10 default-tool-approve（内置白名单：Read/Grep/Glob/WebSearch/…）
11 git-cwd-write-approve（工作区 git 仓库内 Write/Edit）
12 fallback-ask（兜底问用户）
```

harness 约束（plan guard、swarm 批量互斥、btw deny、goal 护栏）**不混入权限链**，各自注册独立 veto listener——gate 只裁决"风险"，产品约束可独立演进。

### 4.6 会话与 Agent 生命周期时序

```
sessionLifecycle.create(opts)（workspace/sessionLifecycle/sessionLifecycleService.ts:257）
 ├─ assertCreateTargetAvailable（live/resuming/deleting/index 四表查重 → SESSION_ALREADY_EXISTS）
 ├─ workspaces.createOrTouch(workDir)（根必须存在）
 ├─ releaseDeletionTombstone
 ├─ materializeSession：
 │    sessionScope = bootstrap.sessionScope(wsId, sid)
 │    ISessionContext（cwd 创建时冻结）→ hostEnv.ready 屏障 → IWorkspaceFileSystem
 │    createScopedChildHandle(Session, sid, extra: sessionContextSeed +
 │         telemetry.withContext({sessionId}) + IWorkspaceFileSystem)
 │    ── 此刻同步构造全部 Session OnScopeCreated 服务（agentLifecycle/interaction/cron/metadata…）
 │    assembleSessionSeedAdapters（5 个 workspace→session 投影 adapter，经 assemble 钩子）
 │    等待 ready 门闩：metadata/toolPolicy/agentProfileCatalog 必须 await（fail-fast）；
 │    skillCatalog fire-and-forget；workspaceMcp 后台连接（seed handle.ready 由 LLM step 等）
 ├─ applyInitialMetadata → 主 agent：mainAgentBinding 指定 → agentLifecycle.create({agentId:'main'})
 ├─ appendSessionIndexEntry（v1 兼容 session_index.jsonl）→ sessions.set → announceCreated
 └─ 失败回滚：sessions.delete → drainAgents → handle.dispose → snapshots.delete

agentLifecycle.doCreate（session/agentLifecycle/agentLifecycleService.ts:179）
 ├─ mcpReady = sessionMcp.ensureMcpReady()（并行）
 ├─ createScopedChildHandle(Agent, agentId, extra: IAgentScopeContext + telemetry.agent_id 视图)
 ├─ handles.set（此刻起 get() 可见，in-flight）→ wire.seal()（写 metadata 信封）
 ├─ sessionMetadata.registerAgent（幂等 no-op，resume 不 bump updatedAt）→ onDidCreate.fire
 ├─ await mcpReady → wire.restore()（校验/迁移/重放/重写/再水合，见 §4.7）
 ├─ bindBootstrap（profile.bind(opts.binding)；默认 permission mode 仅无恢复值时）
 ├─ IAgentToolActivationService.activate() → IAgentExtensionService.activate()
 └─ 失败：handles.delete → dispose → onDidDispose → rethrow（绝不返回半成品）

sessionLifecycle.fork（:694）：源必须 live/indexed → flush 全部 live agent wire
 ├─ snapshots.fork：拷贝会话目录（跳过 state.json/logs/wire.jsonl）→ 无 turnIndex 整份复制；
 │   有 turnIndex → main wire 按第 N 个 user-visible turn 切片（sliceRecordsAtTurn），
 │   其他 agent 按 cutoffTime 截断；pruneAgentsWithMissingParents；drop tasks/cron 运行时状态
 ├─ materializeSession 目标 → targetMeta.update（title='Fork: <源>'/forkedFrom/lastPrompt）
 ├─ duplicateCronTasks（CRON_SESSION_TAG，cutoffTime 之后创建的跳过）→ 重建目标 agent
 └─ appendSessionIndexEntry → announceCreated({source:'fork'})
```

### 4.7 wire：dispatch 与 restore（每 Agent 一个可重放状态机）

```
live dispatch（wireService.ts:105）：
  重入保护：dispatching 中 → queue 挂起；dispatch 返回前排空（MAX_DRAIN=100，超限 CycleError）
  execute（:256）：apply(pure) → Object.freeze 新状态 → persist!==false → opToWireRecord
    → appendToJournal（blob dehydrate 异步链 persistQueue）→ toEvent 发布 IEventBus 事实
    → MODEL_CROSS_REDUCERS 跑其他模型的交叉 reducer（checkpointed model 机制的基础）

restore（:135）：
  逐条读 → isWireRecord / metadata 校验（畸形 → STORAGE_CORRUPTED）
  版本分支：无 metadata → v1.4 前日志（补 metadata + migrateV1_4ToV1_5）；
           更旧 → resolveWireMigrations 链式迁移（当前 WIRE_PROTOCOL_VERSION='1.5'）；
           更新版本 → 只读不重写、跳过未知记录
  replayRecord：OP_REGISTRY 查描述符 → zod schema 校验 → execute({silent:true})
               （不写 journal、不发 toEvent）；未知/畸形 → reportSkippedRecord 静默跳过
  若迁移过 → log.rewrite 原子重写整个 journal（"healing rewrite"）
  rehydrateModels：blobref: 引用 → 内联 data URI（仅存活状态）
  hooks.onDidRestore.run（MCP 发现日志冲刷、compaction 相位归一等）
```

### 4.8 undo（空闲态协调）

```
undo(turns)（undoService.ts:84）——串行队列 undoQueue
 ├─ loop.tryAcquireQuiescence()（有 active turn/挂起请求 → SESSION_BUSY）
 ├─ fullCompaction.compacting !== null → SESSION_BUSY
 ├─ assertUndoAvailable：precheckUndo（computeUndoCut 数锚点；遇 compaction_summary → 'compaction_boundary'）
 │    + checkpointDepth（CHECKPOINTED_MODELS 最小 checkpoints.length < turns → 'checkpoint_lost'）
 ├─ context.undo(turns)：computeUndoCut —— 从尾向前数 isUndoAnchor（user / user-slash skill/plugin），
 │    跳过 injection，遇 compaction_summary 停；每锚点连带切除 prompt-owned injection；
 │    dispatch context.undo（幂等）+ context_size.measured（前缀截断则重估）+ context.spliced
 ├─ wire.flush() → reconcileParticipants（checkpointed 模型自动回滚 current 到 checkpoint[count]）
 ├─ wire.flush() → reconcileLastPromptSafely（session metadata.lastPrompt 回写最近锚点）
 └─ telemetry conversation_undo + context.undone 事件
```

### 4.9 MCP 连接生命周期（mcpCore + workspaceMcp + agent/mcp）

```
workspaceMcpConfig（mcp.json 三级：用户/项目根/项目 + 插件贡献，fs-watch 刷新）
   ▼ 有效 server 集（含 enabled/disabledTools 过滤）
workspaceMcpService（Workspace scope，handler 物化时连接，增量 reconcile）
   └─ McpConnectionManager（mcpCore/connection-manager.ts，scope-agnostic）
        connectOne：attemptId 递增（陈旧守卫）→ createClient（stdio/http/sse 三种传输，
          官方 @modelcontextprotocol/sdk）→ connect + listTools（withTimeout startupTimeout）
        → connected + watchForUnexpectedClose；401 且可 OAuth → needs-auth；否则 failed（stderr 尾部）
        reconnectAndJoin：按 name 合并并发重连
   ▼ sessionHandle() → ISessionMcpHandle seed（普通会话 = 共享 manager 视图；
     临时 mcpServers 会话 = MergedMcpConnectionView 叠加 session-owned overlay）
   ▼ agent/mcp/mcpService.ts：mcp__<server>__<tool> 限定名（>64 字符 FNV-1a 哈希截断）
     注册进 toolRegistry（source:'mcp'）；needs-auth → 合成 mcp__<server>__authenticate 工具
     工具调用失败阶梯：不可恢复（abort/McpError/ZodError）→ 直抛；
     ConnectionClosed → 重连一次再试；疑似死 → probeMcpLiveness(5s ping) → 活则原地重试，
     死则重连后重试（at-least-once：传输在服务器处理后死亡会重复副作用，头注释明确接受）
OAuth（mcpCore/oauth/service.ts，RFC 9728/8414/7591）：一次性 localhost 回调监听 → 设 redirectUrl
  → 驱动 SDK auth() 产出授权 URL → complete 校验 state（防 CSRF）→ code 交换
  → 凭据存 <homeDir>/credentials/mcp/<name>-<sha256>.json（原子文档）
```

## 5. 重要实现细节（算法 / 设计权衡 / 边界）

### 5.1 DI 内核的"为什么"

1. **为什么四层作用域**：资源拥有者决定生命周期。workspace 资源（fs/git/MCP/技能目录）按 handler 加载一次、多会话共享、fs-watch 刷新；Session 资源（interaction/cron/metadata）随会话开闭；Agent 资源（loop/上下文/工具表）随 agent 生灭。`sessionSeedAdapters` 解决了"共享资源怎么安全注入会话"：projection 对象 getter 实时委托当前 upstream 代际，adapter 的 `onDidChange` 在代际切换时 re-fire——消费方永远读不到陈旧闭包；没有 workspace 层的测试宿主自动退化到默认 `extra` 注册。
2. **为什么静态与动态共用 provide 路径**：scope 创建把整批注册作为一个级联事务提交（`provideAll`），所有 token 先注册再激活——注册顺序无关紧要，untracked 的传递性 `createInstance` 解析在批内也能成功；`activateScopeServices` 被删除，eager 激活失败是 sticky `Failed` 单元而不是 scope 创建错误。
3. **为什么构造失败 sticky**：不自动重试（重试风暴）；`update()` 显式重载；解析 Failed 单元 rethrow 原错误——错误可见且可诊断。
4. **为什么 collection 贡献点**：把"一组同类贡献"声明为 token（`AgentToolContribution`/`WireModelContribution`/`ConfigSectionContribution`/`AgentProfileContribution`/`CommandContribution`），消费方拿 `CollectionView` 增量订阅；贡献记录对祖先/后代可见、兄弟不可见——这是"Feature 从 App 作用域向所有 Agent 作用域注入"的通道。
5. **为什么 Feature 连坐**：Feature 单元的所有贡献挂在它自己的账本上（`featureManager` 的 book），撤回 Feature 单元即撤回全树贡献（"连坐"）；`plan` 是第一个按此模式提取的内置 Feature（`features/plan/`：planService/planOps/enter-exit-plan-mode 工具/profile/config section）。
6. **为什么 wire 折叠走 collection 而不是静态表直读**：`WireModelContribution` 记录可动态撤回——撤回域的**历史记录**重放时落到通用 unknown-op 路径（skip + count），持久化事实保持可读；built-in 层（模块表）总是先折叠，撞码时 built-in 赢。静态通道（`defineOp`）的模块加载 fail-fast（`DuplicateOpError`）保留。
7. **快照安全纪律**：可快照的纯数据（state 键）注册进 `I{App,Workspace,Session,Agent}StateService`；含函数引用的机制字段（hook 槽、AbortController、受控 promise）留在实例字段。`snapshot()` 用 `toJsonSafe` 把自定义原型对象折叠为 `'(ClassName)'`——防止顺着服务引用把整个 DI 图拷到堆爆（kimi-inspect 轮询用）。

### 5.2 loop 的并发与容错

- **惰性物化是队列设计的前提**：消息只在 pop 时 append 进 ContextModel，aborted 请求被丢弃时上下文零污染，无需补偿性 undo；`mergeable` 请求（steer/task 通知）与 driver 折叠进同一 LLM 请求，省 token 省往返。
- **turn 快照**：`prepareTurnConfig` 冻结 systemPrompt/params，同一 turn 的重试共享配置——中途换配置不可复现。
- **错误处理链**：loop 自身不重试。step 失败 → 注册的 `LoopErrorHandler` 链（first-match wins）：stepRetry（可重试错误退避重排队首）、fullCompaction（context overflow 恢复）。handler 认领并处理成功 → 继续；未认领/未捕获 → 回合失败。错误分类在 `kosong/contract/errors.ts`：`isRetryableGenerateError` = 连接/超时/空响应/overloaded/`[408,409,429,500,502,503,504,529]`；quota_exhausted 与图片格式错**不可重试**。
- **abort 契约**：`generate()` 在每个 part 前后查 signal 并 `cancelStream`；错误转换器第一行必须 `throwIfAbortError`——用户取消永不被误分类为可重试 provider 错误；`isAbortError` 结构识别 OpenAI/Anthropic SDK 的 abort 形状。
- **maxSteps**：`loop_control.max_steps_per_turn`（env `KIMI_LOOP_MAX_STEPS_PER_TURN` 可覆盖），超限抛 `LOOP_MAX_STEPS_EXCEEDED`（configSection 有 deprecated key 迁移：`max_retries_per_step`→`max_attempts_per_step`、`max_steps_per_run`→`max_steps_per_turn`）。

### 5.3 工具的边界处理

- **abort 2 秒宽限**（`raceWithAbortGrace`）：abort 后不立即杀结果等待，先给工具 2s 自行收敛；用户手动取消与系统中止文案不同（用户取消明确指示模型"不要自动重试"）。
- **preflight 拒绝 ≠ 异常**：所有准备期失败转成 `isError` 合成结果，照常发布 `tool.call.started`/`tool.result`——模型可见、流不中断；运行期异常才在 executeBatch 直接 throw。
- **veto 窗口纪律**：`closeRegistration()` 后任何语句调用抛错，防止异步迟到 veto 被静默吞掉。
- **`stopBatchAfterThis`**：prepare 顺序 await，一旦声明则其后所有调用标 skipped；执行本身并发——"决定串行、运行并行"的折中。
- **冲突判定**：`ToolAccesses.conflict` 只对"写-写/写-递归重叠"冲突（读与读、读与写不冲突）——Read/Grep 天然并行，Bash/Write 同类串行；缺省 accesses 按 `all()` 处理（与一切冲突 → 串行，保守）。
- **工具参数校验**：AJV 按 `$schema` 自动选 draft-07/2019/2020，validator 按工具实例 WeakMap 缓存（编译一次、不泄漏实例）。
- **路径安全**：纯词法 canonicalize（不跟 symlink）；`isWithinDirectory` 要求分隔符前缀防 `/workspace-evil` 共享前缀逃逸；敏感文件判定含 `.env`/SSH key 及 `.bak/.key/.pem` 变体、豁免 `.env.example`/`id_rsa.pub`；`PathSecurityError` 的 message 直接作为工具输出。
- **去重**：同 step 重复调用 veto 占位（结果广播给所有副本）；跨 step 连续重复 3/5/8/12 档 reminder、12 次强制 stopTurn；step 边界把未决 deferred 全部 resolve 成 "original result was lost" 错误，防死锁。
- **结果截断双层**：工具内层 `ToolResultBuilder`（50k/2k 流式截断）；执行器外层 `toolResultTruncationService`（>50k 落盘 + 2k 预览 + `next_step: Use Read with output_path`）。

### 5.4 权限与审批

- **12 策略链的顺序是语义**：auto-deny 必须在 auto-approve 前、用户 deny 在用户 allow 前、session 审批记忆在 user-configured-ask 前（"已批准过"优先于"默认问"）。
- **waitUntil 冷工厂防空枪**：审批 UI 只在所有快速否决都放行后才弹出。
- **session 审批记忆是持久化 wire op**（`recordApprovalResult`），replay 后依然生效；用户 `[permission]` 规则是 transient（宿主 resume 时重供）。
- **规则匹配**：`Tool(args)` pattern → `parsePattern` 分纯名/带参；工具名 picomatch glob；带参时调用工具自带 `matchesRule` 主题谓词（`Bash("npm *")` 可匹配任意 npm 命令，`Bash("npm test")` 只匹配字面）；`!` 前缀取反。
- **三层工具可见性**：Profile（冻结于绑定）∩ 全局 `[tools]` ∩ Session denylist（原子文档 `state.json` 持久化、变更落盘后等全部 Agent 刷新 prompt）——activation 期（registry 有没有）+ 执行期 ToolCallGuard（preflight 兜底）+ 模型可见性（shapeTools 渐进披露）三层各自把关。
- **session denylist 空集语义**：显式空列表绝不禁用一切（`enabled` 空/缺省视为不约束）。

### 5.5 llmRequester 的降级重发链与 usage

- **投影降级**：413（too large）normal→media-degraded（旧媒体换文本占位、保留最近 2 个）→media-stripped（只剥快照内身份，新生成的恢复媒体保留）；图片格式错（400）→media-stripped；可恢复结构错（tool 邻接/角色交替/空文本块）→strict（去重+合并+丢前导）。恢复状态按 turnId 记录、跨 turn 清理——下一 turn 恢复全量媒体。`faultInjection` 可注入 413/图片格式错测这条链。
- **usage 合并**：单次请求 usage 事件是最终快照（finish 前一次）；跨请求 `usageService.record` 按 model/usageScope(turn/session) 累加（wire 持久化）；`currentTurn` 是 live-only 状态。
- **token 估算**：ASCII 4 字符/token + 非 ASCII 1 字符/token + 媒体 2000（`MEDIA_TOKEN_ESTIMATE`），per-message WeakMap 记忆化；`context_size.measured` 是 live-only Op（不持久化），resume 后从零靠后续测量补齐。
- **日志去重**：`logRequest` 按配置签名（provider/model/effort/systemPrompt hash/tools hash）只打一次；工具 schema 只首次 `llm.tools_snapshot` 落盘。
- **思考强度警告**：Anthropic 系模型 effort 不在支持集时按 (code,alias,model,effort,known) 去重 warn 一次，不阻断。

### 5.6 kosong（LLM 抽象层）的实现要点

- **与外部包的关系**：`src/kosong/` 是 `packages/kosong` 的分层重构——contract（纯类型+纯函数，与外部包逐行同构）、protocol（基座+trait 注册表，新增）、model（ModelService/Catalog/Requester，新增）、provider（供应商定义与组合）。外部包的 `createProvider` switch 硬编码 6 厂商 → v2 的 `ProviderDefinition` + `ProtocolAdapterRegistry` 注册表（外部包可注册新厂商）；**Kimi 不是协议也不是类**，而是 `(kimi, openai)` 与 `(kimi, anthropic)` 两条 pair 注册 + 两个 trait 对象。
- **ProtocolTrait**：16 个全可选 hook，管道型（convertMessage/mergeHistory/buildParams）按 trait 序链式（任一返回 null 即丢弃消息），单值型（convertTool/convertError/withThinking/cacheKey/extractUsage/reasoningKey…）last-declarer-wins；`composeOpenAIChatHooks` 折叠进基座 hook 集。
- **apiKey `''` 抑制技巧**：trait 声明 endpoint 但 config+env 链都无 key 时传 `''` 而非 undefined——压制基座构造器的 `OPENAI_API_KEY` 环境回退，组合厂商绝不静默捡到无关 key。
- **tool-call id 归一**：`[^a-zA-Z0-9_-]→_` 清洗 + 上限截断（Anthropic 64）+ 全历史一致重写 + `_2/_3` 后缀保唯一。
- **ReasoningKeyDialect**：入站按 `reasoning_content → reasoning_details → reasoning` 优先级探测并记住该 endpoint 实际说的方言，出站回显；显式配置永远优先。
- **窗口钳制**：`maxContextTokens - usedContextTokens` 钳制（floor 1）→ 模型族 ceiling 表 min；`usedContextTokens` 仅在未显式覆盖 messages 时传（压缩等显式消息请求不受当前上下文钳制——承重规则）。
- **401 刷新重放**：`runWithAuthRefresh` —— 可刷新 OAuth 下 401 强制刷新 + 恰好一次重放；重放仍 401 → `provider.auth_error`（"供应商拒绝了账户本身"，不误导重新登录）。
- **thinking 语义**：always_thinking 模型无条件钳制（'off' 任何 wire 上都不成立）；strict 校验只对 Kimi 原生 API，Kimi 走 anthropic 传输时宽松；keep 的 off 值集合 `0/false/no/off/none/null`。
- **提示缓存**：Anthropic 基座给 system/最后工具/最后消息末块打 `cache_control:{type:'ephemeral'}`；cacheKey 意图在 anthropic 编码为 `metadata.user_id`、Kimi 编码为 `prompt_cache_key`。

### 5.7 持久化（四类访问模式）

- **L0 字节层**：`IFileSystemStorageService` 只有 `write`（原子替换）与 `append`（有序追加）两个原语——append 建在 write 上是 O(n)，write 建在 append 上语义别扭，各实现各自最优。原子写 = tmp + fsync + rename + 目录 fsync（每进程每目录一次，Windows 跳过 + rename 前先 unlink）。
- **AppendLogStore（WAL 语义）**：每 (scope,key) 一个 LogState；`append` 同步入队 + microtask 合批；`read` 先 flush（read-your-writes）；torn 行容忍（末尾无换行残行静默丢弃，**中间**损坏抛 `AppendLogCorruptedError`）；**sticky failure**——flush 失败置位后后续 flush 全部立即 reject（不猜"是否已提交"，防重复写），唯一恢复是成功 rewrite；**cutoverEpoch** 版本号让 rewrite 与并发 append 交接不丢序（旧 drain 停止 splice）；`acquire/release` 引用计数归零后 retirement 交接。
- **AtomicDocumentStore**：每 (scope,key) 一个类型化值全量替换；JSON/TOML 双 codec。
- **QueryStore（minidb 后端）**：ClusterDb 16 shard、多进程读写（单 shard 单写者）；collection 编码为 `collection+NUL+key` 物理前缀；损坏 → 进程内一次性 rebuild；`LockError` 故意原样透传（不映射 `storage.locked`——那是"永久故障"信号）；checkpoint 供投影器重放。
- **写路径纪律（AGENTS.md 强制）**：业务域不实现持久化，只依赖按访问模式命名的 Store（`IAppendLogStore`/`IAtomicDocumentStore`/`IBlobStore`/`IQueryStore`）；禁止业务代码 `import 'node:fs'`。

### 5.8 配置分层

- **五份视图**：rawSnake（磁盘原样，round-trip）→ raw（camelCase，env-free）→ validated（schema 校验，env-free，永不改——env 退化时回落到文件值）→ effective（env 叠加后，每次现算）→ memory（进程内覆盖，get 优先）。分层：defaultValue → 用户 config.toml → env 绑定 → memory 覆盖；workspace 层不在 ConfigService（项目级在 `local.toml`）。
- **写路径**：merge → validate → **stripEnv**（env 绑定字段从 env-free 恢复，防 env 回声写回磁盘；stripped 后再 validate 一次防走私非法值）→ 原子 TOML 写盘 → rebuildEffective。
- **事件双粒度**：`onDidChangeConfiguration`（域被触达，无条件）vs `onDidSectionChange`（deepEqual 变化）。磁盘热重载：documentStore.watch → reload，字节相等跳过。
- **迁移**：`migrateThinkingEffortMaxToHigh` 用 `<home>/migrations-effort.json` 标记文件保证一次。

### 5.9 其它值得记录的权衡

- **workspace 注册表多进程安全**：无内存写缓存 + 每次 fresh read-modify-write + promise 链互斥——因为 v1 TUI 在另一进程并发写同一文件；丢失更新窗口压到单次 RMW，残留由 session-index merge 自愈。
- **fork 快照一致性**：指定 turnIndex 时禁止 active turn（不能切正在跑的 turn）；先 flush 全部 live agent wire 再拷贝。
- **删除的持久化意图**：`delete` 先写 pending 墓碑再动活状态；App 启动 reconcile 补做中断的删除——崩溃安全。
- **session metadata 幂等**：`registerAgent` 的 no-op 设计使 resume/fork 不 bump `updatedAt`。
- **interaction 的 DI 循环回避**：agentLifecycle 需要 interaction（turn 结束取消 pending），interaction 的 journal 需要 agentLifecycle——后者用 `invokeFunction` 在派发时懒解析。
- **undo 只能在 idle**：undo 是对已持久化 wire 日志的切分，运行中切分与后续 append 竞争无法保证一致；quiescence 期间新请求进 heldAdmissions，释放后按序补投。
- **压缩并发安全**：`historySafeToCompact` 逐引用比对（压缩期间用户新发消息 → 取消本次压缩，绝不覆盖新输入）；未阻塞 turn 的压缩失败不影响回合，被阻塞的失败使回合失败。
- **MCP 工具跨重连存活**：failed/pending 状态保留已注册工具——断线表现为慢调用而非 tool not found；工具名确定性（FNV-1a）保证重连稳定。
- **多 agent 事件聚合**：sessionActivity 只从各 agent event bus 折叠（attach 时 seed 一次），不持有权威状态，可随时重建；`activityEquals` 判重才 fire。

## 6. 关键代码位置索引

### 6.1 DI 内核（_base/di/）

- `_base/di/scope.ts:54` — `registerScopedService`：模块级 scoped 服务注册（import=register）
- `_base/di/scope.ts:134` — `createScopedChildHandle`：child scope 创建（watchScopeUnits→assemble→provideAll→激活）
- `_base/di/scope.ts:190` — `Scope.createApp`：App scope 唯一入口
- `_base/di/scope.ts:212` — `Scope.createChild`：kind 递增强校验 + 子注册进父 ledger
- `_base/di/service.ts:28` — `Service` 基类：两阶段构造（ctor 缓冲 / 运行时 flush）
- `_base/di/fiber.ts:30` — `FiberState` 五态机与 `FiberHandle`
- `_base/di/fiber.ts:150` — `ScopeUnits(kind)`：per-scope 物化集合 token
- `_base/di/cascadeEngine.ts:31` — 级联引擎：provide/unprovide/update 事务、传染集、等待区
- `_base/di/collection.ts:30` — `collection<T>(name)`：贡献点 token 与 CollectionView
- `_base/di/scopeUnits.ts:20` — `watchScopeUnits`：scope 创建时的单元物化折叠
- `_base/di/instantiation.ts:50` — `@ref(IX)`/`LiveRef`：观察式依赖（无绑定无图边）
- `_base/di/instantiation.ts:69` — `createDecorator`：DI token 工厂（`$di$dependencies` 元数据）
- `_base/lifecycle/ledger.ts:20` — Ledger：双轨逆序拆除 + reason 透传
- `app/scopes.ts:12` — `LifecycleScope` 四层枚举与 `SCOPE_TOPOLOGY` 声明

### 6.2 主循环与请求管线（agent/）

- `agent/loop/loop.ts:98` — `Step`/`Turn`/`StepAssignment`/`LoopRunResult` 契约
- `agent/loop/loop.ts:138` — `IAgentLoopService` 全接口
- `agent/loop/loopService.ts:181` — `enqueue`：admission 分派 + heldAdmissions（quiescence）
- `agent/loop/loopService.ts:198` — `admit`：四种 admission 语义
- `agent/loop/loopService.ts:271` — `tryAcquireQuiescence`：空闲窗口锁
- `agent/loop/loopService.ts:610` — `run`：步骤主循环（begin/execute/complete/error 四段）
- `agent/loop/loopService.ts:662` — `beginLoopStep`：batch 弹出、step 编号、signal 合并
- `agent/loop/loopService.ts:785` — `materializeBatch`：**消息物化点**（append 进 ContextModel）
- `agent/loop/loopService.ts:802` — `executeLoopStep`：hook→llmRequester→流→工具→step.end
- `agent/loop/loopService.ts:909` — `executeStepTools`：工具执行与 tool.call/result 落盘
- `agent/loop/loopService.ts:1060` — `createStreamPartHandler`：流 part→delta 事件（text/think/function）
- `agent/loop/stepRequest.ts:40` — `StepRequest`：惰性物化契约与状态机
- `agent/loop/stepRequestQueue.ts:38` — `takeNextBatch`：driver+merged 折叠
- `agent/loop/turnOps.ts:20` — `promptTurn`/`steerTurn`/`cancelTurn`/`endTurn` wire Op
- `agent/prompt/promptService.ts:20` — prompt 调度器：active 槽 + FIFO + steer 转换
- `agent/llmRequester/llmRequesterService.ts:236` — `start`：返回 {trace, result}
- `agent/llmRequester/llmRequesterService.ts:332` — `runRequest`：投影选择 + 降级重发循环
- `agent/llmRequester/llmRequesterService.ts:449` — 降级判定（413→media-stripped 等）
- `agent/llmRequester/llmRequesterService.ts:582` — `resolveRequest`：turn 快照 + 预算折叠
- `agent/llmRequester/llmRequesterService.ts:621` — `getOrCreateTurnConfig`：turnId→配置缓存
- `agent/contextMemory/contextMemoryService.ts:65` — `append`；`:83` `undo`；`:97` `applyCompaction`
- `agent/contextMemory/contextOps.ts:113` — `ContextModel`（blob 编解码 + swarm reducer）
- `agent/contextMemory/contextOps.ts:308` — `computeUndoCut`：撤销切割算法
- `agent/contextMemory/loopEventFold.ts:144` — `foldLoopEvent`：五类事件归约
- `agent/contextMemory/compactionHandoff.ts:196` — `selectCompactionUserMessages`：head/tail 预算
- `agent/contextMemory/conversationTime.ts:13` — `isUndoAnchor`；`:44` `CHECKPOINTED_MODELS`；`:50` `defineCheckpointedModel`
- `agent/fullCompaction/fullCompactionService.ts:327` — `begin`；`:594` `compactionRound`；`:822` `historySafeToCompact`
- `agent/fullCompaction/compactionOps.ts:64` — `CompactionPhase` 状态机
- `agent/fullCompaction/strategy.ts:18` — 压缩默认配置（0.85/50k/3 次）
- `agent/stepRetry/stepRetryService.ts:84` — loop 错误处理器注册；`:120` `recover`
- `agent/undo/undoService.ts:84` — `undo`；`:124` `checkpointDepth`；`:144` `assertUndoAvailable`
- `agent/contextProjector/contextProjectorService.ts:396` — `project`（openSlots 槽位机）
- `agent/contextInjector/contextInjectorService.ts:53` — hook/事件挂载；`:143` `handleSplice`

### 6.3 工具与权限（agent/tool*、tool/、session/approval）

- `tool/toolContract.ts:78` — `RunnableToolExecution`（accesses/approvalRule/matchesRule）
- `tool/toolContract.ts:183` — `ToolAccesses.conflict` 冲突语义
- `tool/rule-match.ts:148` — `matchesGlobRuleSubject`；`:152` `matchesPathRuleSubject`
- `tool/path-access.ts:68` — 敏感文件判定；`:214` 分隔符前缀包含；`:289` 路径裁决
- `tool/args-validator.ts:83` — AJV 编译（draft 自动检测）
- `tool/result-builder.ts:58` — 工具内层流式截断（50k/2k）
- `agent/toolRegistry/toolContribution.ts:62` — `registerAgentToolService`：DI 双注册
- `agent/toolActivation/toolActivationService.ts:53` — 激活一趟
- `agent/toolRegistry/toolRegistryService.ts:33` — 运行时注册（引用守卫）
- `agent/toolExecutor/toolExecutorService.ts:184` — `execute` 主循环
- `agent/toolExecutor/toolExecutorService.ts:333` — `prepareToolCall`（resolveExecution+veto）
- `agent/toolExecutor/toolExecutorService.ts:443` — `executeBatch`（ToolScheduler 并发）
- `agent/toolExecutor/toolExecutorService.ts:595` — `finalizeToolResult`；`:898` `raceWithAbortGrace`
- `agent/toolExecutor/beforeToolExecuteEvent.ts:74` — veto/allow/pass/waitUntil 四语句
- `agent/toolExecutor/toolScheduler.ts:30` — 冲突感知调度器
- `agent/permissionGate/permissionGateService.ts:53` — `adjudicate`
- `agent/permissionPolicy/permissionPolicyService.ts:46` — 12 策略链
- `agent/permissionPolicy/policies/session-approval-history.ts:20` — 审批记忆直接批
- `agent/permissionRules/matchesRule.ts:31` — `parsePattern`；`:59` `matchPermissionRule`
- `agent/permissionRules/permissionRulesOps.ts:57` — `recordApprovalResult`（persisted）
- `agent/toolApproval/toolApprovalService.ts:101` — 审批往返；`:171` session 规则提取
- `agent/toolPolicy/evaluate.ts:66` — `isToolActiveComposed` 三层求交
- `session/sessionToolPolicy/sessionToolPolicyService.ts:69` — denylist 串行化替换
- `agent/toolSelect/toolSelectService.ts:104` — `shapeTools`；`:130` `load`
- `agent/toolDedupe/toolDedupeService.ts:290` — `checkToolCall`；`:353` `finalizeResult`
- `agent/toolResultTruncation/toolResultTruncationService.ts:42` — 50k 截断落盘
- `session/approval/approvalService.ts:22` — interaction kernel 审批请求

### 6.4 生命周期（app/、workspace/、session/）

- `app/workspaceLifecycle/workspaceLifecycleService.ts:35` — handler 注册表（create-or-get 单飞）
- `workspace/sessionLifecycle/sessionLifecycleService.ts:257` — `create` 完整管线
- `workspace/sessionLifecycle/sessionLifecycleService.ts:321` — `materializeSession` + ready 门闩
- `workspace/sessionLifecycle/sessionLifecycleService.ts:481` — `resume`；`:694` `fork`
- `workspace/sessionLifecycle/sessionLifecycleService.ts:596` — `doDelete`（意图先写）
- `session/sessionSeed/sessionSeedAdapters.ts:60` — 五个 workspace→session 投影 adapter
- `session/agentLifecycle/agentLifecycleService.ts:122` — `create`（create-or-get 单飞）
- `session/agentLifecycle/agentLifecycleService.ts:179` — `doCreate`（wire seal/restore/bind/activate）
- `session/agentLifecycle/agentLifecycleService.ts:313` — `remove`（优雅退出）
- `session/sessionMetadata/sessionMetadataService.ts:97` — `update`（串行队列+原子写）
- `session/interaction/interactionService.ts:94` — `cancelPendingForTurn`；`:111` `request`
- `session/subagent/runAgentTurn.ts:48` — 子代理回合；`:121` `awaitTurn`（不竞速取消）
- `session/sessionInit/sessionInitService.ts:64` — `/init` 全流程
- `session/sessionActivity/sessionActivityService.ts:143` — 活动聚合折叠
- `app/bootstrap/bootstrap.ts:97` — `resolveBootstrapOptions`（唯一 env 读取点）
- `app/bootstrap/bootstrap.ts:131` — 组合根（FileStorageService seed）

### 6.5 kosong / mcpCore / wire / persistence / features / app

- `kosong/contract/errors.ts:243` — `isRetryableGenerateError`；`:170` `createAbortError`；`:200` `throwIfAbortError`
- `kosong/contract/generate.ts:42` — `generate`：流合并/abort/空响应
- `kosong/contract/message.ts:96` — `mergeInPlace` 流式 delta 合并
- `kosong/model/modelRequesterImpl.ts:191` — `runWithAuthRefresh`（401 重放）
- `kosong/model/modelRequesterImpl.ts:229` — `buildStreamTiming`
- `kosong/model/completionBudget.ts:46` — 预算上限计算
- `kosong/model/catalogService.ts:316` — `buildModel` 单次装配
- `kosong/provider/protocolAdapterRegistry.ts:139` — `createChatProvider`（唯一构造点）
- `kosong/provider/bases/anthropic/anthropic.ts:858` — `generate` 意图覆盖序
- `kosong/provider/bases/openai/openaiHooks.ts:25` — trait hook 组合
- `kosong/provider/providers/kimi/kimi.contrib.ts:309` — Kimi 两条 pair 注册
- `mcpCore/types.ts:45` — `MCPClient` 契约（listTools/callTool/ping）
- `mcpCore/connection-manager.ts:267` — `connectOne`（attemptId 陈旧守卫）
- `mcpCore/connection-manager.ts:248` — `reconnectAndJoin`（并发重连合并）
- `mcpCore/oauth/service.ts:76` — `beginAuthorization`（RFC 9728 + state 校验）
- `mcpCore/client-stdio.ts:50` — stdio 传输（stderr 4KB 有界缓冲）
- `mcpCore/tool-naming.ts:11` — `mcp__<server>__<tool>` + FNV-1a 截断
- `workspace/workspaceMcp/workspaceMcp.ts:24` — `IWorkspaceMcpService`（sessionHandle/sessionOverlay）
- `agent/mcp/mcpService.ts:286` — MCP 工具注册 + 冲突检测
- `agent/mcp/tools/mcp.ts:82` — `retryAfterReconnect` 三级阶梯
- `wire/op.ts:104` — `defineOp`；`:62` `OP_REGISTRY`（DuplicateOpError）
- `wire/model.ts:69` — `defineModel`；`:48` `ModelBlobCodec`
- `wire/wireContribution.ts:30` — `WireModelContribution` collection + fold
- `wire/wireService.ts:105` — `dispatch`（MAX_DRAIN=100）；`:135` `restore`
- `wire/migration/migration.ts:17` — `WIRE_PROTOCOL_VERSION='1.5'`
- `persistence/interface/storage.ts:121` — `IFileSystemStorageService`（write/append 两原语）
- `persistence/interface/appendLogStore.ts:49` — `IAppendLogStore`
- `persistence/backends/node-fs/appendLogStore.ts:83` — torn-line 解码；`:100` rewrite（cutoverEpoch）
- `persistence/backends/node-fs/fileStorageService.ts:85` — 原子写+目录 fsync
- `persistence/backends/minidb/miniDbQueryStore.ts:120` — ClusterDb 16 shard
- `_base/state/stateRegistry.ts:37` — `defineState`；`:103` `snapshot`（toJsonSafe）
- `app/config/configService.ts:221` — ConfigService；`:265` `get`；`:297` `set`；`:357` `stripEnv`
- `app/event/eventBus.ts:25` — `DomainEventMap` 增广点；`app/event/eventBusService.ts:26` — 双发射
- `app/event/fiberEventResolver.ts:15` — 字符串事件名 → IEventBus 订阅（liveRef 等待）
- `features/feature.ts:24` — `Feature` 基类（contribute* 助手）
- `features/featureRegistry.ts:12` — `registerFeature` 模块表
- `features/featureAssemblyService.ts:16` — 装配所有 feature 进 manager
- `app/feature/featureManager.ts:24` — `IFeatureManager`（provideUnit/unprovideUnit/updateUnit）
- `app/gateway/gatewayService.ts:27` — RestGateway（RPC 语义翻译）
- `app/sessionLegacy/sessionLegacyService.ts:50` — v1 `updateProfile` 跨域翻译
- `app/edit/editService.ts:37` — 编辑三态规则（0 次/不唯一/替换）
- `app/git/gitService.ts:41` — git status/diff；`:126` gh pr view（60s TTL）
- `hooks.ts:40` — `OrderedHookSlot`；`:91` `run` 递归分发
- `errors.ts:80` — `ErrorCodes` 聚合（25 个域）；`_base/errors/serialize.ts:33` — MAX_CAUSE_DEPTH=8

## 7. 与其它子系统的接口

### 7.1 对外暴露面（`src/index.ts`，655 行）

全部是 re-export + 裸 import（import 副作用驱动注册）。分组：DI 内核（descriptors/errors/graph/instantiation/instantiationService/lifecycle/scope/serviceCollection/cascadeEngine/dependencyGraph/ledger/collection/fiber/service）、scopes、log、wire（wire/wireService/wireContribution/record/migration）、session（sessionLog/sessionMetadata/sessionActivity/sessionToolPolicy/sessionLifecycleHooks/externalHooks/interaction/approval/question/btw/sessionInit/sessionSwarm/sessionTodo/workspaceContext/sessionSkillCatalog/sessionAgentProfileCatalog/terminal/process/cron/subagent/agentLifecycle/mainAgent）、app（bootstrap/telemetry/config/state/event/task/cron/workspace/workspaceLifecycle/workspaceSessions/sessionIndex/sessionExport/sessionLegacy/gateway/projectLocalConfig/auth/authLegacy/web/edit/git/bashParser/externalHooksRunner/hostFolderBrowser/file/plugin/capability/feature/flag/mcpConfig/agentProfileCatalog/skillCatalog/kosongConfig）、workspace（workspaceDirs/workspaceSkillCatalog/workspaceAgentProfileLoader/workspaceInstructions/workspaceMcp/workspaceMcpConfig/workspaceFs/workspaceFsWatch/workspaceGit/workspaceProcess/workspaceToolPolicy/workspaceTrust/workspaceContext/state）、agent（loop/llmRequester/contextMemory/contextProjector/contextInjector/contextSize/tokenCounting/fullCompaction/stepRetry/undo/usage/toolExecutor/toolRegistry/toolActivation/userTool/toolDedupe/toolSelect/permission*/toolApproval/toolPolicy/profile/prompt/rpc/command/goal/swarm/task/externalHooks/agentsMdReminder/interruptionReminder/mcp/media/scopeContext/shellCommand/systemReminder/dateChange/blob）、tool（toolContract）、features（feature/featureAssembly/featureRegistry + plan 全家桶）、persistence（interface + node-fs/minidb/memory 后端）、os（interface + node-local 后端）、kosong（contract/model/protocol/provider 全部）、debug。

### 7.2 主要消费者

| 消费者 | 消费方式 |
|---|---|
| `kap-server` | `workspace:^`；`transport/channelRegistry` 反射整个 scoped DI 注册表为 RPC 通道（**服务即契约**）；`transport/mainAgent.ts` re-export `ensureMainAgent`/`MAIN_AGENT_ID`；`contract.ts` 子路径只供工具/测试 |
| `klient` | 契约驱动 facade：`global.*`/`session(id).*`/`agent(id).*`（zod 校验），RPC 契约来自 `agent/rpc/core-api.ts`（AgentAPI/SessionAPI + JsonValue 载荷） |
| `acp-server` | ACP 协议适配（stdio 驱动引擎会话） |
| `node-sdk` | 公共 SDK/harness（`workspace:^`） |
| `apps/kimi-code` | CLI/TUI（经 node-sdk 间接） |
| `apps/kimi-inspect` | `/api/v1/debug/*` 反射面：workspace/session/agent 浏览器、per-scope Service 面板、DI 单元视图（消费 `IFeatureManager.units()`、`IAgentStateService.snapshot()`） |
| `kimi-code-mini-bench` | 可运行示例（`link:` 依赖，独立 Vitest 项目） |

### 7.3 引擎内跨域接口风格

- **scoped 服务**：`createDecorator` token + `registerScopedService`，构造参数注入，跨域依赖显式声明（AGENTS.md 要求实现文件头注释列出跨域协作者）。
- **事件**：Agent 级 `IEventBus`（`DomainEventMap` 模块增广，`turn.*`/`tool.*`/`context.*`/`prompt.*` 等）；App 级 `IEventService`（进程级事实）。
- **wire 事实**：所有可重放状态变更走 `IWireService.dispatch`（journal 持久化），`toEvent` 派生事件——"事件是状态的投影"。
- **hooks（责任链）**：`hooks.ts` 的 OrderedHookSlot，跨域扩展点（loop 步骤钩子、工具执行钩子、会话关闭钩子、wire restore 钩子）。
- **state 键**：四作用域 `IStateService`，纯数据可快照（kimi-inspect/调试）。
- **遥测**：业务事件只走 `ITelemetryService.track2`（`app/telemetry/events.ts` 强制注册，编译器校验事件名与属性），agent_id 是 Agent 作用域 telemetry 视图的 ambient 身份。
- **错误**：`Error2` + 域自注册错误码（重复码即抛）+ `toErrorPayload`/`fromErrorPayload` 跨 RPC 序列化（cause 链 ≤8 层）。

### 7.4 磁盘布局（与 v1 共享）

```
<homeDir> = KIMI_CODE_HOME ?? ~/.kimi-code
├── workspaces.json              workspace 注册表（v1 共享，无写缓存多进程安全）
├── config.toml                  分层配置（v1/v2 共享）
├── store/session-deletions.jsonl  删除意图日志（last-record-wins）
├── sessions/<workspaceId>/<sessionId>/
│   ├── state.json               SessionMeta v2（原子文档）
│   ├── agents/<agentId>/wire.jsonl   每 agent 的 wire 追加日志（重放状态机）
│   └── logs/  plans/  tool-results/…
└── session_index.jsonl          v1 兼容发现索引（v2 写入，TUI/export 读取）
```
