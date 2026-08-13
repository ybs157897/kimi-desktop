# 功能点与实施路线

本页把方案拆成可排期、可验收的产品阶段，而不是一次性实现“完整人格成长”。具体编码依赖、ownership 和并行门禁以 [实现就绪审查](./08-implementation-readiness-review.md#工作包与依赖) 为准。

## 功能总览

| 模块 | 功能点 | 第一阶段 | 完整形态 |
| --- | --- | --- | --- |
| 身份 | 可信 Profile 来源 → `MemorySubject` | 必须 | 支持显式迁移和别名 |
| 隔离 | owner / workspace / session / task 过滤 | 必须 | 跨工作区受控共享 |
| 捕获 | Turn、Tool、子 Agent 事实写入 L0 | 必须 | Proposal、Feedback 和可配置采样 |
| 脱敏 | Secret、超大输出、二进制内容处理 | 必须 | 组织级 DLP 策略 |
| L1 | 事实、决策、失败模式、方法提取 | 必须 | 多提取器与质量路由 |
| L2 | 场景聚合和导航摘要 | 后续 | 增量场景维护 |
| L3 | Profile 能力与边界模型 | 后续 | 带时间衰减的能力评估 |
| 检索 | 词法全文检索、过滤、预算裁剪 | 必须 | 向量 + RRF + 重排 |
| 自动召回 | 手动 Recall 稳定后再灰度 | 后置 | 动态预算与相关性门限 |
| 主动工具 | 先 Recall/ReadEvidence，再 Proposal/Feedback | 分阶段 | Inspect 仅为运维能力 |
| 并发 | 单本地 writer、首版 lease/fencing、幂等、Snapshot、分区串行 | 必须 | 多节点锁/CAS、租约和任务迁移 |
| 治理 | Candidate、Validated、Challenged 等状态 | 必须 | 审批、策略和批量治理 |
| 恢复 | L0 重放、投影重建、最后良好 Snapshot | 必须 | 自动灾难恢复演练 |
| 可观测 | 指标、Trace、结构化事件 | 必须 | 质量 Dashboard 和成本归因 |
| 管理界面 | Inspect 只读视图 | 后续 | 编辑、冲突处理、数据导出 |
| 后端 | 本地持久化 | 必须 | TencentDB 适配和混合部署 |

## P0：身份与证据底座

### 功能

- 建立 `ProfileMemoryFeature`、typed config 和 `profile_memory` 实验 Flag。
- 从 Profile 绑定、Session Catalog 和各 Scope 生成可信 `MemorySubject`。
- 把胜出的 Profile `sourceId` 持久化进可回放 binding；旧 Wire 缺来源只关闭 Memory，不按当前 Catalog 猜测。
- 把 `IWorkspaceTrust` 作为 Capture、Projection、Manual/Auto Recall、Proposal 和 Feedback 的强门禁。
- MVP 只允许本地安装主体下来源为 builtin 的 `coder`，只使用 Workspace 范围。
- 为每个主体/Workspace 建立有耐久 receipt、opaque position 和逐事件幂等的 L0 Evidence Store；Capture 连续 source checkpoint 单独维护。
- 分离 L0 `durableThroughPosition` 与 Capture source cursor；通过持久 workspace trust epoch 和 Queue fencing token 拒绝晚到工作。
- 捕获 Turn、Tool 和子 Agent 的确定性完成事实；Feedback 和 Proposal 随工具阶段开放。
- 写入时完成大小限制、敏感字段脱敏、哈希和来源记录。
- 实现幂等键、Session Checkpoint 和基本审计事件。
- 提供 operator-only `MemoryInspect`，可查看 owner、position、队列状态和最近错误。

### 验收标准

1. 同时创建三个 `coder` 实例，三者的事件进入同一个 owner 日志，但保留不同 `runtimeAgentId`。
2. `plan`、同名自定义 `coder` 和其他 Workspace 不能读取 builtin `coder` 的 L0；工具参数根本不含 owner。
3. 同一 Capture 批次重试不会产生重复事件。
4. 进程在 append 后、source checkpoint 前崩溃，按来源 cursor 重扫，最多重复提交并由幂等去重，不丢事件。
5. Secret 规则命中的原文不进入日志和遥测。

## P1：可用的 L1 记忆与检索

### 功能

- 异步把 L0 提取为 L1 Atom。
- 覆盖 `project_fact`、`decision`、`constraint`、`task_outcome`、`failure_pattern`、`work_method`、`tool_knowledge`、`user_feedback`、`capability_evidence` 和 `artifact`。
- 实现 Evidence Gate、去重、冲突检测、状态机和适用范围。
- 建立领域词法 Search Store，并支持类型、状态、workspace 和时间过滤；公共契约不承诺具体评分算法。
- 实现 `MemoryRecall`、`MemoryReadEvidence`、`MemoryPropose`、`MemoryFeedback`。
- 召回结果进行 Token 预算裁剪和不可信文本包装。
- 同一 Turn 固定 opaque `snapshotToken`；没有 MVCC 时只复用已钉住结果，不提供任意历史查询。

### 验收标准

1. 没有证据引用的模型自述不能晋升为 `validated`。
2. 一次成功任务只产生 `task_outcome` 或 Candidate，不直接证明普遍能力。
3. 新证据与旧约束冲突时，两者都可审计，旧记忆进入 `challenged` 而非被覆盖。
4. Recall 在 owner 和 workspace 过滤之后再排名，任何检索路径都不能跨边界泄漏。
5. 索引删除后可从权威日志重建，结果 ID 和状态保持一致。

## P2：自动召回与混合检索

### 功能

- 先为当前 Injector 补齐 new-turn query/turnId 桥接，再启用严格超时的自动 Recall。
- 添加向量索引，并以 RRF 融合词法和语义结果。
- 按任务类型、近期反馈、适用范围、时间衰减和冲突状态重排。
- 所有层级统一作为带 provenance 的不可信历史块注入，不修改 Profile system prompt。
- 记录哪些记忆被召回、是否采用、最终任务结果和成本。

### 验收标准

1. 后端超时不会阻塞主任务超过配置上限。
2. 自动召回为空或失败时，Agent 仍能正常执行且不会看到伪造的“无记忆”指令。
3. 召回 Token 不超过预算，超出时按相关性和层级裁剪，并返回 `truncated`。
4. 质量基准中，混合检索相对 lexical-only 有可重复的提升，否则不启用向量路径。

## P3：L2 场景与 L3 自我模型

### 功能

- 将相关 Atom 聚合为工作区级 Scenario。
- 从跨任务能力证据生成 Profile Self Model。
- 为能力声明保存支持证据、反证、样本量、适用任务、最近验证时间和置信度。
- 采用分区队列：L2 按 owner + workspace 串行，L3 按 owner 串行。
- 支持冷启动、定期刷新、失败恢复和最后良好 Snapshot。
- 提供“为什么形成这条能力判断”的证据追溯。

### 验收标准

1. 单次成功不能把能力从未知提升为稳定能力。
2. 至少跨多个任务、多个时间点且有工具结果支持，才能进入高置信能力声明。
3. 失败和纠正证据会降低或限定能力适用范围，而不是只积累正向案例。
4. L2 Worker 对同一 owner + workspace、L3 Worker 对同一 owner 的并发更新不会最后写入覆盖。
5. 投影损坏时能从 L0/L1 重建，重建前继续提供最后良好 Snapshot。

## P4：治理、可视化与外部后端

### 功能

- 在 Kimi Inspect 中展示 Profile、队列、Atom、Scenario、Self Model、冲突和证据链。
- 支持人工确认、拒绝、弃用、纠错和数据导出。
- 接入 TencentDB Agent Memory v3 镜像 Adapter，并保留本地权威、Outbox、映射和隔离检查。
- 增加保留期、删除请求、备份恢复、数据迁移和 Profile 重命名工具。
- 建立质量与成本 Dashboard、离线回放基准和版本对比。

### 验收标准

1. 操作者可以解释一条记忆的来源、版本、状态变化和实际使用记录。
2. 删除 owner 或 workspace 数据后，权威数据、索引、缓存和外部镜像都被一致处理。
3. 外部后端不可用时按策略降级，本地与外部状态不会静默分叉。
4. Prompt 或提取模型升级前可离线回放，并能比较新增、合并、冲突和误判率。

## 交付拆分

编码工作包固定为 WP0–WP10D：先由单一负责人完成 Contract/ADR 和 Feature 骨架，再并行 Evidence Store、Worker Queue 和 Profile/Tool wiring；Capture、L1、Recall、Tools 和 Auto Recall 按依赖逐层开始。Klient、KAP REST、L2/L3 和 TencentDB 是核心稳定后的独立工作包。

完整依赖图、每包允许并行的时点和验收标准见 [08：工作包与依赖](./08-implementation-readiness-review.md#工作包与依赖)。可直接分发的任务说明见 [09：多 Agent 实施提示词](./09-implementation-agent-prompt.md)。每个工作包都应包含 Schema/Contract、单元或集成测试、指标和开关；不要先写全套 Prompt，再补不可绕过的数据约束。

## 推荐 MVP 边界

第一版可对真实开发任务产生价值的最小集合：

- 同一本地安装主体的 builtin `coder` Profile 共享一份 Workspace 隔离的记忆。
- L0 Evidence Log 和 L1 Atom。
- 领域词法全文检索，不强制或承诺 BM25，不引入向量数据库。
- 先手动 Recall；自动 Recall 是后续独立灰度工作包。
- 先 Recall、ReadEvidence，再开放 Proposal、Feedback。
- Candidate / Validated / Challenged / Deprecated 状态。
- 幂等、Snapshot、冲突、重建和基本观测。
- 本地后端是唯一权威；TencentDB v3 镜像不阻塞核心 Domain，也不进入 MVP。

MVP 暂不做“自动改永久人格”、跨 Profile 学习、自治修改 Skill、无审核的全局记忆晋升和 L3 高自由度叙事生成。

## 已冻结边界与后续决策门

MVP 已冻结为：builtin `coder` only、Workspace only、本地权威、单 writer、人工编辑也追加 Evidence。`agent`、`plan`、`explore` 和自定义 Profile 全部默认关闭；裸 Profile 名称不作为安全身份。Profile 来源迁移不是 MVP：旧 binding 缺 `sourceId` 时只关闭 Memory，后续必须通过独立、显式迁移工作包恢复。

以下问题不阻塞核心 MVP，但在对应后续工作包开始前必须另写 ADR：

1. 其他 Profile 如何显式启用、重命名、迁移和处理来源切换。
2. global 的真实租户/团队边界及跨 Workspace 晋升审批。
3. L0 默认保留期、容量、legal hold、备份残留和协调删除 SLA。
4. 多进程/远程部署的租约、fencing、CAS 与故障域。
5. Klient、KAP REST 和未来 WebSocket 分别面向哪些认证主体。
6. TencentDB v3 镜像的部署、对账、删除和数据驻留要求。

## 完成定义

一个阶段只有同时满足以下条件才算完成：

- 功能通过 Scope 隔离和并发测试。
- 每条投影可追溯至 L0 Evidence。
- 失败路径有明确降级或 Fail-closed 策略。
- 有可观测指标，能区分“没召回”“召回未采用”“召回导致失败”。
- Feature 始终组装，但 Feature Flag/config 可关闭全部新行为；关闭后不打开 Store、不订阅 Capture、不启动 Worker、不 materialize 工具或注入上下文，也不改变基础 Agent 行为。
- Schema 和 Prompt 版本可识别，旧数据可迁移或重建。
