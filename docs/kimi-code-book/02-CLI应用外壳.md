# 第 2 章 CLI 应用外壳：启动、更新与 SEA 打包

> 研究对象：`apps/kimi-code`（`@moonshot-ai/kimi-code`，约 5.5 万行 TS，292 个文件）。
> 学习目标：理解 `kimi` 进程从 argv 到 TUI 的完整旅程，以及"桌面级 CLI 产品"的进程生命周期工程（终端恢复、更新灰度、单二进制打包）。

## 2.1 定位：夹在用户终端与 agent 引擎之间的外壳

`apps/kimi-code` 是用户执行 `kimi` 时实际运行的进程，仓库根 AGENTS.md 给出的入口链：

```
src/main.ts -> src/cli/commands.ts -> src/cli/run-shell.ts
   -> SDK KimiHarness -> src/tui/kimi-tui.ts
```

它不实现任何 agent 逻辑——所有能力（会话、工具、流式事件、审批）都经 `@moonshot-ai/kimi-code-sdk` 的 `KimiHarness`/`Session` 门面获得。AGENTS.md 有硬性约束：**`apps/kimi-code` 不得直接 import `@moonshot-ai/agent-core`**（v1 时代产物）。引擎切换仅靠一个工厂函数 + 一个环境变量：

| 路径 | 机制 |
|---|---|
| v1（legacy） | `createKimiHarness()` → `SDKRpcClient` → 进程内 `KimiCore`（agent-core RPC 服务）+ JSON-RPC |
| v2（默认） | `createKimiHarnessV2()` → 进程内 `bootstrap()` agent-core-v2 DI 容器 → `createKlient({scope: app})`（klient/memory 内存传输）→ 所有调用走 klient 契约校验 + JSON 往返，**与网络传输走同一条验证路径** |

`kimi web` 是例外：它在当前进程内直接启动 kap-server（`startServer()`），不经过 KimiHarness。

## 2.2 模块地图（src/）

```
src/
├── main.ts               # 进程入口：Commander 解析、preflight、分发
├── built-in-catalog.ts   # 构建期注入的 models.dev 目录快照（tsdown define）
├── cli/
│   ├── commands.ts       # createProgram：主命令面 + 全部子命令注册
│   ├── options.ts        # CLIOptions + validateOptions 冲突校验
│   ├── run-shell.ts      # 交互模式启动（stty、crash 恢复、KimiTUI 装配）
│   ├── run-prompt.ts     # 非交互 -p 模式（事件→输出渲染、goal 模式）
│   ├── headless-exit.ts  # headless 收尾：drain stdio + 兜底强杀
│   ├── update/           # 更新预检：cdn/rollout/install-lock/install-state/preflight
│   ├── sub/              # 子命令：acp/doctor/export/login/provider/upgrade/vis/web
│   └── v2/               # run-v2-print.ts（v2 原生 print runner）
├── tui/                  # 交互式终端 UI（kimi-tui.ts 单文件 3445 行）
├── native/               # SEA 原生资产：module-hook/native-assets/minidb-worker
├── migration/            # ~/.kimi → ~/.kimi-code 迁移（检测 + TUI 屏）
├── feedback/             # 反馈提交：zip 打包 + 分片上传
└── constant/ utils/ generated/
```

## 2.3 进程启动时序

```
main()
  ├─ 1. process.title / installCrashHandlers（kimi-telemetry 全局未捕获记录）
  ├─ 2. installGlobalProxyDispatcher（全局 fetch → HTTP_PROXY/HTTPS_PROXY，NO_PROXY 生效）
  ├─ 3. installNativeModuleHook（SEA .node 资产重定向）
  ├─ 4. installMinidbTextBuildWorker（SEA worker 解包，失败降级内联）
  ├─ 5. runNativeAssetSmokeIfRequested?（KIMI_CODE_NATIVE_SMOKE=1 专用退出）
  ├─ 6. queueMicrotask: cleanupStaleNativeCacheForCurrent（fire-and-forget）
  └─ 7. createProgram(...).parse(argv)
handleMainCommand ── validateOptions ──(冲突)→ exit 1
  ── runUpdatePreflight ──(exit)→ process.exit(0)
  ── uiMode == 'print' ? → runPrompt（headless）→ finalizeHeadlessRun
                        └→ runShell（interactive）
```

一个值得学习的失败路径技巧（main.ts:193）：**同步先设 `process.exitCode = 1` 再 await 日志**——失败的 `finally` 清理会先拆掉已注册的 handle，事件循环可能在 await 期间自然排空并以默认码 0 退出，导致 `kimi -p` 失败却返回 0 的非确定性 bug。

`handleMainCommand` 是**可复用、可单测的处理器**，自身不终止进程——`validateOptions`（15 条显式规则清单，非 zod：prompt 非空、prompt 不能配 yolo/auto/plan、agent 与 agent-file 互斥、session 与 continue 互斥……）→ `runUpdatePreflight` → 分发。

### 2.3.1 CLI 命令面（createProgram）

主命令选项：`-S/--session [id]`、`-r/--resume`（隐藏）、`-c/--continue`、`-y/--yolo`、`--auto`、`-m/--model`、`-p/--prompt`、`--output-format`、`--skills-dir`、`--agent/--agent-file`、`--add-dir`、`--plan`。

子命令：`export`、`provider`（add/list/catalog）、`acp`、`web`（+隐藏 `server kill`、`web rotate-token`）、`login`、`doctor`、`vis`、`migrate`、`upgrade`（alias `update`）、隐藏的 `__plugin_run_node`（供插件在宿主 Node 环境执行入口）。

末尾的 `program.argument('[args...]')` 兜底 action 做新旧选项归一（`--resume`→`session`、`--yes`/`--auto-approve`→`yolo`）。

## 2.4 交互模式启动（runShell → KimiTUI）

```
runShell(opts, version)
  ├─ loadTuiConfig()            # tui.toml；失败→fallback+warning
  ├─ getColorPalette + currentTheme.setPalette   # 必须在 pi-tui 抓 stdin 之前
  ├─ createKimiHarnessV2|V1     # engineV2 = !KIMI_CODE_LEGACY_FLAG
  ├─ harness.ensureConfigFile() / getConfig()
  ├─ detectPendingMigration()   # ~/.kimi → 目标 home
  ├─ resolveAgentProfileSelection(--agent/--agent-file)
  ├─ new KimiTUI(harness, {...})
  ├─ initializeCliTelemetry / setCrashPhase('runtime')
  ├─ stty -g 保存 + stty -ixon  # 关 XON/XOFF 流控
  ├─ process.on uncaughtException/unhandledRejection → emergencyExit
  ├─ tui.start()
  │    ├─ registerSignalHandlers()      # SIGTERM→stop(143)；SIGHUP→emergencyExit(129)
  │    ├─ migrationPlan? → runMigrationScreen
  │    ├─ maybeRunWorkspaceTrustPrompt()
  │    ├─ initMainTui() → init()
  │    │     ├─ authFlow.refreshAvailableModels
  │    │     ├─ resume 分支：-S <id> 或 -c（列最近会话）
  │    │     ├─ engineV2 分支：无会话启动（首次消息才创建）← 懒会话
  │    │     └─ 否则 harness.createSession
  │    ├─ mountFooter / renderWelcome / loadBanner / setupAutocomplete
  │    ├─ startEventLoop()
  │    └─ finishStartup()       # 配置警告/会话回放/事件订阅/技能+插件命令刷新
  └─ tui.onExit → shutdownTelemetry → "Bye!" + resume 提示 → 恢复 stty → exit
```

**信号处理与终端恢复是精心设计的防线**：

- SIGHUP/死终端 EIO → `emergencyTerminalExit`（不做清理，防 EIO 写循环烧 CPU）；
- SIGTERM → 正常 `stop()`（逐步拆组件、关会话、harness.close、drainInput）后 exit 143；
- `stop()` 的顺序刻意"先停所有 requestRender 来源，再拆 UI"，防止 stop 后定时器继续触发渲染；
- 崩溃路径（uncaughtException/unhandledRejection/SIGHUP）都走 `emergencyExit`：**同步 flush 日志** + `restoreTerminalModes()` + 恢复 stty + exit——"crash log 只进了异步 sink，必须同步 flush 否则 process.exit 丢掉唯一解释崩溃原因的那行"。

## 2.5 TUI 层结构（src/tui/）

`KimiTUI`（kimi-tui.ts，3445 行）只是**协调器**（装配控制器、转发 slash 命令、处理输入），重逻辑下沉到 controllers/commands/components/reverse-rpc。

### 2.5.1 全局状态形状

- `TUIState`（tui-state.ts:28）：ui/terminal 基件 + 9 个 GutterContainer（transcript/activity/todoPanel/queue/btwPanel/editor）+ footer + editor + appState。
- `AppState`（types.ts:27）：模型/权限/planMode/thinkingEffort/上下文用量/streamingPhase（`'idle'|'waiting'|'thinking'|'composing'|'shell'`）/主题/通知/goal 等 TUI 全局状态的唯一形状。
- `TranscriptEntry`（types.ts:190）：kind 枚举（welcome/user/assistant/tool_call/thinking/status/skill_activation/plugin_command/cron/goal）+ 渲染模式（markdown/plain/notice）+ 各种附加数据载荷。

### 2.5.2 控制器（每个一个可独立测试的职责切片）

| 控制器 | 职责 |
|---|---|
| `session-event-handler.ts`（1202 行） | **SDK 事件路由中枢**：`handleEvent` 按 type 分发到 30+ 私有处理器（turn/step/tool/assistant/thinking/hook/goal/compaction/cron/mcp/subagent/background.task/plugin_command） |
| `streaming-ui.ts`（909 行） | 流式渲染：缓冲 delta，**50ms 节流 flush**，turn 边界折叠、TodoList 结果提取 |
| `session-replay.ts`（785 行） | resume 历史回放渲染（wire.jsonl 重建 transcript） |
| `subagent-event-handler.ts` | 子代理与 AgentSwarm 进度渲染 |
| `tasks-browser.ts` | 后台任务浏览器面板 |
| `editor-keyboard.ts` / `auth-flow.ts` / `btw-panel.ts` | 键盘控制 / 登录流 / 侧问面板 |

### 2.5.3 命令与反向 RPC

- `commands/registry.ts` 注册 ~40 个内置 slash 命令（`/model`、`/yolo`、`/auto`、`/plan`、`/compact`、`/goal`、`/undo`、`/plugins`、`/mcp-config`、`/swarm`、`/fork`…）；`skills.ts`/`plugin-commands.ts` 从 SDK 技能/插件列表**动态生成** slash 命令。
- `reverse-rpc/`：SDK 审批/提问回调 → UI 面板的适配层（`showApprovalPanel`/`showQuestionDialog`），用户选择写回 SDK 响应。显示块类型：brief/diff/shell/file_op/file_content/url_fetch/search。
- `theme/`：颜色令牌系统（单一事实源）——`ColorPalette` dark/light 两套语义令牌，**组件禁止直接用 `chalk.red` 等命名色**（CI 有 `chalk-named-color-guard.test.ts` 强制）。

## 2.6 SDK 事件 → 屏幕的消息流

```
SDK Session（v1 KimiCore RPC / v2 klient+memory）
  │  session.onEvent(event)
  ▼
SessionEventHandler.startSubscription()
  │  event.sessionId 不匹配 → 丢弃；host.aborted → 丢弃
  │  SubAgentEventHandler.routeChildAgentEvent() → 子代理单独走
  ▼
handleEvent(event) ── switch(event.type) 30+ 分支 ──► 各 handleXxx()
  ├─ turn.started/step.started ──► streamingUI.resetToolUi()/setStep()
  ├─ assistant.delta ──► appendAssistantDelta() → scheduleFlush()
  ├─ thinking.delta ──► appendThinkingDelta()（空 delta 保持 moon spinner）
  ├─ tool.call.started/delta ──► registerToolCall()/accumulateToolCallDelta()
  ├─ tool.result ──► completeToolResult()（TodoList 工具→todo 面板）
  ├─ tool.progress ──► 工具卡片尾部追加输出
  ├─ goal.updated ──► 完成消息/生命周期 marker/队列晋升
  ├─ shell.output/started ──► shellOutputStreams（按 commandId 各自更新）
  └─ mcp.server.status ──► spinner→StatusMessage 原位替换
  ▼
StreamingUIController
  ├─ 缓冲：pendingAssistantFlush/pendingThinkingFlush/pendingToolCallFlushIds
  ├─ scheduleFlush(): 距上次 flush ≥50ms 才真正落盘（STREAMING_UI_FLUSH_MS=50）
  ▼
pi-tui TUI
  ├─ requestRender() → nextTick → scheduleRender()（16ms MIN_RENDER_INTERVAL_MS 合并）
  └─ doRender(): 渲染组件树 → 行数组 → overlay 合成 → 提取 CURSOR_MARKER
        → 逐行：raw 字符串引用相等 → 复用上帧处理结果
        → 只把变化的行按行移动 + 重写输出到终端
```

两个边界处理（教科书级）：

- **空 thinking delta 的坑**（handleThinkingDelta 注释）：加密/脱敏 reasoning 流出的 thinking delta 可见文本为空或仅空白——若此时切到 thinking 面板模式会停掉 moon spinner 但 ThinkingComponent 永远建不出来（它需要可见文本）。处理：`event.delta.trim().length===0 && !hasThinkingDraft()` 时**保持 waiting spinner**。
- **goal 队列晋升竞态防护**：`queuedMessageDispatchPending` 标志解决"队列已被 shift 但延迟发送尚未执行"窗口期；`scheduleQueuedGoalPromotion` 用 setTimeout(0) 序列化，任一环节失配就回滚。

## 2.7 非交互 `-p` 模式的事件状态机

```
runPrompt → resolvePromptSession（-S 精确 / -c 最近 / 新建 auto 权限）
  → runPromptTurn: 订阅 session.onEvent，驱动 session.prompt(prompt)
       │  事件过滤规则：只处理 main agent (agentId==='main') 且
       │  turnId 匹配当前 activeTurnId 的事件
       ▼
  turn.started ──→ activeTurnId = id
  assistant.delta / thinking.delta / tool.call.delta ──→ 缓冲写入
  turn.step.started / interrupted ──→ flushAssistant()
  turn.step.retrying ──→ discardAssistant() + 写 retry 通知
  tool.call.started / tool.result ──→ 工具调用块
  turn.ended(reason='completed') ──→ flushAssistant() + evaluateRunCompletion()
       ▼
  evaluateRunCompletion:
    goal.status==='active'?      → holdEventLoop()（等 goal 续轮）
    cron 任务 nextFireAt!==null? → holdEventLoop()（等 cron 触发）
    否则 → finishCompletedTurn()
  turn.ended(reason≠completed) ──→ finish(Error)
```

**事件循环保持（keep-alive）技巧**：`session.prompt` 返回 ≠ run 完成——active goal 或未来 cron 任务会从空闲会话再触发新 turn。而 cron 调度器的 tick 是 `unref'd` 的，若不持有 ref'd handle，进程会在下一轮触发前排空退出。`holdEventLoop()` 用一个 **60s 的 no-op `setInterval`（ref'd）** 作为该 handle，`finish()` 必定清理它。

**headless 退出双保险**（headless-exit.ts）：`kimi -p` 不主动 `process.exit`，靠事件循环自然排空退出；`finalizeHeadlessRun` 先 `drainStdio`（空 write 回调探测缓冲排空，10s 上限）再挂 **unref'd 2s 兜底强杀定时器**——健康运行在它触发前自然退出，只有事件循环被 stray handle 卡死时才强杀。注释记录完整问题史：HTTP/2 PING 保活、黑洞连接、遗留 socket 都会 wedge 事件循环。

**清理限时**（raceWithTimeout）：超时后放弃等待但**不吞掉快速失败的 rejection**，且定时器保持 ref'd——防止清理逻辑挂在 unref'd handle 上导致循环排空提前 exit 0。

## 2.8 更新系统：完整的产品级灰度发布

`src/cli/update/` 六个职责分离的文件，是本包最"产品化"的模块：

### 2.8.1 灰度滚动发布（rollout.ts）

```
rolloutBucket(deviceId, version) = sha256(deviceId:version) 前 4 字节 % 100
rolloutDelayForBatch：按批次数组顺序累加 percent，命中区间取对应 delaySeconds
  （钳到 24h），未覆盖区间落最慢批次
isRolloutEligible：publishedAt + delay 是否已到
```

用 `sha256(deviceId:version)%100` 做**确定性分桶**——同一设备同一版本永远落在同一桶，重启不会在灰度区间边缘横跳。

### 2.8.2 更新预检状态机（preflight.ts，812 行）

```
runUpdatePreflight
  ├─ KIMI_CODE_NO_AUTO_UPDATE 门 → continue
  ├─ 读 install.json
  ├─ [交互] showPendingBackgroundInstallNotice（上次成功未通知?）
  ├─ 读缓存 → decidePassiveUpdateTarget
  ├─ 无目标 → 后台 refreshUpdateCache()（fire-and-forget）→ continue
  ├─ 有目标：
  │    ├─ 源检测（npm/pnpm/yarn/bun/homebrew/native）
  │    ├─ 自动安装可行 & 失败<2 次 & 无活跃安装
  │    │     → 后台安装（install.lock 跨进程锁 + detached 静默子进程 + install.json 状态机）
  │    ├─ 否则 1s 限时前台刷新（超时用缓存值）
  │    └─ 决策：prompt-install（交互询问）或 manual-command（只给命令）
```

后台安装状态机（install.json）：

```
empty → active{version,startedAt} → lastSuccess{installedAt,notifiedAt:null}
                                  → lastFailure{attempts} (≤2，超出改提示)
         next 启动时：notifiedAt==null → 打印"已更新"通知并落 notifiedAt
```

工程细节：

- `latest.json` 用 **zod 故意非 strict** schema——未知字段忽略，避免未来 manifest 加字段弄死已发客户端（该教训来自纯文本 `/latest` 对非 semver 体硬失败）。
- 缓存刷新失败**不覆盖旧缓存**（避免瞬时 CDN 故障把已知最新版冲掉）。
- `installUpdate` 用 `spawn`（win32 走 shell，规避 **CVE-2024-27980** 的 EINVAL）；后台安装 `windowsHide: true` 防"静默更新弹出控制台窗口"。
- native 源用 `set -o pipefail; curl … | bash`——**防 curl 失败被 bash 的 0 掩盖**（假成功）。
- 每个阶段写 `rollout.log` 并上报 telemetry。

## 2.9 SEA 打包：Node 官方单二进制 + postject

**不是 pkg / bun / deno，而是 Node.js 官方 SEA + postject**：

```
scripts/native/（5 步流水线）
  01-bundle.mjs   tsdown 出单文件 ESM main.mjs + worker 单文件
  02-sea-blob.mjs 收集 .node 资产 + web 资产，写 --experimental-sea-config，生成 blob
  03-inject.mjs   复制 node 可执行文件、移除签名、postject 注入 NODE_SEA_BLOB
                  （darwin 用 --macho-segment-name NODE_SEA）
  04-sign.mjs     codesign（本地 ad-hoc，release 用 APPLE_SIGNING_IDENTITY）
  05-verify.mjs   codesign -dv 验证
```

运行时（src/native/）：

- `getSeaAssetSource()`（`node:sea` isSea/getAssetKeys/getRawAsset）→ manifest 强校验（版本、target、相对路径防穿越、sha256 格式）→ 解包到 `~/.cache/kimi-code/native/<version>/<target>/<manifestHash>/`，逐文件 sha256 校验 + tmp+rename 原子写。
- `installNativeModuleHook()`：patch `Module._load`，把 pi-tui 的原生 require（`native/<os>/prebuilds/<arch>/*.node`）重定向到缓存副本——SEA 二进制里这些文件不存在于原路径。
- 缓存 GC：启动时后台清理同 (version,target) 下非当前 hash 目录，fire-and-forget。

**为什么不直接 require node-pty**：SEA 二进制里没有 node_modules，`.node` 文件以 blob 资产形式内嵌，运行时解包——这是 `node-pty` 这类原生依赖能进单二进制的原因。

## 2.10 迁移与反馈

- **迁移**（migration/）：`~/.kimi` → `~/.kimi-code` 检测 + TUI 首启迁移屏（3 阶段状态机 `ask1 → ask2 → progress → result`，4 步进度：config/mcp/user-history/sessions）。**OAuth 凭据故意不迁移**（迁移器绝不复制 credentials——只有 credentials 时视为"无可迁移"，让 /login 重新走认证；只有 oauth-only 数据时返回 null）。
- **反馈**（feedback/）：会话/日志/配置打包 zip → **分片上传**（`createUploadUrl` 返回预签名分片 URL → 并发 3 路 PUT，每片 60s 超时、失败重试 3 次指数退避 → `completeUpload` 提交 etag 列表；总上限 500 MiB）。

## 2.11 v2 原生 print runner（run-v2-print.ts，861 行）

v2 的 `kimi -p` **不经过 KimiHarness/Session**：直接 `bootstrap()` agent-core-v2 app scope → 用原生服务（`IAgentPromptService.enqueue()` + `Turn.result`）驱动一轮 turn → 订阅 per-agent `IEventBus` 渲染原生 `DomainEvent` 流 → 套用 v1 对齐的 print 后台策略（exit/drain/steer）。TUI 的 v2 路径（SDK 客户端）与 print 的 v2 路径是**两条独立代码路径**。

## 2.12 关键代码位置索引

| 位置 | 说明 |
|---|---|
| `src/main.ts:56` | `handleMainCommand`：可复用命令处理器 |
| `src/main.ts:143` | `main()`：进程级装配 |
| `src/main.ts:193` | 失败路径：先同步设 exitCode=1 |
| `src/cli/commands.ts:19` | `createProgram`：全命令面 |
| `src/cli/options.ts:64` | `validateOptions`：15 条冲突规则 |
| `src/cli/run-shell.ts:39` | `runShell`：交互启动全装配 |
| `src/cli/run-shell.ts:157` | stty 保存/`-ixon`/崩溃恢复 |
| `src/cli/run-shell.ts:180` | `emergencyExit` |
| `src/cli/run-prompt.ts:467` | `runPromptTurn`：print 模式事件状态机 + keep-alive interval |
| `src/cli/headless-exit.ts:29` | `scheduleHeadlessForceExit`：unref'd 兜底强杀 |
| `src/cli/update/preflight.ts:670` | `runUpdatePreflight` 全流程 |
| `src/cli/update/rollout.ts:24` | `rolloutBucket`：sha256(deviceId:version)%100 |
| `src/cli/update/cdn.ts` | `latest.json` zod 非 strict schema |
| `src/tui/kimi-tui.ts:314` | `class KimiTUI`：全局协调器 |
| `src/tui/kimi-tui.ts:924` | `stop()`：先停渲染源再拆 UI |
| `src/tui/kimi-tui.ts:983` | `registerSignalHandlers` |
| `src/tui/kimi-tui.ts:1036` | `emergencyTerminalExit`：EIO 防烧 CPU |
| `src/tui/controllers/session-event-handler.ts:257` | `handleEvent`：30+ 事件分发 |
| `src/tui/controllers/streaming-ui.ts:455` | `scheduleFlush`：50ms 节流 |
| `src/tui/reverse-rpc/index.ts` | `registerReverseRPCHandlers` |
| `src/native/native-assets.ts:362` | `ensureNativeAssetTree`：解包+校验+原子写 |
| `src/native/module-hook.ts:26` | `Module._load` patch |
| `src/migration/migration-screen.ts:79` | 迁移屏状态机 |
| `src/feedback/upload.ts:59` | 分片并发上传 |
| `scripts/native/build.mjs` | SEA 5 步构建编排 |
| `packages/node-sdk/src/sdk-rpc-client-v2.ts` | `createKimiHarnessV2`（文件头注释是完整迁移清单） |

## 2.13 本章小结

- 壳-引擎分层极干净：CLI/TUI 不碰 agent-core，一切经 SDK 门面；v1→v2 只改一个工厂函数 + 一个环境变量。
- 进程生命周期是 CLI 产品的核心工程：stty 恢复、SIGHUP 紧急退出、headless 双保险、清理限时——代码里到处是这类防御的事故注释。
- 更新系统是完整产品级实现：确定性灰度分桶、后台静默安装状态机、跨进程锁、安装源感知。
- SEA 打包把"桌面级"体验做进 npm 生态：`.node` 资产内嵌 + 校验解包 + require 重定向。
