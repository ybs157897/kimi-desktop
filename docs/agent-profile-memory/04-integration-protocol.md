# 对接协议

本文定义 Agent、记忆服务、Worker、KAP Server 和外部记忆后端之间的契约。协议的首要目标不是“让模型能调用更多接口”，而是保证共享身份、隔离、幂等和证据引用不会被自然语言绕过。

> 本页是目标协议草图。当前引用的 View/Event 类型必须在 WP0 中逐一实现为唯一 TypeScript 类型和 strict Zod Schema，字段上限、未知字段策略与错误映射以 [实现就绪审查](./08-implementation-readiness-review.md#编码前必须闭合的契约) 为门禁。在 WP0 完成前，不得让不同实现 Agent各自补全这些类型。

## 协议原则

1. `principalId`、`memoryOwnerId`、`ownerEpoch`、Profile 来源、`workspaceId`、`rootBindingId`、`sessionId`、`runtimeAgentId` 由运行时绑定，模型不能在工具参数中指定。
2. 所有顶层请求带 `schemaVersion`；调用上下文带 `requestId`，写事件带逐事件 `idempotencyKey`；所有投影更新带 `expectedVersion`。
3. Recall 默认只返回摘要和证据引用，不返回完整历史对话。
4. 模型提交的是 Proposal 或 Feedback，不是对 L1/L2/L3 的直接修改。
5. 外部协议使用结构化 JSON；注入给模型的文本由本地 Formatter 统一生成并标记为不可信历史材料。
6. 读接口可降级，鉴权和写入校验不能降级。

## 可信调用上下文

```ts
export interface MemoryInvocationContext {
  readonly requestId: string;
  readonly principalId: string;
  readonly memoryOwnerId: string;
  readonly ownerEpoch: number;
  readonly profileName: string;
  readonly profileSourceId: string;
  readonly workspaceId: string;
  readonly rootBindingId: string;
  readonly sessionId?: string;
  readonly runtimeAgentId?: string;
  readonly taskId?: string;
  readonly turnId?: number;
  readonly source: 'runtime' | 'agent-tool' | 'worker' | 'operator';
}
```

绑定规则：

| 字段 | 可信来源 | 禁止来源 |
| --- | --- | --- |
| `principalId` | 真实认证主体；本地 MVP 为宿主生成的安装级主体 | Display name、共享 bearer、Prompt |
| `memoryOwnerId` / `ownerEpoch` | Profile 绑定时的可信主体解析；MVP 为受保护 builtin 映射 `builtin:coder / 0`，未来迁移到 owner registry | 裸 Profile 名称、Tool 参数、召回结果、普通配置 |
| `profileSourceId` | Profile `bind()` 单次 `catalog.inspect(name)` 返回的胜出来源，与同一次 inspection 的 Profile 一起写入 binding | Agent 自报、独立双读取、恢复时按当前 Catalog 同名推断 |
| `workspaceId` | Workspace Scope Context | 模型生成内容 |
| `rootBindingId` | Workspace Trust Authority 对冻结 canonical root 生成的 opaque digest binding | 词法路径、模型参数、裸 workspaceId |
| `sessionId` | Session Scope Context | 自由文本 |
| `runtimeAgentId` | Agent Scope Context | Agent 自报身份 |

相同 `MemorySubject` 的多个运行时 Agent 会读写同一份长期记忆；`runtimeAgentId` 只用于来源追踪和故障定位。`sessionId`、`runtimeAgentId` 和 `turnId` 对 operator/worker 调用可省略，但 runtime Capture 的 Evidence provenance Schema 必须要求 session 与 runtime Agent。MVP 仅允许本地安装主体下来源为 builtin 的 `coder`，只读写当前 Workspace 分区。

`profileSourceId` 必须随 Profile binding 持久化并参与恢复；bind 只调用一次 `catalog.inspect(name)`，同时使用其中的 winner Profile 与 `sourceId`，不得以 `get()` + `inspect()` 双读取制造 TOCTOU。Catalog reload 不得改变已绑定 Agent 的主体。

Workspace Trust 的可序列化字段只有 opaque `rootBindingId`，不暴露 canonical path。唯一 mutation authority 是 App-scope `IWorkspaceTrustAuthority`；它先 `realpath(root)`，再按 `canonicalRoot = workspaceRootKey(realRoot)` 共享 snapshot、mutex 和事件，并由同一 SHA-256 digest 生成安全定长 record key与 `rootBindingId`。原路径、dot segments、symlink 和现有 Windows alias 解析到同一 canonicalRoot 时进入同一个临界区；hardlink/bind mount/inode 等价不在首版保证内。每个 handle 保存 `boundRoot + canonicalRoot + rootBindingId`，所有安全 API 在旧 record lock前重做 realpath；retarget/悬空立即 fail closed，绝不把 A 信任授予 B。Workspace-scope `IWorkspaceTrust` 只是当前 handler 的 facade。Workspace coordinator 先验证长期持有的 home writer lease，再通过 Authority 的 record lock 重读最新记录后签发内部 opaque permit，不能根据 shared/cached snapshot 单独签发；permit 带 `workspaceId + rootBindingId + epoch`、取消信号、异步 `assertCurrent()`，并把 `commit(effect)` 经 facade 委托给 Authority。App 后台经 `IWorkspaceLifecycleService.handlerFor()` 取得 coordinator。每个 read 在返回前异步锁内复验；每个 durable append、projection commit 和 queue ack 都必须在临界区内校验 live binding+epoch并持锁至耐久 effect 完成，不能缓存一次性的 `trusted: true`。

Authority 在现有外部可信地址保存一份 canonical v2 记录。每个 mutation/validation/commit 进入 keyed 进程内 mutex 后，通过 persistence `IExclusiveKeyLockStore` 取得 canonical record key 的跨进程锁并重读最新耐久记录；`untrust()` 写 `trusted=false, epoch=epoch+1`，`trust()` 写 true 但保留 epoch。每次 replacement 都必须完成临时文件 file fsync、原子 rename和 parent-directory fsync，返回成功后才能更新 shared snapshot并广播事件。Authority 从 attach 到最后一个 handle dispose 强制 watch canonical record，并维护 `starting/healthy/degraded/disposed` 与订阅 generation；change/error/close 只加速，即使 healthy 也按可注入时钟在不超过 2 秒的固定上界内锁内重读，watch error/close、周期超时或读取失败原子置 degraded并按 untrusted 撤销，新订阅首次锁内 reconcile 完成前仍不健康。`WorkspaceMcpConfigService` 初始化和每次 reload 只使用 package-private guarded project access：record trusted、watch healthy且当前订阅已 reconcile 才可取得冻结 canonical root；loader、file watch与 project-origin stdio cwd 全链使用该 root并在读取后调用 `validateAfterRead()`。Trust撤销使用独立于普通 initialize/connect/apply tail 的高优先级可取消 lane：立即 deny new use、abort/隔离 pending project connect并卸载；不可取消连接先从 registry 原子撤下再后台清理。跨进程 untrust 后即使 watcher静默漏事件、`connectAll()`或普通 mutation tail卡住，也必须从有界 reconcile 到 deny/unload在冻结上界内完成。Profile Memory 另用首次 enabled 操作时懒获取、持有到 App shutdown drain 的 home 级 writer lease；第二个进程 lease 失败时 Profile Memory mutation/permit fail closed，但基础 Workspace Trust mutation仍可通过短持有 record lock 串行完成。全局锁序是 writer lease validation → keyed in-process mutex → record lock → domain/partition lock，effect 开始前再次验证 lease；禁止持领域锁调用 Trust，record-lock effect 不递归 Trust API，也不持第二个 record lock。普通 queue mutation 要 permit；当 job 已 untrusted/root drift/fence stale 而无法取得 permit时，Authority/coordinator 只返回精确绑定 `jobId + workspaceId + rootBindingId + workspaceTrustEpoch` 的 package-private branded `WorkspaceRevocationProof`。Queue 的 `fenceRevoked(jobId, expectedState, proof)` 必须在 partition lock 内重读 job，确认 job ID、该三元组和 active lease/fencing state 完全匹配后才单调执行 `pending|leased -> fenced`；proof 跨目标重放或任一错配都拒绝。Projection commit与 success ack签名不接受该 proof，也不存在任意 callback effect。handler missing且无法证明时持久退避，不热循环。由于同步 Scope dispose 不等待 Ledger Promise，KAP、ACP、SDK、CLI、harness等 composition root 必须先 await Memory drain（停止新操作、等待 in-flight、release lease），再 dispose。已在 untrust 线性化点前进入同一 record lock 的 effect 可完成，尚未进入的旧 permit全部拒绝；普通 read 在返回前 `await permit.assertCurrent()`，该锁内复验是 read 线性化点，abort 只负责加速。`{rootBindingId, epoch}` 跨 handler/process alias、重启和重新 trust 保留，避免 ABA 与根混淆。

## Agent 工具协议

### MemoryRecall

按当前任务主动查询记忆。工具参数不包含任何身份字段。

```ts
export interface MemoryRecallRequest {
  readonly schemaVersion: 1;
  readonly query: string;
  readonly scope?: 'workspace';
  readonly types?: readonly MemoryAtomType[];
  readonly depth?: 'summary' | 'atoms' | 'with-evidence-refs';
  readonly limit?: number;
  readonly tokenBudget?: number;
  readonly minConfidence?: number;
  readonly includeConflicts?: boolean;
  readonly snapshotToken?: string;
}

export interface MemoryRecallResponse {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly snapshotToken: string;
  readonly status: 'ok' | 'empty' | 'degraded';
  readonly selfModel?: ProfileSelfModelView;
  readonly scenarios: readonly MemoryScenarioView[];
  readonly memories: readonly MemoryAtomView[];
  readonly conflicts: readonly MemoryConflictView[];
  readonly truncated: boolean;
  readonly degradedFrom?: 'hybrid' | 'vector' | 'projection';
  readonly timingMs: {
    readonly total: number;
    readonly lexical?: number;
    readonly vector?: number;
    readonly rerank?: number;
  };
}
```

默认行为：

- `scope = workspace`，防止无意召回其他项目经验。
- `depth = atoms`，只返回 L1 摘要和 `evidenceRefs`。
- 只返回 `validated`；`includeConflicts = true` 时额外返回冲突说明。
- `snapshotToken` 是不透明、有主体绑定和过期时间的 token，用于在同一 Turn 内复用已经钉住的结果；MVP 不承诺任意历史版本查询。

### MemoryReadEvidence

按 Recall 返回的引用读取有限证据。禁止任意全文搜索 L0。

```ts
export interface MemoryReadEvidenceRequest {
  readonly schemaVersion: 1;
  readonly snapshotToken: string;
  readonly evidenceGrantToken?: string;
  readonly evidenceRefs: readonly string[];
  readonly maxItems?: number;
  readonly maxBytes?: number;
}

export interface MemoryReadEvidenceResponse {
  readonly schemaVersion: 1;
  readonly snapshotToken: string;
  readonly evidence: readonly MemoryEvidenceView[];
  readonly unavailableRefs: readonly string[];
  readonly truncated: boolean;
}
```

Repository 必须再次执行 principal、owner epoch、workspace、保留期和敏感级别检查，不能因为引用 ID 难猜就跳过鉴权。`unavailableRefs` 故意不区分“记录不存在”和“调用者无权访问”，避免 Evidence ID 枚举；Evidence Grant 必须短期有效并绑定同一 Snapshot 和主体。

### MemoryPropose

让 Agent 提交“值得记住的候选经验”。它总是先形成 L0 `memory.proposal`，由异步提取器决定是否生成或合并 Atom。

```ts
export interface MemoryProposeRequest {
  readonly schemaVersion: 1;
  readonly idempotencyKey: string;
  readonly type: MemoryAtomType;
  readonly summary: string;
  readonly applicability: {
    readonly scope: 'workspace';
    readonly taskKinds?: readonly string[];
  };
  readonly evidenceRefs: readonly string[];
  readonly confidence: number;
}

export interface MemoryProposalReceipt {
  readonly schemaVersion: 1;
  readonly proposalId: string;
  readonly evidenceEventId: string;
  readonly status: 'queued' | 'duplicate' | 'rejected';
  readonly reason?: string;
}
```

MVP 只接受 `workspace` Proposal。未来若开放 `global-candidate`，它也只能是申请扩大适用范围，必须有独立审批/证据流程；缺少证据、只引用模型自己的陈述、或包含永久人格修改指令的 Proposal 必须拒绝或保持 Candidate。

### MemoryFeedback

```ts
export interface MemoryFeedbackRequest {
  readonly schemaVersion: 1;
  readonly idempotencyKey: string;
  readonly memoryId: string;
  readonly outcome:
    | 'helpful'
    | 'irrelevant'
    | 'incorrect'
    | 'outdated'
    | 'caused_failure';
  readonly taskId?: string;
  readonly evidenceRefs?: readonly string[];
  readonly note?: string;
}

export interface MemoryFeedbackReceipt {
  readonly schemaVersion: 1;
  readonly feedbackId: string;
  readonly status: 'recorded' | 'duplicate' | 'rejected';
}
```

Feedback 不直接调高或调低权重；它作为 L0 证据进入 Evaluator。

### MemoryInspect（MVP Operator Only）

只提供当前 Profile 的健康摘要：Snapshot、队列积压、最近一次成功投影时间、降级状态和可用工具。MVP 只作为本地 operator/debug capability，不注册为模型工具；它不暴露其他 Profile，也不返回后端凭据或正文。

## 工具调用建议

自动召回已覆盖明显相关内容时，Agent 不必重复调用工具。需要追溯证据、发现当前信息冲突或任务跨越多个场景时再主动调用。单轮默认最多：

- `MemoryRecall`：3 次。
- `MemoryReadEvidence`：2 次。
- `MemoryPropose`：1 次。
- `MemoryFeedback`：与实际使用的记忆数量一致，但应批量提交。

这些是预算约束，不是安全边界；服务端仍执行硬限制。

## 内部 Capture 协议

```ts
export interface AppendEvidenceRequest {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly expectedOwnerEpoch: number;
  readonly expectedRootBindingId: string;
  readonly expectedWorkspaceTrustEpoch: number;
  readonly events: readonly NewMemoryEvidenceEvent[];
}

export interface AppendEvidenceResult {
  readonly schemaVersion: 1;
  readonly outcomes: readonly {
    readonly clientEventId: string;
    readonly status: 'accepted' | 'duplicate' | 'rejected';
    readonly eventId?: string;
    readonly position?: string;
    readonly retryable?: boolean;
    readonly reasonCode?: string;
  }[];
  readonly durableThroughPosition: string;
  readonly flushed: true;
}
```

每个 `NewMemoryEvidenceEvent` 自带唯一 `clientEventId` 和 `idempotencyKey`。`durableThroughPosition` 只表示 L0 日志的耐久水位，不是 Context/Wire 来源 cursor。返回 `flushed: true` 表示领域 Store 已满足其耐久合同，不等同于只调用了一次 `IAppendLogStore.append()`。

Capture Service 另行持久化来源进度：

```ts
export interface CaptureCheckpoint {
  readonly sourceStreamId: string;
  readonly sourceEpoch: string;
  readonly sourceCursor: string;
  readonly lastClientEventId?: string;
  readonly durableThroughPosition: string;
}
```

只有 source cursor 连续前缀对应的事件全部 accepted/duplicate，才推进 `sourceCursor`；rejected retryable 洞不能跨越。永久过滤必须在 append 前确定性完成，或形成可审计的终态 outcome。崩溃发生在 append 后、checkpoint 前时按来源 cursor 重扫，靠 idempotency key 收敛。

## Worker 投影协议

Worker 消费 L0 position 区间，并提交有条件更新：

```ts
export interface MemoryProjectionCommand {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly partitionKey: string;
  readonly ownerEpoch: number;
  readonly rootBindingId: string;
  readonly workspaceTrustEpoch: number;
  readonly leaseId: string;
  readonly fencingToken: string;
  readonly expectedVersion: number;
  readonly source: {
    readonly fromPositionExclusive: string;
    readonly toPositionInclusive: string;
  };
  readonly inputDigest: string;
  readonly promptVersion: string;
  readonly modelVersion: string;
  readonly changes: readonly MemoryProjectionChange[];
}
```

Repository 依次校验：分区归属、owner epoch、root binding ID、持久 workspace trust epoch、当前 active lease、每分区单调 fencing token、source interval、输入 digest、证据引用、Schema/Prompt/Model 版本、状态机和 `expectedVersion`。版本冲突返回可重试错误，由 Worker 基于新 Snapshot 重新计算。耐久 Queue 保存 command、partition head、attempt、claim/lease/token、ack/nack/fence 和 DLQ；每次重新 claim 都递增 token，旧 Worker 的 commit/ack 永久失效。领域事件只负责唤醒，不能充当任务权威。

## 领域事件

| 事件 | 关键字段 | 用途 |
| --- | --- | --- |
| `memory.evidence.appended` | owner ID/epoch、workspace、position、kind | 唤醒 L1 Worker、审计 |
| `memory.atom.created` | atomId、type、status、evidenceRefs | 更新索引 |
| `memory.atom.validated` | atomId、version、reason | 质量指标、UI |
| `memory.atom.challenged` | atomId、conflictId | 防止静默覆盖 |
| `memory.atom.deprecated` | atomId、replacementId | 召回过滤 |
| `memory.scenario.updated` | scenarioId、version | 刷新缓存 |
| `memory.self_model.updated` | owner、version | 刷新 L3 Snapshot |
| `memory.projection.failed` | partition、position、errorCode | 重试和告警 |
| `memory.backend.degraded` | backend、fallback | 运维观测 |

Agent 执行事实通过每个 Agent 的 `IEventBus` 捕获；记忆系统自己的跨实例状态通过 App Scope `IEventService` 发布。后者的事件形态是 `{ type, payload }`，payload 只包含 ID、版本、状态、水位、错误码和 digest，不包含原始 Evidence、Atom 正文或 Secret。事件消费者不得反向成为 Domain 的同步依赖，恢复也不得依赖事件仍在内存中。

## 边缘协议状态

核心 MVP 不开放公开 REST、WebSocket 或 Klient API。必须区分三个不同的面：

1. `agent-core-v2` 的引擎领域契约。
2. `klient` 的 tuple Zod contract 与 IPC/memory transport facade；当前只有 global/session/agent，没有 Workspace facade。
3. `kap-server` 的 HTTP operator surface；当前 `/api/v2` 只有 domain-grouped sessions 查询，没有通用 action map 或 v2 WebSocket。

引擎稳定后先写 edge ADR，再决定资源与 action 形态。下面只记录候选能力，不是当前实现承诺，也不允许在核心工作包中顺手添加：

| Scope | 候选能力 | 语义 | 作用 |
| --- | --- | --- | --- |
| Workspace | `memory recall` | 读 | 运维工具或可信客户端发起召回 |
| Workspace | `scenario/atom query` | 读 | 带授权过滤和 opaque pagination 的查询 |
| Agent | `memory propose/feedback/read-evidence` | 写/读 | 以运行时绑定的可信 Agent 主体调用 |
| Operator | `inspect/rebuild/delete` | 管理 | 不向模型开放的治理操作 |

未来 Memory operator route 可以复用 KAP Envelope 的 `code/msg/data/request_id` 核心形状，但不能把下列脱敏子集描述成当前全局 Envelope。当前 KAP 错误 Envelope 允许 `stack?: string`，因此 WP10B 必须为 Memory route 使用专用 redacted mapper，确保响应中实际省略 stack 和后端正文：

```ts
export interface MemoryKapResponse<T> {
  readonly code: number;
  readonly msg: string;
  readonly data: T | null;
  readonly request_id: string;
  readonly details?: unknown;
}
```

Memory 专用错误映射只返回集中注册的数值码、脱敏消息、`retryable` 和有界的 `retryAfterMs/details`；即使底层通用 Envelope 支持，也禁止传 stack、原始后端响应和记忆正文。若要修改全局 KAP Envelope，必须另开服务器安全工作包和兼容性评审。未来若增加 WebSocket，必须独立设计鉴权、授权、序号、断线重放和缺口 Snapshot；本文不宣称已有 v2 WS。

## 错误语义

领域层使用稳定的符号错误码，KAP Server 再映射为集中注册的数值码：

| 领域码 | 是否重试 | 行为 |
| --- | --- | --- |
| `memory.disabled` | 否 | 返回功能关闭，不影响 Agent 主任务 |
| `memory.workspace_untrusted` | 否 | 全部自动/手动记忆行为 fail closed，撤销缓存和注入 |
| `memory.owner_unavailable` | 否 | 禁止回退到 runtime Agent ID |
| `memory.access_denied` | 否 | Fail closed，并记录安全审计 |
| `memory.not_found` | 否 | 引用不存在或不可见 |
| `memory.snapshot_conflict` | 是 | 重新读取后重算，禁止覆盖 |
| `memory.invalid_evidence_ref` | 否 | Proposal 或投影拒绝 |
| `memory.backend_unavailable` | 是 | 读可降级，写不得假成功 |
| `memory.timeout` | 视调用而定 | 自动 Recall 跳过；显式调用返回错误 |
| `memory.budget_exceeded` | 否 | 截断并返回 `truncated` |
| `memory.queue_full` | 是 | Capture 告警，实施背压 |
| `memory.projection_corrupted` | 否 | 切换最后良好 Snapshot 并触发重建 |

## TencentDB 适配协议（后续 v3 镜像）

适配器负责把可信上下文映射为 TencentDB Agent Memory 的隔离字段：

```text
principalId + memoryOwnerId + ownerEpoch -> 本地映射表 -> agent_id / user_id
workspaceId                            -> 本地映射表 -> team_id
sessionId     -> session_id
taskId        -> task_id
```

本地 Repository 仍是权威，适配器通过 Outbox 把有限 L0/L1 镜像到具备 team/agent/user/session 隔离的 v3 API。适配器负责 provision/mapping、确定性分块、幂等、重试、对账和删除回执，不降级到 `/v2` 或默认桶。外部结果先做本地主体过滤和逐条再授权，再进入预算裁剪、冲突标记和安全 Formatter；外部正文绝不直接注入 Prompt。

## 协议版本兼容

- 顶层请求和事件必须实际带 `schemaVersion`，首版为字面量 `1`；仅在文档中声称存在不算完成。
- 新增可选字段属于向后兼容；重命名、删除、改变默认隔离范围属于 Breaking Change。
- 存储 Schema、Prompt 版本和 API Schema 分开管理，禁止用一个版本号同时表达三类变化。
- Recall Response 必须保留未知字段容忍；Projection Command 必须严格拒绝未知变更类型。
