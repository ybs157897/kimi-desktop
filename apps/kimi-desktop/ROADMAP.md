# Kimi Code Desktop 落地路线图（M6 → M9）

> 本文档梳理 TUI（`apps/kimi-code`）已具备、而 Desktop（`apps/kimi-desktop`）尚未覆盖的功能，并给出落地路线。
> 来源：`apps/kimi-code`（src/tui/ 292 个 TS 文件）功能盘点 + kap-server / `@moonshot-ai/protocol` / `@moonshot-ai/agent-core-v2` 协议面调研。
> 状态：**M6 / M7 / M8 / M9 已实施**（待 GUI 验收）；遗留待办：init / plugins / MCP（协议缺口，见「里程碑 M7」7.2）。

## 约定（硬约束）

- Desktop **只消费契约**，不修改 kap-server / protocol / transcript 的代码。
- **plan / goal / swarm 必须走 `POST /sessions/{id}/profile` 的 `agent_config`**。prompt 提交里的 `plan_mode` / `swarm_mode` / `goal_objective` 是 v1 兼容字段，v2 路由（`packages/kap-server/src/routes/prompts.ts:247-271`）只应用 `profile/model/thinking/permission_mode/disabled_tools`，其余忽略。
- GUI 无法在本开发环境验收，每个里程碑以「纯逻辑单测 + typecheck + build」门控，GUI 项标注「需 GUI 验收」。

## 已完成（M0–M5）

- 内嵌/附着 server 生命周期、连接错误屏、版本展示
- 会话列表 / 搜索 / 归档 / `fs:browse` 目录选择器
- Transcript 渲染（`@moonshot-ai/transcript` 双向同步：REST 基线 + `subscribe_v2` + seq 补洞）
- Composer（Slate：`@`/`$`/`/` 提及 + 附件上传 + steer + send/stop/queue）
- Plan 评审卡（`tool_input_display.kind === 'plan_review'` 审批交互）
- 面板系统：diff / 文件树 / 终端（完整 PTY，第三条 WS + xterm.js）/ open-in
- 主题（light/dark/system）、快捷键、多窗口、会话导出 ZIP、electron-builder 配置

---

## 里程碑 M6：模式体系（**已实施，待 GUI 验收**）

目标：把 TUI 的四大模式（plan / goal / swarm / yolo 权限）完整落到 Desktop。

### 6.1 数据层底座（✅ 已完成）

| 新增 | 端点 / 事件 | 说明 |
|---|---|---|
| `updateSessionProfile(sessionId, {agent_config})` + hook | `POST /sessions/{id}/profile` | `sessionAgentConfigPartialSchema`：`model` / `system_prompt?` / `tools?` / `mcp_servers?` / `thinking?` / `permission_mode?`(`manual\|yolo\|auto`) / `plan_mode?`(bool) / `swarm_mode?`(bool) / `goal_objective?`(string) / `goal_control?`(`pause\|resume\|cancel`) |
| `getGoal()` + hook | `GET /sessions/{id}/goal` | `GoalSnapshot \| null`：`goalId` / `objective` / `completionCriterion?` / `status`(`active\|paused\|blocked\|complete`) / `turnsUsed` / `tokensUsed` / `wallClockMs` / `budget` / `terminalReason?` |
| WS 事件消费 | `agent.status.updated`（含 `planMode/swarmMode/permission/model/thinkingEffort`）、`goal.updated`（`{snapshot, change?}`） | 实现方式：**ActivitySocket 增加 `follow(sessionId)`**，用 `subscribe_v2` + transcript grade `'off'` 订阅活动会话 —— 这是唯一不被 `suppressedByTranscript` 抑制的 grade（transcript socket 的 `block` 收不到这两个原始事件，只能拿字段不全的投影）；事件合并进 `['session', id]` / `['goal', id]` 缓存 |
| createSession 带配置 | 创建时传 `agent_config` | 新会话继承 localStorage 默认权限模式 |

说明：`getSessionStatus`（ROADMAP 原 6.1 条目）**未接 UI** —— 模式栏所需字段 `session.agent_config` 已覆盖，status 端点留待后续需要时再加。

单测：`test/sessionModes.test.ts`（22 项：profile patch 构造、`applyStatusEventToSession` 合并、duration/tokens 格式化、goal 预算进度）。

### 6.2 会话模式栏（✅ 已完成）— 位置：App.tsx 头部右侧（终端按钮左侧）

- **权限模式**：下拉（manual/auto/yolo，含「默认」空值）+ 会话级写 profile + 实时显示（ws `agent.status.updated.permission` 合并进缓存）；Composer 的 per-prompt 下拉保留
- **Plan 开关**：chip 切换 → profile `plan_mode`，活动态高亮
- **Swarm 开关**：chip 切换 → profile `swarm_mode`，活动态高亮
- **Goal 按钮**：无目标 → `GoalDialog` 输入 objective → profile `goal_objective`；有目标 → 展开 `GoalStatusCard` 下拉
- **模型**：Composer 的 ModelSelect 增加「📌 设为本会话默认」→ profile `model`（选中 per-prompt 覆盖时显示）

### 6.3 Goal 状态卡（✅ 已完成，依赖 6.1）

`GoalStatusCard`：objective / 状态 chip（进行中·已暂停·受阻·已完成，语义色）/ 回合 / tokens / 耗时 / 预算进度条 + **暂停 / 继续 / 取消**（→ profile `goal_control`）。数据来自 `useGoal`（REST 基线 + `goal.updated` 事件 + 30s 轮询兜底）。

**需 GUI 验收**：模式栏交互、Goal 弹窗/状态卡、实时刷新（模型自行进入 plan/swarm 时头部联动）、新会话权限继承。

---

## 里程碑 M7：会话管理增强（**已实施，待 GUI 验收**）

> **协议面修正（2026-08 核实）**：fork / undo / compact / btw / 后台任务**均有现成 REST 端点**
> （`POST /sessions/{id}:fork|:undo|:compact|:btw`、`GET|POST /sessions/{id}/tasks*`，schema 全在
> `@moonshot-ai/protocol` 已导出；web UI 已在用）。早期「kap-server REST 面无端点」的评估是错的。

### 7.1 已实施（协议就绪）

| 功能 | 端点 / 说明 | 工作量 | 状态 |
|---|---|---|---|
| 审批面板增强 | 危险命令红字（`lib/dangerousCommand.ts`，TUI 8 模式：recursive delete / sudo / pipe to shell / dd write / mkfs / raw device / chmod 777 / fork bomb）+ 全屏 diff 预览（`FullscreenPreview`，`diffRender` 渲染 display 的 before/after） | M | ✅ |
| 撤销 | `POST /sessions/{id}:undo` `{count?, page_size?}` → `{messages, status}`；成功后 `TranscriptSync.refresh()`（新增 public 方法）REST 基线重拉 | M | ✅ |
| 压缩 | `POST /sessions/{id}:compact` `{instruction?}` → `{}` | S | ✅ |
| Fork | `POST /sessions/{id}:fork` `{title?, metadata?}` → Session；fork 后自动切到新会话 | S | ✅ |
| btw 侧向问答 | `POST /sessions/{id}:btw` → `{agent_id}`（`agent-<N>`，普通 session agent）；侧向面板 = 第二个 `<ChatView agentId>`（ChatView/Composer 加 `agentId` prop，prompt 带 `agent_id`） | L | ✅ |
| 后台任务浏览器 | `GET /sessions/{id}/tasks?status=`、`GET /tasks/{id}?with_output=&output_bytes=`（输出在 `output_preview`/`output_bytes`）、`POST /tasks/{id}:cancel`（40904 幂等）；`TaskBrowser` 模态 + 3s 轮询 | M | ✅ |
| Todo 面板 | `TranscriptChatStore.state.todos`（`todo.upsert` op 维护，无需解析）；ChatView 内 Composer 上方，>5 条折叠 | S | ✅ |

队列面板**不单独实现**：desktop 忙时 steer 语义已覆盖（TUI 的排队+Ctrl-S 注入等价物）。

### 7.2 遗留待办（协议缺口，web 也没有，暂不做）

| 功能 | 说明 |
|---|---|
| `/init`（生成 AGENTS.md） | 无 REST 端点（web bundle 无 `:init`） |
| `/plugins` 插件管理 | 无 REST 端点 |
| MCP 状态列表 | 无 REST 端点（仅 ws `mcp.server.status` 事件） |

---

## 里程碑 M8：配置中心（**已实施，待 GUI 验收**）

| 功能 | 协议 | 工作量 | 状态 |
|---|---|---|---|
| 默认模型 | `POST /api/v1/config {default_model}`（merge 语义，非 PATCH；等价于 `/models/:set_default`，单一写路径） | S | ✅ |
| 默认权限模式（替换 localStorage 方案） | `POST /config {default_permission_mode}`（枚举 manual/auto/yolo 与 `PromptPermissionMode` 同集合；写后 `event.config.changed` 自动刷新 `['config']` 缓存） | S | ✅ |
| 默认 plan 模式 | `POST /config {default_plan_mode}`（boolean） | S | ✅ |
| Provider 管理 | `GET/POST/PUT/DELETE /api/v1/providers*`（`type` 枚举 kimi/openai/openai_responses/anthropic/google-genai/vertexai；`status` 枚举 connected/error/unconfigured）+ `GET /api/v1/catalog/providers`（models.dev 目录，`POST /providers:import_catalog` 导入）+ `POST /providers/{id}:refresh` | L | ✅ |
| API key 输入 | create/import body `api_key`；编辑走 PUT 三态（缺省=保留 / `""`=清除 / 值=替换，`GET /providers/{id}` 回填） | S | ✅ |
| 自定义主题加载 | 本地文件（`~/.kimi-code/themes/*.json`） | S | ⏸️ 暂缓：需主进程 IPC + TUI 主题 JSON → desktop `--color-*` token 映射契约不明确，价值低 |
| MCP 状态面板 | ⚠️ 依赖 M7 决策 | M | ⏸️ 待 M7 决策 |

实施说明：
- config 更新实际是 **POST /api/v1/config**（merge 语义），`patchConfigRequestSchema` 在 `@moonshot-ai/protocol` 已导出；桌面 `request()` 扩展了 PUT/DELETE 方法与 204 无体响应（DELETE provider）。
- providers 的 create/replace/import/catalog schema **不在 protocol 包**（kap-server 独立副本），按 export 先例客户端手写类型（`lib/api.ts` 的 `CreateProviderRequest` 等）。
- PUT 编辑需完整 `models`：从 `GET /models` 按 provider 过滤重建（`lib/providers.ts` 的 `buildProviderModelsFromCatalog`，剥 `${providerId}/` 别名前缀）。
- UI：Settings 新增「默认模型 / 默认权限 / 默认计划 / Provider 管理」分区；`ProviderManager` 模态（列表 + 编辑/刷新/删除[y/N] + 目录导入 + 手动添加，`ProviderEditDialog` 双模式）。
- 单测：`test/providers.test.ts`（17 项：别名剥前缀、models 重建、api_key 三态、目录过滤、权限模式归一化）。

**需 GUI 验收**：Settings 默认值写入与实时回显、Provider 增删改/导入交互、OAuth 托管 provider（40003）拒绝提示。

---

## 里程碑 M9：桌面体验面（**已实施，待 GUI 验收**）

| 功能 | 说明 | 工作量 | 状态 |
|---|---|---|---|
| 状态栏（footer 等价） | 窗口底部细条：模型（`useSession` 事件合并）+ thinking（`GET /sessions/{id}/status` 的 `thinking_level`）+ `context: N% (tokens/max)`（`context_usage` 0..1 + 事件合并）+ git 分支（v2 列表 `include=git`） | M | ✅ |
| 剪贴板图片粘贴 | 新 IPC `readClipboardImage`（main 进程 `clipboard.readImage` → PNG data URL）+ 长边 2048 压缩（`lib/imageScale.ts` 纯函数 + `clipboardImage.ts` canvas）+ 复用 `uploadFile` 管线；Composer onPaste 按 files → items → IPC 三级兜底 | M | ✅ |
| Welcome 屏 | 启动空态：logo + 新建会话按钮 + 工作目录（`fs:home`）/ 默认模型（config）/ 后端版本·模式 | S | ✅ |
| 在浏览器打开 | TUI `/web` 等价：头部 🌐 按钮 → 新 IPC `openExternal`（`shell.openExternal`，http/https 白名单校验）→ `webAppUrl` 深链（`origin/sessions/<id>#token=`，对齐 TUI `webSessionUrl`） | S | ✅ |
| `/btw` 侧向问答 | 侧向面板（第二个 `<ChatView agentId>`）在 M7 已实施，见里程碑 M7 | L | ✅（M7） |

实施说明：
- `applyStatusEventToStatus`（`lib/sessionModes.ts`）把 `agent.status.updated` 的 context/thinking 字段合并进 `['session-status']` 缓存（`max_context_tokens` 0=unknown 不覆盖），30s 轮询兜底。
- 测试：`test/experience.test.ts`（webAppUrl 5 项 + computeScaledSize 6 项）+ `sessionModes.test.ts` 补 `applyStatusEventToStatus` 4 项。

**需 GUI 验收**：状态栏显示与实时刷新、截图粘贴、Welcome 屏、浏览器打开深链。

---

## 排期与依赖

```
M6 数据层（无前置依赖）
  └→ M6 模式栏 / Goal 卡
       └→ M7 协议就绪项（审批/队列/todo，复用 ws 底座）
M8 配置中心（独立，可与 M7 并行）
M9 体验面（依赖 M6 状态事件 + M8 完成度）
```

| 里程碑 | 预估工作量 | 主要风险 |
|---|---|---|
| M6 | ~1 周（✅ 已实施，待 GUI 验收） | ws 事件消费改动 ActivitySocket（grade `'off'` 订阅 + follow 切换） |
| M7 | ~1 周（✅ 已实施，待 GUI 验收） | undo 后 transcript 基线刷新；btw 双 transcript socket |
| M8 | ~3-4 天（✅ 已实施，待 GUI 验收） | provider 表单量大；PUT 需重建 models；DELETE 204 无体 |
| M9 | ~1 周（✅ 已实施，待 GUI 验收） | 剪贴板图片跨平台（mac 主测）；DOM 模块不得进 main project 的 test 编译面 |

## 风险与决策点汇总

1. **遗留协议缺口**（init / plugins / MCP）：无 REST 端点（web 也没有），保持待办。
2. **prompt 层 plan_mode/swarm_mode/goal 字段不生效**：一律走 profile（硬约束）。
3. **ws 事件消费**：模式事件走 ActivitySocket 的 grade `'off'` 订阅（M6 已落地）；`agent.status.updated` 是 volatile 帧，socket 重连间隙会丢 —— `useGoal` 有 30s 轮询兜底，权限/plan/swarm 状态由 profile 写回后的 invalidate 兜底。
4. **GUI 验收缺失**：每阶段纯逻辑单测门控，GUI 项标注「需 GUI 验收」。

## 每阶段验证策略

- `pnpm --filter @moonshot-ai/kimi-desktop test`（优先把纯逻辑单测加到现有 `test/` 文件）
- `pnpm --filter @moonshot-ai/kimi-desktop typecheck`
- `pnpm --filter @moonshot-ai/kimi-desktop build`
- `node scripts/check-nix-workspace.mjs`
- `git diff --check`
- GUI 交互项（模式栏、终端、拖拽等）明确标注「需 GUI 验收」
