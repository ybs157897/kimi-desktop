# 01 · apps/kimi-code —— CLI 主应用研究报告

> 研究目标：`apps/kimi-code`（`@moonshot-ai/kimi-code`，v0.33.0）
> 规模：292 个 TS 文件 / 55,754 行（`src/`）；其中 `src/tui/kimi-tui.ts` 单文件 3,445 行（129 KB）
> 技术栈：TypeScript + ESM，Commander.js 参数解析，自研 pi-tui 差分渲染 TUI 库，Node.js SEA（Single Executable Application）打包，`tsdown`（rolldown 系）构建
> 阅读日期：2026-08（基于仓库当前 HEAD）

---

## 1. 子系统定位与职责

`apps/kimi-code` 是 Kimi Code 的**终端 UI / CLI 主应用**，即用户执行 `kimi` 时实际运行的进程。仓库根 `AGENTS.md` 给出的入口链是：

```
src/main.ts -> src/cli/commands.ts -> src/cli/run-shell.ts
   -> SDK KimiHarness -> src/tui/kimi-tui.ts
```

### 在整体架构中扮演的角色

它是整个 monorepo 的"外壳层"（shell/UI 层），与三个核心引擎的关系如下：

- **`@moonshot-ai/agent-core`（v1 引擎）**：`apps/kimi-code` **不直接 import 它**（这是 `AGENTS.md` 的硬性约束："`apps/kimi-code` may only use core capabilities through `@moonshot-ai/kimi-code-sdk`"）。v1 路径通过 SDK 的 `createKimiHarness()` → `SDKRpcClient` 间接调用，后者在进程内启动一个 `KimiCore`（agent-core 的 RPC 服务）并通过 JSON-RPC 通信。
- **`@moonshot-ai/agent-core-v2`（v2 引擎，新架构）**：从 0.33.0 起是**默认引擎**（`kimi -p`、交互式 TUI、`kimi doctor` 全部默认走 v2；`kimi web` 总是走 v2）。TUI 通过 `createKimiHarnessV2()` → `SDKRpcClientV2` 接线：该客户端在进程内 `bootstrap()` agent-core-v2 的 DI 容器（`Scope`），再用 `createKlient({ scope: app })`（`@moonshot-ai/klient/memory` 内存传输）创建 facade 客户端，**所有调用都经过 klient 契约校验 + JSON 往返**，与网络传输走同一条验证路径。`KIMI_CODE_LEGACY_FLAG=1` 可切回 v1。
- **`@moonshot-ai/kap-server`**：`kimi web` 子命令的前端进程宿主。`kimi web` 在**当前进程内**启动 kap-server（v2 引擎的本地服务器：REST + WebSocket + Web UI），attach 到终端直到 Ctrl+C；它不经过 KimiHarness，而是直接调 kap-server 的 `startServer()` 并把 telemetry 客户端传入其 `coreProcessOptions`。

一句话定位：**`apps/kimi-code` = 参数解析 + 进程生命周期管理 + 终端 UI + 更新/迁移/反馈等桌面级运维设施，夹在"用户终端"与"agent 引擎"之间**。所有 agent 能力（会话、工具、流式事件、审批）都是通过 `@moonshot-ai/kimi-code-sdk` 的 `KimiHarness`/`Session` 门面获得的，自身不实现任何 agent 逻辑。

### 与其它 app 的关系

| 面 | 说明 |
|---|---|
| 交互式 TUI | `kimi`（默认）→ `runShell` → `KimiTUI` |
| 非交互 | `kimi -p "..."` → `runPrompt`（v1 或 v2 print runner） |
| Web | `kimi web` → kap-server 进程内启动 |
| ACP | `kimi acp` → 默认走 agent-core-v2 原生 ACP 服务（`acp-native`），`KIMI_CODE_LEGACY_FLAG` 时走 `@moonshot-ai/acp-adapter` 的 `runAcpServer` |
| 可视化 | `kimi vis` → `@moonshot-ai/vis-server` 进程内启动 |

---

## 2. 包/目录清单与依赖关系

### 2.1 目录结构（`src/`）

```
apps/kimi-code/
├── src/
│   ├── main.ts               # 进程入口：Commander 解析、preflight、分发
│   ├── built-in-catalog.ts   # 构建期注入的 models.dev 内置目录快照（tsdown define）
│   ├── cli/                  # 命令行解析、子命令、启动装配
│   │   ├── commands.ts       # createProgram：主命令面 + 全部子命令注册
│   │   ├── options.ts        # CLIOptions 类型 + validateOptions 冲突校验
│   │   ├── run-shell.ts      # 交互模式启动（stty、crash 恢复、KimiTUI 装配）
│   │   ├── run-prompt.ts     # 非交互 `-p` 模式（事件→输出渲染、goal 模式）
│   │   ├── headless-exit.ts  # headless 运行收尾：drain stdio + 兜底强杀
│   │   ├── telemetry.ts      # telemetry bootstrap/初始化（CLI 与 server 两套）
│   │   ├── version.ts        # 版本解析（build-info 优先，回落 package.json）
│   │   ├── experimental-v2.ts# KIMI_CODE_LEGACY_FLAG 引擎切换开关
│   │   ├── agent-selection.ts# --agent/--agent-file 解析
│   │   ├── goal-prompt.ts    # headless goal 模式（/goal 目标解析与退出码映射）
│   │   ├── prompt-session.ts / prompt-render.ts  # print 模式会话与输出 writer
│   │   ├── startup-error.ts  # 启动失败格式化
│   │   ├── sub/              # 子命令：acp / doctor / export / login / provider / upgrade / vis / web
│   │   ├── update/           # 更新预检：cdn/rollout/install-lock/install-state/preflight/prompt/refresh/cache/source/types
│   │   └── v2/               # run-v2-print.ts（v2 原生 print runner）、validate-config.ts
│   ├── tui/                  # 交互式终端 UI（详见 §3.4）
│   ├── native/               # SEA 原生资产：module-hook / native-assets / minidb-worker / web-assets / smoke / native-require
│   ├── migration/            # ~/.kimi → ~/.kimi-code 迁移（检测 + TUI 屏）
│   ├── feedback/             # 反馈提交：zip 打包（codebase/）、分片上传
│   ├── constant/             # app.ts（路径/URL/超时）、terminal.ts、update.ts
│   ├── generated/            # vis-web-asset.d.ts（构建产物类型占位）
│   └── utils/                # 剪贴板/git/历史/图片/进程/用量/catalog-fetch/paths/插件市场等
├── scripts/                  # dev.mjs、postinstall.mjs、native/*.mjs（SEA 打包 5 步）、built-in-catalog.mjs
├── test/                     # 单元 + e2e（KIMI_E2E=1）
└── tsdown.config.ts / tsdown.native.config.ts / tsdown.worker.config.ts
```

### 2.2 Workspace 依赖（全部 `workspace:^`，均在 devDependencies——因为构建期打包成单文件，运行时不再解析 node_modules）

```
@moonshot-ai/kimi-code-sdk (node-sdk)   ← 主接线：KimiHarness / Session / createKimiHarness(V2)
@moonshot-ai/agent-core-v2              ← v2 引擎（经 SDK v2 客户端 + run-v2-print + acp-native 深 import）
@moonshot-ai/kap-server                 ← kimi web 服务器
@moonshot-ai/pi-tui                     ← 自研 TUI 渲染库（Container/TUI/editor）
@moonshot-ai/kimi-telemetry             ← 遥测（track/shutdown/withTelemetryContext）
@moonshot-ai/kimi-code-oauth            ← 认证（device code、api.json 注册表、device id）
@moonshot-ai/migration-legacy           ← 迁移检测/执行逻辑（屏幕 UI 在本包）
@moonshot-ai/minidb                     ← 会话存储；SEA 内嵌 text-build worker
@moonshot-ai/acp-adapter / acp-server   ← 旧版 ACP stdio 桥（legacy 路径）
@moonshot-ai/vis-server / vis-web       ← kimi vis 可视化
@moonshot-ai/agent-core                 ← 仅经 SDK 间接依赖（AGENTS.md 禁止直接 import）
```

第三方依赖：`commander`（唯一参数解析库）、`chalk`、`zod`、`semver`、`smol-toml`、`cli-highlight`、`yazl`/`postject`（SEA 注入）、`jimp`（图片处理）、`pathe`；**optionalDependencies**：`node-pty`（终端会话）、`@mariozechner/clipboard`（剪贴板）——两者都是原生 `.node` 模块，SEA 打包时作为资产内嵌（见 §5.4）。

### 2.3 谁依赖它

`apps/kimi-code` 是终端产品本身，没有其它包依赖它（`packages/` 反向引用不存在）；它是 monorepo 的**消费端/汇合点**。`plugins/` 目录下的官方插件（如 kimi-datasource）在运行时通过 SDK/协议与其交互，而非编译期依赖。

---

## 3. 模块结构与核心类型

### 3.1 入口层（`src/main.ts` + `src/cli/`）

**`main.ts`** —— 进程唯一入口，全链路职责：
- `main()`（行 143）：设置 `process.title` → `installCrashHandlers()`（kimi-telemetry 的全局未捕获异常记录）→ `installGlobalProxyDispatcher()`（把全局 fetch 路由到 HTTP_PROXY/HTTPS_PROXY，NO_PROXY 生效）→ `installNativeModuleHook()`（SEA 原生资产重定向）→ `installMinidbTextBuildWorker()`（SEA 内嵌 worker 解包）→ `runNativeAssetSmokeIfRequested()` → 后台 `cleanupStaleNativeCacheForCurrent()`（fire-and-forget）→ `getVersion()` → `createProgram(...)` → `program.parse(process.argv)`。
- `handleMainCommand()`（行 56）：**可复用、可单测的处理器**，自身不终止进程——`validateOptions`（冲突即 `OptionConflictError` → stderr + exit 1）→ `runUpdatePreflight`（更新预检，可返回 `'exit'`）→ 根据 `uiMode` 分发到 `runPrompt`（print）或 `runShell`（shell）。
- 失败路径的关键技巧（行 193-211）：**同步先设 `process.exitCode = 1` 再 await 日志**——因为失败的 `finally` 清理会先拆掉已注册的 handle，事件循环可能在 await 期间自然排空并以默认码 0 退出，导致 `kimi -p` 失败却返回 0 的非确定性 bug。
- `handleMigrateCommand` / `handleUpgradeCommand` / `handlePluginNodeRunner`：各自独立小入口。

**`cli/commands.ts`** —— `createProgram()`：Commander `Command` 面。主命令选项（`-S/--session [id]`、`-r/--resume`（隐藏）、`-c/--continue`、`-C`（隐藏）、`-y/--yolo`、`--auto`、`-m/--model`、`-p/--prompt`、`--output-format`、`--skills-dir`（可重复）、`--agent`/`--agent-file`（互斥 + 与 session/continue 冲突）、`--add-dir`、`--plan`、隐藏的 `--yes`/`--auto-approve`）；子命令：`export`、`provider`、`acp`、`web`（+隐藏 `server kill`、`web rotate-token`）、`login`、`doctor`、`vis`、`migrate`、`upgrade`（alias `update`）、隐藏的 `__plugin_run_node`。末尾的 `program.argument('[args...]')` 兜底 action 做新旧选项归一（`--resume`→`session`、`--yes`/`--auto-approve`→`yolo`），拼出 `CLIOptions` 交给 `onMain`。

**`cli/options.ts`** —— `CLIOptions` 接口（§3.1 全量字段）；`validateOptions()` 用**显式规则清单**（非 zod）做冲突校验：prompt 非空、prompt 不能配 yolo/auto/plan、output-format 仅限 prompt、agent 与 agent-file 互斥、agent 不能配 session/continue、session 与 continue 互斥、yolo 与 auto 互斥等；`resolveOutputFormat()` 优先级：`--output-format` > `KIMI_MODEL_OUTPUT_FORMAT` 环境变量（仅 prompt 模式生效）> `text`。

**`cli/run-shell.ts`** —— 交互模式启动装配（详见 §4.2）：`loadTuiConfig()`（tui.toml，解析失败回落默认 + 警告）→ 初始化全局 Theme 单例（**必须在 pi-tui 抓 stdin 之前**）→ `createCliTelemetryBootstrap()` → `isKimiV2Enabled()` 选择 `createKimiHarnessV2`/`createKimiHarness` → `harness.ensureConfigFile()` → `detectPendingMigration()` → `harness.getConfig()` → `resolveAgentProfileSelection()` → `new KimiTUI(...)` → `initializeCliTelemetry()` → `setCrashPhase('runtime')` → stty 保存/`-ixon` → 安装 crash 处理器（`uncaughtException`/`unhandledRejection` → `emergencyExit`：同步 flush 日志 + `restoreTerminalModes()` + 恢复 stty + exit，防 raw 模式残留在用户 shell）→ `tui.start()` → `tui.onExit`（写 `Bye!`、打印 resume 提示、`exitForegroundTask` 移交前台任务或 exit）。

**`cli/run-prompt.ts`** —— 非交互模式（详见 §4.3）：`raceWithTimeout`（清理阶段限时，防 wedged 清理挂死 headless 运行）；`resolvePromptSession`（`-S` 精确恢复 / `-c` 续上一个 / 新建）；`forcePromptPermission`（恢复时若原权限非 auto 则临时提升为 auto，退出后恢复）；`installHeadlessHandlers`（approval 全批准 + question 返回 null）；`runPromptTurn`（事件→输出 writer 的状态机，详见 §4.3）；`installPromptTerminationCleanup`（SIGINT/SIGTERM/SIGHUP → 先清理再按 128+signum 退出）；headless goal 模式（`kimi -p "/goal ..."`，`runHeadlessGoal`：创建 goal → 常规 turn → goal 事件聚合 → 总结输出 + `goalExitCode` 映射非致命退出码）。

**`cli/headless-exit.ts`** —— `finalizeHeadlessRun`：`drainStdio`（空 write 回调探测缓冲排空，10s 上限）→ `scheduleHeadlessForceExit`（**unref'd** 2s 兜底定时器——健康运行在它触发前自然退出，只有事件循环被 stray handle 卡死时才强杀）。

**`cli/telemetry.ts`** —— `createCliTelemetryBootstrap`（homeDir + deviceId 生成，`onFirstLaunch` 回调）；`initializeCliTelemetry`（把 `@moonshot-ai/kimi-telemetry` 模块函数接入真实客户端：app_name、ui_mode、model、sessionId、`getAccessToken` 取自 `KimiAuthFacade`）；`initializeServerTelemetry`（`kimi web` 用，ui_mode="web"，读 config 的 telemetry 开关）。

**`cli/version.ts`** —— `getVersion`：`KIMI_BUILD_INFO.version`（构建期注入）优先，否则向上找 `package.json`（兼容 dev `tsx src/main.ts` 与 prod `dist/main.mjs` 两种深度）；`createKimiCodeHostIdentity`（productName=`kimi-code-cli` + version + platform）。

### 3.2 子命令（`src/cli/sub/`）

| 子命令 | 文件 | 职责 |
|---|---|---|
| `acp` | `acp.ts` / `acp-native.ts` | 默认（非 legacy）：注册原生 v2 ACP 服务命令（agent-core-v2 的 ACP server，`args=['--login']` 进入 device-code 登录）。legacy：`runAcpServer`（JSON-RPC stdio 桥，`console.*` 重定向 stderr，uiMode='acp'） |
| `doctor` | `doctor.ts` | 诊断：zod 校验 config.toml/tui.toml、MCP 配置、环境；`KIMI_CODE_DOCTOR=1` |
| `export` | `export.ts` | `kimi export`：会话查找 + 确认 + 调 SDK `exportSession`（ZIP/manifest 由 SDK 拥有） |
| `login` | `login.ts` / `login-flow.ts` | device-code 登录流（ACP 终端认证入口也复用） |
| `provider` | `provider.ts` | 非交互 provider 管理：`add`（写 `source={kind:'apiJson',url,apiKey}`，与 TUI `/provider` 同一持久化 blob）、`list`、`catalog` 子命令（内置目录/远程目录导入，apiKey 落盘） |
| `upgrade` | `upgrade.ts` | 手动升级（读 CDN latest，非 rollout 门控） |
| `vis` | `vis.ts` | 进程内启动 vis-server，打印 URL，可选开浏览器，Ctrl+C 关闭 |
| `web` | `web/` | 前台运行 kap-server + 开浏览器；`web rotate-token`（轮换 home 级 bearer token）；隐藏 `server kill`（清理 <0.28.0 遗留服务器进程）；`--no-open` 跳过浏览器；多实例共享 home：注册实例注册表、自动取下一个空闲端口 |

### 3.3 更新子系统（`src/cli/update/`）

这是本包最"产品化"的模块之一，六个职责分离的文件：

- **`cdn.ts`**：拉 `https://code.kimi.com/kimi-code/latest`（纯文本版本，永远不变）+ `latest.json`（zod 校验，**故意非 strict**——未知字段忽略，避免未来 manifest 加字段弄死已发客户端；该教训来自纯文本 `/latest` 对非 semver 体硬失败）。
- **`rollout.ts`**：灰度滚动发布。`rolloutBucket(deviceId, version)` = `sha256(deviceId:version)` 前 4 字节 `% 100`；`rolloutDelayForBatch`：按批次数组顺序累加 percent，命中区间取对应 `delaySeconds`（钳到 24h），未覆盖区间落最慢批次。`isRolloutEligible` 判 `publishedAt + delay` 是否已到。
- **`cache.ts` / `refresh.ts`**：`latest.json` 拉取缓存（`<home>/cache/updates/latest.json`）；刷新失败**不覆盖**旧缓存（避免瞬时 CDN 故障把已知最新版冲掉）。
- **`install-state.ts` / `install-lock.ts`**：后台安装状态机 `install.json`（`active` / `lastFailure{version,attempts}` / `lastSuccess{version,installedAt,notifiedAt}`）+ 跨进程锁 `install.lock`（防止多实例并发安装）。
- **`preflight.ts`**（核心，812 行）：`runUpdatePreflight` 全流程——`KIMI_CODE_NO_AUTO_UPDATE` 门 → 读 install-state → 交互模式先展示"上次后台安装成功"通知 → 读缓存决策（startup-cache 阶段）→ 无目标则后台刷新（background-refresh 阶段）→ 有目标：检测安装源（npm/pnpm/yarn/bun global、homebrew、native、unsupported）→ `canAutoInstall` 判定 → `tryStartAutomaticBackgroundInstall`（**detached + stdio ignore + windowsHide 的静默子进程**，失败 2 次后改提示用户）→ 否则 1s 限时前台刷新（prompt-refresh）→ 决策 `prompt-install`（交互安装）或 `manual-command`（homebrew/unsupported 只给命令）；`installUpdate` 用 `spawn`（win32 走 shell，规避 CVE-2024-27980 的 EINVAL）；native 源用 `set -o pipefail; curl … | bash`（防 curl 失败被 bash 的 0 掩盖）。每个阶段都写 `rollout.log` 并上报 telemetry。
- **`source.ts`**：安装源检测（查 PATH、npm 前缀、homebrew 前缀等）。

### 3.4 TUI 层（`src/tui/`）

**`kimi-tui.ts`（3,445 行）—— `KimiTUI` 协调器类**。按 AGENTS.md 的分层纪律：它只做**协调**（装配控制器、转发 slash 命令、处理输入），重逻辑下沉到 controllers/commands/components/reverse-rpc。核心字段：

```ts
class KimiTUI {
  readonly harness: KimiHarness;      // SDK 门面（v1 或 v2 客户端）
  session: Session | undefined;       // 当前会话（v2 引擎下可为空，懒创建）
  state: TUIState;                    // 全局 UI 状态（tui-state.ts）
  readonly streamingUI / authFlow / btwPanelController /
    sessionEventHandler / sessionReplay / tasksBrowserController / editorKeyboard;
  readonly engineV2: boolean;         // v2 引擎开关（懒会话创建语义不同）
  skillCommands / pluginCommands;     // 动态 slash 命令（技能/插件）
  shellOutputStreams: Map<commandId, {entry, component, taskId}>; // 并发 `!` shell 输出卡片
  onExit?: (exitCode?) => Promise<void>;  // runShell 注入的进程收尾
  exitForegroundTask / exitOpenUrl;   // /web 移交前台任务机制
}
```

关键方法族（行号见 §6）：生命周期（`start`/`stop`/`init`/`finishStartup`/`emergencyTerminalExit`）、会话管理（`ensureSession`/`lazyCreateSession`/`setSession`/`switchToSession`/`createNewSession`/`resumeSession`）、发送（`sendNormalUserInput`/`steerMessage`/`sendQueuedMessage`/`activatePluginCommand`）、流式渲染（委托 streamingUI）、面板（approval/question/session-picker/help/迁移屏）、主题（`applyTheme` + 终端背景检测 + Kitty 色彩方案追踪）、消息队列（`queuedMessages` + `queuedMessageDispatchPending` 标志，防"队列看似空但 dispatch 未完成"竞态）。

**`tui-state.ts`** —— `TUIState`（行 28）：ui/terminal 基件 + 9 个 GutterContainer（transcript/activity/todoPanel/queue/btwPanel/editor）+ footer + editor + appState + startupState（'pending'|'ready'|'picker'）+ livePane + transcriptEntries + tasksBrowser + queuedMessages 等。`createTUIState` 在构造时装配 `ProcessTerminal` → `TUI` → 各 `GutterContainer`（带 `CHROME_GUTTER` 左右留白）→ `CustomEditor` → `FooterComponent`。

**`types.ts`** —— `AppState`（行 27）：模型/权限/planMode/thinkingEffort/上下文用量/streamingPhase（`'idle'|'waiting'|'thinking'|'composing'|'shell'`）/主题/可用模型与 provider/通知/升级偏好/goal/banner 等 **TUI 全局状态的唯一形状**；`TranscriptEntry`（行 190）：kind 枚举（welcome/user/assistant/tool_call/thinking/status/skill_activation/plugin_command/cron/goal）+ 渲染模式（markdown/plain/notice）+ 各种附加数据载荷（toolCallData/compactionData/cronData/goalData/pluginCommandData…）；`LivePaneState`；`QueuedMessage`（文本 + agentId + prompt parts + 图片附件）。

**controllers/** —— 每个控制器一个可独立测试的职责切片：

| 文件 | 职责 |
|---|---|
| `session-event-handler.ts`（1,202 行） | **SDK 事件路由中枢**：`startSubscription()` 订阅 `session.onEvent`，`handleEvent()` 按 type 分发到 30+ 私有处理器（turn/step/tool/assistant/thinking/hook/goal/compaction/cron/mcp/subagent/background.task/plugin_command）；维护 MCP 服务器状态快照、技能/插件激活去重、goal 队列晋升（`scheduleQueuedGoalPromotion`，含阻塞降级与竞态防护） |
| `streaming-ui.ts`（909 行） | 流式渲染控制器：缓冲 thinking/assistant delta 与 tool-call 参数，**50ms 节流 flush**（`scheduleFlush`/`flushNow`），turn 边界折叠、max_tokens 截断标记、TodoList 工具结果提取到 todo 面板 |
| `session-replay.ts`（785 行） | resume 时的历史回放渲染：把 `AgentReplayRecord`/`wire.jsonl` 重建成 transcript 组件（工具调用/后台任务/目标完成消息等），`REPLAY_TURN_LIMIT` 限制 |
| `subagent-event-handler.ts`（695 行） | 子代理与 AgentSwarm 进度渲染 |
| `tasks-browser.ts` | 后台任务浏览器面板（轮询 + 展开/终止/分离） |
| `editor-keyboard.ts` | 编辑器键盘控制（粘贴、undo、词导航、图片粘贴提取） |
| `auth-flow.ts` | 登录/模型刷新流（`refreshAvailableModels`/`refreshProviderModels`/`enterLoginRequiredStartupState`） |
| `btw-panel.ts` / `cache-hint-controller.ts` / `clipboard-image-hint.ts` / `plugin-update-notifier.ts` | 各类辅助面板与通知 |

**commands/** —— slash 命令声明与解析。`types.ts` 定义 `KimiSlashCommand`（name/aliases/description/priority/availability/experimentalFlag/completeArgs）；`registry.ts` 注册 ~40 个内置命令（`/model`、`/yolo`、`/auto`、`/plan`、`/compact`、`/goal`、`/undo`、`/plugins`、`/mcp-config`、`/swarm`、`/export`、`/fork`…）；`dispatch.ts` 的 `dispatchInput` 是输入分派入口（含彩蛋 `/dance`）；`skills.ts`/`plugin-commands.ts` 从 SDK 技能/插件列表**动态生成** slash 命令；`parse.ts` 解析 `/name args`；`resolve.ts` 处理忙碌态（streaming/compacting 时禁用部分命令）；`config.ts`（940 行）承载模型选择器/权限选择器/设置面板等重命令。

**reverse-rpc/** —— SDK 审批/提问回调 → UI 面板的适配层。`types.ts` 定义显示块类型（brief/diff/shell/file_op/file_content/url_fetch/search…）；`approval/` 与 `question/` 各有 `adapter.ts`（核心载荷 → 面板数据）、`controller.ts`（面板生命周期）、`handler.ts`；`base-controller.ts` + `modal-coordinator.ts` 协调模态覆盖；`index.ts` 的 `registerReverseRPCHandlers` 把 SDK 回调注册到 `KimiTUI`（`showApprovalPanel`/`showQuestionDialog`），用户选择再写回 SDK 响应。

**theme/** —— 颜色令牌系统（单一事实源）：`colors.ts`（ColorPalette：dark/light 两套语义令牌，对比度约束）、`theme.ts`（`currentTheme` 单例 + apply/switch）、`detect.ts`/`terminal-background.ts`（终端背景色检测，OSC 11 查询）、`pi-tui-theme.ts`、`highlight-theme.ts`（代码高亮）、`custom-theme-loader.ts`、`theme-schema.json`。AGENTS.md 有硬性规则：组件禁止直接用 `chalk.red` 等命名色（CI 里有 `chalk-named-color-guard.test.ts` 强制）。

**components/** —— pi-tui 组件，按类别分目录：`chrome/`（footer、todo-panel、welcome、moon-loader、gutter-container）、`dialogs/`（选择器、审批面板、提问弹窗、设置弹窗）、`editor/`（custom-editor、file-mention-provider 文件 @ 补全）、`media/`（图片、diff、代码高亮）、`messages/`（assistant/user/tool-call/thinking/usage/subagent 等消息块）、`panes/`（活动面板、队列面板）。AGENTS.md 约束：**components 不得直接调 SDK、不得读写会话状态**。

### 3.5 原生层（`src/native/`）与打包

- `native-assets.ts`：SEA 资产运行时——`getSeaAssetSource()`（`node:sea` isSea/getAssetKeys/getRawAsset）、`getEmbeddedNativeAssetManifest`（从 blob 读 manifest 并强校验：版本、target、相对路径防穿越、sha256 格式）、`ensureNativeAssetTree`（把资产解包到 `~/.cache/kimi-code/native/<version>/<target>/<manifestHash>/`，逐个 sha256 校验 + 原子写：tmp 文件 + rename，失败重试）、`getNativePackageRoot`（node-pty/clipboard/tree-sitter 的安装根）、`cleanupStaleNativeCache`（保留当前根 + 最新兄弟目录，清其余同版本同 target 的 hash 目录；**不碰其它版本/target**）。
- `module-hook.ts`：patch `Module._load`，把 pi-tui 的绝对路径原生 require（`native/<darwin|win32>/prebuilds/<arch>/*.node`）重定向到缓存副本（SEA 二进制里这些文件不存在于原路径）。
- `minidb-worker.ts`：把 SEA 内嵌的 minidb text-build worker（`runtime/minidb/text-build-worker.mjs`）解包并 `configureTextBuildWorkerRuntime`；失败仅降级为内联模式，绝不阻塞启动。
- `web-assets.ts`：`kimi vis` 的 Web 前端资产（dist-web）同样的 SEA 资产机制。
- 打包（`scripts/native/*.mjs`，5 步流水线）：`01-bundle.mjs`（tsdown 出单文件 ESM `main.mjs` + worker 单文件）→ `02-sea-blob.mjs`（收集 `.node` 资产 + web 资产，写 `--experimental-sea-config`，生成 blob）→ `03-inject.mjs`（复制 node 可执行文件、移除签名、`postject` 注入 `NODE_SEA_BLOB`，darwin 用 `--macho-segment-name NODE_SEA`）→ `04-sign.mjs`（codesign：本地 ad-hoc，release 用 `APPLE_SIGNING_IDENTITY`）→ `05-verify.mjs`（`codesign -dv` 验证）。即：**不是 pkg / bun / deno，而是 Node.js 官方 SEA + postject**。
- `postinstall.mjs`：全局安装时把旧 Python CLI（`kimi_cli`）的 `kimi` shim 改名 `kimi-legacy`，避免 PATH 遮蔽；任何错误都不失败安装（规则：不识别的不动、非全局安装静默）。

### 3.6 迁移（`src/migration/`）

- `detect-pending.ts`：启动前同步检测（`~/.kimi` → `~/.kimi-code`）：`existsSync(sourceHome)` + marker 抑制（`.migrated-to-kimi-code`/`.skip-migration-from-kimi-cli`）+ `detectMigration()`（migration-legacy 包）。**OAuth 凭据故意不迁移**（只有 credentials 时视为"无可迁移"，让 /login 重新走认证）；仅 oauth-only 时返回 null。
- `migration-screen.ts`：TUI 首启迁移屏，`MigrationScreenComponent extends Container implements Focusable`，**3 阶段状态机 `ask1 → ask2 → progress → result`**（now/later/never 门 + scope 选择 + 4 步进度：config/mcp/user-history/sessions，braille spinner 80ms 一帧）；`kimi migrate` 命令通过 `skipDecisionStep` 跳过决策门。
- `command.ts` / `index.ts`：注册 `migrate` 子命令；`badge.ts` 是迁移入口提示角标。

### 3.7 反馈（`src/feedback/`）

- `archive.ts` + `codebase/`：把会话/日志/配置打包 zip（yazl）。
- `feedback-attachments.ts`：附件收集（图片等）。
- `upload.ts`：**分片上传**——`createUploadUrl`（服务端返回预签名分片 URL 列表）→ 并发 3 路 PUT（每片超时 60s、失败重试 3 次、指数退避 1s 基数）→ `completeUpload`（etag 列表）；总大小上限 500 MiB，进度回调；上传失败提示 `/feedback` 引导到 GitHub issues。

### 3.8 杂项

- `constant/app.ts`：产品常量（产品名、`KIMI_CODE_CDN_BASE`、安装 URL、数据目录布局：`KIMI_CODE_HOME`/`.kimi-code/{logs,cache,updates,bin,user-history,banner}`、超时常量 `CLI_SHUTDOWN_TIMEOUT_MS=3000`/`PROMPT_CLEANUP_TIMEOUT_MS=8000`/`HEADLESS_FORCE_EXIT_GRACE_MS=2000`/`HEADLESS_STDIO_DRAIN_TIMEOUT_MS=10000`、`OAUTH_LOGIN_REQUIRED_CODE`（从 SDK `ErrorCodes` 派生，防漂移））。
- `built-in-catalog.ts`：`BUILT_IN_CATALOG_JSON` —— 构建期由 tsdown `define` 注入的 models.dev 快照（源码为空；release 构建前跑 `update-catalog.mjs` 生成）。
- `cli/v2/run-v2-print.ts`（861 行）：v2 原生 print runner——**不经过 KimiHarness/Session**，直接 `bootstrap()` agent-core-v2 app scope、用原生服务（`IAgentPromptService.enqueue()` + `Turn.result`）驱动一轮 turn、订阅 per-agent `IEventBus` 渲染原生 `DomainEvent` 流、套用 v1 对齐的 print 后台策略（`exit`/`drain`/`steer`）；`validate-config.ts` 是 v2 的 config 校验。

---

## 4. 关键数据流 / 状态机 / 时序

### 4.1 进程启动时序（`kimi`）

```
shell 用户
  │  kimi [args]
  ▼
main()  ── 1. process.title / installCrashHandlers
         ── 2. installGlobalProxyDispatcher      (fetch → HTTP(S)_PROXY)
         ── 3. installNativeModuleHook           (SEA .node 重定向)
         ── 4. installMinidbTextBuildWorker      (SEA worker 解包，失败降级内联)
         ── 5. runNativeAssetSmokeIfRequested?   (KIMI_CODE_NATIVE_SMOKE=1 时专用退出)
         ── 6. queueMicrotask: cleanupStaleNativeCacheForCurrent  (fire-and-forget)
         ── 7. createProgram(...).parse(argv)
  ▼
handleMainCommand ── validateOptions ──(冲突)→ error: ... ; exit 1
  ▼
runUpdatePreflight ── 缓存决策/后台安装/交互提示 ──(exit)→ process.exit(0)
  ▼
uiMode == 'print' ?  ──→ runPrompt (headless) ──→ finalizeHeadlessRun (drain stdio + unref'd 强杀兜底)
  │
  └──→ runShell (interactive)
```

### 4.2 交互模式启动（runShell → KimiTUI.start）

```
runShell(opts, version)
  ├─ loadTuiConfig()            # tui.toml；失败→fallback+warning
  ├─ getColorPalette + currentTheme.setPalette   # 必须在 pi-tui 抓 stdin 之前
  ├─ createKimiHarnessV2|V1     # engineV2 = !KIMI_CODE_LEGACY_FLAG
  ├─ harness.ensureConfigFile() / getConfig()
  ├─ detectPendingMigration()   # ~/.kimi → 目标 home
  ├─ resolveAgentProfileSelection(--agent/--agent-file)
  ├─ new KimiTUI(harness, {cliOptions, tuiConfig, version, workDir, migrationPlan, engineV2})
  ├─ initializeCliTelemetry / setCrashPhase('runtime')
  ├─ stty -g 保存 + stty -ixon  # 关 XON/XOFF 流控
  ├─ process.on uncaughtException/unhandledRejection → emergencyExit (flush日志+恢复终端+exit)
  ├─ tui.start()
  │    ├─ registerSignalHandlers()      # SIGTERM→stop(143)；SIGHUP→emergencyExit(129)
  │    ├─ migrationPlan? → startEventLoop + runMigrationScreen → 退出/继续
  │    ├─ maybeRunWorkspaceTrustPrompt()   # 工作区信任（可能已启动事件循环）
  │    ├─ initMainTui() → init()
  │    │     ├─ setExperimentalFeatures / authFlow.refreshAvailableModels
  │    │     ├─ resume 分支：-S <id>（校验 workDir 匹配）或 -c（列最近会话）
  │    │     ├─ engineV2 分支：hydrateLazyConfigDefaults → 无会话启动（首次消息才创建）
  │    │     └─ 否则 harness.createSession
  │    ├─ mountFooter / renderWelcome / loadBanner / setupAutocomplete
  │    ├─ startEventLoop()  # ui.start() + 剪贴板提示 + focus/主题追踪
  │    └─ finishStartup()   # 配置警告 / 会话回放 / sessionEventHandler.startSubscription / 技能+插件命令刷新
  └─ tui.onExit → shutdownTelemetry → "Bye!" + resume 提示 → 恢复 stty → exit
```

**信号处理与终端恢复是精心设计的防线**：SIGHUP/死终端 EIO → `emergencyTerminalExit`（不做清理，防 EIO 写循环烧 CPU）；SIGTERM → 正常 `stop()`（逐步拆组件、关会话、harness.close、drainInput）后 exit 143。`stop()` 的顺序刻意"先停所有 requestRender 来源，再拆 UI"，防止 stop 后定时器继续触发渲染。

### 4.3 非交互 `-p` 模式的事件状态机

```
runPrompt → resolvePromptSession（-S 精确 / -c 最近 / 新建 auto 权限）
  → runPromptTurn: 订阅 session.onEvent，驱动 session.prompt(prompt)
       │
       │  事件过滤规则：只处理 main agent (agentId==='main') 且
       │  turnId 匹配当前 activeTurnId 的事件
       ▼
  turn.started ──→ activeTurnId = id
  assistant.delta / thinking.delta / tool.call.delta
       ──→ PromptTranscriptWriter / PromptJsonWriter 缓冲写入
  turn.step.started / interrupted ──→ flushAssistant()
  turn.step.retrying ──→ discardAssistant() + 写 retry 通知
  tool.call.started / tool.result ──→ 工具调用块
  turn.ended(reason='completed') ──→ flushAssistant() + evaluateRunCompletion()
       │
       ▼
  evaluateRunCompletion:
    goal.status==='active'?      → holdEventLoop()（等 goal 续轮）
    cron 任务 nextFireAt!==null? → holdEventLoop()（等 cron 触发）
    否则 → finishCompletedTurn():
            handlePrintMainTurnCompleted() → 'continue'? holdEventLoop
            → finish()（清 keepAliveTimer、unsubscribe、writer.finish、resolve）
  turn.ended(reason≠completed) ──→ finish(Error)（provider.filtered/blocked 专有文案）
  error 事件 ──→ finish(Error)
```

**事件循环保持（keep-alive）技巧**：`session.prompt` 返回≠run 完成——active goal 或未来 cron 任务会从空闲会话再触发新 turn。而 cron 调度器的 tick 是 `unref'd` 的，若不持有 ref'd handle，进程会在下一轮触发前排空退出。`holdEventLoop()` 用一个 **60s 的 no-op `setInterval`（ref'd）** 作为该 handle，`finish()` 必定清理它。

### 4.4 TUI 运行时消息流（SDK 事件 → 屏幕）

```
SDK Session (agent-core v1 KimiCore RPC / v2 klient+memory transport)
  │  session.onEvent(event)        # 事件总线（session 级订阅）
  ▼
SessionEventHandler.startSubscription()
  │  event.sessionId 不匹配 → 丢弃；host.aborted → 丢弃
  │  SubAgentEventHandler.routeChildAgentEvent() → 子代理事件单独走
  ▼
handleEvent(event)  ── switch(event.type) 30+ 分支 ──► 各 handleXxx()
  │   ├─ turn.started/step.started ──► streamingUI.resetToolUi()/setStep()
  │   ├─ assistant.delta ──► streamingUI.appendAssistantDelta() → scheduleFlush()
  │   ├─ thinking.delta ──► appendThinkingDelta()（空 delta 保持 moon spinner）
  │   ├─ tool.call.started/delta ──► registerToolCall()/accumulateToolCallDelta()
  │   ├─ tool.result ──► completeToolResult()（TodoList 工具→todo 面板）
  │   ├─ tool.progress ──► 工具卡片尾部追加输出
  │   ├─ goal.updated ──► 完成消息/生命周期 marker/队列晋升
  │   ├─ shell.output/started ──► shellOutputStreams Map（按 commandId 各自更新）
  │   ├─ mcp.server.status ──► spinner→StatusMessage 原位替换
  │   └─ ... 
  ▼
StreamingUIController
  ├─ 缓冲：pendingAssistantFlush/pendingThinkingFlush/pendingToolCallFlushIds
  ├─ scheduleFlush(): 距上次 flush ≥50ms 才真正落盘（STREAMING_UI_FLUSH_MS=50）
  ├─ flush(): 把增量写入 assistant/thinking 组件，markDirty → ui.requestRender()
  ▼
pi-tui TUI
  ├─ requestRender() → nextTick → scheduleRender()
  │     （16ms MIN_RENDER_INTERVAL_MS 合并；force 模式全清重绘）
  └─ doRender():
        render(width) 渲染组件树 → 行数组
        overlay 合成（模态面板栈）
        提取 CURSOR_MARKER 光标位置
        逐行：raw 字符串引用相等 → 复用上帧处理结果（差分渲染的关键优化）
        否则 normalizeTerminalOutput + 截断 + SEGMENT_RESET
        只把变化的行按行移动 + 重写输出到终端
```

**reverse-RPC 方向**（UI → SDK）：

```
engine 需要批准/提问
  │  requestApproval(payload) / requestQuestion(...)（SDK 回调注册点）
  ▼
registerReverseRPCHandlers(approvalController, questionController, ...)
  ├─ adapter.ts: 核心载荷（diff/shell/file_op/url_fetch...）→ 显示块类型
  ├─ controller.ts: 挂载 ApprovalPanelComponent（临时替换编辑器，焦点管理）
  └─ 用户选择 ──► SDK 响应（decide/answer/dismiss）写回引擎
```

### 4.5 更新预检状态机

```
runUpdatePreflight
  ├─ 环境禁用（KIMI_CODE_NO_AUTO_UPDATE）→ continue
  ├─ 读 install.json
  ├─ [交互] showPendingBackgroundInstallNotice → 上次成功未通知? 打印通知
  ├─ 读缓存 → decidePassiveUpdateTarget(缓存)
  ├─ 无目标 → 后台 refreshUpdateCache()（fire-and-forget）→ continue
  ├─ 有目标：
  │    ├─ 源检测（npm/pnpm/yarn/bun/homebrew/native）
  │    ├─ 自动安装可行 & config 允许 & 失败<2 次 & 无活跃安装
  │    │     → 后台安装（install.lock 锁 + detached 静默子进程 + install.json 状态迁移）
  │    ├─ 否则 1s 前台刷新（prompt-refresh 限时，超时用缓存值）
  │    └─ 决策：
  │         ├─ prompt-install → 交互询问 → spawn 安装 → 'exit'（要求重启）
  │         └─ manual-command → 打印升级命令 → continue
```

后台安装状态机（install.json）：

```
empty → active{version,startedAt} → lastSuccess{installedAt,notifiedAt:null}
                                  → lastFailure{attempts} (≤2，超出改提示)
         next 启动时：notifiedAt==null → 打印"已更新"通知并落 notifiedAt
```

### 4.6 会话生命周期（TUI 侧）

```
（v2 引擎）TUI 启动无会话 → 用户第一条消息 ──► ensureSession() → lazyCreateSession()
   （ensureSessionPromise 共享，并发首用不重复创建）
→ setSession() → activateRuntime() → registerSessionHandlers()
→ 输入 handleUserInput → sendNormalUserInput → enqueueMessage → sendQueuedMessage
   （streamingPhase!=='idle' 时入队 queuedMessages，drainOneQueuedMessage 逐条派发）
→ closeSession/reason → unloadCurrentSession → clearReverseRpcPanels → resetRuntimeState
```

---

## 5. 重要实现细节

### 5.1 差分渲染 TUI 库（pi-tui）的关键设计

`apps/kimi-code` 的 TUI 完全建立在自研 `@moonshot-ai/pi-tui` 上（**不是 react/ink**）：

- **组件树 + 强制渲染周期**：`Component` 接口 + `Container`（children 数组）；`TUI extends Container` 持有 `ProcessTerminal`。
- **请求合并**：`requestRender(force?)` 置标志后 `process.nextTick` → `scheduleRender`：距上次渲染不足 16ms 则延迟补齐；渲染后若期间又有请求则继续排（连续动画时退化为约 60fps）。
- **逐行差分**：`doRender` 把整树渲染为行数组，与上帧 `previousRawLines` 逐行比较；**组件渲染缓存返回相同的字符串引用**是复用通道——未变化的行直接复用上帧已处理的输出（`normalizeTerminalOutput` + 截断 + `SEGMENT_RESET` 都不用重做），只需移动光标重写变化行。这也是 `KimiTUI` 里多次出现的 `children[idx] = status` "原位替换"能被容器 ref 检查缓存识别的原因（session-event-handler 的 MCP spinner→StatusMessage 替换有注释明确提到）。
- **光标标记**：组件渲染内容中嵌入 `CURSOR_MARKER`，`extractCursorPosition` 从可视视口底部向上扫出光标行列，输出前剥离。
- **Kitty 键盘协议**：`terminal.ts` 有 `kittyProtocolActive`；AGENTS.md 专门规定输入比较必须先 `printableChar(data)` 解码 CSI-u 序列（VSCode 终端里普通字符以 `\x1b[113u` 形式到达），`test/tui/printable-key-guard.test.ts` 在 CI 强制。
- **Overlay 栈**：模态面板（审批/提问/选择器）通过 `showOverlay/hideOverlay` 叠加渲染 + 焦点恢复策略（`preserve`/`clear`），关闭时恢复焦点到之前组件。
- **终端完整性**：raw 模式、光标、bracketed paste、OSC 11 背景查询、Kitty 图片（`previousKittyImageIds` 管理增量删除）、`drainInput`（退出前排空 stdin，防 Kitty key-release 事件泄漏到父 shell）。

### 5.2 事件流与流式渲染的工程细节

- **50ms flush 节流**：`scheduleFlush` 只在有 pending 时排一次定时器，`STREAMING_UI_FLUSH_MS=50`——高吞吐 delta 流（如长思考）合并成每 50ms 一次的 DOM 更新，`flushNow()` 在 turn 边界/tool 边界强制落盘。
- **空 thinking delta 的坑**（`handleThinkingDelta` 注释）：加密/脱敏 reasoning（Kimi 经 Anthropic 兼容协议）流出的 thinking delta 可见文本为空或仅空白——若此时切到 'thinking' 面板模式会停掉 moon spinner 但 ThinkingComponent 永远建不出来（它需要可见文本），留下无 spinner 的空窗。处理：`event.delta.trim().length===0 && !hasThinkingDraft()` 时**保持 waiting spinner**。
- **turn 折叠**：`mergeCurrentTurnSteps`/`foldCurrentTurnContent`/`mergeAllTurnSteps`——长 turn 的中间步骤折叠成摘要，`trimTranscriptWindow` 控制 transcript 窗口长度（防内存与终端滚动爆炸）。
- **goal 队列晋升竞态防护**：`queuedMessageDispatchPending` 标志解决"队列已被 shift 但延迟发送尚未执行"窗口期；`scheduleQueuedGoalPromotion` 用 setTimeout(0) 序列化，`isReadyForQueuedGoalPromotion` 检查 streamingPhase==='idle' && 队列空 && 无 pending dispatch，任一环节失配就回滚（`restoreAndCancelStartedQueuedGoal`）。

### 5.3 进程级健壮性

- **headless 双保险**：`kimi -p` 不主动 `process.exit`，靠事件循环自然排空退出；`finalizeHeadlessRun` 先 drain stdio（10s 上限）再挂 unref'd 2s 兜底强杀。注释里记录了完整的问题史：HTTP/2 PING 保活、黑洞连接、遗留 socket 都会 wedge 事件循环。
- **清理限时**：`raceWithTimeout(promise, PROMPT_CLEANUP_TIMEOUT_MS)`——超时后放弃等待但**不吞掉快速失败的 rejection**（catch 里 `if (timedOut) return; throw error`），且定时器保持 ref'd，防止清理逻辑挂在 unref'd handle 上导致循环排空提前 exit 0。
- **信号退出码**：`signalExitCode` 按 POSIX 128+signum（SIGINT→130、SIGHUP→129、SIGTERM→143）。
- **stty 保存/恢复**：`stty -g` 存状态、`stty -ixon` 关流控、退出时 `spawnSync('stty', args)` 恢复；崩溃路径（uncaughtException/unhandledRejection/SIGHUP）都走 `emergencyExit`/`emergencyTerminalExit` 恢复终端——注释强调"crash log 只进了异步 sink，必须同步 flush 否则 process.exit 丢掉唯一解释崩溃原因的那行"。
- **重复 runShell 不泄漏监听器**：`removeCrashHandlers` 在干净退出时摘掉 process 监听（测试里同一进程多次 runShell）。

### 5.4 SEA 打包与原生资产

- **为什么不直接 require node-pty**：SEA 二进制里没有 node_modules，`.node` 文件以 blob 资产形式内嵌（`node --experimental-sea-config` 的 `assets` 字段），运行时解包到版本化+manifest-hash 化的缓存目录。
- **校验链**：manifest 内嵌每个文件的 sha256 → 解包时逐文件校验 → 写盘用 tmp+rename 原子替换（rename 失败且目标已正确则吞掉）→ `ensureEntryFile` 写 `node_modules/.kimi-native-entry.cjs`（`module.exports = require`），让缓存树可被 createRequire 当作包根。
- **路径安全**：manifest 校验器拒绝绝对路径、`..`、空段、重复 key；`resolveAssetPath` 二次防穿越；target 与版本段都做 `sanitizeSegment`（只留 `[a-zA-Z0-9._-]`）。
- **缓存 GC**：启动时后台清理同 (version,target) 下非当前 hash 目录（保留最新兄弟目录作防御），fire-and-forget，错误只收集不抛。
- **module hook 的匹配模式**：`/native[\\/](?:win32|darwin)[\\/]prebuilds[\\/].+\.node$/`——注释特意说明路径是 `native/<os>/prebuilds/<arch>/<file>.node`，`prebuilds` 后有两个段所以用 `.+`（不是 `[^/]+`）跨平台匹配。

### 5.5 v1 → v2 引擎迁移模型

- **统一门面**：`createKimiHarnessV2` 返回同一个 `KimiHarness` 类型，内部是 `SDKRpcClientV2`（`extends SDKRpcClientBase`）。**未迁移的方法回落到 `getRpc()` 的 `not_implemented` 响亮失败**——迁移是"逐个方法覆盖"的清单制，`.tmp/v2-migration-tracker.md` 跟踪。
- **v2 客户端架构**：进程内 `bootstrap()` 出 agent-core-v2 `Scope` → `createKlient({scope: app})`（klient/memory 内存传输）→ 所有调用走 klient 契约 + JSON 往返。绕过 klient facade 的深 import（`engineAccessor`）用于 facade 没覆盖的服务（workspace skill catalog、session-scope MCP、agent-scope goal/task）。
- **事件桥**：v2 引擎的 `IEventBus` DomainEvent 经 `event-mapper.ts` 翻译回 v1 `Event` 形状；**故意绕过 klient events hub**（它只注册 13 种总线类型，缺 `shell.*`/`turn.step.*`）。approval/question 由 v2 interaction kernel 的 `onDidChangePending` 驱动，结果经 `ISessionApprovalService.decide` 写回。
- **懒会话**：v2 引擎下 TUI 以"无会话"启动（`SESSIONLESS_STARTUP_NOTICE`），首个消息才 `lazyCreateSession`；skill/plugin 命令在会话前就能从 workspace 全局拿（`listWorkspaceSkills`/`listPluginCommands`）。`--model`/`--agent`/`--plan` 等启动标志存到 appState，首次创建时应用。
- **print 模式**：v2 不走 SDK 层（`run-v2-print.ts` 直接驱动原生服务 + `Turn.result`），与 TUI 的 v2 路径（SDK 客户端）是两条独立代码路径。

### 5.6 其它值得注意的设计决策

- **OAuth 凭据不迁移**（migration）：安全决策——迁移器绝不复制 credentials；只有 oauth-only 数据时直接判定"无可迁移"。
- **CDN manifest 非 strict zod**：向后兼容的显式工程决策，防止未来加字段破坏旧客户端。
- **Windows spawn 走 shell**：CVE-2024-27980 后 Node 对 `.cmd/.bat` 无 shell 抛 EINVAL；`installUpdate` 与后台安装都处理了这一点；后台安装还 `windowsHide: true` 防"静默更新弹出控制台窗口"。
- **`set -o pipefail` 防假成功**：`curl … | bash` 管道里 curl 失败时 bash 仍 exit 0，加 pipefail 让 curl 的非零状态浮上来。
- **telemetry 的 crash phase**：`setCrashPhase('startup'|'runtime'|'shutdown')` 贯穿整个生命周期，崩溃报告带阶段信息。
- **`kimi web` 的 token 轮换**：`web rotate-token` 是唯一的管理子命令；旧版遗留服务器用隐藏 `server kill` 清理（pre-0.28.0 的进程不会自我注册实例）。

---

## 6. 关键代码位置索引

### 入口与 CLI 层

| 位置 | 说明 |
|---|---|
| `src/main.ts:56` | `handleMainCommand`：可复用命令处理器（validate → preflight → runPrompt/runShell） |
| `src/main.ts:143` | `main()`：进程级装配（crash handlers/proxy/native hook/minidb worker/缓存 GC） |
| `src/main.ts:193` | 失败路径：先同步设 `process.exitCode=1` 再 await 日志（防 drain-exit 变 0） |
| `src/cli/commands.ts:19` | `createProgram`：Commander 全命令面（主选项 + 12 子命令 + 隐藏命令） |
| `src/cli/commands.ts:141` | 兜底 action：新旧选项归一 → `CLIOptions` → `onMain` |
| `src/cli/options.ts:64` | `validateOptions`：15 条选项冲突规则 |
| `src/cli/options.ts:21` | `resolveOutputFormat`：flag > env > text 优先级 |
| `src/cli/run-shell.ts:39` | `runShell`：交互启动全装配 |
| `src/cli/run-shell.ts:157` | stty 保存/`-ixon`/崩溃恢复 |
| `src/cli/run-shell.ts:180` | `emergencyExit`：同步 flush 日志 + 终端恢复 + exit |
| `src/cli/run-shell.ts:218` | `tui.onExit`：Bye!/resume 提示/前台任务移交 |
| `src/cli/run-prompt.ts:55` | `raceWithTimeout`：清理限时且不吞快速失败 |
| `src/cli/run-prompt.ts:98` | `runPrompt`：v2 分派 + headless goal 模式 |
| `src/cli/run-prompt.ts:392` | `forcePromptPermission`：恢复会话临时提权 auto |
| `src/cli/run-prompt.ts:467` | `runPromptTurn`：print 模式事件状态机 + keep-alive interval |
| `src/cli/run-prompt.ts:431` | `installPromptTerminationCleanup`：信号→清理→128+signum 退出 |
| `src/cli/headless-exit.ts:29` | `scheduleHeadlessForceExit`：unref'd 兜底强杀 |
| `src/cli/headless-exit.ts:63` | `drainStdio`：空 write 回调探测排空 |
| `src/cli/telemetry.ts:39` | `createCliTelemetryBootstrap`：deviceId/首启 |
| `src/cli/version.ts:40` | `getVersion`：build-info 优先，package.json 回落 |
| `src/cli/experimental-v2.ts:25` | `isLegacyEnabled`：`KIMI_CODE_LEGACY_FLAG` 引擎开关 |

### 更新子系统

| 位置 | 说明 |
|---|---|
| `src/cli/update/preflight.ts:670` | `runUpdatePreflight`：全流程（三阶段 rollout 检查 + 后台安装 + 交互提示） |
| `src/cli/update/preflight.ts:490` | `installUpdate`：spawn 安装（win32 shell、pipefail） |
| `src/cli/update/preflight.ts:517` | `startBackgroundInstall`：detached 静默子进程 + install.json 状态机 |
| `src/cli/update/rollout.ts:24` | `rolloutBucket`：sha256(deviceId:version)%100 |
| `src/cli/update/rollout.ts:34` | `rolloutDelayForBucket`：批次区间映射，钳 24h |
| `src/cli/update/cdn.ts` | `latest.json` zod 非 strict schema |
| `src/cli/update/install-state.ts` | 后台安装状态（active/failure/success） |
| `src/cli/update/install-lock.ts` | 跨进程安装锁 |
| `src/cli/update/source.ts` | 安装源检测 |

### TUI 层

| 位置 | 说明 |
|---|---|
| `src/tui/kimi-tui.ts:314` | `class KimiTUI`：全局协调器 |
| `src/tui/kimi-tui.ts:401` | 构造函数：控制器装配 + reverse-rpc 注册 + 布局 |
| `src/tui/kimi-tui.ts:583` | `start()`：信号处理→迁移屏/信任提示→initMainTui→事件循环 |
| `src/tui/kimi-tui.ts:812` | `init()`：会话创建/恢复（resume/picker/懒创建三分支） |
| `src/tui/kimi-tui.ts:889` | v2 懒会话启动（`SESSIONLESS_STARTUP_NOTICE`） |
| `src/tui/kimi-tui.ts:924` | `stop()`：先停渲染源再拆 UI 的有序关闭 |
| `src/tui/kimi-tui.ts:983` | `registerSignalHandlers`：SIGTERM 正常关闭 / SIGHUP 紧急退出 |
| `src/tui/kimi-tui.ts:1036` | `emergencyTerminalExit`：EIO 死终端防烧 CPU |
| `src/tui/kimi-tui.ts:1238` | `drainOneQueuedMessage`：消息队列逐条派发 |
| `src/tui/kimi-tui.ts:1735` | `createSessionFromCurrentState`（v2 懒创建） |
| `src/tui/kimi-tui.ts:2365` | `trimTranscriptWindow`：transcript 窗口裁剪 |
| `src/tui/kimi-tui.ts:3113` | `runMigrationScreen`：迁移屏接入 |
| `src/tui/kimi-tui.ts:3355` | `showApprovalPanel` / `showQuestionDialog` |
| `src/tui/tui-state.ts:28` | `TUIState`：全局 UI 状态单一形状 |
| `src/tui/tui-state.ts:65` | `createTUIState`：基件装配（ProcessTerminal→TUI→容器→editor→footer） |
| `src/tui/types.ts:27` | `AppState`：TUI 全局状态字段语义 |
| `src/tui/types.ts:190` | `TranscriptEntry`：transcript 条目形状（kind/渲染模式/载荷） |
| `src/tui/controllers/session-event-handler.ts:202` | `startSubscription`：事件订阅入口 |
| `src/tui/controllers/session-event-handler.ts:257` | `handleEvent`：30+ 事件类型分发 switch |
| `src/tui/controllers/session-event-handler.ts:488` | `handleThinkingDelta`：空 delta 保持 spinner 的边界处理 |
| `src/tui/controllers/session-event-handler.ts:748` | `scheduleQueuedGoalPromotion`：goal 队列晋升 |
| `src/tui/controllers/streaming-ui.ts:42` | `class StreamingUIController`：流式渲染缓冲 |
| `src/tui/controllers/streaming-ui.ts:455` | `scheduleFlush`：50ms 节流 |
| `src/tui/controllers/session-replay.ts` | resume 回放渲染 |
| `src/tui/reverse-rpc/types.ts` | 审批/提问显示块契约 |
| `src/tui/reverse-rpc/index.ts` | `registerReverseRPCHandlers`：SDK 回调↔面板接线 |
| `src/tui/commands/dispatch.ts` | `dispatchInput`：slash 输入分派 |
| `src/tui/commands/registry.ts` | 内置 slash 命令注册表 |
| `src/tui/theme/colors.ts` | ColorPalette 语义令牌（dark/light） |
| `src/tui/config.ts` | tui.toml 配置加载（失败回落） |
| `src/tui/constant/streaming.ts:10` | `STREAMING_UI_FLUSH_MS = 50` |

### 原生层 / 迁移 / 反馈 / 常量

| 位置 | 说明 |
|---|---|
| `src/native/native-assets.ts:258` | `getSeaAssetSource`：node:sea 资产访问 |
| `src/native/native-assets.ts:362` | `ensureNativeAssetTree`：解包+sha256 校验+原子写 |
| `src/native/native-assets.ts:419` | `getNativePackageRoot`：包根解析（module-hook 重定向目标） |
| `src/native/native-assets.ts:474` | `cleanupStaleNativeCache`：缓存 GC |
| `src/native/module-hook.ts:26` | `installNativeModuleHook`：`Module._load` patch |
| `src/native/minidb-worker.ts:37` | `installMinidbTextBuildWorker`：SEA worker 安装 |
| `src/native/web-assets.ts` | vis Web 前端资产 |
| `src/built-in-catalog.ts:5` | 构建期注入的 models.dev 目录 |
| `src/migration/detect-pending.ts:25` | `detectPendingMigration`：启动前迁移检测 |
| `src/migration/migration-screen.ts:79` | `MigrationScreenComponent`：ask→progress→result 状态机 |
| `src/feedback/upload.ts:59` | `uploadArchive`：分片并发上传（3 路/重试 3） |
| `src/constant/app.ts` | 全部路径/URL/超时常量 |
| `scripts/native/build.mjs` | SEA 5 步构建编排 |
| `scripts/native/01-bundle.mjs` | tsdown 单文件 bundle + worker bundle |
| `scripts/native/02-sea-blob.mjs` | sea-config 生成与 blob 构建 |
| `scripts/native/03-inject.mjs` | postject 注入（sentinel fuse + macho 段） |
| `scripts/postinstall.mjs` | 旧 Python CLI shim 清理 |

### 上游接线（SDK / v2 引擎）

| 位置 | 说明 |
|---|---|
| `packages/node-sdk/src/sdk-rpc-client.ts:138` | `createKimiHarness`：v1 SDKRpcClient + KimiHarness |
| `packages/node-sdk/src/sdk-rpc-client-v2.ts` | `createKimiHarnessV2`：bootstrap + klient memory transport；文件头注释是完整的 v1→v2 迁移清单 |
| `packages/node-sdk/src/v2/event-mapper.ts` | v2 DomainEvent → v1 Event 翻译 |
| `packages/node-sdk/src/v2/session-wiring.ts` | 每活会话的事件总线接线 + approval/question 桥 |
| `packages/pi-tui/src/tui.ts:308` | `class TUI`：差分渲染主类 |
| `packages/pi-tui/src/tui.ts:735` | `requestRender` / `scheduleRender`：16ms 合并 |
| `packages/pi-tui/src/tui.ts:doRender` | 逐行 diff + 引用复用 + 光标提取 |
| `packages/pi-tui/src/terminal.ts:99` | `ProcessTerminal`：raw 模式/Kitty 协议/OSC 查询 |

---

## 7. 与其它子系统的接口

### 7.1 对外暴露的 API（被谁调用）

`apps/kimi-code` 是最终产品，**对外暴露的是二进制与 CLI 契约**，不是库 API：

- **`bin: kimi` → `dist/main.mjs`**（npm 全局安装后的可执行入口；SEA 原生构建则是一个自包含可执行文件）。
- **CLI 契约**：`kimi [options]`（§3.1 全量选项）、12 个子命令（`export/provider/acp/web/login/doctor/vis/migrate/upgrade/__plugin_run_node`）。
- **隐藏的 ACP 入口**：`kimi acp`（v2 原生 ACP server，`AuthMethodTerminal.args=['--login']` 引导 ACP 客户端重调 `kimi acp --login` 完成设备码登录）——这是被 **IDE/宿主 ACP 客户端**调用的协议面。
- **`kimi web` 的本地服务器**：REST + WebSocket + Web UI（kap-server 提供），浏览器/IDE 通过 `http://localhost:<port>` 访问；实例注册表允许多实例共享 home 并自动取空闲端口。
- **`kimi vis`**：本地可视化服务器（vis-server），浏览器访问 URL。
- **`__plugin_run_node`**（隐藏）：供插件运行时用 `kimi __plugin_run_node <entry> <args>` 在宿主 CLI 的 Node 环境里执行插件入口（`runPluginNodeEntry`）。

### 7.2 消费的子系统接口（调用谁）

| 接口 | 消费方式 |
|---|---|
| `@moonshot-ai/kimi-code-sdk` | `createKimiHarness(V2)`/`KimiHarness`/`Session`/`Event`（30+ 类型）/`KimiConfig`/`ErrorCodes`/catalog 工具 —— **唯一的核心能力入口** |
| `@moonshot-ai/agent-core-v2` | 经 SDK v2 客户端；`run-v2-print.ts`/`acp-native.ts` 直接深 import 原生服务（`bootstrap`/`IAgentPromptService`/`IEventBus` 等） |
| `@moonshot-ai/pi-tui` | `TUI`/`Container`/`Component`/`ProcessTerminal`/`CustomEditor` 基件 + `SlashCommand`/`AutocompleteItem` 类型 |
| `@moonshot-ai/kimi-telemetry` | `track`/`withTelemetryContext`/`setCrashPhase`/`initializeTelemetry`/`shutdownTelemetry` |
| `@moonshot-ai/kimi-code-oauth` | `KimiAuthFacade`（经 SDK）、`createKimiDeviceId`、`fetchCustomRegistry`/`CustomRegistrySource`、identity/UA 构造 |
| `@moonshot-ai/migration-legacy` | `detectMigration`/`resolveMigrationScope`/`runMigration`/`shouldSuppressMigration` |
| `@moonshot-ai/minidb` | 会话存储（`worker-runtime` 配置，SEA worker 模式） |
| `@moonshot-ai/kap-server` | `startServer`/`RunningServer`（`kimi web`） |
| `@moonshot-ai/acp-adapter` | `runAcpServer`（仅 legacy 路径） |
| `@moonshot-ai/vis-server` | 可视化服务器启动（`kimi vis`） |
| 外部服务 | CDN（`code.kimi.com/kimi-code`：latest/latest.json/install.sh/plugins 市场）、Kimi 后端（provider/遥测/反馈上传/设备码认证） |

### 7.3 数据/状态契约要点

- **事件契约**：SDK `Event` 判别联合（`turn.*`/`tool.*`/`assistant.delta`/`goal.updated`/`shell.*`/`cron.fired`/`mcp.server.status`…）是 TUI 与引擎之间的**主协议**；v2 引擎的 DomainEvent 由 `event-mapper.ts` 翻译成同一形状——TUI 层对引擎版本无感知（除了 `engineV2` 标志影响会话创建时机）。
- **持久化契约**：`KimiConfig`（config.toml）、tui.toml（`TuiConfig`）、`install.json`/`latest.json`/`rollout.log`（更新）、banner state、输入历史、goal 队列（`goal-queue-store.ts`，存会话内）。
- **文件系统布局**：`~/.kimi-code/`（数据：logs/cache/updates/bin/user-history/banner）+ 平台缓存目录（`~/Library/Caches/kimi-code` / `LOCALAPPDATA` / `XDG_CACHE_HOME`，原生资产）——`resolveKimiHome` 由 SDK 提供，`getDataDir`/`getNativeCacheBase` 在本包实现。

---

## 附：架构总评（要点速览）

1. **壳-引擎分层极干净**：CLI/TUI 不碰 agent-core，一切经 SDK 门面；v1→v2 引擎切换只改一个工厂函数 + 一个环境变量。
2. **进程生命周期是重中之重**：终端恢复（stty/raw 模式/光标）、headless 退出双保险、信号语义——这是 CLI 产品与普通 Web 服务最大的工程差异，代码里到处是这类防御的注释。
3. **SEA 打包把"桌面级"体验做进了 npm 包**：`.node` 资产内嵌 + 校验解包 + 缓存 GC + require 重定向，是 `node-pty` 这类原生依赖能进单二进制的原因。
4. **TUI 是自研差分渲染引擎**（非 ink/react）：16ms 合并 + 引用相等的行复用 + 光标标记提取，配合 50ms 流式 flush 节流，在慢终端上也保持流畅。
5. **更新系统是完整的产品级实现**：灰度滚动发布（确定性分桶）、后台静默安装状态机、跨进程锁、安装源感知、失败退让策略——远超一般 CLI 的"检查一下版本"。
