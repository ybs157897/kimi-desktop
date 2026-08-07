# 第 6 章 TUI 与 VSCode 集成：两个平行前端

> 研究对象：`packages/pi-tui`（终端 UI 渲染库，约 1.2 万行）与 `apps/vscode`（VS Code 扩展，约 7k 行）。
> 学习目标：理解同一产品的两个架构决策完全相反的前端——CLI 的"免依赖终端图形栈"与扩展的"引擎内嵌 + postMessage 桥"。

## 6.1 两条路线

| | pi-tui 路线（CLI） | vscode 路线 |
|---|---|---|
| 形态 | 长驻进程，自己管理 raw-mode 终端 | 扩展进程内**直接内嵌 Node SDK**（agent-core 全家桶） |
| UI | 自研差分渲染引擎 | React webview，postMessage 桥 |
| 引擎 | 进程内 RPC（SDK） | 进程内（extension host 里跑引擎） |
| 共享 | — | 与 CLI 共享 `KIMI_CODE_HOME` 下的 config/MCP/登录态/会话（但不保证跨进程会话锁，官方禁止同时运行同一会话） |

```
┌────────────────────────────────────────────────────────────┐
│                       Kimi Code 产品矩阵                      │
├──────────────┬──────────────┬───────────────────────────────┤
│  CLI/TUI     │  VS Code 扩展 │  Web / 服务器形态              │
│ apps/kimi-   │ apps/vscode  │ apps/kimi-code (web 模式)      │
│ code         │ (webview+    │   → kap-server (agent-core-v2)│
│   ↓ 渲染      │  extension)  │   → Web UI (code-app 仓库)     │
│ pi-tui       │   ↓ 内嵌      │                               │
│   ↓ 引擎      │ kimi-code-   │                               │
│ kimi-code-sdk│ sdk (agent-   │                               │
│ (agent-core) │ core 全家桶)  │                               │
└──────────────┴──────────────┴───────────────────────────────┘
```

**VSCode 扩展与"通信"无关**：tsdown 把 `agent-core`/`kaos`/`kosong`/`oauth`/`node-sdk` 全部 alias 到源码并打进单个 `dist/extension.js`——扩展是一个**自包含的完整 Kimi Code**，不依赖外部 kap-server 进程。

## 6.2 pi-tui：免依赖的终端图形栈

运行时仅依赖两个 npm 包（`get-east-asian-width`、`marked`），自研了差分渲染、输入管线、终端协议对话、组件库（Editor 2415 行是最大组件）。它的唯一消费者是 `apps/kimi-code`（84 个文件 import）。

### 6.2.1 核心类型

| 符号 | 职责 |
|---|---|
| `Component` | 渲染契约：`render(width): string[]` + `handleInput?(data)` + `invalidate()` |
| `Focusable` | IME 支持：聚焦时在光标处输出 `CURSOR_MARKER`（`\x1b_pi:c\x07` 零宽 APC 序列），TUI 扫描定位后移动硬件光标 |
| `TUI extends Container` | 主引擎：帧缓存（previousLines/previousRawLines/previousLineImageIds）、overlay 栈、视口跟踪、硬件光标行 |
| `ProcessTerminal` | raw mode、bracketed paste、Kitty 协议协商、OSC 9;4 进度 |
| `StdinBuffer` | 字节流 → 完整序列（防拆包），按 CSI/OSC/DCS/APC/SS3 分类判定完整性 |
| `matchesKey(data, keyId)` | 统一按键匹配：Kitty CSI-u → modifyOtherKeys → 传统转义 → 裸字节四级回退 |
| `Editor` | 多行编辑器：undo 栈、kill-ring、历史、paste 标记、自动补全、跳转模式 |

### 6.2.2 差分渲染三策略

```
1. 首帧或尺寸变化 ──▶ fullRender(clear=true)：CSI 2026h + 清屏 [2J[H[3J] + 全量写
2. clearOnShrink 且内容缩短 ──▶ fullRender(clear=true)（默认开）
3. 正常差分 ──▶ 移到 firstChanged 行，每行 [2K 清行后重写 [firstChanged, lastChanged]
                  多余旧行 \r\n\x1b[2K 清掉
   例外：firstChanged < 上一视口顶部 或 kitty 图片越界 ──▶ 退化为 fullRender
```

所有写路径都包在 **synchronized output**（`\x1b[?2026h`…`l`）里——终端延迟合成输出，避免闪烁。Append-only 场景有专门的 `appendStart` 快路径：直接光标下移 + `\r\n` 续写，不做整屏重绘。

### 6.2.3 帧级 processed-line 复用（性能核心）

`doRender` 保留上一帧的 `previousRawLines`（组件 render 缓存的**原始字符串引用**）与 `previousLines`（处理后的输出）。逐行比较 `rawLine === previousRawLines[i]`（**引用相等即未变**），未变行零成本复用处理结果（截断 + normalize + SEGMENT_RESET）与 kitty 图片 id。steady-state 帧（转圈动画）的代价从 O(所有行重处理) 降到 O(行数) 指针比较 + O(变化行) 真活。配套 `asciiVisibleWidth(line, limit)` 快速路径（纯 ASCII 扫描 + 超限早退），只有非 ASCII 行才落到 `visibleWidth`（`Intl.Segmenter` 字素级宽度 + 4096 项 FIFO 缓存）。

### 6.2.4 Kitty 键盘协议协商

```
queryAndEnableKittyProtocol 写入 \x1b[>7u\x1b[?u\x1b[c：
  先声明期望 flags（1=disambiguate，2=事件类型，4=alternate keys）
  → 查询 → DA 查询做哨兵
  不支持 Kitty 的终端会回 DA → 收到 DA 前没等来 Kitty 响应 → 启用 modifyOtherKeys（\x1b[>4;2m）
  两者都收不到 → 退化为传统转义序列
```

协商响应可能跨多个 stdin 事件拆包，用 `keyboardProtocolNegotiationBuffer` + 150ms 冲刷定时器处理。这保证了 Shift+Enter 在 Kitty/Ghostty/WezTerm/iTerm2/xterm/Apple Terminal 上的统一语义（**4 种编码路径**：Kitty CSI-u、modifyOtherKeys、`\x1b\r`、`\n`）。

### 6.2.5 StdinBuffer 的边界处理

- 高字节单字节输入（>127）转换为 `ESC + (byte-128)`（兼容老式 meta 键）；
- WezTerm 的 Escape 键按下以裸 `\x1b` 发出、松开是完整 CSI-u 序列，会粘成 `\x1b\x1b[27;…u`——遇到 `\x1b\x1b` 且后随 `[`/`]`/`O`/`P`/`_` 时只发第一个 ESC 并从第二个重启解析；
- Kitty 打印字符去重：CSI-u 无修饰码点后若跟来相同的裸码点，丢弃裸码点；
- 鼠标 SGR 序列必须完整匹配三段数字才判 complete。

### 6.2.6 粘贴双保险

- bracketed paste（首选）：聚合 `200~…201~`；Editor 对 >10 行的粘贴生成 `[paste #N +M lines]` 原子标记（`segmentWithMarkers` 把标记并入单个字素段——光标移动/删除/换行都视其为整体），大粘贴展开为可折叠块；
- 无 bracketed 支持终端：`PasteBurst` 启发式——8 个字符间隔 ≤8ms 视为粘贴突发，其后的 Enter 被抑制为换行而非提交（120ms 窗口）。

### 6.2.7 宽字符与超宽防御（本地分歧）

- 超宽行一律 `sliceByColumn` 截断而非抛错（上游会写崩溃日志 + throw）；
- `wordWrapLine` 对不可再分的单字素（如 CJK 在 maxWidth=1）不再递归（上游会无限递归爆栈）；
- 负宽度 `repeat` 全部 clamp；
- `normalizeTerminalOutput` 把泰语/老挝语 AM 元音换成兼容分解形式，规避某些终端差分重绘的残留。

### 6.2.8 光标与 IME

`CURSOR_MARKER` 由 Focusable 组件在假光标处输出；TUI 在**可见视口底部 height 行内**倒序扫描 marker，用 `visibleWidth` 算出列位置，把硬件光标移过去（行用相对移动、列用绝对 `CSI n G`），默认隐藏硬件光标（`PI_HARDWARE_CURSOR=1` 可显示，部分终端需要可见光标才能定位 IME 候选窗）。容器组件必须向子组件传播 `focused` 标志，否则 CJK 输入法候选窗位置错误。

### 6.2.9 退出卫生

`drainInput(maxMs, idleMs)`：退出前先 `\x1b[<u` 关 Kitty 协议、再排空 stdin 最多 1s（或 50ms 空闲），防止 slow SSH 下 Kitty release 事件泄漏给父 shell；`stop()` 里 `process.stdin.pause()` 防止残留 Ctrl+D 关闭父 shell。

## 6.3 apps/vscode：引擎内嵌 + postMessage 桥

### 6.3.1 一次聊天请求的完整链路

```
webview (React)                          Extension Host                     SDK/agent-core
InputArea 发送
  │ Bridge.call("StreamChat", {content,model,...})
  ▼ postMessage ──────────────────────▶ webview.onDidReceiveMessage
                                        BridgeHandler.handle()
                                          ├─ validateRpcMessage()（白名单+逐方法参数校验）
                                          ├─ handlers.chat → ctx.getOrCreateSession()
                                          │     └─ KimiRuntime.openSession()
                                          │           ├─ harness.createSession({workDir, model,
                                          │           │     permission: yolo→auto})
                                          │           └─ SessionRuntime（订阅 onEvent，
                                          │              注册 setApprovalHandler/QuestionHandler）
                                          └─ runtime.prompt(content)
  ◀──────────────────────────────────── 引擎事件流 onSdkEvent（微任务异步）
                                        SessionRuntime.onSdkEvent
                                          ├─ adaptSdkEvent → UIStreamEvent
                                          ├─ terminal 事件 → emitTerminal()：stream_complete + settlePrompt
                                          └─ broadcast(Events.StreamEvent, evt)
  Bridge.on("StreamEvent") ◀── postMessage ◀── provider.broadcastInternal
  chat.store.processEvent(evt)（zustand+immer 增量更新 transcript）
  │
  ├─ ApprovalRequest 事件 → ApprovalDialog → Bridge.call("RespondApproval")
  │     └─ reverseRpc.respondApproval(id, resp) → resolve 引擎的 Promise
  └─ QuestionRequest 事件 → QuestionDialog → RespondQuestion（同上）
```

### 6.3.2 安全边界：webview 是不可信输入

`validateRpcMessage`：必须是纯对象、id 非空字符串、method 在 Methods 白名单内（50 个请求-响应方法 + 9 个单向事件）、**每个方法都有专属参数校验器**（如 `StreamChat` 的 content 递归校验 text/think/image_url 结构）。校验失败在进入任何业务 handler 前返回错误。webview HTML 带 nonce CSP（`default-src 'none'`）。trace 日志刻意排除 params/prompt/文件路径/凭据。

### 6.3.3 会话生命周期（KimiRuntime / SessionRuntime）

- 整个扩展只有一个 `KimiHarness`（in-process）；`sessionByView` 做 webview↔session 映射；一个会话可被多个 webview 订阅，最后一个订阅者离开时会话自动 `close()`。
- `customWorkDirs` 允许每个 webview 选自己的工作目录（必须落在 workspace 内）；会话 workdir 不匹配时 `assertSessionWorkDir` 拒绝挂载。
- **并发控制：一会话一 turn**——`SessionRuntime.isBusy` 时新 prompt 直接失败（`ALREADY_GENERATING_MESSAGE`），绝不打断在途 turn；非终态 error 被强制标 `terminal: false`，避免 UI 提前解锁导致二次发送撞车；fork 走 `runExclusiveAfterCancelling`（cancel → 等终端事件 → 执行不可并发操作）。
- **审批"双许可"模型**：会话元数据存 `{yolo, afk}` 标志（兼容 CLI 旧版），映射到 SDK 的 `Permission`（yolo→auto）；`setApprovalHandler` 是引擎的最后一道闸——**引擎权限层已自动放行的不会到 UI**，到达 handler 的都是敏感文件/plan review/ask 规则等必须人工决策的请求。

### 6.3.4 事件适配与去重

SDK 的 `Event` 经 `EventAdapterState` 增量映射为 webview 协议事件（`TurnBegin/StepBegin/ContentPart/ToolCall…/stream_complete`）；`emitTerminal` 以 `terminal.key` 去重（引擎可能补发终止事件）；`suppressedError` 机制：终端错误已上报后，紧随其后的同 code+message 的 error 事件被吞掉。

### 6.3.5 Baseline（文件回滚）

`tool.call.started`（Write/Edit）→ `captureFileBaseline`（校验文件在会话 workDir 内）→ `BaselineManager` 把原文件内容快照存到 globalStorage → 广播 `FileChangesUpdated` → webview 显示改动列表 → `OpenFileDiff` 用注册的 `kimi-baseline` scheme 打开只读原版 → `RevertFiles`/`KeepChanges` 回滚或确认。

## 6.4 关键代码位置索引

### pi-tui（packages/pi-tui/src/）

| 位置 | 说明 |
|---|---|
| `tui.ts:74-98` | `Component` 接口 |
| `tui.ts:114-131` | `Focusable` + `CURSOR_MARKER` |
| `tui.ts:516-651` | `showOverlay` + 焦点恢复状态机 |
| `tui.ts:735-782` | `requestRender/scheduleRender`：16ms 节流 |
| `tui.ts:1267-1658` | `doRender`：差分渲染三策略 |
| `tui.ts:1665-1696` | `positionHardwareCursor`：IME 光标定位 |
| `terminal.ts:220-330` | Kitty 协议协商 + modifyOtherKeys 回退 |
| `terminal.ts:368-404` | `drainInput` 退出卫生 |
| `stdin-buffer.ts:184-255` | `\x1b\x1b` 粘包特判 |
| `stdin-buffer.ts:287-398` | `process()`：粘贴聚合/去重/超时 |
| `keys.ts:820-1211` | `matchesKey` 四级回退 |
| `utils.ts:216-271` | `visibleWidth` 字素宽度 + 缓存 |
| `components/editor.ts:115-218` | `wordWrapLine` 单字素防递归 |
| `components/editor.ts:265-370` | `Editor` 状态 |
| `terminal-image.ts:65-125` | 终端能力探测矩阵 |
| `paste-burst.ts:1-61` | 粘贴突发启发式 |

### vscode（apps/vscode/）

| 位置 | 说明 |
|---|---|
| `src/extension.ts:19-142` | `activate`：provider/命令/迁移编排 |
| `src/KimiWebviewProvider.ts:152-181` | CSP HTML 注入 |
| `src/bridge-handler.ts:52-74` | RPC 统一入口 |
| `shared/bridge.ts:12-99` | Methods/Events 协议枚举 |
| `shared/bridge.ts:104-221` | `validateRpcMessage` 逐方法校验 |
| `src/runtime/kimi-runtime.ts:44-69` | `KimiRuntime` in-process harness |
| `src/runtime/session-runtime.ts:174-223` | `prompt`：单 turn 并发闸门 |
| `src/runtime/session-runtime.ts:359-375` | `runExclusiveAfterCancelling` |
| `src/runtime/reverse-rpc.ts` | 审批/提问反向 RPC 桥 |
| `src/handlers/chat.handler.ts` | StreamChat/Steer/Abort |
| `webview-ui/src/stores/chat.store.ts` | zustand+immer 发送队列状态机 |
| `tsdown.config.ts` | 全量内联 bundle 配置 |

## 6.5 本章小结

- pi-tui 是"免依赖的终端图形栈"：差分渲染三策略（全量/清屏/增量）包在 CSI 2026 同步输出中，帧级引用相等复用让 steady-state 帧几乎零成本；Kitty 协议四级回退 + StdinBuffer 防拆包 + 5 处本地分歧全是围绕"窄终端 + CJK + 性能"的现实修补。
- VSCode 扩展与"通信"无关：引擎以 SDK 形态内嵌进 Extension Host，webview 通过带逐方法参数校验的 postMessage 桥访问——webview 被当作不可信输入。
- 审批是"双许可"模型：引擎权限层自动放行的不会到 UI，到达 handler 的都是必须人工决策的请求。
- 三条产品线（CLI/VSCode/Web）共用 `@moonshot-ai/kimi-code-sdk` 作为引擎门面：CLI 与 VSCode 走进程内 RPC，Web 走 kap-server 的 HTTP/WS。
