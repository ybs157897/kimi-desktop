# Agent Profile 共享记忆系统实现设计

本文档包定义 Kimi Code Agent Profile 共享记忆系统的目标架构、数据模型、通信协议、v2 引擎落位方式、功能边界和实施路线。它面向后续实现者和评审者，是一份设计提案，不表示仓库中已经存在对应功能。

系统的核心身份规则是：**一个可信解析后的 Agent Profile 主体对应一份长期记忆，运行时 Agent 只是该主体的并发工作实例。** 例如，同时运行的多个内置 `coder` 实例共同读取和贡献同一份记忆；同名但来源、部署主体或世代不同的 Profile 不会因为名字相同而自动共享。

```text
长期主体：local-installation/builtin:coder/epoch-0（MVP 受保护常量）
├─ 运行实例：agent-a91
├─ 运行实例：agent-b27
└─ 运行实例：agent-c08
       │
       └──────────────► memoryOwnerId = trusted("builtin:coder")
```

> **实现就绪状态：** 当前文档已经完成架构设计，但编码前仍需先冻结身份、持久化、队列和协议契约。实施者必须先阅读 [实现就绪审查与工作包](./08-implementation-readiness-review.md)，不能直接把本文中的概念性 TypeScript 片段当成已闭合接口。首轮实施提示词见 [多 Agent 实施提示词](./09-implementation-agent-prompt.md)。

> **发布边界：** 这是仓库内部实施设计，位于 `docs/` 便于协作，但已从 VitePress 用户文档构建中排除；它不需要 `docs/en` / `docs/zh` 公开文档镜像。功能对用户可用时，再为实际产品行为另写双语用户文档。

## 设计决策摘要

| 决策 | 结论 |
| --- | --- |
| 长期身份键 | 使用运行时可信解析的 `MemorySubject`；`profileName` 只是其中的显示字段，不能单独作为全局存储键 |
| 多实例关系 | 同一 Profile 的所有实例共享一份逻辑记忆 |
| MVP 隔离 | 仅启用内置 `coder`，只提供当前本地部署主体内的 Workspace 级记忆；不开放 global、跨用户或跨租户共享 |
| 记忆分层 | 采用 `L0 Evidence → L1 Atom → L2 Scenario → L3 Self Model` |
| 权威来源 | L0 在保留/删除命令前按只追加方式写入，是权威记录；L1–L3 是带版本、可重建的投影 |
| Memory Agent 定位 | 负责提取、归纳、冲突分析和召回组织，不直接拥有数据库 |
| 存储定位 | 确定性 Memory Service 负责身份绑定、权限、版本、持久化和恢复 |
| 写入方式 | 普通 Agent 只能记录经历和提交候选记忆，不能直接改写永久记忆 |
| 读取方式 | 自动召回提供少量相关上下文，工具调用负责主动深挖 |
| MVP 检索 | 元数据过滤后的词法全文检索；向量与 RRF 属于后续质量优化，契约不承诺具体评分算法 |
| MVP 并发 | 每个本地 Store 单写者，但 Queue 首版仍带 lease ID + 分区单调 fencing token，防止同进程重领后的晚 Worker；多进程还需跨进程锁/CAS 证明 |
| Feature 开关 | Feature 始终组装；Flag/config 在 Service、工具、Capture/Worker 和注入入口 fail closed，关闭时没有运行副作用 |
| Workspace 信任 | App-scope `IWorkspaceTrustAuthority` 按 canonical trust-record key 共享唯一状态、事件和跨进程锁；Workspace `IWorkspaceTrust` 只是 facade。每次 mutation/commit 同时校验 opaque `rootBindingId + epoch`，动态 symlink retarget会撤销旧 binding；跨进程 watch health fail closed，project MCP只读取冻结 canonical root。v2 记录以 file fsync + rename + parent-directory fsync耐久保存；Profile Memory另用懒获取的 home级 writer lease保证单写者 |
| Capture 恢复 | L0 `durableThroughPosition` 与 Context/Wire source cursor 分离；来源连续前缀成功后才推进 checkpoint |
| 故障方式 | 记忆故障默认降级，不阻塞 Agent 完成主要任务；持久化确认除外 |

## 文档目录

1. [总体架构](./01-architecture.md)：目标、边界、组件、Scope 布局和主要数据流。
2. [记忆模型与处理流水线](./02-memory-model-and-pipeline.md)：L0–L3 数据模型、保存、提取、去重、晋升和召回。
3. [agent-core-v2 实现设计](./03-v2-implementation.md)：建议目录、Service 契约、配置、持久化、运行时注入和 TencentDB 适配。
4. [对接与通信协议](./04-integration-protocol.md)：Agent 工具协议、内部服务协议、事件、HTTP/WS 映射、错误码和幂等规则。
5. [功能点与实施路线](./05-features-and-roadmap.md)：功能矩阵、MVP 边界、里程碑、依赖和验收标准。
6. [安全、可靠性与测试](./06-security-reliability-and-testing.md)：提示词注入、证据门禁、并发恢复、可观测性和测试策略。
7. [Memory Worker 中文提示词契约](./07-worker-prompts.md)：L1 提取、冲突评估、L2/L3 投影和召回整理的基线提示词。
8. [实现就绪审查与工作包](./08-implementation-readiness-review.md)：代码事实、缺口、冻结决策、并行依赖、验收和测试门禁。
9. [多 Agent 实施提示词](./09-implementation-agent-prompt.md)：可复制给协调 Agent、契约负责人和各工作包 Agent 的任务提示词。

## 术语

| 术语 | 含义 |
| --- | --- |
| `profileName` | Agent Profile 的显示名称，例如 `coder`；它参与主体解析，但不能单独作为安全身份 |
| `runtimeAgentId` | 一次运行实例的 ID，只用于来源追踪、审计和并发控制 |
| `MemorySubject` | 由可信运行时绑定的复合主体，至少包含部署/租户主体、`memoryOwnerId`、`ownerEpoch`、Profile 来源、Workspace ID 和 opaque `rootBindingId` |
| `memoryOwnerId` | 一个 Profile 逻辑人格的稳定 ID；MVP 内置 coder 使用受保护的 builtin namespace，多实例共享此值 |
| Memory Agent | 逻辑上的记忆管理员，由可横向扩展的 Curator Worker 实现 |
| Memory Service | 确定性的业务服务，负责存储、查询、权限、版本和状态机 |
| L0 Evidence | 原始对话、工具结果、测试结果、反馈等不可随意改写的证据事件 |
| L1 Atom | 从 L0 提取出的独立、可引用的原子记忆 |
| L2 Scenario | 围绕工作区、模块、问题或任务场景聚合的记忆块 |
| L3 Self Model | Profile 的长期能力画像、弱点、工作模式和适用边界 |
| Memory Snapshot | 一次召回所依据的稳定投影版本，保证单轮执行期间认知一致 |

## 非目标

第一阶段不解决以下问题：

- 不训练或微调基础模型。
- 不让普通 Agent 自主修改系统提示词、核心人格或权限。
- 不把所有历史全量注入上下文。
- 不把一个运行实例等同于一个新的人格。
- 不提供任意 Agent 互读私有记忆的通用邮箱。
- 不把向量索引当作权威事实源。
- 不因一次任务成功就自动生成全局 Skill 或稳定能力结论。

## 参考实现的采用边界

保存和召回流水线参考 [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/feat/server_team/README_CN.md) 的分层设计，重点采用以下思想：

- 原始内容先保存，再异步提炼。
- `L0 Conversation → L1 Atom → L2 Scenario → L3 Persona` 分层生长。
- 词法、向量与 RRF 混合召回的分层思路；MVP 只承诺词法全文检索，不复制具体评分实现。
- 记忆按身份隔离，通过 Loadout 按需进入 Agent 上下文。
- 对召回条数、字符数、Token 和超时设置预算。

本设计不直接复制其用户画像语义。针对 Kimi Code，L3 被定义为 Agent Profile 的自我模型。外部服务的 `agent_id` 由适配器映射表从可信 `MemorySubject` 派生，不能直接等同于裸 `profileName`；运行实例 ID 只保留为证据来源。
