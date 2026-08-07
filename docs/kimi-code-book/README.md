# Kimi Code 源码解读：从终端到 DI 引擎

> **《Kimi Code 实现详解》**——一本基于源码逐模块考古写成的技术学习文档。
> 覆盖 Moonshot AI（月之暗面）终端 AI 编码代理 `kimi` 的全部核心子系统：约 20 个 workspace 包、40 万行 TypeScript。

## 如何使用本书

本书假设你已了解 TypeScript 基础（class/interface/async/泛型）与前端工程常识（pnpm workspace、Node 生态），目标是读完每一章后能**在源码中独立定位并解释对应机制的实现**。每章统一按"定位 → 结构 → 数据流 → 实现细节 → 代码索引"组织，代码引用格式为 `packages/<pkg>/src/<path>.ts:行号`（或 `apps/<app>/src/...`），全部相对仓库根 `kimi-code/` 解析。

> 源码基线：`~/Documents/ybs/code/proxy/kimiwork/kimi-code`（workspace 0.1.x，2026-08 快照）。行号随版本演进可能漂移，请以文件内注释与结构为准。
> 术语沿用官方文档约定：轮次（turn）、工具调用（tool call）、审批请求（approval request）、YOLO 模式、Plan 模式、Thinking 模式。

## 总目录

### 第 1 章 [总览与架构](01-总览与架构.md)
- 1.1 Kimi Code 是什么（运行形态：TUI/headless/web/ACP/VSCode）
- 1.2 仓库布局与代码规模 Top 10
- 1.3 总体架构：壳-引擎严格分层（SDK 门面）
- 1.4 设计主线（引擎可替换 / 可重放状态 / 权限第一公民 / 终端完整性）
- 1.5 阅读路线图

### 第 2 章 [CLI 应用外壳：启动、更新与 SEA 打包](02-CLI应用外壳.md)
- 2.1 定位：夹在用户终端与引擎之间的外壳
- 2.2 模块地图
- 2.3 进程启动时序（main → handleMainCommand → runShell/runPrompt）
- 2.4 交互模式启动（stty / crash 恢复 / 信号语义）
- 2.5 TUI 层结构（KimiTUI / 控制器 / slash 命令 / reverse-RPC）
- 2.6 SDK 事件 → 屏幕的消息流（50ms flush 节流）
- 2.7 非交互 `-p` 模式（事件状态机 / keep-alive / headless 双保险）
- 2.8 更新系统（灰度分桶 / 后台安装状态机 / CVE 防御）
- 2.9 SEA 打包（5 步流水线 / 资产校验解包 / module hook）
- 2.10 迁移与反馈
- 2.11 v2 原生 print runner
- 2.12 关键代码位置索引

### 第 3 章 [v2 引擎：DI × Scope 新架构](03-v2引擎.md) ★核心章节
- 3.1 四层作用域（App/Workspace/Session/Agent）
- 3.2 DI Scope 内核（Fiber 五态机 / 级联引擎 / collection 贡献点）
- 3.3 回合主循环（请求队列 + 惰性物化 / StepRequest / 错误链）
- 3.4 上下文折叠（loopEventFold / computeUndoCut）
- 3.5 工具系统（ToolAccesses 冲突语义 / veto 事件链 / 执行管线）
- 3.6 权限与审批（12 策略静态链 / waitUntil 冷工厂 / 三层可见性）
- 3.7 全量压缩（观测学习 ×0.85 / historySafeToCompact / 输入阶梯）
- 3.8 wire 可重放状态机（dispatch / restore / checkpointed model / undo）
- 3.9 会话与 Agent 生命周期（sessionSeedAdapters / fork 快照）
- 3.10 MCP 集成（mcpCore / 失败阶梯 / OAuth）
- 3.11 kosong：LLM 抽象（ProtocolTrait / 两条 pair 注册 / 提示缓存）
- 3.12 持久化（write/append 两原语 / AppendLogStore / sticky failure）
- 3.13 配置分层（五份视图 / stripEnv）
- 3.14 关键代码位置索引

### 第 4 章 [v1 引擎：上一代内核](04-v1引擎.md)
- 4.1 定位：被 v2 取代，但绝非死代码
- 4.2 手写 DI 容器（环检测双保险 / Proxy 延迟实例化）
- 4.3 loop：无状态主循环（事件双路 / 五个窄接口）
- 4.4 Agent 聚合根（20 个子管理器 / TurnFlow / 6 钩子）
- 4.5 ContextMemory（尾部闭合不变量 / 投影层）
- 4.6 容错三层防御（退避重试 / 媒体投影降级 / 溢出观测学习）
- 4.7 工具执行的安全边界（coerceToolResult / 2s 宽限 / SSRF 防护）
- 4.8 RPC：同进程模拟网络
- 4.9 事件溯源式 wire log
- 4.10 其它子系统速览（MCP/插件/Hook/后台任务/Goal）
- 4.11 关键代码位置索引

### 第 5 章 [KAP 服务器与 kosong](05-KAP服务器与kosong.md)
- 5.1 kap-server：传输外壳（startServer 组合根）
- 5.2 启动时序与安全模型（loopback/lan/public 分级）
- 5.3 WS 事件流（durable/volatile 二分 / 三个一致性机制 / Journal）
- 5.4 反射 RPC 面（/api/v1/debug，无白名单）
- 5.5 Transcript 双通道（活数据优先 / healTurnOps）
- 5.6 搜索服务（generation 发布 / terms vs literal）
- 5.7 文件监视（WS 旁路）
- 5.8 路由层（defineRoute / :action 约定 / 占位投影）
- 5.9 kosong：最薄的 LLM 抽象（消息级工具声明 / 并行工具路由 / 五 adapter）
- 5.10 关键代码位置索引

### 第 6 章 [TUI 与 VSCode 集成](06-TUI与VSCode.md)
- 6.1 两条路线（自研终端图形栈 vs 引擎内嵌）
- 6.2 pi-tui：差分渲染三策略 / 帧级引用复用 / Kitty 协商 / StdinBuffer
- 6.3 VSCode：postMessage 桥 / 不可信 webview / 一会话一 turn / 双许可审批
- 6.4 关键代码位置索引

### 第 7 章 [协议层](07-协议层.md)
- 7.1 三组职责（protocol / klient+node-sdk / acp 双桥）
- 7.2 protocol：信封与错误码 / 事件 51 种 / WS 控制面 / 快照-订阅恢复
- 7.3 klient：契约驱动 facade（KlientChannel / wireClone / parity 断言）
- 7.4 node-sdk：双引擎统一（迁移地图 / 事件桥 / 审批 pull 桥）
- 7.5 transcript：14 种幂等 op（append 四态对齐 / 粒度过滤）
- 7.6 ACP 桥：TurnDriver / 工具调用懒建（REPLACE 语义）
- 7.7 关键代码位置索引

### 第 8 章 [minidb：自研嵌入式数据库](08-minidb.md)
- 8.1 定位与演化（Redis × SQLite 血统 / stage 1-12）
- 8.2 数据模型与磁盘帧（22 字节定长头 + CRC trailer）
- 8.3 写入提交路径（同 tick append+apply / ambiguous 语义）
- 8.4 组提交（writev / 整组回滚 / 毒化恢复）
- 8.5 非阻塞压缩（先快照后 WAL / pre-copy 收敛 / 失败自愈）
- 8.6 索引体系（zskiplist / staged 事务 / 查询引擎 / 全文索引）
- 8.7 Generation 检查点（CURRENT 原子发布 / 定义哈希）
- 8.8 ClusterDb 多进程分片（锁租约 / 指纹再校验 / WAL 追赶）
- 8.9 锁文件（watch-bid-rename 接管协议）
- 8.10 事件循环友好性
- 8.11 关键代码位置索引

### 第 9 章 [基础设施](09-基础设施.md)
- 9.1 六个单元的分类
- 9.2 oauth（设备码登录 / token 生命周期 / 401 竞态恢复 / 墓碑）
- 9.3 telemetry（管道五段 / 磁盘兜底 / 崩溃捕获）
- 9.4 kaos（Kimi Agent OS：实例级 cwd / 进程组 kill / SSH）
- 9.5 tree-sitter-bash（预算封顶 / 永不抛异常 / 差分钉住）
- 9.6 migration-legacy（五步迁移 / mtime 还原 / OAuth 不迁移）
- 9.7 kimi-inspect（ProxyChannel / transcript 对账 / 虚拟化零依赖）
- 9.8 关键代码位置索引

## 快速索引：十个必读文件

| 文件 | 为什么值得读 |
|---|---|
| `packages/agent-core-v2/src/app/scopes.ts:12` | 四层作用域拓扑声明——v2 架构的入口 |
| `packages/agent-core-v2/src/_base/di/cascadeEngine.ts:31` | 级联引擎（传染集/等待区）——DI 内核的心脏 |
| `packages/agent-core-v2/src/agent/loop/loopService.ts:610` | 回合主循环（begin/execute/complete/error 四段） |
| `packages/agent-core-v2/src/agent/permissionPolicy/permissionPolicyService.ts:46` | 12 策略静态链——权限决策的语义顺序 |
| `packages/agent-core-v2/src/wire/wireService.ts:105` | wire dispatch——可重放状态机的核心 |
| `packages/minidb/src/write-path.ts:525` | applyOp "must not throw" 契约注释 |
| `packages/minidb/src/compaction.ts:238` | 非阻塞压缩全流程（先快照后 WAL 的崩溃安全论证） |
| `packages/tree-sitter-bash/src/parse.ts:31` | "永不抛异常、预算封顶"的退出契约 |
| `packages/pi-tui/src/tui.ts:1267` | 差分渲染三策略 + 帧级引用复用 |
| `apps/kimi-code/src/main.ts:193` | 失败路径先设 exitCode 的教训 |

## 附录

- 研究报告原始材料（子代理考古产出，含更多代码索引）：`research/01-08-*.md`
- 术语速查：**KAP**=Kimi Agent Protocol（/api/v1 REST + WS 的统称）；**ACP**=Agent Client Protocol（Anthropic 主导，编辑器集成用）；**Scope**=v2 引擎的生命周期作用域（App/Workspace/Session/Agent）；**wire**=每 Agent 的 JSONL 可重放状态日志；**klient**=v2 引擎的契约驱动客户端；**kaos**=执行环境抽象（Kimi Agent OS）；**kosong**=LLM 抽象层（"空"）；**generation**=minidb 的持久化索引检查点。

---

*本文档由对 `kimi-code` 源码的逐子系统考古生成，所有结论均可回溯到对应源码位置。*
