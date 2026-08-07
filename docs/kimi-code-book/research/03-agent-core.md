# 03 · agent-core（旧架构 agent 核心）研究报告

> 分析对象：`packages/agent-core`（`@moonshot-ai/agent-core` v0.15.7，私有包）
> 规模：371 个 TS 源文件，约 6.9 万行
> 定位：Kimi Code 的"第一代统一 agent 引擎"，已被 `agent-core-v2` 取代主引擎地位，但仍作为 SDK / ACP / 迁移工具链的底层引擎存活。
> 本报告只读分析，未修改任何源文件。

---

## 1. 子系统定位与职责

### 1.1 在 Kimi Code 整体中的角色

`agent-core` 是 Kimi Code 历史上第一个"统一 agent 引擎"包（package.json 自述 *"The unified agent engine for Kimi"*）。它把 agent 运行时的全部要素收拢在一个包里：

- **Agent 本体**：`Agent` 类（`src/agent/index.ts`）—— 一个可独立运行的 agent 实例，聚合上下文、回合、工具、权限、规划、压缩、后台任务等 20 个子管理器；
- **无状态主循环**：`src/loop/` —— 回合（turn）/ 步（step）/ 工具调用批次的纯逻辑循环，不持有会话状态；
- **状态与持久化**：`src/session/` + `src/agent/records/` —— 会话生命周期、wire log 事件溯源式持久化、断点恢复（resume）；
- **宿主能力**：`src/rpc/`（进程内 RPC 契约）、`src/services/`（从 `@moonshot-ai/services` 合并进来的 21 个 `IXxxService` 服务契约与实现）、`src/di/`（VSCode 风格依赖注入容器）；
- **外部集成**：`src/mcp/`（MCP 客户端管理器）、`src/plugin/`（插件安装/清单/能力）、`src/skill/`（技能发现/解析/注册）、`src/tools/builtin/`（内置工具集）；
- **配置面**：`src/config/`（KimiConfig 全量 schema 与解析）、`src/profile/`（agent 档案 / agentfile）、`src/flags/`（实验特性开关）。

它不包含任何 UI：TUI、服务器、编辑器适配全部在包外（`apps/kimi-code`、`apps/vis`、`packages/pi-tui` 等）。包的出口（`src/index.ts`）刻意把"被服务端消费"作为一等公民：大量导出是给 `node-sdk`、`acp-adapter`、`apps/vis` 用的（wire record 类型、RPC 类型、图片压缩管线、logging）。

### 1.2 与 agent-core-v2 的关系：legacy 还是被替代？

**结论：agent-core 是旧架构（legacy），主引擎地位已被 agent-core-v2 取代，但绝非死代码**。证据链：

1. **主应用用 v2**：`apps/kimi-code/package.json` 依赖 `@moonshot-ai/agent-core-v2`（*"The unified agent engine for Kimi (v2 — DI Scope architecture)"*），**不依赖** `@moonshot-ai/agent-core`。
2. **agent-core 的现存消费者**（grep 全部 `package.json`）：
   - `packages/node-sdk`（**同时依赖 v1 与 v2** —— 兼容层，两份引擎共存）
   - `packages/acp-adapter`（ACP 适配器，仍跑 v1）
   - `apps/vis/server`（可视化服务端）
   - `packages/migration-legacy`（迁移工具链）
3. **v2 的架构升级点**：v2 引入了 `#/_base/di/scope`、`cascadeEngine`、`fiber`（ServiceRecipe / ScopeUnits）、`collection`、`wire`（wire record 框架化）等——即"DI Scope 架构"：把 v1 中 `Agent` 大类聚合的 20 个管理器，重构为按 scope 组织、由 DI 容器级联构建的服务体系。v1 的 `Agent` 构造器"一把梭"（见 `agent/index.ts:192` 的构造器），v2 则拆成 app/scopes 注册。
4. **两者还共享协议与 wire 兼容**：`agent/records` 的 `restoreAgentRecord` 明确处理 v2 引擎写入的 `profile.bind`、`tools.reset_active_tools` 等 record 类型（`agent/records/index.ts:51-78`），说明 v1 仍承担"用 v2 的会话文件恢复旧引擎"的兼容职责（`migration-legacy` 场景）。

一句话：**agent-core 是 v2 的"上一代内核"，负责 SDK 嵌入、ACP 与迁移场景；它定义的概念（loop 契约、wire record、RPC 面、Hook 语义）是 v2 的直接前身，读 v1 是理解 v2 的捷径。**

### 1.3 与 kaos / kosong / kap-server / protocol 的分工

- `@moonshot-ai/kaos`：OS 抽象层（`osEnv`、文件读写、进程、PTY），agent-core 通过 `Agent.kaos` 访问一切文件/环境能力；
- `@moonshot-ai/kosong`：**协议无关的模型对话原语**——`generate()`、`Message/ContentPart/Tool/TokenUsage` 类型、`ChatProvider` 接口、API 错误类（`APIStatusError`、`APIContextOverflowError`、`APIRequestTooLargeError`…）。agent-core 的 loop 以 `LLM` 接口包裹 kosong，`Agent.generate` 是包好的闭包（`agent/index.ts:288`）；
- `@moonshot-ai/protocol`：与 kap-server 的线上协议类型（`SessionWarning` 等），agent-core 仅做类型引用；
- `kap-server`：Kimi Code 的 WebSocket 服务器（"core 即 agent"），它跑在 **agent-core-v2** 之上——所以本包与 kap-server 没有直接运行时关系，但 `services/` 与 `rpc/` 的契约形状（ApprovalRequest/QuestionRequest）正是为服务器-客户端双端设计的。

---

## 2. 包/目录清单与依赖关系

### 2.1 workspace 内部依赖（agent-core 依赖谁）

| 依赖包 | 用途 |
|---|---|
| `@moonshot-ai/kaos` (workspace:^) | OS 抽象层：环境、文件、进程、PTY |
| `@moonshot-ai/kosong` (workspace:^) | 模型对话原语：generate/Message/Tool/错误类 |
| `@moonshot-ai/kimi-code-oauth` (workspace:^) | MCP 远程服务器 OAuth（`mcp/oauth/`） |
| `@moonshot-ai/protocol` (workspace:^) | 与服务器共享的协议类型 |

第三方关键依赖：`@modelcontextprotocol/sdk`（MCP 客户端）、`zod`（全量 schema）、`ajv`（工具参数校验）、`chokidar`、`node-pty`、`nunjucks`、`js-yaml`、`smol-toml`、`undici`、`proper-lockfile`、`ulid`、`jimp`+`@jsquash/webp`+`linkedom`+`@mozilla/readability`（图片/网页处理）、`socks`、`tar`/`yauzl`（插件 zip）。

**注意**：无任何运行时 DI 库、无 HTTP 框架——DI 容器手写（约 600 行），HTTP 走 `undici`。

### 2.2 谁依赖 agent-core（被依赖关系）

```
packages/node-sdk      -> @moonshot-ai/agent-core（+ agent-core-v2，双引擎兼容层）
packages/acp-adapter   -> @moonshot-ai/agent-core
apps/vis/server        -> @moonshot-ai/agent-core
packages/migration-legacy -> @moonshot-ai/agent-core（+ v2）
apps/kimi-code         -> @moonshot-ai/agent-core-v2（主引擎，不碰 v1）
apps/kimi-inspect      -> @moonshot-ai/agent-core-v2
packages/kap-server    -> @moonshot-ai/agent-core-v2
packages/klient        -> @moonshot-ai/agent-core-v2
packages/acp-server    -> @moonshot-ai/agent-core-v2
```

### 2.3 包内目录职责总览

```
packages/agent-core/src/
├── index.ts         包根 barrel：agent/session/rpc/config/flags/loop/di/services/…
├── agent/            Agent 类 + 20 个状态管理器（context/turn/tool/permission/plan/…）
│   ├── background/  后台任务（bash/子代理/question 三类任务，环形缓冲 + 磁盘 output.log）
│   ├── compaction/  全量压缩（FullCompaction）与 micro 压缩（已停用）、策略、握手
│   ├── config/      ConfigState：provider/model/thinking 等运行时配置快照
│   ├── context/     ContextMemory：历史消息状态机 + projector（消息投影）+ dynamic-tools
│   ├── cron/        CronManager：定时任务（主 agent 专有）
│   ├── goal/        GoalMode：目标模式生命周期/预算（v0.15 新增）
│   ├── injection/   系统提醒注入器（goal/plan/permission/todo/tools-diff）
│   ├── permission/  PermissionManager：策略链 + 审批 RPC + 会话级规则缓存
│   ├── plan/        PlanMode：计划模式（plan/*.md 文件）
│   ├── records/     事件溯源 wire log（JSONL 持久化 + 恢复）+ blob 存储
│   ├── replay/      面向 SDK 的"重放快照"（ReplayBuilder）
│   ├── skill/       SkillManager：技能激活/参数展开
│   ├── swarm/       SwarmMode：多代理蜂群模式开关
│   ├── tool/        ToolManager：内置/用户/MCP 三类工具注册、渐进披露
│   ├── turn/        TurnFlow：回合驱动（goal 驱动 / 单回合），与 loop 的桥
│   └── usage/       UsageRecorder：按模型聚合 token 用量
├── base/common/     VSCode 风格 Emitter/Event<T>（仅此一个文件，lifecycle 在 di/）
├── config/          KimiConfig zod schema、TOML 解析、迁移、merge、env 覆盖
├── di/              自研 DI 容器（createDecorator/InstantiationService/…）
├── flags/           实验特性开关（FLAG_DEFINITIONS + FlagResolver）
├── loop/            无状态 agent 主循环（runTurn/executeLoopStep/tool-call/…）
├── logging/         日志系统（RootLogger、会话日志 sink、诊断日志文件）
├── mcp/             MCP 连接管理器 + stdio/http/sse 客户端 + OAuth + 工具命名
├── plugin/          插件管理器（manifest 解析、GitHub/zip 安装、能力聚合）
├── profile/         agent 档案（agentfile YAML、系统提示渲染、插件段落）
├── rpc/             进程内 RPC：core-api（核心面）/ sdk-api（SDK 面）+ 类型化客户端
├── services/        21 个 IXxxService 契约与默认实现（merge 自 @moonshot-ai/services）
├── session/         Session 生命周期、子代理宿主、Hook 引擎、持久化 store
├── skill/           技能发现/解析/注册（SessionSkillRegistry）
├── tools/           工具基础设施：args-validator、store、builtin 工具集、支持管线
├── telemetry.ts     遥测客户端契约（noop 默认）
├── errors.ts        KimiError / ErrorCodes / makeErrorPayload
└── utils/           abort/promise/tokens/fs/xml-escape/hero-slug/… 通用工具
```

---

## 3. 模块结构与核心类型

### 3.1 `di/` —— 自研 VSCode 风格依赖注入容器（本项目特色）

设计动机（`di/README.md`）：**零运行时依赖**（约 600 行纯 TS）+ 与 VSCode `vs/platform/instantiation` 概念对齐。

核心概念表：

| 概念 | 位置 | 语义 |
|---|---|---|
| `createDecorator<T>(name)` | `di/instantiation.ts` | 铸出"品牌化可调用值"作为服务标识；**同名幂等**（同一 name 返回同一引用）；同时是构造器参数装饰器 |
| `SyncDescriptor<T>` | `di/descriptors.ts` | 包装 构造器 + 静态参数 + `supportsDelayedInstantiation` 标志 |
| `ServiceCollection` | `di/serviceCollection.ts` | 每容器一份 id → (descriptor\|实例) 的映射 |
| `InstantiationService` | `di/instantiationService.ts` | 运行时容器：解析、缓存、子容器、追踪、销毁 |
| `registerSingleton` | `di/extensions.ts` | 模块级全局注册表，bootstrap 时 `getSingletonServiceDescriptors()` 取回 |
| `Graph<T>` | `di/graph.ts` | 依赖子树，用于环检测 + 叶子优先构建 |
| `IDisposable/Disposable` | `di/lifecycle.ts` | 析构契约（DisposableStore/DisposableMap/RefCountedDisposable 等全家桶） |
| `TestInstantiationService` | `di/testInstantiationService.ts` | 仅测试子路径导出：`.get/.set/.stub` |

**注入模型**：构造器参数按序解析——非装饰静态参数在前、`@IFoo` 装饰的服务参数在后；`createInstance(Ctor, ...static)` 用 `GetLeadingNonServiceArgs` 推断静态前缀长度（`instantiationService.ts:251-281` 的 `_createInstance`）。

**延迟实例化（Proxy 魔法）**：`new SyncDescriptor(C, [], true)` 打开惰性路径（`instantiationService.ts:426-537`）：
- 首次 `accessor.get(IFoo)` 返回 `Proxy(Object.create(null))`，真实构造器**不执行**；
- Proxy 的 `get` trap：`onDid*`/`onWill*` 属性访问被"驻车"进 `LinkedList` 早监听器（`di/util/linkedList.ts`）；首个非事件属性访问触发 `GlobalIdleValue` 真正构造，随后重放驻车监听器；
- `getPrototypeOf` trap 返回真实 ctor 的 prototype，`instanceof` 可用；
- `set` trap 直通真实实例。
- 一个细节：惰性构造在**子容器**里完成（`child._globalGraphImplicitDependency = String(id)`），用于隐式依赖图边记录。

**环检测双保险**（`instantiationService.ts:283-394`）：
1. **图遍历（主）**：`_createAndCacheServiceInstance` 先用 `_util.getServiceDependencies` 构建完整 `@IFoo` 依赖子树（`Graph`），然后反复取 `roots()` 叶子优先构造；图卡死（非空无根）抛 `CyclicDependencyError`，`findCycleSlow()` 格式化 `A -> B -> A` 路径——**任何构造器体运行之前就能抓到环**；
2. **树级构造栈（防御）**：根容器持有 `_inProgress` 栈，抓构造器体内 `accessor.get` 互相回调产生的运行时环。

**生命周期**：`dispose()` 幂等；先深度优先销毁子容器，再按**逆构造序（LIFO）**销毁本容器缓存实例；惰性 Proxy 未进 `_constructionOrder` 的实例由 `_servicesToMaybeDispose` 兜底第二遍；仅 duck-typing 有 `dispose()` 的实例；销毁 Proxy 不会强制物化。

### 3.2 `loop/` —— 无状态主循环（核心契约）

设计原则（`loop/README.md`）：**loop 不持有会话、wire 传输、压缩执行、权限 UI、协议桥**——这些全是宿主层职责；loop 与宿主之间只通过窄接口通信。

| 文件 | 职责 |
|---|---|
| `types.ts` | `LoopHooks`（6 个阶段钩子）、`ExecutableTool`（`resolveExecution`）、`TurnResult`、`LoopStepStopReason`（`end_turn/max_tokens/tool_use/filtered/paused/unknown`） |
| `llm.ts` | `LLM` 接口：`systemPrompt/modelName/capability/chat()`；`LLMRequestTraceState`（traceId 捕获）；`LLMStreamTiming`（TTFT 拆分） |
| `events.ts` | 事件联合：`LoopRecordedEvent`（step.begin/end、content.part、tool.call/result——入转录本）与 `LoopLiveOnlyEvent`（text/thinking/tool.call delta、tool.progress、step.retrying、turn.interrupted——只直播）；`createLoopEventDispatcher` 双路分发 |
| `run-turn.ts` | 回合收敛：abort 安全点、maxSteps、usage 聚合、非工具停后的可选继续 |
| `turn-step.ts` | 单步：beforeStep 钩子、消息构造、`step.begin` 信封、LLM 调用、流式回调、工具批次交接、`step.end` 封印 |
| `tool-call.ts` | 工具调用批次生命周期：preflight 校验 → prepare 钩子 → `tool.call` 事件 → 调度执行 → `tool.result`（按 provider 顺序） |
| `tool-scheduler.ts` | 有状态调度器：**资源访问不冲突的任务可重叠执行，冲突任务按 provider 顺序串行** |
| `retry.ts` | 指数退避重试（500ms×2^n 封顶 32s、±25% 抖动、`Retry-After` 覆盖） |
| `tool-access.ts` | `ToolAccesses`：文件级读写/search 资源声明 + `conflict()` 判定（写-写/写-读冲突、路径前缀重叠） |
| `tool-args-parse.ts` | 工具参数 JSON 解析（失败降级 `{}`） |

**`LLM` 与 `ExecutableTool` 是宿主与 loop 的全部边界**：宿主提供 `buildMessages`、`buildTools`、`dispatchEvent`、`hooks`，loop 不 import 任何宿主实现。

### 3.3 `agent/` —— Agent 类与状态管理器

**`Agent`（`agent/index.ts:115`）** 是聚合根。构造器（`agent/index.ts:192-251`）把 20 个子系统一次性组装：

```ts
records / fullCompaction / microCompaction / context / config / turn /
injection / permission / planMode / swarmMode / usage / skills / tools /
background / cron(仅 main) / goal / replayBuilder
```

关键设计：
- **AGENTS.md 硬性规则**（`packages/agent-core/AGENTS.md`）：`Agent` 构造器不得强制要求 `Session`/`agentId`，只能把 `sessionId` 当请求配置提示——保证 Agent 可独立运行；
- **`Agent.generate` 是闭包包装**（`agent/index.ts:288-331`）：在 kosong `generate()` 前挂上 LLM 请求日志、请求记录（wire record）、认证解析（`modelProvider.resolveAuth`）；abort 预检避免记录未发出的请求；
- **`Agent.rpcMethods`**（`agent/index.ts:550-723`）：把全部 RPC 方法映射到内部管理器——`prompt/steer/cancel/undoHistory/setThinking/setPermission/setModel/enterPlan/beginCompaction/registerTool/activateSkill/activatePluginCommand/createGoal/getCronTasks/…`，这是 `rpc/core-api.ts` 的 `AgentAPI` 实现；
- **`toolSelectEnabled`**（`agent/index.ts:279-286`）：渐进工具披露的三门闸（模型能力 `dynamically_loaded_tools` ∧ `tool_use` ∧ `tool-select` 实验开关），所有披露逻辑的单一决策点；
- **`resume()`**（`agent/index.ts:533-548`）：replay wire → 后台任务/定时任务从磁盘装载 → 上下文/回合结束恢复。

**`TurnFlow`（`agent/turn/index.ts:139`）** 是回合的"宿主侧"编排（loose 于 `loop/runTurn`）：
- `prompt()` → `launch()`：分配单调 `turnId`、建 `AbortController`、`turnWorker`；
- `steer()`：**活跃回合或手动压缩期间缓冲**（`steerBuffer`），`onCompactionFinished` 重放；
- `cancel()`：以 `userCancellationReason()` 作为 `signal.reason` abort——这个 reason 一路传给工具，让模型能区分"用户主动打断"与"系统超时"；
- `turnWorker`（`agent/turn/index.ts:400`）：若有活跃 goal 则走 `driveGoal`（连续多回合驱动，每回合重新注入 GOAL_CONTINUATION_PROMPT 提示词），否则 `runOneTurn`；普通回合内模型 `CreateGoal` 也能交接到 goal 驱动；
- `runOneTurn`（`:567`）：resolvePromptMedia（本地视频上传）→ `context.appendUserMessage` → UserPromptSubmit 钩子（可 block）→ `runStepLoop` → `turn.ended` 事件；**永不 throw**，异常映射为 `cancelled/failed`；
- `runStepLoop`（`:808`）：调 `loop/runTurn`，并实现宿主侧全部 6 个钩子——`beforeStep`（microCompaction 检测[已禁用，类保留为 no-op]、fullCompaction、flush steer、注入器）、`afterStep`（usage 记账、compaction、goal 预算 stopTurn）、`shouldContinueAfterStop`（4 级继续决策：goal 预算硬顶 → steer 冲刷 → print 模式排空 → Stop 钩子一次续跑）、`prepareToolExecution`（同步去重）、`authorizeToolExecution`（权限）、`finalizeToolResult`（去重登记、PostToolUse 钩子、`budgetToolResultForModel` 预算裁剪）；
- **上下文溢出恢复**（`:1027-1053`）：`APIContextOverflowError` 或 413 → `fullCompaction.handleOverflowError` → `continue` 以压缩后上下文重试，最多 `maxOverflowCompactionAttempts`（默认 3）。

**`ContextMemory`（`agent/context/index.ts:52`）** 是会话历史状态机：
- 不变量：**历史尾部不得存在未闭合的工具调用交换**——`pendingToolResultIds` 记录尾部缺失的 tool result，后续消息进 `deferredMessages` 直到补齐（`agent/context/index.ts:48-51`）；
- `appendLoopEvent` 把 `tool.call`/`tool.result`/`step.end` 等事件折叠成 `ContextMessage`；
- 消息带 `origin`（`user/injection/retry/compaction_summary/shell_command/plugin_command/hook_result/system_trigger…`），决定 replay 是否可见、undo 是否可删、投影是否进请求；
- `undo(n)` 从尾部删到第 n 个真实用户输入，遇压缩摘要边界停；
- `applyCompaction`：保留用户消息（head+tail 双端选择，溢出时夹 elision 标记）+ user 角色摘要，兼容旧 wire 记录的恢复路径（`agent/context/index.ts:314-430`）；
- 投影：`projector.ts` 的 `project()` 处理媒体降级（`MEDIA_DEGRADE_KEEP_RECENT`）、孤儿 tool result 丢弃、`trimTrailingOpenToolExchange`；`strictMessages`（严格线规重排）、`mediaDegradedMessages`/`mediaStrippedMessages`（媒体投影）三个备选构建器供 loop 重发。

**`ToolManager`（`agent/tool/index.ts:48`）**：
- 三类工具注册表：`builtinTools`（Map）、`userTools`（SDK 注册）、`mcpTools`（按 server 分组，工具名 `mcp__<server>__<name>` 限定，`mcp/tool-naming.ts`）；
- `setActiveTools`：profile 工具白名单（`enabledTools`）+ MCP glob 模式（`mcpAccessPatterns`）+ denylist（`disabledTools`/`mcpDenyPatterns`）；
- `initializeBuiltinTools`（`:775`）：按能力/条件构造 ~25 个内置工具（Read/Write/Edit/Grep/Glob/Bash/ReadMediaFile/EnterPlanMode/ExitPlanMode/SelectTools/CreateGoal…/AskUserQuestion/TodoList/Task*/Cron*/Skill/Agent/AgentSwarm/WebSearch/FetchURL）；
- `loopTools` getter（`:956`）：**每步重读**（`buildTools: () => this.agent.tools.loopTools`），空表自愈、渐进披露过滤、`deferred` 标记（动态工具从出站顶层 `tools[]` 剥离，仅入可执行表）；
- `runShellCommand`（`!` 命令路径，`:142`）：复用 Bash 工具但**不启动回合**（claude-code `shouldQuery:false` 对齐）；
- MCP 工具注册处理碰撞（同 server/跨 server 重名丢弃并报事件）、`needs-auth` 时注册合成 `authenticate` 工具（`mcp/auth-tool.ts`）。

**`PermissionManager`（`agent/permission/index.ts:28`）**：
- 策略链（`policies/`）：多个 `PermissionPolicy` 顺序求值，首个命中者决定 `approve/deny/ask/result`；
- `ask` → `agent.rpc.requestApproval`（RPC 到宿主 UI）；无 RPC 时自动 approved（嵌入式无 UI 场景）；
- **会话级批准缓存**：`recordApprovalResult` 把 `scope:'session'` 的批准规则写入 `localSessionApprovalRulePatterns`，后续同规则工具免审；
- 子 agent 权限继承父级（`parent` 链），拒绝文案对 sub agent 更严厉（"don't retry, don't bypass"）。

**`FullCompaction`（`agent/compaction/full.ts:70`）**：
- 触发策略（`strategy.ts`）：`usedSize >= maxSize × triggerRatio(0.85)` 或触发保留区（`reservedContextSize` 50k）；`blockRatio` 同步阻塞；
- 溢出观测：`observeContextOverflow` 把 `估计请求 tokens × 0.85` 记为模型的实际上下文上限（`observedMaxContextTokensByModel`）；
- 压缩本身是**一次独立的 LLM 调用**（summarizer，自带重试、traceId），产物经 `context.applyCompaction` 落历史；
- 手动压缩禁止在有活跃回合时启动（`:191`），自动压缩在回合内 step 边界同步跑；
- 溢出恢复循环上限 `maxOverflowCompactionAttempts = 3`，超限抛 `CONTEXT_OVERFLOW`。

**`GoalMode`（`agent/goal/index.ts`）**：目标模式状态机——`active/paused/blocked/complete`（`complete` 瞬时态不落盘）；预算（token/turn/wall-clock）；`driveGoal` 驱动连续回合；`UpdateGoal` 工具是模型侧的控制面。

**`BackgroundManager`（`agent/background/index.ts`）**：三类任务（`ProcessBackgroundTask` bash、`AgentBackgroundTask` 子代理、`QuestionBackgroundTask`）；内存环形缓冲（1 MiB 上限）+ 磁盘 `output.log`（权威输出）；任务 `lost` 状态（重启后 reconcile 失联任务）；输出超限强制 SIGTERM→grace→SIGKILL。

**`CronManager`（`agent/cron/manager.ts`）**：主 agent 专有；任务持久化、到点 steer 通知；`CronCreate/CronList/CronDelete` 工具。

**`AgentRecords`（`agent/records/`）**：事件溯源 wire log（`wire.jsonl`，`AGENT_WIRE_PROTOCOL_VERSION` 版本化 + 迁移）；`logRecord` 写、`replay` 逐条 `restoreAgentRecord` 重建内存态（**恢复契约：不得发 UI 事件/调 LLM/执行工具**，`records/index.ts:22-31`）；`BlobStore` 存大块数据（图片原件）；`FileSystemAgentRecordPersistence` 用 proper-lockfile 加锁。

### 3.4 `rpc/` —— 进程内结构化 RPC（非 JSON-RPC over socket）

`rpc/client.ts:31` 的 `createRPC()` 是**同进程双端代理**：
- 两端各自 `createControlledPromise` 交换实现；
- `simulateNetwork`：`setTimeout(0)` + `JSON.stringify/parse` 往返——**强制参数/返回值可 JSON 序列化**，同时模拟异步网络边界（也让调用方无法传递非序列化引用）；
- `mapRpcFunction`：错误统一转 `KimiErrorPayload` 传输、对端还原抛出（`toKimiErrorPayload`/`fromKimiErrorPayload`）；
- `bindAllFunctions`：沿原型链收集并绑定全部方法。
- 类型面：`CoreAPI`（核心→SDK：agent 事件、审批、问题、工具回调）与 `SDKAPI`（SDK→核心：prompt/steer/cancel/setModel/…）两个方向，`RPCMethods<T>` 映射为 `(payload, options?: {signal}) => Promise<Return>`。

`core-api.ts` 定义了全部会话级 payload：`CreateSessionPayload`（workDir/model/thinking/permission/mcpServers/agentProfile…）、`ResumeSessionPayload`（replayTurnLimit）、`ExportSessionPayload`、`ForkSessionPayload`（turnIndex 截断）、`PromptPayload`、`RunShellCommandPayload`（commandId 关联流式输出）等。

### 3.5 `session/` —— 会话生命周期

`Session`（`session/index.ts:213`）：
- 拥有 `agents: Map<string, AgentEntry>`（main/sub 多 agent，惰性恢复 `Promise<ResumedAgent>`）、`McpConnectionManager`、`HookEngine`、`SessionSkillRegistry`、`SessionAgentProfileCatalog`；
- `createAgent({type:'sub'|'independent'|'main'}, …)`；`ensureAgentResumed`；
- `SessionSubagentHost`（`session/subagent-host.ts:151`）：子代理生成——profile 解析、模型绑定（`secondary-model` 实验）、2 小时默认超时、摘要最小长度 200 字符（不足触发一次续写回合）、侧通道问答（SIDE_QUESTION_SYSTEM_REMINDER）；
- `SubagentBatch`（`subagent-batch.ts`）：AgentSwarm 批量执行、并发上限 `resolveSwarmMaxConcurrency`；
- `HookEngine`（`session/hooks/`）：Claude Code 风格外部钩子——`runHook` spawn shell 命令、stdin 喂 JSON、exit code 2 = block、stdout JSON 结构化输出（`permissionDecision:'deny'` → block）、30s 默认超时、abort 传播；
- `SessionStore`（`session/store/session-store.ts`）：磁盘布局 `<home>/sessions/<workDirKey>/<sessionId>/`（workDir 哈希分桶）、`session-index.json` 索引、fork（cp 目录 + 截断）、export（zip + manifest）、proper-lockfile 并发保护；
- `provider-manager.ts`：`ModelProvider` 解析 provider 配置/认证。

### 3.6 `mcp/` —— MCP 集成

`McpConnectionManager`（`mcp/connection-manager.ts:129`）：
- 每会话一个，`connectAll` 并行连接所有 server，`Promise.allSettled` **失败隔离**（一个 server 崩溃不影响会话启动）；
- 状态机：`pending → connected | failed | needs-auth | disabled`，`onStatusChange` 通知 ToolManager 注册/注销工具；
- `attemptId` 机制防止过期连接尝试覆盖新状态（`isCurrent` 检查）；
- 三种传输客户端：`StdioMcpClient`（`@modelcontextprotocol/sdk` 包装，stderr 环形缓冲 4KiB 诊断、`executor:'kaos'` 预留未实现）、`HttpMcpClient`（Streamable HTTP）、`SseMcpClient`（legacy SSE）；
- 超时体系：`KIMI_MCP_STARTUP_TIMEOUT_MS` env → `[mcp] startup_timeout_ms` → 30s 默认；每 server `startupTimeoutMs` 最高优先；
- OAuth：`McpOAuthService` + 合成 `authenticate` 工具（`mcp/auth-tool.ts`），401 判定 `needs-auth`；
- 工具命名：`mcp__<server>__<name>`（`tool-naming.ts`），支持 `enabledTools`/`disabledTools` 名单；
- 配置来源：`mcp.json`（`config-loader.ts`，会话/用户两级 + 插件贡献）。

### 3.7 `plugin/` 与 `skill/`

**插件（`plugin/manager.ts:39`）**：
- 安装源：本地路径 / GitHub（`github-resolver.ts` 解析 tarball URL）/ zip URL；下载→解压→manifest 校验→拷入受管目录（`<kimiHomeDir>/plugins/<id>/`）；
- `parseManifest`（zod 校验）→ `PluginRecord`（id/root/enabled/source/capabilities）；
- 能力聚合：`enabledMcpServers()`（运行时改名 `plugin__<id>__<server>`）、`enabledHooks()`（注入 `KIMI_CODE_HOME`/`KIMI_PLUGIN_ROOT` env）、`enabledCommands()`（slash 命令，`commands.ts` 模板展开 `$ARGUMENTS`）、`enabledSessionStarts()`、`enabledSystemPrompts()`、`pluginSkillRoots()`、`pluginAgentRoots()`；
- `reload()` 返回 `{added, removed, errors}` 差异摘要；
- 特殊处理：`node` 命令 fallback（`__plugin_run_node` 隐藏子命令，单二进制分发无 node 时用）。

**技能（`skill/`）**：`discoverSkills`（scanner 扫描 project/user/extra/builtin 四级根）、`SessionSkillRegistry`（`registry.ts:26`，按名 + 按插件索引、`renderSkillPrompt` 参数展开 `$NAME`）、`parser.ts`（frontmatter 解析）、`SkillManager`（agent 侧激活：slash 激活/模型激活、参数展开后注入回合）。

### 3.8 `config/` 与 `profile/`

**config（`config/schema.ts`）**：`KimiConfigSchema` 是全配置的唯一真源（zod）——providers（6 种类型：anthropic/openai/kimi/google-genai/openai_responses/vertexai）、models（`ModelAlias`：maxContextSize/maxInputSize/capabilities/supportEfforts/thinking 相关/overrides 覆盖层）、thinking（enabled/effort/keep）、permission rules、hooks、loopControl（maxStepsPerTurn/maxRetriesPerStep/reservedContextSize/compactionTriggerRatio）、background、subagent、secondaryModel、mcp、image、modelCatalog、experimental、telemetry；`KimiConfigPatchSchema`（strict 局部补丁）。`model.ts` 的 `effectiveModelAlias` 做 Anthropic 档案推断与 maxInputSize 钳制。TOML 解析（`toml.ts`）+ migrations + merge + env 覆盖（`resolve.ts`）。

**profile（`profile/`）**：agent 档案（agentfile）——YAML schema（`RawAgentProfileSchema`：extends/name/systemPromptPath/tools/whenToUse/subagents/modelPreference）；`ResolvedAgentProfile` 渲染系统提示——模板经 `utils/render-prompt.ts`（nunjucks 全局唯一入口，`throwOnUndefined:true`）或 agentfile 的 `${var}` 纯替换（`profile/agentfile/from-file.ts:9` 明示非 nunjucks），注入 cwd/AGENTS.md/skills/plugin 段落；`SessionAgentProfileCatalog` 聚合内置 + `~/.agents/agents` + 项目 `.agents/agents` + 插件贡献。

### 3.9 `tools/` —— 工具基础设施（注册 → 校验 → 执行）

工具层分工：**声明 + 参数解析 + 可执行闭包**在 `tools/`，**调度/并发/权限钩子**在 `loop/tool-call.ts`，**装配/披露**在 `agent/tool/index.ts`。

**参数校验管线（重点机制）**：声明用 zod → 转换用 `toInputJsonSchema`（`tools/support/input-schema.ts:26`，zod v4 `toJSONSchema` 转 draft-07 input 视图，递归补 `additionalProperties:false` 保持对象闭合）→ 运行时用 **AJV**（`tools/args-validator.ts`）：
- 三个单例 Ajv 按方言分立（DRAFT_07 / DRAFT_2019 / DRAFT_2020），`ajvFor` 按 `$schema` 选择、缺失时嗅探专有关键字；
- 编译结果缓存在 `loop/tool-call.ts:61` 的 `WeakMap<ExecutableTool, ToolArgsValidator>`（随工具对象 GC 释放）；
- 已知边界：AJV 表达不了 zod `superRefine` 跨字段约束（如 Bash timeout 上限、AskUserQuestion 问题唯一性），这类校验手工补在 `execute` 内。

**路径安全策略**（`tools/policies/path-access.ts`）：纯词法规范化（不 follow symlink）、`isWithinDirectory` 强制分隔符边界防 `/workspace-evil` 共享前缀逃逸、`resolvePathAccess` 默认模式**越界绝对路径放行（仅标记 outsideWorkspace）、相对路径逃逸抛 `PathSecurityError`**；`sensitive.ts` 敏感文件检测（`.env`、`id_rsa` 及改名掩护变体，豁免 `.env.example`/`*.pub`），Read/Write/Edit 拒读写。

**内置工具全清单**（`agent/tool/index.ts:775` 注册，按能力/条件实例化）：

| 类别 | 工具 |
|---|---|
| 文件 | Read（1000 行/100KB 上限）、Write（递归建父目录）、Edit（replace_all、CRLF 视图转换）、Grep（rg 子进程）、Glob（`rg --files`，gitignore 感知）、ReadMediaFile（压缩/region 裁剪/full_resolution） |
| Shell | Bash（前台/后台/超时自动转后台，见 §5.3） |
| 规划 | EnterPlanMode / ExitPlanMode（写 plan/*.md）、select_tools（渐进披露原语，schema 以 `tools` 字段 system 消息注入 context） |
| 协作 | Agent（子代理）、AgentSwarm、AskUserQuestion（RPC 提问，支持 background）、Skill（递归深度上限 3） |
| 目标 | CreateGoal / GetGoal / UpdateGoal / SetGoalBudget（主 agent 专有） |
| 后台 | TodoList（ToolStore 持久化）、TaskList / TaskOutput / TaskStop（BackgroundManager 门面） |
| 定时 | CronCreate / CronList / CronDelete |
| Web | WebSearch / FetchURL（宿主经 `ToolServices` 注入实现才注册） |

**`resolveExecution(args)` 的设计**：同步解析并返回 `ToolExecution`——声明 `accesses`（驱动调度并发）、`display`、`approvalRule`+`matchesRule`（权限匹配）、惰性 `execute(ctx)` 闭包；**路径安全解析发生在 resolveExecution 阶段**（"批准前先看到将访问的路径"），实际 I/O 全在 execute 内。`select_tools` 特意不声明 accesses，默认 `ToolAccesses.all()` 全局串行。

**Web 宿主实现**（`tools/providers/`）：`LocalFetchURLProvider` 带完整 **SSRF 防护**——只允许 http(s)、IP 字面量查私网/回环/ULA 黑名单、DNS `lookup all` 检查每个解析地址、`pinnedLookup` 把连接固定到已校验地址集防 DNS rebinding；`MoonshotFetchURLProvider`/`MoonshotWebSearchProvider` 走 Moonshot 服务，失败降级本地。

**图片管线**（`tools/support/`）：jimp 编解码 + WebP WASM 解码、`MAX_IMAGE_EDGE_PX=2000`、JPEG 质量阶梯 [80,60,40,20] × 边长阶梯迭代压缩、`persistOriginalImage` **sha256 内容寻址**原图存档（1GiB 上限按 mtime 清扫）、`file-type.ts` magic bytes 嗅探、`detectFileType` 含 EXIF 方向。

### 3.10 `flags/`、`base/`、`utils/`、`logging/`、`services/`、`errors/`

**flags（`flags/registry.ts`）**：目前仅 2 个实验开关——`tool-select`（渐进工具披露）、`secondary-model`（子代理副模型）；`FlagResolver`（`resolver.ts`）优先级：`KIMI_CODE_EXPERIMENTAL_FLAG` 总开关 → 单 flag env → config `[experimental]` → registry 默认；纯同步、每次实时读 env（无缓存）。

**base/common**：VSCode 风格 `Emitter/Event<T>`（`base/common/event.ts:9-82`）——`Event<T>` 是函数类型 `(listener, thisArg?, disposables?) => IDisposable`，`Emitter.fire` 同步顺序调用、每个监听器经 `safelyCallListener` 包裹（异常进 `onUnexpectedError` 不影响兄弟）；命名空间工具 `once/map/filter/any/None`。与 `rpc` 的协议 `Event` 联合类型冲突，故顶层 barrel 只导出 `Emitter`，`Event<T>` 走子路径。

**utils/**：`abort.ts`（`UserCancellationError` name 保持 `'AbortError'` 但带 `userCancelled=true` 标记，作为 signal.reason 区分"用户取消"与"超时/系统中止"）、`tokens.ts`（字符启发式估算：ASCII 4 字符/token、CJK 1 字符/token，media part 固定 2000）、`promise.ts`（`timeoutOutcome`/`resettableTimeoutOutcome`，钳制 `MAX_TIMER_DELAY_MS` 防 Node 1ms 钳位）、`fs.ts`（`writeFileAtomicDurable`：tmp 写入+fsync → rename → 目录 fsync）、`per-id-json-store.ts`（每 id 一个 JSON 文件，idRegex 兼作路径穿越防护，静默丢弃坏 JSON）、`proxy.ts`（undici 代理装配：HTTP(S) 优先、SOCKS 自写 connector、`installGlobalProxyDispatcher` 启动一次性安装、子进程 env 大小写双写）、`completion-budget.ts`、`render-prompt.ts`（nunjucks 唯一入口，`throwOnUndefined:true`）、`xml-escape.ts`（三档转义）、`hero-slug.ts`（漫威/DC 名字表生成 `hero-hero-hero` slug）。

**logging/**：`RootLogger` 挂 `Symbol.for('kimi.logger.root')` 于 globalThis 晚绑定（未 configure 时静默 no-op）；`attachSession` 幂等合并（同 sessionId+dir refCount+1），会话日志 `<sessionDir>/logs/kimi-code.log`；`RotatingFileSink` 异步串行队列、批内 1000 行上限、每行 `fh.sync()`、按 `path.N` 轮转；格式化两级脱敏（键名匹配 13 类敏感名 + 原始值正则 `authorization: bearer xxx`）；**v1 故意不读 config.toml**，只吃 `KIMI_LOG_*` env。

**services/**（`services/AGENTS.md` 是硬规范）：定位为"上层门面"——services 可依赖 runtime（rpc/session/di），runtime 不得反向 import services；命名规范 `IXxxService = createDecorator('xxxService')`；每域 `<domain>.ts` 放契约、`<domain>Service.ts` 放实现，**实现文件底部 `registerSingleton(...)` 自注册**（import barrel 即触发副作用），延迟注册用 `InstantiationType.Delayed`（Proxy 惰性物化）；服务器引导用 `getSingletonServiceDescriptors()` 读全局注册表、`services.set(...)` 覆盖需要运行时参数的项。21 个服务一句话职责：

| 服务 | 一句话职责 |
|---|---|
| `IApprovalService` | 一次性反向 RPC broker：审批请求路由给等待方，`resolve(id, resp)` 结算 |
| `IConfigService` | 协议形状 `ConfigResponse` 整读整写 |
| `ICoreProcessService` | 跨进程 RPC 适配器：持有 `CoreRPC` 代理，`ready()` 等 KimiCore 构造完成 |
| `IEnvironmentService` | 已解析路径权威来源（homeDir/configPath/identity） |
| `IEventService` | 传输无关纯 pub-sub 总线（`publish` + `onDidPublish`），WS 扇出在 server 侧 |
| `IFileStore` | 文件上传存储（50MB 上限） |
| `IFsService` / `IFsSearchService` / `IFsGitService` / `IFsWatcher` | 会话作用域文件面 / 内容检索 / git 状态 / 变更订阅（防抖聚合） |
| `ILogService` | 进程内日志门面（实现驻 server 侧） |
| `IMcpService` | MCP 服务器列表/重启（状态映射） |
| `IMessageService` | 分页消息历史 + ContextMessage → 协议 Message 适配 |
| `IModelCatalogService` | 模型/提供商目录、默认模型、刷新 |
| `IOAuthService` | 设备码登录编排（每提供商单在途 flow） |
| `IPromptService` | Prompt 调度器：submit/list/steer/abort，合成 `prompt.completed/aborted` |
| `IQuestionService` | 一次性反向 RPC broker（同 approval，问题 id 扁平化回传） |
| `ISessionService` | 会话生命周期 + `onDidCreate/onDidClose` |
| `ISkillService` | 技能 list/activate（REST 版斜杠命令） |
| `ITaskService` | 后台任务面（kind/status 有损映射） |
| `ITerminalService` | 终端会话（NodePty 后端可注入） |
| `IToolService` | 只读工具目录 |
| `IWorkspaceRegistry` / `IWorkspaceFsService` | 工作区注册表 / 文件浏览 |
| `IAuthSummaryService` | 就绪探测单点（`GET /v1/auth` 载荷） |

**errors.ts 体系**：`KimiError` 唯一错误类（判别按 `code` 字符串而非 instanceof）；`ErrorCodes` 约 70 个 `domain.reason` 常量；`KIMI_ERROR_INFO` 元数据表（title/retryable/public/action，`satisfies` 保证穷尽）；`toKimiErrorPayload` 归一化任意错误（429→rate_limit、401→auth_error、**quota 耗尽 429 特判 api_error 防 swarm 重排队死循环**、HTML 错误体抽 `<title>`）；`KimiErrorPayload` 跨进程线格式**有意剔除 cause/stack**。

---

## 4. 关键数据流 / 状态机 / 时序

### 4.1 一回合（turn）完整时序：从用户输入到 `turn.ended`

```
宿主(Session/CLI)          Agent/TurnFlow                  loop (无状态)                  kosong/Provider
     │ prompt(input, origin)  │                                │                              │
     │───────────────────────>│ records.logRecord(turn.prompt) │                              │
     │                        │ launch(): turnId++, AbortController                           │
     │                        │ turnWorker → runOneTurn        │                              │
     │                        │ emit turn.started              │                              │
     │                        │ resolvePromptMedia(视频上传)     │                              │
     │                        │ context.appendUserMessage      │                              │
     │                        │ UserPromptSubmit 钩子(可block)  │                              │
     │                        │ runStepLoop:                   │                              │
     │                        │  mcp.waitForInitialLoad        │                              │
     │                        │  injection.injectGoal/工具diff  │                              │
     │                        │  ┌─── runTurn 循环 ───────────┐│                              │
     │                        │  │ beforeStep(compaction)     ││                              │
     │                        │  │ buildMessages(context投影)  ││                              │
     │                        │  │ dispatch step.begin ──────>││                              │
     │                        │  │ llm.chat(messages,tools)   ││──── generate() ─────────────>│
     │                        │  │   流式: text.delta/         ││  (流式回调 → 直播事件)        │
     │                        │  │   tool.call.delta (直播)    ││<── usage + toolCalls ────────│
     │                        │  │ recordUsage(回合聚合)       ││                              │
     │                        │  │ stop=tool_use?             ││                              │
     │                        │  │  preflight校验(参数/工具存在) ││                              │
     │                        │  │  prepare钩子(去重)           ││                              │
     │                        │  │  authorize钩子(权限/审批)    ││                              │
     │                        │  │  dispatch tool.call ──────>││                              │
     │                        │  │  ToolScheduler 执行         ││── execute(ctx) ─────────────>│
     │                        │  │    (冲突串行/无冲突并发)      ││  onUpdate → tool.progress     │
     │                        │  │  dispatch tool.result ────>││<── ExecutableToolResult ─────│
     │                        │  │  step.end 封印(usage)       ││                              │
     │                        │  │  afterStep(记账/compaction) ││                              │
     │                        │  │  继续 or shouldContinueAfterStop 决策(4级)                    │
     │                        │  └─── (最多 maxStepsPerTurn) ──┘│                              │
     │                        │ emit turn.ended(reason)        │                              │
     │<─── agent.status.updated/error 事件 ─────────────────────│                              │
```

要点：
- **loop 是纯函数式**：每步的输入是 `buildMessages()` 现取的快照 + `buildTools()` 现取的表格（工具表在 `beforeStep` **之后**求值，保证与消息同状态——beforeStep 可能触发压缩丢弃动态工具 schema）；
- **事件双路**：`LoopRecordedEvent`（step.begin/end、content.part、tool.call/result）先落转录本（`context.appendLoopEvent`）再直播；`LoopLiveOnlyEvent`（delta/progress/retrying）只直播，`safeEmitLive` 吞掉监听器异常；
- **工具批次按 provider 顺序落事件**：执行可乱序完成，但 `tool.result` 严格按 provider 顺序 await 分发（`tool-call.ts:168-178`），且每对 `tool.call` 必有配对 `tool.result`；
- **中断语义**：`turn.interrupted` 事件在 `step.begin` 存在而无 `step.end` 时仍正确报告；usage 在 `llm.chat` 返回后立即记账（工具执行中途 abort 不丢已耗 token）。

### 4.2 上下文状态机（ContextMemory）

```
                    ┌─────────────────────────────────────────────────┐
                    │ _history: ContextMessage[]                      │
                    │  [user][assistant(toolCalls)][tool][user]...    │
                    └─────────────────────────────────────────────────┘
      不变量: 尾部不得有未闭合工具交换 ── 尾部交换缺失的 result id 在 pendingToolResultIds
      新消息 → 若 pending 非空 → 进 deferredMessages，直到对应 tool.result 补齐
                     │
   appendUserMessage │ appendLoopEvent(tool.call/result/step.end) │ applyCompaction
   (origin 标记)      │ (折叠为 ContextMessage)                     │ (head+tail 保留+摘要)
                     ▼
            投影层 projector.ts（每次请求构建，不落盘）:
              project() ── 媒体降级(keep recent)、孤儿 tool result 丢弃、
                            尾部未闭合交换裁剪、动态工具 schema 剥离
              strictMessages ── 严格线规重排（闭合工具调用、合并连续 assistant）
              mediaDegradedMessages ── 旧媒体换文本标记
              mediaStrippedMessages ── 全部媒体换标记
```

`undo(n)`：从尾部倒删到第 n 个 `isRealUserInput`，遇 `compaction_summary` 边界停；`injection` origin 的消息不可撤销；删除会同步修 token 计数与 replay 构建器。

### 4.3 工具并发调度状态机（ToolScheduler）

```
             add(task) ──► 与 activeTasks + queuedTasks 冲突判定
                          ├─ 无冲突 ─► start(): 立即执行（可重叠）
                          └─ 冲突   ─► queuedTasks 排队
   完成(finish) ─► 从 activeTasks 移除 ─► startQueuedTasks():
             对每个排队任务重新判定（可能仍有冲突 → 留在队列）
   冲突判定: ToolAccesses.conflict ── 任一侧 kind='all' ⇒ 冲突
             文件访问: 写-写 / 写-读 冲突 ∧ 路径相同或递归前缀重叠
```

结果总是按 provider 顺序交付：`runToolCallBatch` 把每个 `scheduler.add()` 返回的 Promise 存入 `pendingResults` 数组，随后**按数组顺序 await**（执行早已并发，只是交付顺序被钉死）。

### 4.4 DI 容器解析状态机（InstantiationService）

```
   accessor.get(IFoo)
      │
      ├─ entry 是实例 ───────────────────────────────► 直接返回
      └─ entry 是 SyncDescriptor
           │ 根容器 _inProgress 已含 IFoo? ──► CyclicDependencyError(防御栈)
           ├─ 构建依赖图: DFS 展开 @IFoo 构造器的 @IDep 元数据
           │    (每节点记录 ctor 的 serviceDependencies)
           │    图边数 >1000 或 无根非空 ──► CyclicDependencyError(图检测, 构造前)
           ├─ 反复取 roots() 叶子优先 _createServiceInstanceWithOwner
           │    (非延迟: 入 _constructionOrder; 延迟: 造 Proxy + GlobalIdleValue)
           └─ 返回根 id 的实例
   dispose(): 子容器先销毁(深度优先) → 自身 _constructionOrder 逆序(LIFO)
              → _servicesToMaybeDispose 补漏(惰性物化实例) → 从父容器 _children 移除
```

### 4.5 MCP 服务器状态机

```
        connectAll(configs)                      reconnect(name)
             │                                        │
             ▼                                        ▼
   ┌─────────────────────────────────────────────────────────────┐
   │ pending ──连接+tools/list──► connected ──工具注册到 ToolManager│
   │    │                           │                            │
   │    │ 失败                      │ 401/OAuth 失效               │
   │    ▼                           ▼                            │
   │ failed                    needs-auth ──合成 authenticate 工具 │
   │    │                           │(浏览器流完成→reconnect)       │
   │    └────────────── 重试 ───────┘                            │
   │ disabled(enabled=false)/remove(name) ──► 注销工具            │
   └─────────────────────────────────────────────────────────────┘
   attemptId 递增: 过期 attempt 的连接结果被 isCurrent 丢弃, 不覆盖新状态
   并行连接, Promise.allSettled 失败隔离
```

### 4.6 Goal 驱动状态机

```
              createGoal / resumeGoal
                    ▼
   ┌────────► active ──驱动 driveGoal: 每回合注入 GOAL_CONTINUATION_PROMPT──┐
   │             │                                                          │
   │       模型调 UpdateGoal                                                │
   │        ├─ complete ──► 发完成事件, 记录清空(瞬时态, 不落盘) ──► 结束     │
   │        ├─ blocked ──► blocked(可 /goal resume) ──► 停止驱动             │
   │        └─ (未决定)  ──► 预算超限? ──► blocked ──► 停止; 否则继续下一回合   │
   │   用户 pauseGoal / 中断 abort / 运行时失败 ──► paused(可 resume)          │
   │   cancelGoal ──► 丢弃记录                                                │
   └── resume 时 normalizeAfterReplay: active 降级为 paused(磁盘上不可能在跑)   │
```

### 4.7 Wire record 事件溯源（持久化与恢复）

```
   运行期:  任意状态变更 ──logRecord──► wire.jsonl (JSONL 追加, proper-lockfile 锁)
            ├─ turn.prompt / turn.steer / turn.cancel
            ├─ context.append_message / append_loop_event / apply_compaction
            ├─ permission.set_mode / tools.set_active_tools / config.update
            ├─ usage.record / full_compaction.* / plan_mode.* / goal.*
            └─ mcp.tools_discovered(带 hash 去重)
   恢复期:  resume() ──replay──► 逐条 restoreAgentRecord() 重放
            契约: 只重建内存态, 不触发 UI 事件 / LLM / 工具 / 网络
            "用写它的同一方法恢复它" (permission.set_mode → permission.setMode)
   兼容:  wire 版本号迁移(AGENT_WIRE_PROTOCOL_VERSION) + v2 引擎 record
          类型映射(profile.bind → config.update + tools.set_active_tools)
```


---

## 5. 重要实现细节

### 5.1 容错与重试体系（三层防御）

1. **step 层**：`chatWithRetry`（`loop/retry.ts`）默认 10 次尝试（9 次重试），退避 `min(500ms × 2^n, 32s)` + 25% 抖动，服务端 `Retry-After` 覆盖本地退避；每步发 `step.retrying` 直播事件；`LLM.isRetryableError` 由 provider 决定哪些错可重试。
2. **消息投影重发**（`turn-step.ts:209-391`，本轮最精细的恢复机制）：
   - **413 请求体过大**（base64 媒体堆积，token 驱动压缩救不了）：`normal → media-degraded → media-stripped` 逐级降级重发，且**一旦某级成功，回合内后续 step 直接使用该投影**（避免每步重复被拒）；降级成功的标记（`mediaDegradedResendUsed`）回传给 `runTurn` 维持状态；
   - **图片格式被拒**（不知道哪张图有毒）：整体换文本标记重发一次——"唯一保证无毒的投影"；历史保留媒体，`<image path>` 包装让模型可重读；
   - **结构非法**（tool_use/tool_result 配对、空文本、角色不交替——严格 provider 会拒）：`buildMessagesStrict` 严格重建重发一次，仍被拒则大声报错（这是 wire 合规性缺口信号）。
3. **上下文溢出**（`turn/index.ts:1027`）：`APIContextOverflowError` 或 413+估计超窗 → 观测学习实际窗口（`observedMaxContextTokensByModel = 估计 × 0.85`）→ `handleOverflowError` 强制压缩 → `continue` 重试；连续 `maxOverflowCompactionAttempts=3` 次失败放弃并抛 `CONTEXT_OVERFLOW`。

### 5.2 工具执行的安全与信任边界

- **`coerceToolResult`**（`tool-call.ts:686`）：工具是任意 JS，返回值经信任边界校验——`null/undefined`、非对象、缺 `output` 字段一律转 `isError` 结果，保证 `tool.result` 事件永远配对合法；
- **`normalizeToolResult`**（`tool-call.ts:706`）：空输出替换为 `'Tool output is empty.'`；纯媒体无文本时前置文本说明；**`stopTurn`/`message` 是循环内私货，持久化时剥掉**，只保留 `note`（模型可见侧信道）与 `truncated`；
- **2 秒宽限超时**（`tool-call.ts:634`）：abort 后工具若无视 `AbortSignal` 不收敛，`raceExecuteWithGraceTimeout` 用 2s 哨兵兜底返回合成错误，回合不被挂死；
- **abort 文案区分**（`tool-call.ts:69`）：`isUserCancellation(signal.reason)` 时明确告诉模型"用户主动打断，不要自动重试"；
- **未执行工具调用**（`recordUnexecutedToolCalls`，`tool-call.ts:199`）：provider 流中断但响应仍带 toolCalls（参数可能截断）——**不执行但也不丢弃**：逐条记录并立即闭合合成错误结果，保持 wire 合法、不丢模型意图；
- **`stopBatchAfterThis`**：工具成功返回 `stopTurn` 后，同批次的后续调用全部跳过（`prepareSkippedToolCall`），但仍记录 `tool.call`+`tool.result` 配对。

### 5.3 后台任务与 Bash 生命周期

- 前台 Bash 超时**默认转后台**而非被杀（`bashAutoBackgroundOnTimeout` 默认 true）：任务重新武装后台超时，TUI 可 ctrl+b 接管；
- 输出三重通道：直播事件（`tool.progress`）→ 内存环形缓冲 1MiB（`/tasks` UI 用，可丢弃）→ 磁盘 `output.log`（权威、永不截断）；**16MiB 硬顶**：超限 SIGTERM→宽限→SIGKILL 强制终止，防磁盘/内存被失控命令打爆；
- 重启恢复：`reconcile()` 把"磁盘标记 running 但无存活进程"的任务标为 `lost` ghost 呈现；
- `!` 命令路径（`runShellCommand`）与模型调 Bash 的区别：**不启动回合**，输入输出以 `shell_command` origin 写入上下文。

### 5.4 渐进工具披露（select_tools / tool-select 实验）

三门闸：模型能力 `dynamically_loaded_tools` ∧ 模型声明 `tool_use` ∧ `tool-select` flag（`agent/index.ts:279`）。开启后：
- 顶层 `tools[]` 只含核心集 + `select_tools`，**MCP/延迟用户工具 schema 不进请求**（省 token、省请求体）；
- `select_tools` 把选中工具的完整 schema 以带 `tools` 字段的 system 消息注入 context → 下个 step 即可执行（`buildTools` 每步重读保证即时可派发）；
- 执行侧 `loopTools` 仍含全部动态工具（标记 `deferred:true`，kosong `generate()` 从出站 tools[] 剥离）；
- `missingToolMessage` 区分三种失败：可加载未加载（引导 select_tools）、已加载但 server 断线（勿重试）、已加载但已注销；
- 压缩/undo 后 `pendingLoadedDynamicTools` 清空（schema 消息随历史被折叠，模型需重新选择）。

### 5.5 会话级批准缓存与权限策略链

- 策略链按序求值，首个命中者决定；`ask` 走 RPC 审批，`approved + scope:'session'` 时把 `approvalRule` 记入 `localSessionApprovalRulePatterns`——同规则后续调用免审；规则可跨回合、跨子 agent（parent 链合并）；
- 无 `requestApproval` RPC 的嵌入式环境自动放行；
- 子 agent 的拒绝文案更严厉（"don't retry, don't bypass"），防止子代理无限重试同一被拒调用。

### 5.6 同进程 RPC 的"模拟网络"边界

`simulateNetwork`（`rpc/client.ts:38`）：`setTimeout(0)` + `JSON.stringify/parse` 往返。效果：
- 强制 payload/返回值 **JSON 可序列化**——跨进程序列化契约在进程内也被执行，杜绝引用泄漏；
- 天然的异步边界（调用方拿到的永远是拷贝）；
- 错误统一 `KimiErrorPayload` 线格式往返（无 cause/stack，`code` 判别）。

### 5.7 Hook 引擎（外部命令钩子）

- 触发点：`UserPromptSubmit`（可 block 回合）、`Stop`（回合结束可续跑一次）、`PreToolUse`/`PostToolUse`/`PostToolUseFailure`（fire-and-forget）、`PermissionRequest`/`PermissionResult`、`StopFailure`、`Interrupt`；
- 协议：spawn shell 命令，stdin 喂 JSON，**exit code 2 = block**，stdout JSON 结构化输出（`hookSpecificOutput.permissionDecision:'deny'` → block），30s 默认超时，`windowsHide` 防 Windows 弹窗；
- `fireAndForgetTrigger` 不阻塞主流程；`triggerBlock` 用于 Stop 钩子的同步阻断语义；
- 插件可贡献钩子（注入 `KIMI_CODE_HOME`/`KIMI_PLUGIN_ROOT` env 与插件根 cwd）。

### 5.8 流式时序与遥测归因

- `LLMStreamTiming` 把 TTFT 拆成 client 侧 `requestBuildMs` + server 侧 `serverFirstTokenMs`；解码窗口拆 `serverDecodeMs`（等包）+ `clientConsumeMs`（处理包）——慢回合可无解析 wire log 直接归因；
- traceId 链：`LLMRequestTraceState.capture` 从响应头 `x-trace-id`（Kimi/KFC 专属）捕获，失败尝试也提前捕获（`retry.ts:116`），随 `turn.ended`/`turn.interrupted`/`step.end` 事件上报；
- 请求日志（`llm-request-logger.ts`）对每个 LLM 请求打诊断日志 + 可选 wire record（`llm-request-recorder.ts`），日志省略 sessionId/agentId 上下文键防泄漏。

### 5.9 图片处理管线（压缩-持久化-回读闭环）

- 入口多路（CLI 粘贴/服务端上传/ACP），统一 `compressImageForModel`/`compressBase64ForModel`；
- 压缩永不留痕：`buildImageCompressionCaption` 生成"压缩了什么"的 `<system>` 说明，经 injection origin 注入（用户不可见但模型可见）；
- `persistOriginalImage` 把压缩前原图按 sha256 内容寻址存 `<sessionDir>/media-originals/`（1GiB 上限按 mtime 清扫）——模型事后可 `ReadMediaFile` 全分辨率回读；
- `cropImageForModel` 支持 region 裁剪读原图；MCP 工具结果管线用 `compressImageContentParts` 整表压缩并返回 caption；
- 格式门禁：`gateImageFormatParts` 在 prompt 入口把 provider 拒收格式（AVIF/HEIC）换文本通知——"最后一个漏斗"保证会话历史永不被有毒图片污染。

### 5.10 会话目录布局与并发安全

```
<kimiHomeDir>/
├── sessions/<workDirKey>/<sessionId>/     # workDir 哈希分桶
│   ├── wire.jsonl          # agent 事件溯源日志（records 持久化）
│   ├── session.json        # SessionMeta（agents/标题/时间戳）
│   ├── plans/<id>.md       # 计划文件
│   ├── tasks/<id>.json     # 后台任务元数据
│   ├── tasks/<id>/output.log
│   ├── cron/<id>.json      # cron 任务镜像
│   ├── media-originals/    # 原图存档（sha256 寻址）
│   ├── blobs/              # BlobStore 大对象
│   └── logs/kimi-code.log  # 会话日志
├── plugins/<pluginId>/     # 插件受管目录
└── session-index.json      # 全局会话索引（追加式 + 墓碑）
```

- 写路径全部走 `writeFileAtomicDurable`（tmp+fsync→rename→目录 fsync）或 proper-lockfile 互斥；`session-index.json` 用追加 + 删除墓碑；
- workdir 分桶键优先用 workspace registry 的注册 id（Windows 大小写/斜杠折叠），避免同一物理根拆成两个桶；
- fork 会话：cp 目录 + `truncateForkedSessionAtTurn`（按 turnIndex 截断 wire log + 状态）+ 丢弃 `upcoming-goals.json` 等派生命文件。

### 5.11 时序/并发易错点清单（从代码注释提炼）

- `buildTools` 在 `beforeStep` **之后**求值：beforeStep 可能跑压缩（丢弃动态工具 schema），提前快照会派发模型已没有的工具；
- 压缩期间 `steer` 缓冲、`onCompactionFinished` 重放——手动压缩持锁期间的新输入不丢失也不提前落上下文；
- 工具执行期间 abort：`tool.result` 仍要配齐（批处理用 `Promise.allSettled` 兜底）再检查 signal 封 `step.end`；
- 手动压缩禁止与活跃回合并发（自动压缩在回合内 step 边界同步跑，天然安全）；
- 会话幂等恢复：`attachSession` refCount、`reconnect` 的 attemptId、`seenMcpDiscoveries` hash 去重（reconnect 不重复写 wire record）、`observedMaxContextTokensByModel` 按模型别名记录。

---

## 6. 关键代码位置索引

### DI 容器（特色）
| 位置 | 说明 |
|---|---|
| `di/instantiationService.ts:108` | `InstantiationService`：解析/缓存/子容器/dispose |
| `di/instantiationService.ts:283-394` | `_getOrCreateServiceInstance`：防御栈 + 图构建 + 叶子优先构造（环检测） |
| `di/instantiationService.ts:426-537` | `_createServiceInstance`：延迟实例化 Proxy + `onDid*` 早监听器驻车 |
| `di/instantiation.ts` | `createDecorator`（同名幂等）+ 构造器参数装饰器 |
| `di/extensions.ts` | `registerSingleton` / `getSingletonServiceDescriptors` |
| `di/lifecycle.ts` | `Disposable` 全家桶（DisposableStore/Map/Set/RefCounted…） |
| `di/graph.ts` | 依赖图（环检测 + 拓扑排序） |

### Loop 主循环
| 位置 | 说明 |
|---|---|
| `loop/run-turn.ts:89` | `runTurn`：回合收敛（abort/maxSteps/usage/继续决策） |
| `loop/turn-step.ts:79` | `executeLoopStep`：单步 + 媒体投影/严格投影重发恢复 |
| `loop/turn-step.ts:501` | `deriveStepStopReason`：provider finish → 归一化 stop reason |
| `loop/tool-call.ts:138` | `runToolCallBatch`：批次生命周期（provider 顺序交付） |
| `loop/tool-call.ts:686` | `coerceToolResult`：工具返回值信任边界 |
| `loop/tool-scheduler.ts:28` | `ToolScheduler`：资源冲突感知的并发调度 |
| `loop/tool-access.ts:22` | `ToolAccesses`：资源声明 + conflict 判定 |
| `loop/retry.ts:38` | `chatWithRetry`：指数退避 + Retry-After |
| `loop/events.ts:165` | `createLoopEventDispatcher`：双路事件分发（转录 + 直播） |

### Agent 与回合编排
| 位置 | 说明 |
|---|---|
| `agent/index.ts:115` | `Agent` 聚合根（20 个子管理器装配） |
| `agent/index.ts:288` | `Agent.generate` 闭包（日志/记录/认证包装） |
| `agent/index.ts:550` | `rpcMethods`：AgentAPI 全量实现 |
| `agent/turn/index.ts:139` | `TurnFlow`：prompt/steer/cancel/回合驱动 |
| `agent/turn/index.ts:400` | `turnWorker`：goal 驱动 vs 单回合 |
| `agent/turn/index.ts:808` | `runStepLoop`：宿主侧 6 钩子实现 + 溢出恢复 |
| `agent/context/index.ts:52` | `ContextMemory`：历史状态机 + 投影 |
| `agent/tool/index.ts:48` | `ToolManager`：三类工具 + 渐进披露 |
| `agent/tool/index.ts:775` | `initializeBuiltinTools`：内置工具注册表 |
| `agent/tool/index.ts:956` | `loopTools`：每步重读的披露/过滤 |
| `agent/compaction/full.ts:70` | `FullCompaction`：触发/溢出观测/summarizer |
| `agent/compaction/strategy.ts:41` | `DefaultCompactionStrategy`：85% 触发阈值 |
| `agent/records/index.ts:32` | `restoreAgentRecord`：wire record 重放分发 |
| `agent/permission/index.ts:28` | `PermissionManager`：策略链 + 审批 |
| `agent/goal/index.ts` | `GoalMode`：目标状态机 + 预算 |
| `agent/background/index.ts` | `BackgroundManager`：三类后台任务 |
| `agent/cron/manager.ts:113` | `CronManager`：调度引擎适配 |

### Session / MCP / RPC / Plugin / Skill
| 位置 | 说明 |
|---|---|
| `session/index.ts:213` | `Session`：会话生命周期与多 agent 宿主 |
| `session/subagent-host.ts:151` | `SessionSubagentHost`：子代理生成/恢复/超时 |
| `session/store/session-store.ts:67` | `SessionStore`：磁盘布局/fork/索引 |
| `session/hooks/runner.ts:60` | `runHook`：外部命令钩子协议 |
| `mcp/connection-manager.ts:129` | `McpConnectionManager`：连接生命周期状态机 |
| `mcp/client-stdio.ts:36` | `StdioMcpClient`（stderr 环形缓冲/握手竞态处理） |
| `rpc/client.ts:31` | `createRPC`：同进程模拟网络 RPC |
| `rpc/core-api.ts` | CoreAPI/SDKAPI 全量 payload 定义 |
| `plugin/manager.ts:39` | `PluginManager`：安装/清单/能力聚合 |
| `skill/registry.ts:26` | `SessionSkillRegistry`：发现/索引/渲染 |
| `tools/args-validator.ts:30` | AJV 方言分派参数校验 |
| `tools/policies/path-access.ts:201` | `resolvePathAccess`：路径安全门卫 |
| `tools/providers/local-fetch-url.ts:121` | SSRF 防护（DNS pinning） |
| `config/schema.ts:339` | `KimiConfigSchema`：全配置唯一真源 |
| `services/event/event.ts:44` | `IEventService`：进程内 pub-sub 总线 |
| `errors/codes.ts:11` | `ErrorCodes` + `KIMI_ERROR_INFO` 元数据表 |

---

## 7. 与其它子系统的接口

### 7.1 包出口（`src/index.ts` 显式导出面）

| 导出 | 消费者 | 用途 |
|---|---|---|
| `Agent`、`Session`、`SessionStore` | node-sdk、acp-adapter、vis/server | 嵌入式运行 agent 与会话 |
| `AgentAPI`/`SDKAPI` 类型 + `createRPC` | node-sdk | SDK↔core 进程内 RPC 契约 |
| `AgentRecord*` + `AGENT_WIRE_PROTOCOL_VERSION` | apps/vis | wire record 类型化读取 |
| `LoopRecordedEvent` 等 loop 事件类型 | apps/vis、node-sdk | 转录本/直播事件消费 |
| 图片压缩管线（`compressImageForModel` 等 17 个符号） | node-sdk、server | 提示摄入侧图片处理 |
| `buildReplay` / `limitAgentReplayByTurns` | node-sdk | 会话重放快照 |
| `parseAgentFileText` / `resolveAgentPath` | kimi-code（v2 引擎兼容） | agentfile 解析 |
| `Emitter`、`IDisposable`、`IXxxService` 全家 | server、vis | DI 与事件基建 |
| logging 全家（`log`/`getRootLogger`/`redact`/`attachSession`） | 全仓库 | 统一日志 |
| `installGlobalProxyDispatcher` | kimi-code | 全局代理安装 |
| `SingleModelProvider`/`ModelProvider` | node-sdk | 模型提供者抽象 |

### 7.2 被调用方（agent-core 调用谁）

- `@moonshot-ai/kaos`：一切 OS 能力（`Agent.kaos`、`Session` 的 `toolKaos`/`persistenceKaos` 双实例——工具执行与持久化可分离）；
- `@moonshot-ai/kosong`：`generate()`（模型对话）、`Message/Tool/TokenUsage/FinishReason` 类型、API 错误类、`ChatProvider` 能力元数据；
- `@moonshot-ai/kimi-code-oauth`：MCP OAuth；
- `@modelcontextprotocol/sdk`：stdio/streamable-http/SSE 客户端。

### 7.3 与 agent-core-v2 的接口（兼容层）

- `restoreAgentRecord` 显式处理 v2 的 `profile.bind`（映射为 v1 的 config.update + tools.set_active_tools）与 `tools.reset_active_tools`（no-op）——**v1 引擎能直接恢复 v2 写出的会话**；
- `mcp`/`permission`/`hook` 的语义（工具命名 `mcp__server__name`、permission 规则、HookDef schema）与 v2 对齐，`HookDefSchema` 直接复用；
- `services/` 的协议翻译器（`toProtocol*`）保证 v1 服务面与线上协议形状一致，v2 时代服务层可平滑平移。

### 7.4 宿主需要实现的回调面（SDK 嵌入契约）

一个宿主接入 agent-core 只需提供：

```ts
const rpc: Partial<SDKAgentRPC> = {
  emitEvent(event),                          // 事件推送（turn.started/ended、tool.list.updated…）
  requestApproval(req) => Promise<resp>,     // 工具审批 UI（缺省自动放行）
  requestQuestion(req) => Promise<resp>,     // 提问 UI
  toolCall(req) => Promise<resp>,            // 用户注册工具的执行回调
};
const agent = new Agent({ kaos, config, rpc, homedir, … });
agent.rpcMethods.prompt(input);              // 或经 createRPC 双向绑定
```

其余全部（上下文、压缩、权限、后台、cron、goal、计划、记录）由 `Agent` 内部管理器自足——这正是 AGENTS.md 硬规则"Agent 必须能独立使用"的落地形态。

### 7.5 线上协议桥（kap-server 时代的继承）

v1 虽不再服务 kap-server，但 `services/` 的 `toBrokerRequest`/`toAgentCoreResponse` 翻译器与 `ApprovalRequest/QuestionRequest` 协议形状（`rpc/sdk-api.ts`）定义了**服务器-客户端双端契约**，v2 继承同一形状——理解 v1 的 rpc/services 层即可推导 kap-server 的线上语义。
