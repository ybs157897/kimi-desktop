# 05 · pi-tui 与 VSCode 扩展（apps/vscode）

> 研究目标：`packages/pi-tui`（终端 UI 渲染库，约 1.2 万行）与 `apps/vscode`（VS Code 扩展，约 7k 行源码 + 3k 行 webview 前端）。
> 本文是 Kimi Code 代码考古系列的第 5 份报告，聚焦"终端交互层"与"编辑器宿主层"两套完全不同的前端实现。

---

## 1. 子系统定位与职责

### 1.1 pi-tui：CLI 的"终端图形栈"

`@moonshot-ai/pi-tui` 是一个**自研的、免依赖的终端 UI 框架**（vendored 自上游 pi-mono 项目，基线 0.80.2，本仓库 0.80.8），核心卖点是**差分渲染 + 同步输出（CSI 2026）+ 不闪烁**。它不是简单的组件库，而是承担了：

- **渲染引擎**：把组件树渲染成"行数组"，与上一帧逐行 diff，只把变化行写入 stdout；
- **输入管线**：raw mode + bracketed paste + Kitty 键盘协议协商 + 序列切分（防拆包），把字节流变成"按键事件"；
- **终端协议对话**：光标控制、颜色查询（OSC 11）、色彩方案通知（`CSI ? 996 n`）、像素尺寸查询（`CSI 16 t`）、Kitty 图形协议、OSC 8 超链接、同步输出；
- **组件库**：Editor（多行输入框）、Markdown 渲染、SelectList、Loader、Image、Overlay 系统等。

在 Kimi Code 整体架构中的位置：**`apps/kimi-code`（CLI/TUI 应用）是 pi-tui 的唯一 workspace 内消费者**，`src/tui/` 下 84 个文件直接 `import` pi-tui，构建了完整的聊天界面（消息流、输入框、对话框、状态栏、侧栏）。pi-tui 不依赖 agent-core/agent-core-v2/kap-server 中的任何一个——它是纯 UI 层，与 agent 引擎完全解耦（通过 `apps/kimi-code` 的控制器层间接对接 `@moonshot-ai/kimi-code-sdk`）。

### 1.2 apps/vscode：把整个 agent 引擎塞进扩展宿主

`apps/vscode` 是 Kimi Code 的 VS Code 扩展（marketplace 名称 `moonshot-ai.kimi-code`）。它与 pi-tui 是**同一产品的两个平行前端**，但架构决策完全相反：

- **pi-tui 路线（CLI）**：一个长驻进程，自己管理 raw-mode 终端、自己渲染、自己处理输入；
- **vscode 路线**：扩展进程（Extension Host）内**直接内嵌运行 Node SDK（`@moonshot-ai/kimi-code-sdk`）**，会话、agent、工具执行全部发生在扩展宿主进程里；UI 是 React webview，通过 `postMessage` 桥与扩展宿主通信。

关键事实（README 明确声明）：扩展运行 SDK 于 Extension Host；当扩展与 CLI 解析到同一个 `KIMI_CODE_HOME` 时，两者**共享 config.toml、MCP 配置、登录态、会话**（但不保证跨进程会话锁，官方禁止同时运行同一会话）。构建时 tsdown 把 `agent-core`、`kaos`、`kosong`、`oauth`、`node-sdk` 全部 alias 到源码并打进单个 `dist/extension.js`——**VSCode 扩展是一个自包含的完整 Kimi Code**，不依赖外部 kap-server 进程（kap-server 是 Web 版/多会话服务器形态，扩展不消费它）。

### 1.3 两者与 agent-core-v2/kap-server 的关系

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
│ kimi-code-sdk│ sdk (agent-  │                               │
│ (agent-core) │ core 全家桶)  │                               │
└──────────────┴──────────────┴───────────────────────────────┘
```

三条产品线共用 `@moonshot-ai/kimi-code-sdk`（node-sdk 包）作为引擎门面：CLI 与 VSCode 扩展走**进程内 RPC**（createRPC 的内存双工通道），Web 形态走 kap-server 的 HTTP/WebSocket。pi-tui 只服务于第一条线。

---

## 2. 包/目录清单与依赖关系

### 2.1 pi-tui 目录

```
packages/pi-tui/
├── src/
│   ├── index.ts               # 唯一公共出口（export * 集中）
│   ├── tui.ts        (1752行) # TUI/Container/Component/Overlay/差分渲染引擎
│   ├── terminal.ts   ( 531行) # Terminal 接口 + ProcessTerminal 实现
│   ├── stdin-buffer.ts(434行) # 输入字节流 → 完整序列（防拆包）
│   ├── keys.ts       (1400行) # 按键解析（Kitty CSI-u / modifyOtherKeys / 传统转义）
│   ├── keybindings.ts( 244行) # 可配置键位表（Emacs 风格默认值）
│   ├── utils.ts      (1214行) # 可见宽度/截断/换行/ANSI 处理（含缓存）
│   ├── terminal-image.ts(488) # Kitty/iTerm2 图形协议编码 + 终端能力探测
│   ├── terminal-colors.ts(73) # OSC 11 背景色 / 色彩方案报告解析
│   ├── autocomplete.ts( 912)  # 斜杠命令 + 文件路径补全
│   ├── fuzzy.ts      ( 137)   # 模糊匹配（补全过滤用）
│   ├── native-modifiers.ts    # macOS 原生修饰键查询（.node 插件）
│   ├── paste-burst.ts         # 无 bracketed-paste 终端的粘贴突发检测
│   ├── kill-ring.ts / undo-stack.ts / word-navigation.ts
│   └── components/            # box/editor/input/markdown/select-list/…
│       └── editor.ts (2415行) # 多行编辑器（最大组件）
├── native/                    # darwin-modifiers(.c/.node)、win32-console-mode.node
└── test/                      # node --test 测试（非 vitest！）
```

### 2.2 vscode 目录

```
apps/vscode/
├── src/                       # 扩展宿主侧（TypeScript）
│   ├── extension.ts           # activate/deactivate、命令注册、迁移编排
│   ├── KimiWebviewProvider.ts # webview 生命周期 + HTML/CSP + 广播
│   ├── bridge-handler.ts      # 桥接核心：RPC 分发 + 工作目录/基线管理
│   ├── handlers/              # 按领域拆分的 RPC 处理器（7 个文件）
│   ├── runtime/               # KimiRuntime / SessionRuntime / reverse-rpc / event-adapter / legacy-approval / tool-display / replay-adapter
│   ├── managers/              # baseline.manager（文件基线快照）/ file.manager
│   ├── migration/             # 旧版 CLI 数据迁移（@moonshot-ai/migration-legacy）
│   └── utils/                 # workspace-path / fs-path / context / session-context
├── shared/                    # 扩展与 webview 共享的协议层（纯类型 + 校验）
│   ├── bridge.ts              # Methods/Events 枚举 + RPC 消息校验
│   ├── legacy-sdk.ts          # 兼容层类型（ContentPart/ApprovalResponse 等）
│   └── types.ts               # UIStreamEvent 等 UI 协议类型
├── webview-ui/                # React 19 + Tailwind 4 + Vite 前端（打进单 JS）
├── resources/ scripts/        # 图标、打包发布脚本（vsix-package/verify/publish）
└── dist/                      # 构建产物：extension.js + webview.js（gitignored）
```

### 2.3 依赖关系

```
apps/kimi-code ──workspace:^──▶ @moonshot-ai/pi-tui        （唯一 workspace 消费者）
apps/kimi-code ──workspace:^──▶ kimi-code-sdk / agent-core-v2 / kap-server / migration-legacy / kimi-code-oauth
apps/vscode   ──workspace:^──▶ @moonshot-ai/kimi-code-sdk
apps/vscode   ──workspace:^──▶ @moonshot-ai/migration-legacy
apps/vscode   ──bundled───▶   agent-core / kaos / kosong / oauth（tsdown alias 直连源码）
@moonshot-ai/pi-tui ──npm──▶  get-east-asian-width（宽度）、marked（markdown 解析）
@moonshot-ai/pi-tui ──dev──▶  @xterm/headless（VirtualTerminal 测试用）、chalk
```

要点：
- pi-tui 的**运行时依赖只有两个**（`get-east-asian-width`、`marked`），其余全部自研——这是"vendored 上游框架"的典型形态；
- vscode 的 `package.json` 只声明 SDK 与迁移包，但 `tsdown.config.ts` 里 `alwaysBundle: [/^@moonshot-ai/, 'zod']` + alias 到 `packages/*/src/index.ts`，**发布物是单文件自包含 bundle**（`node_modules/vscode` 除外）；`webview-ui` 单独用 Vite 打成 IIFE `webview.js`，CSS 通过 `vite-plugin-css-injected-by-js` 内联进 JS，实现单文件注入；
- vscode 与 kap-server **无任何依赖关系**——两条独立的产品路径。

---

## 3. 模块结构与核心类型

### 3.1 pi-tui 核心类型

| 符号 | 位置 | 职责与字段语义 |
|---|---|---|
| `Component` | `tui.ts:74` | 渲染契约：`render(width): string[]`（每行不得超宽）、`handleInput?(data)`、`invalidate()`；`wantsKeyRelease?` 选择是否接收 Kitty release 事件 |
| `Focusable` | `tui.ts:114` | IME 支持：`focused: boolean`；聚焦时组件要在光标处输出 `CURSOR_MARKER`（`\x1b_pi:c\x07`，零宽 APC 序列），TUI 扫描定位后移动硬件光标 |
| `Container` | `tui.ts:266` | 子组件列表，`render` 只是逐子拼接；宽度 clamp `Math.max(1, width)`（本地分歧 #2） |
| `TUI extends Container` | `tui.ts:308` | 主引擎。维护 `previousLines/previousRawLines/previousLineImageIds`（差分帧缓存）、`focusedComponent`、`overlayStack`、`previousViewportTop/maxLinesRendered`（视口跟踪）、`hardwareCursorRow`（真实光标行，IME 会偏离内容行） |
| `Terminal` | `terminal.ts:52` | 抽象终端：`start/stop/write/columns/rows/moveBy/hideCursor/…/setTitle/setProgress/drainInput/kittyProtocolActive` |
| `ProcessTerminal` | `terminal.ts:99` | 真实实现：raw mode、bracketed paste、Kitty 协议协商、OSC 9;4 进度、`PI_TUI_WRITE_LOG` 输出审计 |
| `StdinBuffer` | `stdin-buffer.ts:274` | EventEmitter。`process(data)` 吞字节流，按 CSI/OSC/DCS/APC/SS3 分类判定完整性，发出 `data`（单序列）与 `paste`（bracketed 内容）事件 |
| `Key` / `KeyId` | `keys.ts:163` | 类型安全的按键标识符工厂（`Key.ctrl("c")` → `"ctrl+c"`），模板字面量类型 |
| `matchesKey(data, keyId)` | `keys.ts:820` | 统一按键匹配：Kitty CSI-u → modifyOtherKeys → 传统转义 → 裸字节四级回退 |
| `KeybindingsManager` | `keybindings.ts:155` | 命名键位（`tui.editor.cursorUp` 等）→ `KeyId[]`，支持用户重绑定与冲突检测 |
| `visibleWidth/truncateToWidth/wrapTextWithAnsi/sliceByColumn` | `utils.ts` | ANSI 感知的宽度计算、截断（补省略号）、换行（跨行保留样式）、按列切片 |
| `CombinedAutocompleteProvider` | `autocomplete.ts:273` | 斜杠命令 + 文件路径（`~/` `./` `@` 前缀）补全 |
| `Editor` | `components/editor.ts:265` | 多行编辑器：`EditorState{lines,cursorLine,cursorCol}`、滚动、undo 栈、kill-ring、历史、paste 标记、自动补全、跳转模式 |
| `Markdown` | `components/markdown.ts:110` | marked 解析 + 主题化渲染 + 渲染缓存 |
| `TerminalCapabilities` | `terminal-image.ts:5` | `{images: "kitty"|"iterm2"|null, trueColor, hyperlinks}` 能力探测结果 |

### 3.2 vscode 核心类型

| 符号 | 位置 | 职责 |
|---|---|---|
| `KimiWebviewProvider` | `KimiWebviewProvider.ts:19` | `WebviewViewProvider` 实现；维护 `webviews: Map<webviewId, Webview>`（侧边栏 + 面板可并存），注入带 nonce 的 CSP HTML |
| `BridgeHandler` | `bridge-handler.ts:25` | 单 RPC 入口：`handle(value, webviewId) → Promise<RpcResult>`；校验 → 分发 → trace 日志；持有 `customWorkDirs`（每 webview 独立工作目录）、`fileManager`、`baselineManager`、`runtime` |
| `Methods` / `Events` | `shared/bridge.ts:12/89` | 50 个请求-响应方法（StreamChat、GetKimiSessions、ForkKimiSession…）+ 9 个单向事件（StreamEvent、LoginUrl…）；`validateRpcMessage` 在进入任何 handler 前做白名单 + 逐方法参数校验（webview 是不可信输入） |
| `KimiRuntime` | `runtime/kimi-runtime.ts:44` | 扩展宿主内的 SDK 持有者：`createKimiHarness({identity: kimi-code-vscode, uiMode: "vscode"})`；`sessions: Map<id, SessionRuntime>`、`sessionByView: Map<webviewId, id>`（多 webview 可订阅同一会话） |
| `SessionRuntime` | `runtime/session-runtime.ts:70` | 每个会话一个；**唯一**订阅 SDK `session.onEvent`，把 SDK 事件流适配成 `UIStreamEvent` 广播给所有订阅 webview；持有 `ReverseRpcController`（审批/提问反向 RPC）、`activePrompt`（在途 turn 的 Promise）、`legacyApproval`（yolo/afk 标志） |
| `ReverseRpcController` | `runtime/reverse-rpc.ts` | 引擎→UI 的请求：`requestApproval/requestQuestion` 返回 Promise，通过 webview 广播发起，`respondApproval/respondQuestion` 由 RPC handler 调回 resolve |
| `UIStreamEvent` | `shared/types.ts` | 统一事件协议（`TurnBegin/StepBegin/ContentPart/ApprovalRequest/…/stream_complete`），附带 `_sessionId` |
| `BaselineManager` | `managers/baseline.manager.ts` | 文件改动基线：工具调 Write/Edit 前记录原文件，供 diff/revert |
| `Bridge`（webview 侧） | `webview-ui/src/services/bridge.ts` | `acquireVsCodeApi().postMessage` 封装：pending Map 做 request/response，事件订阅器；带 mock 模式（浏览器调试） |

---

## 4. 关键数据流 / 状态机 / 时序

### 4.1 pi-tui：一帧渲染的完整路径

```
                    ┌──────────────────────────────────────────┐
  组件状态变化        │ TUI 渲染循环（节流 16ms，process.nextTick）  │
 (onChange/输入/     │                                          │
  异步消息)          │  requestRender()                          │
      │             │    └─▶ scheduleRender() ─▶ doRender()     │
      ▼             │                                          │
 render(width)      │  1. render() 组件树 → newLines[]           │
 逐组件生成行数组 ────┼▶  2. compositeOverlays() 叠加 overlay      │
      │             │  3. extractCursorPosition() 找 CURSOR_MARKER│
      │             │  4. 逐行处理：isImageLine? → Kitty id 提取  │
      ▼             │      否则 asciiVisibleWidth 超宽检测→截断   │
 ┌─────────────┐    │      + normalizeTerminalOutput + SEGMENT_RESET
 │ 帧缓存       │◀───┼▶  5. 与 previousLines diff → first/lastChanged
 │ previous*   │    │  6. 策略选择（见下）→ 拼 ANSI buffer        │
 └─────────────┘    │  7. terminal.write(buffer)                 │
                    │  8. 更新 previousLines/previousRawLines/   │
                    │     previousLineImageIds/视口/光标          │
                    └──────────────────────────────────────────┘
```

**差分渲染三策略**（`tui.ts:1267 doRender` 内的分支，依次判断）：

```
1. 首帧或宽度变化或高度变化(非 Termux) ──▶ fullRender(clear=true)：CSI 2026h + 清屏 [2J[H[3J] + 全量写
2. clearOnShrink 且内容缩短          ──▶ fullRender(clear=true)（默认开，可用 PI_CLEAR_ON_SHRINK=0 关）
3. 正常差分                            ──▶ 移到 firstChanged 行，每行 [2K 清行后重写
                                            [firstChanged, lastChanged] 区间；多余旧行 \r\n\x1b[2K 清掉
    例外：firstChanged < 上一视口顶部 或 kitty 图片越界 ──▶ 退化为 fullRender
```

所有写路径都包在 **synchronized output**（`\x1b[?2026h`…`\x1b[?2026l`）里——终端延迟合成输出，避免闪烁。Append-only 场景（聊天内容追加）有专门的 `appendStart` 快路径：直接光标下移 + `\r\n` 续写，不做整屏重绘。

**输入管线**（字节 → 按键事件）：

```
stdin 'data' 事件（可能拆包）
   │  StdinBuffer.process()：累积 + 完整性判定（CSI 终字节 0x40-0x7E / OSC 以 BEL 或 ESC\ 结束 / DCS-APC / 旧式鼠标 6 字节）
   │  10ms 超时强刷（不完整的尾巴按原样发出）
   ├─ bracketed paste ──▶ 聚合整个粘贴体 → 发 'paste' 事件（ProcessTerminal 再包一层 200~/201~ 交给 Editor）
   ├─ Kitty 协议协商响应（CSI ? flags u / DA）──▶ 切换 _kittyProtocolActive，选择解析路径
   └─ 单序列 ──▶ ProcessTerminal.forwardInputSequence ──▶ TUI.handleInput
        ├─ OSC 11 响应 / 色彩方案报告 / CSI 16t 像素尺寸响应（这些在 TUI 层被"消费"而非转发）
        ├─ inputListeners 链（可改写/吞掉 data）
        ├─ 全局调试键 shift+ctrl+d → onDebug
        ├─ 焦点校验（overlay 失焦重定向 / 焦点恢复状态机）
        └─ focusedComponent.handleInput(data)（isKeyRelease 默认过滤）→ 组件内部处理 → requestRender
```

**焦点与 Overlay 状态机**（`tui.ts` 里最复杂的部分，状态类型见 251-261 行）：

```
OverlayFocusRestoreState = inactive | eligible{overlay} | blocked{overlay, blockedBy, resume}
resume = restore-overlay | focus-target{target}
- showOverlay：入栈 + 若可见则 setFocus(overlay)，记录 preFocus；返回 handle
- overlay 获得焦点 → restore = eligible
- 焦点被"借走"到非 overlay 组件（如临时替换 UI）→ restore = blocked（resume=restore-overlay）
- 非 overlay 焦点时输入到达 → 若 restore=eligible 强制夺回焦点；blocked 则按 resume 决策
- handle.unfocus({target})：显式转移；hide()/setHidden()：出栈并回退到最顶可见 overlay 或 preFocus
```

设计意图：**可见的聚焦 overlay 必须能收回键盘**（模态对话框不会丢输入），但允许临时把焦点让给其他组件（如编辑器里的补全列表）。这是 README 里专门用一节解释的行为。

### 4.1.5 补充：Editor 内部状态机（最大组件，2415 行）

`Editor` 是 pi-tui 中唯一有"会话级状态"的组件，其内部状态可以画成一张状态图：

```
            ┌─────────────── jumpMode（Ctrl+] 等待下一字符）
            │                    ┌──► 收到可打印字符 → jumpToChar
            ▼                    │     （跳到光标前后第一个该字符）
  normal ──► handleInput ──► 分支决策
              │ │ │ │ │          ├─ autocompleteState ≠ null ──► 补全子状态机
              │ │ │ │ │          │    （up/down 移动、tab/enter 应用补全、escape 取消）
              │ │ │ │ │          ├─ 按键匹配（KeybindingsManager）→ undo/kill/yank/历史/编辑
              │ │ │ │ │          └─ 可打印字符 → 插入 + pasteBurst 计数
              │ │ │ │ └─ bracketed paste 进行中 ──► 累积 pasteBuffer 直到 201~ → handlePaste
              │ │ │ └─ isInPaste 状态切换
              │ │ └─ historyIndex ≥ 0（↑↓浏览历史，onRecall 支持宿主过滤）
              │ └─ scrollOffset 自动调整（光标超出可视区）
              └─ onChange 回调 + requestRender（经 TUI 节流）
```

关键机制：
- **撤销**：`UndoStack<EditorState>` 快照式（整个 `{lines,cursorLine,cursorCol}` 入栈），配合 `lastAction` 做合并（连续输入合并为一次 undo 单元）；
- **kill-ring**：`Ctrl+K/U/W` 删除进环，`Ctrl+Y` 取出、`Alt+Y` 轮换，模拟 Emacs；
- **粘贴标记**：`handlePaste` 把 >10 行或 >1000 字符的粘贴折叠为 `[paste #N +M lines]` 原子标记，文本仍完整存在 `pastes: Map<id, string>` 中；`segmentWithMarkers` 让字素分割器把标记视为不可分单元，光标/换行/删除不会从中间穿过；用户展开标记才显示全文（kimi-code 应用层实现）；
- **自动补全**：`CombinedAutocompleteProvider` 对斜杠命令与文件路径分流——输入 `/` 走命令列表、`Tab` 走文件补全（`~/` `./` `../` `@` 前缀解析，含引号内路径、空格分隔符处理），`@` 前缀只列出可附加文件；`fuzzy.ts` 的 `fuzzyMatch` 用于候选过滤；编辑器侧的补全请求带 debounce + `AbortController` + 自增 token，过期响应被丢弃（防止慢速文件系统返回乱序结果）；
- **历史**：`history[]` + `historyIndex`（-1 为编辑态），`onRecall` 允许宿主（kimi-code 应用层）注入持久化历史与过滤；浏览历史时保存当前草稿（`historyDraft`），退出浏览恢复；
- **跳转模式**：`Ctrl+]`/`Ctrl+Alt+]` 进入 jumpMode，下一个可打印字符决定向前/向后跳到该字符的首次出现处；按同一个热键取消。

### 4.2 vscode：一次聊天请求的完整链路

```
webview (React)                          Extension Host                     SDK/agent-core
─────────────────                        ────────────────                   ──────────────
InputArea 发送
  │ Bridge.call("StreamChat", {content,model,...})
  ▼ postMessage ──────────────────────────▶ webview.onDidReceiveMessage
                                            BridgeHandler.handle()
                                              ├─ validateRpcMessage()（白名单+参数校验）
                                              ├─ handlers.chat → ctx.getOrCreateSession()
                                              │     └─ KimiRuntime.openSession()
                                              │           ├─ harness.createSession({workDir, model,
                                              │           │     permission: yolo→auto})
                                              │           └─ SessionRuntime（订阅 onEvent，
                                              │              注册 setApprovalHandler/QuestionHandler）
                                              └─ runtime.prompt(content)
                                                    └─ session.prompt() ─▶ 引擎开始 turn
  ◀────────────────────────────────────────── 引擎事件流 onSdkEvent（微任务异步）
                                               SessionRuntime.onSdkEvent
                                                 ├─ adaptSdkEvent(adapterState, event)  # 把 SDK 事件
                                                 │    ────────────────────────────────────▶ UIStreamEvent
                                                 ├─ terminal 事件 → emitTerminal()：stream_complete + settlePrompt
                                                 └─ broadcast(Events.StreamEvent, evt, webviewId)
  Bridge.on("StreamEvent") ◀──── postMessage ◀─── provider.broadcastInternal
  chat.store.processEvent(evt)（zustand+immer 增量更新 transcript）
  │
  ├─ ApprovalRequest 事件 → ApprovalDialog 渲染 → Bridge.call("RespondApproval")
  │     └─ reverseRpc.respondApproval(id, resp) → resolve 引擎的 Promise
  └─ QuestionRequest 事件 → QuestionDialog → RespondQuestion（同上）
```

**会话生命周期**（`KimiRuntime`）：`sessionByView` 做 webview↔session 映射；一个会话可被多个 webview 订阅（`SessionRuntime.webviewIds` Set），最后一个订阅者离开（`detachView`）时会话自动 `close()`；`openSession` 对同 webview 复用已有会话（只重发 StatusUpdate），换 workDir/换 sessionId 则 detach 旧视图；fork（`ForkKimiSession`）走 `runExclusiveAfterCancelling`——先取消在途 turn、等终端事件落定、再执行不可并发的 fork 操作。

**事件适配**（`runtime/event-adapter.ts`）：SDK 的 `Event`（turn.started/step/text/tool.call.*/…）经 `EventAdapterState` 增量映射为 webview 协议事件（`TurnBegin/StepBegin/ContentPart/ToolCall…/stream_complete`），错误按 phase（`preflight`/`runtime`）标注，`terminal` 标志决定 UI 是否解锁输入框；重复/补发事件通过 `terminalKeys` Set 去重。

**Baseline（文件回滚）流**：`tool.call.started`（Write/Edit）→ `captureFileBaseline`（校验文件在会话 workDir 内）→ `BaselineManager` 把原文件内容快照存到 globalStorage → 广播 `FileChangesUpdated` → webview 显示改动列表 → `OpenFileDiff` 用注册的 `kimi-baseline` scheme 打开只读原版 → `RevertFiles`/`KeepChanges` 回滚或确认。

### 4.3 迁移流（extension.ts）

```
activate()
  ├─ updateLoginContext()（决定 isLoggedIn）
  ├─ offerLegacyMigration(): discovery.prompt == null?
  │     ├─ 是：按需弹一次性 reauth/warning 通知
  │     └─ 否：弹信息条（"Migrate Now"）→ performMigration(manager, retry)
  │           └─ 复制/合并 config.toml、MCP 配置、历史、skills、sessions
  │              （OAuth 凭据不复制 → 提示重新登录）
  └─ 迁移成功后 harness.getConfig({reload:true}) + resetAllWebviews()
```

---

### 4.4 补充：webview 侧发送队列状态机（chat.store.ts）

webview 不直接发流式请求，而是通过 zustand store 的发送队列管理并发：

```
IDLE ──send()──► SENDING（handshakeReceived=false）
                 │  StreamChat 发出
                 ├─ 收到首个 StreamEvent（TurnBegin）→ handshakeReceived=true
                 ├─ 流式事件 → processEvent() 增量更新 transcript（immer produce）
                 ├─ 队列非空 → 当前 turn 结束后 50ms 自动发送下一条
                 └─ 收到 stream_complete/error(terminal) → 回 IDLE，解锁输入框
 中途 abort（Stop 按钮）→ AbortChat → cancel() → 终端事件解锁
```

`processEvent` 是纯 reducer：`TurnBegin/StepBegin/ContentPart/ToolCall*/ApprovalRequest/…/stream_complete` 逐条把 UI 状态推进，streaming 标志、pendingInput 回滚、错误展示都由它驱动；发送中禁止重复发送（`isStreaming` 检查），排队消息显示在 `QueuedMessagesPanel`。

### 4.5 补充：SDK 事件 → UIStreamEvent 适配映射（event-adapter.ts）

| SDK 事件 | UI 事件 | 说明 |
|---|---|---|
| `turn.started` | `TurnBegin{user_input, forkable}` | 标记 activePrompt.started |
| `turn.step.started` | `StepBegin{n}` | 步骤序号 |
| `agent.message.text` / `content.part` | `ContentPart{type,text}` | 流式文本增量 |
| `tool.call.started/completed/failed` | `ToolCallStarted/…` | 附带参数/输出（敏感字段由 UI 脱敏） |
| `approval.requested` | `ApprovalRequest` | 经 reverse-rpc，不直接来自事件流 |
| `question.requested` | `QuestionRequest` | 同上 |
| `turn.ended`（reason 分支） | `stream_complete{finished/cancelled}` 或 `error{code,message,terminal}` | 终态事件按 terminal.key 去重 |
| `compaction.completed/cancelled` | 不转 UI，resolve `pendingHostCompaction` | 宿主侧 /compact 的 Promise |
| `error`（非终态） | `error{terminal:false}` | 避免 UI 提前解锁 |
| `turn.step.retrying` | 仅日志 | provider 退避重试记录 |

### 4.6 补充：会话 fork / 恢复的时序（session.handler.ts + KimiRuntime）

```
ForkKimiSession{sessionId, turnIndex}
  ├─ getOrCreateSession → runtime（或从 harness 恢复）
  ├─ runExclusiveAfterCancelling：cancel() → 等终端事件 → 执行
  │     ├─ SessionRuntime 事件流先重放到 turnIndex 之前的全部事件
  │     │   （replay-adapter：确保 UI 能看到 fork 出的新会话的既有内容）
  │     └─ harness.forkSession → 新 sessionId
  └─ detachView(旧) + openSession(新) → UI 切换到新会话
ResumeKimiSession{kimiSessionId}
  ├─ harness.resumeSession({id, includeSubagents:true})
  ├─ assertSessionWorkDir（跨目录拒绝）
  ├─ 恢复 legacyApproval（读元数据 → 迁移读取 → 默认）→ setPermission 同步
  └─ SessionRuntime 包装 + announceStatus（模型/effort/planMode 以引擎为准）
```

## 5. 重要实现细节

### 5.1 pi-tui

**① 帧级 processed-line 复用（本地分歧 #5，性能核心）**
`doRender` 保留上一帧的 `previousRawLines`（组件 render 缓存的原始字符串引用）与 `previousLines`（处理后的输出）。逐行比较 `rawLine === previousRawLines[i]`（引用相等即未变），未变行**零成本复用**处理结果（截断 + normalize + SEGMENT_RESET）与 kitty 图片 id；宽度变化时引用必不相等，自然全量重处理。steady-state 帧（比如转圈动画）的代价从 O(所有行重处理) 降到 O(行数) 指针比较 + O(变化行) 真活。配套 `asciiVisibleWidth(line, limit)` 快速路径（纯 ASCII 扫描 + 超过 limit 早退），只有非 ASCII 行才落到 `visibleWidth`（`Intl.Segmenter` 字素级宽度 + 4096 项 FIFO 缓存）。

**② Kitty 键盘协议协商（terminal.ts:220）**
`queryAndEnableKittyProtocol` 写入 `\x1b[>7u\x1b[?u\x1b[c`：先声明期望 flags（1=disambiguate，2=事件类型，4=alternate keys），再查询，最后 DA 查询做哨兵——不支持 Kitty 的终端会回 DA，收到 DA 前若没等来 Kitty 响应就启用 **modifyOtherKeys**（`\x1b[>4;2m`）作为第二方案；两者都收不到时退化为传统转义序列（`\x1b[A` 等）。协商响应可能跨多个 stdin 事件拆包，用 `keyboardProtocolNegotiationBuffer` + 150ms 冲刷定时器处理。这保证了 `matchesKey` 在 Kitty/Ghostty/WezTerm/iTerm2/xterm/Apple Terminal 上的统一语义（例如 Shift+Enter 有 4 种编码路径：Kitty CSI-u、modifyOtherKeys、`\x1b\r`、`\n`）。

**③ StdinBuffer 的边界处理**
- 高字节单字节输入（>127）转换为 `ESC + (byte-128)`（兼容老式 meta 键）；
- WezTerm 的 Escape 键按下以裸 `\x1b` 发出、松开是完整 CSI-u 序列，会粘成 `\x1b\x1b[27;…u`——遇到 `\x1b\x1b` 且后随 `[`/`]`/`O`/`P`/`_` 时只发第一个 ESC 并从第二个重启解析；
- Kitty 打印字符去重：CSI-u 无修饰码点后若跟来相同的裸码点（终端既发协议又发文本），丢弃裸码点（`pendingKittyPrintableCodepoint` 机制）；
- 鼠标 SGR 序列 `ESC[<B;X;Ym` 必须完整匹配三段数字才判 complete，否则继续攒。

**④ 粘贴处理（双保险）**
- bracketed paste（首选）：`StdinBuffer` 聚合 `200~…201~`，`ProcessTerminal` 重新包上标记交给 Editor；Editor 对 >10 行的粘贴生成 `[paste #N +M lines]` 原子标记（`segmentWithMarkers` 把标记并入单个字素段，光标移动/删除/换行都视其为整体），大粘贴展开为可折叠块；
- 无 bracketed 支持终端：`PasteBurst` 启发式——8 个字符间隔 ≤8ms 视为粘贴突发，其后的 Enter 被抑制为换行而非提交（120ms 窗口）。

**⑤ 宽字符与超宽防御**
`Container.render` clamp 宽度 ≥1；超宽行一律 `sliceByColumn` 截断而非抛错（本地分歧 #3，上游会写崩溃日志 + throw）；`wordWrapLine` 对不可再分的单字素（如 CJK 在 maxWidth=1）不再递归（本地分歧 #1，上游会无限递归爆栈），溢出 1 列交给渲染层截断；负宽度 `repeat` 全部 clamp（分歧 #4）。`normalizeTerminalOutput` 把泰语/老挝语 AM 元音换成兼容分解形式，规避某些终端差分重绘的残留。

**⑥ 终端对话（tui 主动查询）**
- `queryCellSize()`：`CSI 16 t` 查像素格尺寸（仅图片能力终端），响应 `CSI 6;h;wt` 被 `consumeCellSizeResponse` 消费并 `invalidate()` 全树重渲染；
- `queryTerminalBackgroundColor`：OSC 11 查询带超时队列（`pendingOsc11BackgroundQueries`，超时 resolve undefined）；
- `queryTerminalColorScheme`：`CSI ? 996 n` + 监听色彩方案通知协议（`CSI ? 2031h` 开启），供暗/亮主题自适应。

**⑦ 光标与 IME**
`CURSOR_MARKER`（APC 序列）由 Focusable 组件在假光标处输出；TUI 在**可见视口底部 height 行内**倒序扫描 marker，用 `visibleWidth` 算出列位置，把硬件光标移过去（`positionHardwareCursor`，行用相对移动、列用绝对 `CSI n G`），默认隐藏硬件光标（`PI_HARDWARE_CURSOR=1` 可显示，部分终端需要可见光标才能定位 IME 候选窗）。容器组件必须向子 Input/Editor 传播 `focused` 标志，否则 CJK 输入法候选窗位置错误。

**⑧ 原生修饰键**
`native-modifiers.ts` 通过动态加载 `native/darwin/prebuilds/darwin-{arch}/darwin-modifiers.node`（C NAPI 插件，用 CoreGraphics 查 shift/command/control/option 的实时状态）解决 Apple Terminal 的 Shift+Enter 无法区分问题；Windows 侧用 `win32-console-mode.node` 加 `ENABLE_VIRTUAL_TERMINAL_INPUT` 让 Shift+Tab 不再与 Tab 混淆。找不到原生插件时静默降级。

**⑨ 退出卫生**
`drainInput(maxMs, idleMs)`：退出前先 `\x1b[<u` 关 Kitty 协议、再排空 stdin 最多 1s（或 50ms 空闲），防止 slow SSH 下 Kitty release 事件泄漏给父 shell；`stop()` 里 `process.stdin.pause()` 防止残留 Ctrl+D 关闭父 shell；光标移动到内容末尾再恢复。

**⑩ 终端能力探测（terminal-image.ts:65）**
纯环境变量 + 命令探测：tmux 下 `tmux display-message -p '#{client_termfeatures}'` 确认是否转发 hyperlinks（图片协议一律禁用）；kitty/ghostty/wezterm/warp → kitty 图形；iTerm2 → iterm2 协议；Windows Terminal/VSCode/Alacritty → 无图片但有 truecolor+hyperlink；未知终端保守默认（无 hyperlink，因为被吞掉的 OSC 8 会让 URL 从输出里消失）。

### 5.2 vscode

**① 安全边界：webview 是不可信输入**
`shared/bridge.ts` 的 `validateRpcMessage`：必须是纯对象、id 非空字符串、method 在 Methods 白名单内、**每个方法都有专属参数校验器**（如 `StreamChat` 的 content 递归校验 `text/think/image_url/audio_url/video_url` 结构，`SaveConfig` 校验 model/thinking/effort 类型）。校验失败在进入任何业务 handler 前返回错误。webview HTML 带 nonce CSP（`default-src 'none'`，仅允许 webview.cspSource + 内联样式 + nonce 脚本）。`trace()` 日志刻意排除 params/prompt/文件路径/凭据。

**② 单 harness、多 webview、每 webview 独立 workdir**
整个扩展只有一个 `KimiHarness`（in-process）；`customWorkDirs` 允许每个 webview 选自己的工作目录（必须落在 workspace 内），切换 workdir 会 `detachView` 并清掉该视图的会话。会话的 workdir 不匹配时 `assertSessionWorkDir` 拒绝挂载（"The selected session belongs to a different working directory."）。

**③ 审批的"双许可"模型（legacy-approval.ts）**
会话元数据里存 `{yolo, afk}` 标志（兼容 CLI 旧版），映射到 SDK 的 `Permission`（yolo→auto）；`setApprovalHandler` 是引擎的最后一道闸——**引擎权限层已自动放行的不会到 UI**，到达 handler 的都是敏感文件/plan review/ask 规则等必须人工决策的请求。`withGlobalYoloMode` 把扩展设置的 yoloMode 与每个会话自身标志合并（全局开关恒为真则会话提升为 yolo）。元数据更新失败时回滚 permission（保持一致性）。

**④ 并发控制：一会话一 turn**
`SessionRuntime.isBusy`（activePrompt 或 hostAction 在途）时新 prompt 直接失败（`ALREADY_GENERATING_MESSAGE`），绝不打断在途 turn；`activePrompt` 的 `started` 标志决定错误是 preflight（UI 可解锁）还是 runtime；SDK 事件里非终态 error（turn 仍在跑）被强制标 `terminal: false`，避免 UI 提前解锁导致二次发送撞车；`runExclusiveAfterCancelling` 用于 fork——cancel → 等终端事件 → 执行不可并发操作；host 侧斜杠命令（/compact、/init）通过 `beginHostAction`/`emitHostText`/`completeHostAction` 模拟一轮 turn 的事件流，与引擎 turn 共用同一 UI 管线。

**⑤ 事件适配与去重**
`emitTerminal` 以 `terminal.key` 去重（引擎可能补发终止事件）；`suppressedError` 机制：终端错误已上报后，紧随其后的同 code+message 的 error 事件被吞掉（避免双报）；`event-adapter` 的 `EventAdapterState` 增量维护 step/turn 上下文（如 `StepBegin` 的序号）。

**⑥ 构建与发布**
tsdown 单文件 bundle（`neverBundle: ['vscode']`，其余 workspace 包全打进）——发布物不依赖任何运行时 npm 依赖；`extensionKind: ["workspace"]`（跑在 workspace 侧 Extension Host，可访问本机 KIMI_CODE_HOME）；`retainContextWhenHidden: true` 保持 webview 状态；`untrustedWorkspaces: false` 不信任不受信工作区。版本注入：`__EXTENSION_VERSION__` define + raw-text-loader 内联资源。

---

## 6. 关键代码位置索引

### 6.1 pi-tui（`packages/pi-tui/src/`）

| 位置 | 说明 |
|---|---|
| `tui.ts:74-98` | `Component` 接口：渲染/输入/失效契约 |
| `tui.ts:114-131` | `Focusable` + `CURSOR_MARKER`：IME 光标定位协议 |
| `tui.ts:266-303` | `Container`：宽度 clamp ≥1（分歧 #2） |
| `tui.ts:308-357` | `TUI` 类状态字段：帧缓存、视口、光标、overlay |
| `tui.ts:516-651` | `showOverlay` + OverlayHandle + 焦点恢复状态机 |
| `tui.ts:658-670` | `start()`：挂输入/缩放回调、隐藏光标、查像素尺寸 |
| `tui.ts:735-782` | `requestRender/scheduleRender`：16ms 节流 + nextTick |
| `tui.ts:784-858` | `handleInput`：监听器链 → 调试键 → overlay 焦点裁决 → 分发 |
| `tui.ts:860-914` | OSC 11 / 色彩方案 / 像素尺寸响应的消费 |
| `tui.ts:1055-1114` | `compositeOverlays`：overlay 合成（按 focusOrder 排序、防超宽） |
| `tui.ts:1267-1658` | `doRender`：差分渲染三策略 + 帧缓存更新（分歧 #3/#5） |
| `tui.ts:1665-1696` | `positionHardwareCursor`：IME 光标定位 |
| `tui.ts:1703-1752` | `queryTerminalBackgroundColor` / `queryTerminalColorScheme` |
| `terminal.ts:52-94` | `Terminal` 接口 |
| `terminal.ts:134-167` | `ProcessTerminal.start`：raw mode、bracketed paste、SIGWINCH 刷新 |
| `terminal.ts:220-330` | Kitty 键盘协议协商 + modifyOtherKeys 回退 |
| `terminal.ts:368-404` | `drainInput`：退出前排空 stdin |
| `terminal.ts:406-452` | `stop()`：协议关闭 + stdin.pause 防泄漏 |
| `stdin-buffer.ts:29-78` | 转义序列完整性分类 |
| `stdin-buffer.ts:184-255` | `extractCompleteSequences`：`\x1b\x1b` 粘包特判 |
| `stdin-buffer.ts:287-398` | `process()`：粘贴聚合、Kitty 打印字符去重、10ms 超时 |
| `keys.ts:163-252` | `Key` 工厂：模板字面量类型按键 |
| `keys.ts:587-651` | `parseKittySequence`：CSI-u 四段格式解析 |
| `keys.ts:820-1211` | `matchesKey`：四级回退匹配（含 Shift+Enter 各终端特例） |
| `utils.ts:216-271` | `visibleWidth`：ANSI 剥离 + 字素宽度 + FIFO 缓存 |
| `utils.ts:280-297` | `asciiVisibleWidth`：超宽早退快速路径 |
| `utils.ts:720-826` | `wrapTextWithAnsi`：ANSI 状态跟踪器 + 断词 |
| `utils.ts:941-1083` | `truncateToWidth`：省略号 + 样式闭合 |
| `components/editor.ts:115-218` | `wordWrapLine`：字素级换行 + CJK 断行 + 单字素防递归（分歧 #1） |
| `components/editor.ts:265-370` | `Editor` 状态：滚动/补全/粘贴/历史/kill-ring/undo |
| `components/editor.ts:677-806` | `handleInput`：跳转模式、bracketed paste、键位分发 |
| `components/markdown.ts:110-` | Markdown 组件（marked + 主题） |
| `autocomplete.ts:273-` | `CombinedAutocompleteProvider` |
| `terminal-image.ts:65-125` | `detectCapabilities`：终端能力探测矩阵 |
| `keybindings.ts:54-134` | `TUI_KEYBINDINGS`：Emacs 风格默认键位 |
| `paste-burst.ts:1-61` | 粘贴突发启发式 |
| `native-modifiers.ts:21-59` | macOS 原生修饰键加载 |

### 6.2 vscode（`apps/vscode/`）

| 位置 | 说明 |
|---|---|
| `src/extension.ts:19-142` | `activate`：provider/命令/迁移编排 |
| `src/extension.ts:159-215` | `offerLegacyMigration`：一次性通知状态机 |
| `src/KimiWebviewProvider.ts:51-110` | webview 解析/面板创建/RPC 回发 |
| `src/KimiWebviewProvider.ts:152-181` | CSP HTML 注入（nonce + baseuri + webviewid） |
| `src/bridge-handler.ts:52-74` | RPC 统一入口：校验→分发→trace |
| `src/bridge-handler.ts:127-194` | dispatch + HandlerContext 装配 |
| `src/bridge-handler.ts:207-228` | `getEditorMention`：@文件/行号 mention 生成 |
| `src/bridge-handler.ts:230-276` | `captureFileBaseline`：写文件前快照 |
| `shared/bridge.ts:12-99` | Methods/Events 协议枚举 |
| `shared/bridge.ts:104-221` | `validateRpcMessage` + 逐方法参数校验 |
| `src/runtime/kimi-runtime.ts:44-69` | `KimiRuntime`：in-process harness 工厂（uiMode:"vscode"） |
| `src/runtime/kimi-runtime.ts:80-177` | `openSession/attachResumedSession`：会话复用/恢复 |
| `src/runtime/kimi-runtime.ts:179-223` | `detachView/closeSession/dispose`：引用计数式生命周期 |
| `src/runtime/session-runtime.ts:93-108` | 订阅 SDK 事件 + 注册审批/提问 handler |
| `src/runtime/session-runtime.ts:174-223` | `prompt/runTurnAction`：单 turn 并发闸门 |
| `src/runtime/session-runtime.ts:329-352` | `cancel`：双面取消（reverseRpc + session.cancel） |
| `src/runtime/session-runtime.ts:359-375` | `runExclusiveAfterCancelling`：fork 专用 |
| `src/runtime/session-runtime.ts:439-495` | `onSdkEvent`：事件适配主循环 |
| `src/runtime/session-runtime.ts:515-557` | `emitTerminal`：终止事件去重 + settlePrompt |
| `src/runtime/reverse-rpc.ts` | 审批/提问的反向 RPC Promise 桥 |
| `src/handlers/chat.handler.ts` | StreamChat/Steer/Abort + 编辑器上下文注入 |
| `src/handlers/session.handler.ts` | 会话列表/恢复/删除/fork |
| `src/handlers/file.handler.ts` | 文件跟踪/差异/回滚 |
| `webview-ui/src/services/bridge.ts` | 前端 RPC 客户端（10min 超时，OAuth 16min） |
| `webview-ui/src/stores/chat.store.ts` | zustand+immer 会话状态机（发送队列/流式处理） |
| `tsdown.config.ts` | 全量内联 bundle 配置 |

---

## 7. 与其它子系统的接口

### 7.1 pi-tui 对外 API（`src/index.ts` 是唯一出口）

- **消费方**：仅 `apps/kimi-code`（`package.json` `@moonshot-ai/pi-tui: workspace:^`）。84 个文件 import；`tui-state.ts:69-70` 创建 `ProcessTerminal` + `TUI`；`CustomEditor extends Editor`（`tui/components/editor/custom-editor.ts:120`）叠加应用层键位（mention 补全、可换行 SelectList）。
- **主要 API 面**：
  - 引擎：`TUI`（addChild/removeChild/setFocus/requestRender/start/stop/showOverlay/addInputListener/onTerminalColorSchemeChange/queryTerminalBackgroundColor…）、`Container`、`Component/Focusable` 接口、`CURSOR_MARKER`；
  - 组件：`Text/TruncatedText/Input/Editor/Markdown/Loader/CancellableLoader/SelectList/SettingsList/Box/Spacer/Image`；
  - 输入：`Key/matchesKey/parseKey/decodePrintableKey/isKeyRelease/isKeyRepeat/setKittyProtocolActive`、`StdinBuffer`；
  - 终端：`Terminal` 接口 + `ProcessTerminal`（另有测试用 `VirtualTerminal`，基于 @xterm/headless）；
  - 工具：`visibleWidth/truncateToWidth/wrapTextWithAnsi/sliceByColumn/fuzzyFilter`；
  - 图片：`renderImage/encodeKitty/encodeITerm2/detectCapabilities/hyperlink`；
  - 补全：`CombinedAutocompleteProvider`。
- **不对外**：不依赖也不暴露 agent 引擎任何概念；`imports` 映射 `#/* → ./src/*.ts` 仅供包内使用；发布物 `dist/` 由 tsdown 构建（发布版 export 指向 dist）。

### 7.2 vscode 的对外接口

- **被谁调用**：`apps/vscode` 是终端用户产品，无 workspace 内消费者；作为 VS Code 扩展暴露：
  - `contributes.commands`：10 个命令（openInTab/openInSideBar/focusInput/insertMention/newConversation/showLogs/resetKimi/logout/migrateLegacyData/clearAllState）；
  - `viewsContainers.activitybar` + `views`（`kimi.webview` 侧边 webview）+ `kimiPanel` 标签页 webview；
  - keybindings：`cmd+shift+k` 聚焦输入、`alt+k` 插入 @mention；
  - configuration：`kimi.yoloMode/autosave/enableNewConversationShortcut/useCtrlEnterToSend/showThinkingContent/showThinkingExpanded/editorContext`；
  - 自定义 scheme `kimi-baseline`：只读文件基线提供者（diff 查看器用）。
- **它消费的接口**：`@moonshot-ai/kimi-code-sdk`（`createKimiHarness` → `KimiHarness.createSession/resumeSession/prompt/steer/compact/cancel/onEvent/setApprovalHandler/setQuestionHandler/getConfig`）；`@moonshot-ai/migration-legacy`（数据迁移）；扩展与 webview 之间是自研 postMessage RPC（shared/bridge.ts），**不经过 kap-server、不用 stdio、不产生子进程**——引擎就在扩展宿主里。

### 7.3 与任务叙述的对照（结论性备注）

- "apps/kimi-code 的 tui/ 用 pi-tui 了吗？"——**用了，而且是唯一使用者**；`src/tui/`（约 4400 行）是 pi-tui 之上构建的完整聊天界面；
- "VSCode 扩展如何与 kimi-code 通信"——**不通信**（无外部进程）；扩展把整个 agent-core 以 SDK 形态内嵌进 Extension Host，webview 通过 postMessage 桥访问；这与 kap-server 形态（HTTP/WS）完全正交。官方共享的是 `KIMI_CODE_HOME` 下的配置文件与数据目录，而不是进程间通道。

---

## 附录：构建与测试要点

- pi-tui 测试用 `node --test`（`pnpm --filter @moonshot-ai/pi-tui test`），**不参与根 vitest**；CI 有专门 `test-pi-tui` job；AGENTS.md 列出的 5 处本地分歧均有守卫测试（`test/tui-render.test.ts`、`test/editor.test.ts` 等），重 vendor 时必须全绿。
- vscode 测试：vitest（`test/` 目录）+ `test:extension-host` 冒烟脚本；发布链路 `package:platform → package:verify → publish:vsix/ovsx`。
- 调试开关：`PI_TUI_WRITE_LOG`（原始 ANSI 流落盘）、`PI_TUI_DEBUG=1`（每帧 diff 明细写 /tmp/tui）、`PI_DEBUG_REDRAW=1`（fullRender 原因日志）、`PI_HARDWARE_CURSOR`、`PI_CLEAR_ON_SHRINK`。
