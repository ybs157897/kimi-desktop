# agent-core-v2 实现设计

本页把总体方案落到 `packages/agent-core-v2` 的 DI × Scope 架构中，给出建议目录、Service 契约、持久化方式、配置和集成点。实现时应以源码和最近的 `AGENTS.md` 为准；这里给出的文件名是目标设计，不代表当前已存在。

> **实施门禁：** 本页包含目标接口草图，不是已经闭合的编码契约。开始业务实现前，必须先完成 [WP0 契约冻结和 WP1 Feature 骨架](./08-implementation-readiness-review.md#工作包与依赖)，并以其中的身份、耐久性、队列和 MVP 决策为准。

## Domain 边界

新增独立的 `profileMemory` Domain。它拥有 Profile 长期记忆的业务模型、状态机和写入不变量，不属于现有 `contextMemory` Domain。

两者区别如下：

| Domain | 身份 | 生命周期 | 权威数据 |
| --- | --- | --- | --- |
| `contextMemory` | 单个 `agentId` | Agent / Session 内对话 | 当前 Agent 的 Wire 记录 |
| `profileMemory` | 可信 `MemorySubject` | 跨 Agent、跨 Session | Profile L0 Evidence Log |

`contextMemory` 仍负责当前实例的 LLM 上下文和回放；`profileMemory` 只通过召回注入向 `contextMemory` 提供历史数据，不接管对话折叠和 Undo。

## Feature 落位

Profile Memory 是一项可整体关闭行为的内建能力，应使用 v2 的 Feature seam，而不是把一个 Domain 分散注册到四个顶层目录。`ProfileMemoryFeature` 始终由现有 Feature Assembly 组装；当前 Flag 系统不会自动 `unprovide` Feature。只有 Profile Memory 业务侧的 coordinator、writer lease/repository、Agent Service、工具、Capture/Worker和上下文注入由该 Feature 贡献，Flag/config 在这些入口 fail closed。基础 `IWorkspaceTrustAuthority`、Workspace `IWorkspaceTrust` facade、cross-process watch/reconcile 和 MCP guarded path 属于既有 Workspace Trust 安全域，必须通过静态 scoped registration 始终存在，绝不能放入可 retract 的 `ProfileMemoryFeature` book；Feature disabled/retract 时不得 dispose Trust Authority、watch 或 MCP 门禁。配置、Profile binding 以及持久化 Wire vocabulary 继续使用静态 `import = register` 通道，保证 manifest 和历史回放不依赖开关状态。

## 建议目录

```text
packages/agent-core-v2/src/
└─ features/profileMemory/
   ├─ profileMemoryFeature.ts
   ├─ configSection.ts                 # 静态注册
   ├─ profileMemory.ts                 # 公共 Service 契约
   ├─ profileMemoryService.ts          # Agent 门面
   ├─ types.ts
   ├─ schemas.ts
   ├─ errors.ts
   ├─ identity/
   │  ├─ contract/
   │  ├─ resolver/
   │  └─ installationPrincipalStore/ # WP2 独占真实 backend
   ├─ evidence/
   │  ├─ evidenceStore.ts              # 领域专用耐久契约
   │  ├─ localEvidenceStore.ts
   │  ├─ evidenceKeyCodec.ts
   │  └─ captureService.ts
   ├─ projection/
   │  ├─ projectionQueue.ts
   │  ├─ projectionWorker.ts
   │  ├─ workerLlm.ts
   │  └─ atomStateMachine.ts
   ├─ recall/
   │  ├─ searchStore.ts
   │  ├─ recallService.ts
   │  ├─ recallRanking.ts
   │  └─ recallInjection.ts
   └─ tools/
      ├─ recall/
      ├─ propose/
      ├─ read-evidence/
      └─ feedback/
```

可以根据实现演进合并纯函数文件，但每个 DI Service 仍保持一个接口文件和一个实现文件。

## Service 落位树

```text
static base domain: workspaceTrust (not owned/retracted by ProfileMemoryFeature)
├─ App resource: IWorkspaceTrustAuthority
│    consumers: WorkspaceTrust facade; owns keyed state/event/cross-process lock/watch orchestration
├─ Workspace resource: IWorkspaceTrust
│    owns: current handler facade and guarded MCP path; delegates to App keyed authority
└─ persistence watch/durable-replace/lock access patterns

feature domain: profileMemory
├─ App resources
│  ├─ IProfileMemoryWriterLease
│  │    consumers: Workspace coordinator / Profile Memory stores; lazy home-level single writer
│  ├─ IProfileMemoryRepository
│  │    consumers: Agent facade / Capture / Projection / Recall
│  ├─ IProfileMemoryEvidenceStore
│  │    consumer: Repository
│  ├─ IProfileMemoryProjectionQueue
│  │    consumers: Capture wake-up / Projection worker
│  ├─ IProfileMemorySearchStore
│  │    consumers: Projection indexer / Recall
│  └─ IProfileMemoryWorkerLLM
│       consumer: Projection worker; wraps IModelCatalog
├─ Agent resources
│  ├─ IAgentProfileMemoryService
│  └─ IAgentProfileMemoryCaptureService
├─ Workspace resource
│  └─ IWorkspaceProfileMemoryCoordinator
│       owns: permits / cancellation / memory caches; delegates fencing to Trust
└─ trusted dependencies
   ├─ persisted Profile binding source + workspace/session contexts
   ├─ IWorkspaceLifecycleService @App — background resolves handler by workspaceId
   ├─ persistence primitives  @App direct — wrapped by domain stores
   ├─ IEventBus               @Agent event  — capture current Agent facts
   ├─ IEventService           @App event  — publish body-free status facts
   └─ IModelCatalog           @App direct — wrapped by restricted WorkerLLM
```

MVP 不为了 Scope 对称性预建通用 `IWorkspaceProfileMemoryService` 或 `ISessionProfileMemoryService`，但必须有一个窄的 `IWorkspaceProfileMemoryCoordinator`，因为 permit、取消句柄和 recall cache 确实由 Workspace 生命周期拥有。持久 trust epoch、canonical-key snapshot/event 与 trust-record lock/watch orchestration 属于静态注册的 App-scope `IWorkspaceTrustAuthority`；现有 Workspace-scope `WorkspaceTrustService` 只保留静态注册的公共 facade。两者是基础 Trust 生命周期，不属于 `ProfileMemoryFeature` 的可 retract book。Profile Memory 的 home 级 single-writer lease 是独立的 Feature App resource，首次 enabled 操作时懒获取，coordinator 不能再造第二份权威或锁。Session ID 是可信调用上下文和持久 Capture source checkpoint 的业务键，仍不需要 Session facade。

`IEventBus` 是每个 Agent 一份的事实总线，不存在 App 级 `IEventBus`。进程级通知使用 `IEventService`，其 payload 只能包含 ID、状态、水位和哈希，不包含原始记忆正文。耐久日志和队列才是恢复权威，事件只用于唤醒和观测。

## 核心 Service 契约

### App Repository

```ts
export interface IProfileMemoryRepository {
  readonly _serviceBrand: undefined;

  appendEvidence(
    permit: WorkspaceMemoryPermit,
    context: MemoryInvocationContext,
    events: readonly NewMemoryEvidenceEvent[],
  ): Promise<AppendEvidenceResult>;

  recall(
    permit: WorkspaceMemoryPermit,
    context: MemoryInvocationContext,
    request: MemoryRecallRequest,
  ): Promise<MemoryRecallResponse>;

  readEvidence(
    permit: WorkspaceMemoryPermit,
    context: MemoryInvocationContext,
    request: MemoryReadEvidenceRequest,
  ): Promise<MemoryReadEvidenceResponse>;

  propose(
    permit: WorkspaceMemoryPermit,
    context: MemoryInvocationContext,
    request: MemoryProposeRequest,
  ): Promise<MemoryProposalReceipt>;

  feedback(
    permit: WorkspaceMemoryPermit,
    context: MemoryInvocationContext,
    request: MemoryFeedbackRequest,
  ): Promise<MemoryFeedbackReceipt>;

  applyProjectionChange(
    permit: WorkspaceMemoryPermit,
    command: MemoryProjectionCommand,
  ): Promise<MemoryProjectionResult>;
}
```

所有 Workspace 数据方法都要求内部 branded `WorkspaceMemoryPermit`；它不属于任何外部/模型 Schema。Repository 不把“收到 permit”当作最终授权：读路径在返回前复验，耐久写路径必须调用 permit 的 `commit()`。`applyProjectionChange` 只供内部 Worker 使用，还必须校验 Worker 身份、Prompt 版本、来源引用和 `expectedVersion`。它不能注册为普通 Agent 工具。

### Workspace Trust keyed 权威、facade 与记忆协调器

WP1 必须先把现有布尔 Trust 契约升级为版本化权威；不是在 Profile Memory 目录旁挂一个事后监听器：

```ts
export interface WorkspaceTrustFence {
  readonly rootBindingId: string;
  readonly epoch: number;
}

export interface WorkspaceTrustSnapshot extends WorkspaceTrustFence {
  readonly trusted: boolean;
}

export interface WorkspaceRevocationTarget {
  readonly jobId: string;
  readonly workspaceId: string;
  readonly rootBindingId: string;
  readonly workspaceTrustEpoch: number;
}

export interface IWorkspaceTrust {
  // 保留现有 ready/get/isTrusted/trust/untrust/onDidChange
  getSnapshot(): Promise<WorkspaceTrustSnapshot>;
  getGuardedProjectAccess(): Promise<WorkspaceGuardedProjectAccess>;
  validateCurrent(expected: WorkspaceTrustFence): Promise<void>;
  commitIfCurrent<T>(
    expected: WorkspaceTrustFence,
    effect: () => Promise<T>,
  ): Promise<T>;
  proveRevoked(target: WorkspaceRevocationTarget): Promise<WorkspaceRevocationProof>;
}
```

现有 `WorkspaceTrustService` 不能独自成为权威。`IWorkspaceLifecycleService` 的 live/materializing map 以传入 `workspaceId` 为键；legacy/alias ID 可能为同一 `workspaceRootKey()` 等价类形成多个 Workspace Scope。如果每个 facade 各有 mutex/snapshot，它们会竞争同一记录并造成 epoch 丢失或 stale commit。因此必须增加 App-scope `IWorkspaceTrustAuthority`：

```ts
export interface IWorkspaceTrustAuthority {
  attach(input: {
    readonly workspaceId: string;
    readonly root: string;
  }): Promise<WorkspaceTrustAuthorityHandle>;
}

export interface WorkspaceTrustAuthorityHandle {
  getSnapshot(): Promise<WorkspaceTrustSnapshot>;
  getGuardedProjectAccess(): Promise<WorkspaceGuardedProjectAccess>;
  validateCurrent(expected: WorkspaceTrustFence): Promise<void>;
  trust(): Promise<void>;
  untrust(): Promise<void>;
  commitIfCurrent<T>(expected: WorkspaceTrustFence, effect: () => Promise<T>): Promise<T>;
  proveRevoked(target: WorkspaceRevocationTarget): Promise<WorkspaceRevocationProof>;
  readonly onDidChange: Event<WorkspaceTrustChange>;
  dispose(): void;
}

// package-private；canonicalRoot 不进入 Wire/工具/持久业务记录
export interface WorkspaceGuardedProjectAccess {
  readonly snapshot: WorkspaceTrustSnapshot;
  readonly canonicalRoot: string;
  validateAfterRead(): Promise<void>;
}

declare const workspaceRevocationProofBrand: unique symbol;

// package-private；只能交给 Queue.fenceRevoked，不能传给 projection/success ack
export interface WorkspaceRevocationProof {
  readonly target: WorkspaceRevocationTarget;
  readonly reason: 'untrusted' | 'stale-epoch' | 'root-drift';
  readonly [workspaceRevocationProofBrand]: true;
}
```

`attach()` 必须通过 App-scope `IHostFileSystem.realpath(root)` 解析 symlink 与 dot segments，随后以 `workspaceRootKey(realRoot)` 得到 `canonicalRoot`；realpath/归一化失败就 fail closed，不回退到调用方拼写。唯一 codec 同时生成 `digest = sha256(utf8(canonicalRoot))`、`trustRecordKey = "v2-" + digest + ".json"` 和 opaque `rootBindingId = "rb-v1-" + digest`；不能把原始路径、`canonicalRoot`、调用方 legacy `workspaceId` 或 `encodeWorkDirKey(root)` 直接当文件 key。Trust key codec 属于 WP1，不与 WP2 的 Profile Memory 数据 key codec 混用。Authority 以 `canonicalRoot` 为本进程 Map key，为每个物理路径等价类只保留一个 ref-counted entry，包含 ready、shared snapshot、watchHealth、进程内 promise-chain mutex 和 change broadcaster；原路径、dot-segment、symlink 和现有 Windows alias 解析到同一 canonicalRoot 时共享它。handle 另保留 `boundRoot + canonicalRoot + rootBindingId`，每个安全 API 都在进入旧 record lock前重新 realpath boundRoot 并比较；漂移/解析失败立刻 fail closed、abort并广播，绝不能自动 attach 新 target。这里不承诺跨 hardlink、bind mount、网络文件系统 inode 或 macOS Unicode/case folding 的设备级等价；未来若扩展身份规则，必须版本化 key并显式迁移。每个 mutation/validation/commit 还必须在该 mutex 内通过 `IExclusiveKeyLockStore` 取得 `trustRecordKey` 的跨进程锁并重读耐久记录。Workspace `WorkspaceTrustService` 只持有 handle 并转发旧 API 与新增 snapshot/commit API，`isTrusted()` 也实时读取 shared snapshot，不再把 trusted/epoch 注册为各 handler 独立权威。若为 Inspector 保留 Workspace State，它只能是 Authority event 的只读 projection。

Authority 把旧“文档存在即 trusted”迁移为单份版本化记录。新记录的物理 key 是 canonical trust-record key，旧 `workspace-trust/<encodeWorkDirKey(root)>` 只作为迁移输入；迁移必须在同一 canonical record lock 与 keyed mutex 中完成，且不会为同一 canonicalRoot 生成两份 v2 权威：

```ts
interface WorkspaceTrustRecordV2 {
  readonly schemaVersion: 2;
  readonly canonicalRoot: string;
  readonly rootBindingId: string;
  readonly trusted: boolean;
  readonly epoch: number;
  readonly changedAt: number;
  readonly trustedAt?: number;
}
```

兼容读取规则固定为：canonical v2 一旦存在且 `record.canonicalRoot === canonicalRoot` 就独占权威并忽略旧 marker；key/内容不一致视为损坏并 fail closed。没有 v2 时，在同一 record lock 内 `list('workspace-trust')`，跳过 `v2-*.json`，逐个解码旧 marker，并只保留满足 strict `{ root: string, trustedAt: finite number }`、`await realpath(old.root)` 成功且 `workspaceRootKey(realOldRoot) === canonicalRoot` 的记录；不能只检查当前拼写的 `encodeWorkDirKey(root)`，否则会漏掉 alias。任一合法旧 marker 只表达 `{ trusted: true, epoch: 0 }`，多个合法 alias marker 合并后仍是同一个 `true/0`，完全无合法记录读为 `{ trusted: false, epoch: 0 }`；损坏、目标不存在或 canonicalRoot 不匹配的 marker 忽略并记录有界诊断，不得把它解释成旧版 `untrusted` 或虚构更高 epoch。第一次 mutation 才写 canonical v2，绝不能用任意目录枚举顺序决定结果。旧 marker 在 MVP 不删除；v2 出现后永远忽略它们，避免掉电迁移窗口。新版 `untrust()` 不再删除权威记录，而是在 canonical-key mutex 中先重新读取最新耐久记录，再全耐久写入 `{ trusted: false, epoch: old + 1 }`，成功后才更新 shared snapshot 并广播 `onDidChange({ trusted: false, epoch })`。`trust()` 同锁重读后写 `trusted: true` 但保留当前 epoch；重复同状态调用幂等。写入失败时 snapshot、epoch 和事件都不改变，调用方收到失败。并发 `trust/untrust/retrust` 按同一 keyed mutex 的顺序线性化。

`getSnapshot()` 和 `validateCurrent()` 不是缓存读取：它们先复验 bound root，再取得 canonical-key 进程内 mutex与跨进程 record lock、重读最新记录，随后刷新 shared snapshot；`validateCurrent()` 在 `!trusted` 或 `{rootBindingId, epoch}` 不匹配时抛出稳定领域错误。同步 `isTrusted()` 仅为旧调用方保留 cached facade 语义，不能用于 Profile Memory 或 project MCP reload 的安全判定。`commitIfCurrent()` 使用相同锁序并在锁内复验 `trusted && rootBindingId === expected.rootBindingId && epoch === expected.epoch`，然后持有 record lock 到 `effect` 达到领域耐久点。Profile Memory permit 在进入 Authority 前和 effect 开始前另行验证 home writer lease，Authority 本身不依赖 Memory Feature。`onDidChange` 是同 key 的进程内共享广播；各 alias coordinator 用它轮换自己的 `AbortController` 和清理 cache，但安全判断不能依赖 listener 被 await。

Authority entry 必须从 attach 到最后一个 handle dispose 期间强制订阅 canonical v2 record 的跨进程观察，并做启动/重订阅后的 reconciliation。当前 `IAtomicDocumentStore.watch()` 只暴露 `Event<void>`，底层 watcher error 被送到 `onUnexpectedError`，无法满足可观测 error/close 合同；WP1 因此同时扩展 persistence watch handle（或新增专用 access-pattern SPI）为 `{ onDidChange, onDidError, onDidClose, dispose }`，更新 node-fs/in-memory backend 与现有调用兼容接线，不能在 Authority 中假装能收到当前 API 不提供的错误。entry 显式维护 `watchHealth: 'starting' | 'healthy' | 'degraded' | 'disposed'` 和 subscription generation。change 事件只负责加速唤醒；即使订阅表面 healthy，也必须以可注入时钟在不超过 2 秒的固定上界内周期执行一次 keyed-mutex + record-lock authoritative reconcile，不能把“没有事件”当作记录未变。watch error/意外 close、周期 reconcile 超时或读取失败都原子置 degraded、把 cached facade 投影为 untrusted、广播撤销并有界重订阅；新订阅建立后仍为 starting，只有当前 generation 的首次锁内 reconcile 成功才置 healthy并广播。主动 dispose 置 disposed且不产生伪错误。普通 Memory 正确性仍由 permit/read/commit 的锁内重读保证，但 project MCP 必须依赖这个有界健康撤销通道。

`WorkspaceMcpConfigService.initialize()` 和每次 file/trust reload 都必须先 `await trust.getGuardedProjectAccess()`，只有其 snapshot 满足“耐久 record trusted + watch healthy + 当前订阅已完成 reconcile”时才读取 project MCP；不得再用 `isTrusted()` 或普通 `getSnapshot()`。该 package-private capability 同时返回冻结 `canonicalRoot` 与 `validateAfterRead()`，loader、file watch 和 project-origin stdio default/relative cwd 全链都只消费此 root，读取完成后再调用校验；canonicalRoot 不进入 Wire/工具/业务持久记录。这样 symlink retarget不会把 B 的配置或 cwd 授权给 A 的 permit。Authority broadcast或周期 reconcile 触发 reload，但撤销路径不能只排入普通 serialized apply/connect tail：Trust degraded/untrusted/root-drift 必须进入专用高优先级、幂等且可取消的 revocation lane，立即标记 project-origin MCP deny-new-use、abort/隔离尚未完成的 project connect，并使 unload/dispose 不等待 `initialize()/connectAll()` 或普通 mutation tail；底层 connector 无法取消时也必须先从可调用 registry 原子撤下并后台清理，不能让卡住的 promise扩大安全窗口。untrust 返回的安全完成条件仍是记录耐久；其他进程从下一次有界 reconcile 到 deny/unload 的端到端默认测试上界为 2 秒，而不只是“检测到变化”在 2 秒内。测试必须覆盖底层无 change/error/close 事件但耐久记录已经改变的静默漏事件，以及 project connect promise 永不 resolve、普通 apply tail堆积时周期 reconcile后仍在上界内 deny/unload；watch down、周期 reconcile 超时/失败时即使记录仍 true也持续卸载，直到健康订阅的首次 reconcile 完成且仍 trusted才允许恢复。

跨进程锁必须由通用 persistence access-pattern Service 提供，并同时闭合短临界区与长租约两种用法：

```ts
export interface IExclusiveKeyLease {
  readonly ownerToken: string;
  readonly signal: AbortSignal;
  validate(): Promise<void>;
  release(): Promise<void>;
}

export interface IExclusiveKeyLockStore {
  withLock<T>(namespace: string, key: string, effect: () => Promise<T>): Promise<T>;
  acquire(namespace: string, key: string): Promise<IExclusiveKeyLease>;
}
```

`withLock()` 必须等价于 `acquire()` + `try/finally release()`；争用、owner token 不匹配、所有权丢失分别以稳定 storage/领域错误暴露，不能静默成功。`signal` 在所有权丢失/主动释放时 abort。node-fs lease 的安全合同是：活着且仍持 owner token 的进程不会仅因墙钟超时或事件循环暂停被另一个进程接管；只允许明确 release 或经 PID/owner-token 证明的死亡 owner 回收。否则“validate 后写入”仍有双 writer 窗口。backend 可复用仓库已有、经过同进程双实例、子进程竞争、PID 存活、死亡 owner 接管和 token mismatch 测试的 lock primitive，in-memory backend 提供确定性等价实现；先核对依赖/export，不能假定某个包可直接 import。它不能复用 `IAtomicDocumentStore.acquire()`，后者当前只是 flush-on-dispose/no-op 语义。

Trust authority 用短持有的 canonical-record lock，使多个进程仍能使用现有 trust/untrust 路由；Profile Memory 另用 `IProfileMemoryWriterLease` 包装 `acquire('profile-memory-writer', canonicalHomeKey)` 的长租约，在 Flag/config 首次允许实际 Store/Worker/permit 前懒获取，并在每次签发 permit 前执行 `validate()`。长租约取得后可用 Service/Fiber `effect()` 注册兜底 disposer，但它不构成 close 已等待的证明；正常关机必须走下文显式 `IProfileMemoryShutdown.drain()`。不得用只接收同步回调的普通 `onDispose` 丢弃 Promise。若 acquisition 与 teardown/drain 竞态导致无法注册或系统已 closing，必须当场 release 后 fail closed。第二进程 lease 失败时只关闭 Profile Memory mutation/permit，不破坏基础 Workspace Trust。disabled 状态不得打开 Store或申请 lease。

```ts
export interface IProfileMemoryWriterLease {
  readonly _serviceBrand: undefined;
  ensureHeld(): Promise<void>;   // idempotent lazy acquire; disabled caller不得调用
  validateHeld(): Promise<void>; // never acquires; missing/lost/releasing => fail closed
  readonly signal: AbortSignal;  // ownership loss / shutdown drain 开始时 abort
}
```

全局锁顺序固定为：先在所有 domain/queue/repository 锁外确保并验证已长期持有的 home writer lease，再取 canonical-key 进程内 mutex，再取 canonical record lock，最后才允许取 Evidence/Projection/Queue partition 等领域锁；effect 开始前再次验证 writer lease。任何 record-lock effect 禁止递归调用 Trust API，也禁止同时持有两个 record lock；确有批量需求必须先拆成单 key 操作。反向方向严格禁止：持有 domain/partition lock 时不能 acquire permit、调用 Trust 或等待 writer lease。Worker 必须以无锁/短锁 peek 获取候选并释放，取得 permit 后再由 `permit.commit()` 进入仍获授权的领域临界区。对已经 untrusted、root drift 或 fence 失效而无法取得 permit 的 job，coordinator/Authority 只能在 Trust mutex + record lock 内返回 package-private branded `WorkspaceRevocationProof`；proof 精确绑定该 job 候选的 `jobId + workspaceId + rootBindingId + workspaceTrustEpoch`。Queue 独立暴露 `fenceRevoked(jobId, expectedState, proof)`：它必须在同一 partition lock 下重读持久 job，逐字段确认 job ID与三元组均和 `proof.target` 完全相等，并确认当前状态、active leaseId/fencingToken仍与 `expectedState` 相等，之后才允许单调 `pending|leased -> fenced`；任一错配都拒绝。Projection commit与 success ack签名不接受该 proof，也不存在任意 callback effect。proof 不能跨 job、workspace、binding 或 epoch 重放；同一撤销事实也必须为每个候选重新签发并走上述持久匹配。handler 不存在且无法证明时持久退避/隔离，不得热循环或猜测。基础 Trust mutation 从不申请 home writer lease，因此不会与 disabled/第二 writer 相互阻塞。

Epoch 更新的线性化点必须是**每次** durable replacement 完成：安全创建缺失 scope 目录并同步每个新目录在其父目录中的 entry，临时文件写完并 file fsync，原子 rename，再对记录的 parent directory fsync，之后方法才能返回并更新 snapshot。当前 `FileStorageService.write()/writeStream()` 的随机临时文件与 file fsync 可复用，但 rename 后只通过 `syncDirOnce()` 首次同步目录，不满足第二次及后续 replacement；WP1 固定修正这两个方法为每次 rename 后 `syncDir(parent)`，`syncDirOnce()` 只保留给 append 文件首次创建等明确场景，并补上新 scope 目录链的耐久创建。无需在 Trust 业务域再造专属 byte writer。in-memory backend 给出等价的原子可见性/故障合同；Trust 业务代码不得直接 import `node:fs` 或手写路径。

现有 `Scope.dispose()` / `InstantiationService.dispose()` 会 fire-and-forget Ledger teardown，不能作为长 lease 已释放的证明。WP1 不改整个 DI 公共销毁语义，而是新增 App-scope `IProfileMemoryShutdown`（或等价窄接口）：`drain(): Promise<void>` 幂等，先阻止新 permit/Store 操作、abort writer lease signal、等待进行中 Memory commits/Worker，再 await lease release；完成后第二个 App 才可接管。所有创建 v2 App 的 composition root 在调用同步 `app/core/root.dispose()` **之前**显式 await drain：至少 `packages/kap-server/src/start.ts`、`packages/acp-server/src/start.ts`、`packages/node-sdk/src/sdk-rpc-client-v2.ts`、`apps/kimi-code/src/cli/v2/run-v2-print.ts` 和 `packages/agent-core-v2/test/harness/agent.ts`；若 Feature 从未 enabled，drain 是无副作用 no-op。任何其他 bootstrap owner 在 Contract Freeze 时通过 `rg 'bootstrap\(|createAppScope\('` 列入审计清单并接线或书面豁免。不要只注册一个 Ledger async disposer后宣称调用方已经等待它。

```ts
export interface WorkspaceMemoryPermit {
  readonly workspaceId: string;
  readonly rootBindingId: string;
  readonly workspaceTrustEpoch: number;
  readonly signal: AbortSignal;
  assertCurrent(): Promise<void>;
  commit<T>(effect: () => Promise<T>): Promise<T>;
  // 还带 package-private unique-symbol brand；只能由 coordinator 构造
}

export interface IWorkspaceProfileMemoryCoordinator {
  readonly _serviceBrand: undefined;

  acquirePermit(): Promise<WorkspaceMemoryPermit>;
  run<T>(operation: (permit: WorkspaceMemoryPermit, signal: AbortSignal) => Promise<T>): Promise<T>;
  proveRevoked(target: WorkspaceRevocationTarget): Promise<WorkspaceRevocationProof>;
}
```

Coordinator 是 Workspace-scope Service，直接注入 `IWorkspaceTrust` facade、`IProfileMemoryWriterLease` 和 `IWorkspaceContext`。`acquirePermit()` 先在 record lock 外确保并验证 home writer lease，再调用会锁内重读的 `await facade.getSnapshot()`；未信任或任一依赖不可用时拒绝签发。permit 的 `{rootBindingId, epoch}` 来自该权威 snapshot，异步 `assertCurrent()` 委托 facade 的 `validateCurrent()`，`commit()` 先验证 writer lease，再委托 facade 的 `commitIfCurrent()`，并在 effect 真正开始前再次验证 lease。`proveRevoked(target)` 是 App Worker 取得撤销证明的唯一 Workspace-scope 入口：先验证已持有的 writer lease，再要求 `target.workspaceId === IWorkspaceContext.workspaceId` 且 `target.rootBindingId === 当前 handle 冻结的 rootBindingId`，任一不等直接拒绝，不能把 target/handle binding 不一致解释为 root drift；随后才委托 facade/Authority。Authority 在 keyed mutex + record lock 内重新 realpath handle 的 `boundRoot` 并重读权威记录，只在三种条件之一成立时签发：(1) boundRoot 已不再解析到冻结 canonicalRoot/binding，原因 `root-drift`；(2) root仍绑定且 `target.workspaceTrustEpoch !== record.epoch`，原因 `stale-epoch`；(3) root/epoch均匹配但 `record.trusted === false`，原因 `untrusted`。root/epoch精确匹配且仍 trusted、记录损坏/绑定不一致、writer lease失效时一律拒绝。`jobId` 只作为 opaque nonce 绑定，存在性与 active lease/token 由 WP3 Queue 锁内重读验证；Authority 不依赖 Queue。该路径不申请普通 permit，也不允许任意 effect。不能根据 shared/cached snapshot 单独签发 permit或 proof。同 root 任一 alias 的本进程 Trust 通知会广播给所有 facade，分别 abort 尚未 commit 的本 Workspace 操作并清空 Snapshot/Recall cache；跨进程即使通知延迟，最终异步复验仍保证结果不返回、写入不提交。Agent 门面从父 Scope 注入 coordinator，消费者不能通过参数越过当前工作区。Permit/proof 都是内部 capability object，不进入 Zod、Wire 或模型参数；`rootBindingId + epoch` 另写入 MemorySubject、Evidence、Snapshot、Queue Record 和 Projection Command 的内部可信字段，并共同参与 Workspace 分区 key。

App Repository/Queue/Worker 不能直接注入 Workspace-scope Trust。同步调用由 coordinator 的 `run()` 包裹；每个 durable append、projection commit 和 queue ack 必须在 `permit.commit(effect)` 内完成。`untrust()` 的线性化点是新版 Trust 记录耐久落盘：在此之前已经进入同一 mutex 的 commit 可完成，之后尚未进入的旧 permit 必须失败。普通 read 在取数前后执行 `await permit.assertCurrent()`，最后一次校验成功是该 read 的线性化点；若另一进程已完成 untrust，锁内重读必须拒绝结果。`AbortSignal` 只负责尽快停止工作，不能替代返回前的权威复验。

现有 KAP trust/untrust route 可以继续调用当前 handler 的 `IWorkspaceTrust.trust()/untrust()`；facade 会进入 App keyed Authority。不得把 route 改成直接操作 document，也不得让 Profile Memory coordinator 拥有另一条 mutation API。

后台 claim 根据 Queue Record 中可信的 `jobId + workspaceId + rootBindingId + workspaceTrustEpoch`，通过 `IWorkspaceLifecycleService.handlerFor({ workspaceId })` 取得 Workspace handle，再从 `handle.accessor` 取得 coordinator 并比较当前 binding。可信 permit 可达时才进行普通 claim/renew/ack/投影；binding/epoch 失效、root drift或 untrusted 时经 `handler.accessor -> coordinator.proveRevoked(target) -> facade/Authority` 为该完整 `WorkspaceRevocationTarget` 取得 branded proof，再调用 Queue `fenceRevoked()`；Queue 锁内重读的 job target/expected state 任一不匹配都拒绝清退。Workspace/handler 不存在且无法权威证明失效时进入有界持久退避/隔离，不热循环。单个 `trusted: boolean`、仅内存 generation、入队时布尔快照或模型可构造 token 都不满足此合同。

### Agent Client

```ts
export interface IAgentProfileMemoryService {
  readonly _serviceBrand: undefined;

  callerContext(): MemoryInvocationContext;
  recall(request: MemoryRecallRequest): Promise<MemoryRecallResponse>;
  propose(request: MemoryProposeRequest): Promise<MemoryProposalReceipt>;
  feedback(request: MemoryFeedbackRequest): Promise<MemoryFeedbackReceipt>;
  readEvidence(request: MemoryReadEvidenceRequest): Promise<MemoryReadEvidenceResponse>;
}
```

这是核心 MVP 的最小门面。`listScenarios`、`currentSnapshot`、`onDidChangeSnapshot` 和 `autoRecall` 在对应 WP 到来时基于已冻结的 View、opaque token 和事件语义另行增加，WP0 不先发明未被首个切片消费的接口。

`callerContext()` 不能只读取 `IAgentProfileService.data().profileName` 后自行拼接身份。该接口目前没有 Profile 来源信息，而 Session Catalog 的 `inspect(name)` 同时返回胜出 Profile 与 `sourceId`。WP1 必须冻结 `ResolvedAgentProfileBinding { profile, sourceId }`（或等价 branded 类型），让所有改变持久 Profile identity 的 `bind/useProfile/applyProfile`、fork 与新 Wire 写入只能消费/保留这个整体。初次名称解析只做一次 `inspection = inspect(name)`；不得双读取。`ProfileData`/binding snapshot 的来源字段为兼容历史回放可 optional，但所有新 bind/fork 必填。恢复和 `refreshSystemPrompt()` 只能验证/使用持久 source-addressed binding；若当前 Catalog 无法证明同一 source，关闭 refresh 与 Memory，不能按同名当前 winner fallback。旧 Wire 缺来源只关闭记忆、不阻断 Session 回放，显式迁移另开工作包。

主体解析器基于上述可回放 binding 生成不可由模型修改的 `MemorySubject`，并绑定安装主体、`memoryOwnerId`、`ownerEpoch`、Workspace ID 和 `rootBindingId`。MVP builtin coder 的 owner 映射固定为 `{ memoryOwnerId: 'builtin:coder', ownerEpoch: 0 }`，来自受保护运行时常量而非模型/Profile/config；删除治理落地前不递增，但所有 key/record 仍携带 0。安装主体真实的原子创建/锁/权限属于 WP2 的 `IInstallationPrincipalStore`；WP1 只依赖其接口与 fake。任何字段缺失或 Workspace 未信任时关闭记忆，不能回退到 runtime Agent ID、默认公共桶或“手动调用可绕过”的路径。

## Profile 配置扩展

长期形态可以在 `AgentProfile` 增加声明式策略，但这不是 MVP 的第一步。当前 `AgentProfile` 没有 `memory` 字段，文件 Profile 解析器会忽略未知 frontmatter，文件转 Profile 工厂和用户 Profile 持久化也不会传播该字段；同名 Profile 还可能由 builtin、plugin、user、workspace 或 explicit 来源覆盖。因此不能只改一个 TypeScript interface 就宣称自定义 Profile 已支持记忆。

长期目标契约如下：

```ts
export interface AgentProfileMemoryPolicy {
  readonly enabled?: boolean;
  readonly owner?: string; // 仅可信注册来源可覆盖，不能来自普通 agent-file
  readonly autoRecall?: boolean;
  readonly autoCapture?: boolean;
  readonly tools?: readonly ProfileMemoryToolName[];
  readonly defaultScope?: 'workspace'; // global 需后续 ADR 扩展
}

export interface AgentProfile {
  // existing fields...
  readonly memory?: AgentProfileMemoryPolicy;
}
```

MVP 冻结策略：

| Profile | 自动召回 | 自动捕获 | 主动工具 | 备注 |
| --- | --- | --- | --- | --- |
| `coder` builtin | 先捕获，后手动召回 | 开启 | 分阶段开放 | 所有 builtin coder 实例共享同一 `memoryOwnerId` |
| `agent` / `explore` / `plan` | 关闭 | 关闭 | 无 | 等身份与权限策略单独评审后再开放 |
| plugin / user / workspace / explicit Profile | 关闭 | 关闭 | 无 | 不按同名自动继承，不扩展 agent-file 格式 |

Profile 记忆工具还必须显式加入 Profile 的精确 tool allowlist；仅通过 Feature 贡献工具不会让 builtin `coder` 自动激活它们。自定义 Profile 支持进入后续工作包时，要一次性覆盖 catalog/source identity、agent-file parser、file factory、用户 Profile store、Profile snapshot 和迁移测试，且默认仍关闭。

## 全局配置

可持久化、用户可调的选择放入 `profileMemory` Config Section：

```toml
[profile_memory]
enabled = false
capture_enabled = false
projection_enabled = false
manual_recall_enabled = false
auto_recall_enabled = false
auto_recall_timeout_ms = 1500
recall_token_budget = 1800
recall_limit = 12
worker_model = "memory-worker"   # 必须显式配置；缺失时投影暂停
```

MVP 只有本地权威后端。TencentDB 配置在适配器工作包落地时另增，不能让 `backend = "tencentdb"` 在核心契约完成前出现为可选生产路径。Feature 始终存在。每类业务操作统一计算 `operationEnabled = flags.enabled('profile_memory') && config.enabled && config.<operation>Enabled`，任一缺失字段按 false；Capture、Projection、Manual Recall 和 Auto Recall 都遵守同一真值表。关闭时不得打开 Store、订阅 Capture、启动 Worker、materialize 模型工具或注入上下文；直接调用稳定返回 `memory.disabled`。Operator inspect 可在不开 Store 的前提下报告 disabled 原因，不得绕过 gate。

API 密钥和凭据不写入普通记忆配置或记忆日志。凭据通过现有凭据机制或外部 Secret 注入，业务代码只接收已解析的客户端。

以下内容不属于 Config：当前 Snapshot 版本、队列游标、某个 Profile 的自我模型和本轮召回缓存。这些分别属于持久投影、Session 状态和 Agent 状态。

## 持久化布局

### 本地后端

推荐语义布局（真实物理 key 由唯一 `EvidenceKeyCodec` 生成）：

```text
profile-memory/
└─ principals/<principal-id>/owners/<owner-id>/epochs/<owner-epoch>/
   └─ workspaces/<workspace-id>/bindings/<root-binding-id>/
      ├─ evidence/
      │  ├─ events.jsonl
      │  └─ writer-state.json
      ├─ queue/
      │  ├─ records.jsonl
      │  └─ partition-head.json
      ├─ projection-events.jsonl
      ├─ atoms/
      ├─ conflicts.json
      └─ projection-checkpoint.json
```

业务代码不直接拼接这些物理路径。MVP 复用 `IBootstrapService.scope('store')` 根目录，不虚构新的 `profile-memory` PersistenceScopeName；所有 key 必须经过一个经过遍历攻击测试的 codec。

现有 Store 原语不能直接充当领域契约：

- `IAppendLogStore.append()` 返回 `void` 且允许缓冲；只有 `flush()` 可等待，它不分配或返回领域 offset。
- `IAtomicDocumentStore` 没有 compare-and-swap，不能据此承诺多进程乐观锁。
- `IQueryStore` 能维护索引和有序分页，但没有词法全文搜索或相关性分数接口。

因此 WP2 必须先定义并用 Contract Test 固化 `IProfileMemoryEvidenceStore.appendBatch()` 的耐久返回语义、单调 position、逐事件幂等、`durableThroughPosition` 和 ambiguous-append 恢复。WP5 另定义 Capture source checkpoint；两者不可混用。WP7 必须定义 `IProfileMemorySearchStore`，MVP 只承诺“词法全文检索”，不向调用者承诺 BM25。当前 Store 可以作为内部实现原语；`IBlobStore` 继续保存脱敏后的大型输出。

MVP 明确采用每个本地 Store 单写者。若同一数据目录可能被多个进程写入，Feature 必须拒绝启动第二个 writer；首版 Queue 内仍实现 lease/fencing 处理同进程重领，不能据此宣称多进程安全。多进程/远程写入要等跨进程锁、CAS 和租约合同具备后再开放。

### TencentDB 后端映射（后续镜像，不属于 MVP）

| 本设计 | TencentDB Agent Memory | 映射 |
| --- | --- | --- |
| `MemorySubject` | `agent_id` / `user_id` / `team_id` | 由本地映射表分配外部 ID，不能假定裸本地 ID 可直接透传 |
| 用户或部署主体 | `user_id` | 来自真实认证主体；本地模式使用安装级主体，不把显示身份当鉴权主体 |
| 工作区 | `team_id` | 通过 provision/mapping 产生的稳定外部 Team ID |
| 会话 | `session_id` | Kimi Session ID |
| 任务 | `task_id` | 子 Agent Task / Tool Call 关联 ID |
| L0 Evidence | Conversation | 按轮增量写入，扩展元数据保存事件类型和 runtime Agent |
| L1 Atom | Atomic | 类型、优先级、版本和来源引用 |
| L2 Scenario | Scenario | 工作区场景块 |
| L3 Self Model | Core | Profile 长期自我模型 |

本地 Repository 始终是 MVP 权威。后续 TencentDB v3 适配器先作为 L0/L1 检索镜像，通过本地 Outbox、映射表、能力握手、确定性分块和对账流程同步；L2/L3 继续由本地投影负责。不得降级到隔离较弱的 `/v2` 或默认 team/user 桶。外部成功与本地 Outbox 失败的双向分叉、删除回执和 SSRF/TLS 配置校验必须进入该工作包的验收。

## Capture 集成点

Capture 采用“实时事件触发、耐久上下文取数”的混合模式：

- Agent Scope 的 `IEventBus` 提供 `turn.started`、`turn.ended`、`tool.call.started`、`tool.result` 和 `subagent.completed` 等完成信号。
- `turn.ended` 只有 `turnId`、结束原因、错误和耗时，不含最终 Assistant 文本；完成时必须从 `IAgentContextMemoryService` 或一个新增的耐久 Context/Wire 投影接口读取已折叠结果，不能从 delta 临时拼出权威文本。
- `tool.call.started` 有名称和参数，`tool.result` 只有 `toolCallId`、输出和错误状态；Capture 必须以 `toolCallId` 做有上限的关联，或改在 Tool Executor 的确定性完成 hook 取完整调用。进程崩溃后以耐久记录重扫补齐。
- `subagent.completed` 当前真实存在并提供 `subagentId`、summary 和 usage；Profile、父子关联来自 spawn 记录或可信 Session 元数据，不能让 summary 自报。
- 用户 / Reviewer Feedback 与 Proposal 只通过显式领域命令进入 L0。
- Capture 必须通过 Workspace coordinator 获取 permit；订阅/取数前执行 `await permit.assertCurrent()`，durable append 包在 `permit.commit()` 中。运行中 `untrust()` 取消尚未 commit 的 Capture，并使旧 generation 的晚到 append 失败。

Capture 的来源进度与 L0 position 是两个坐标，不能共用一个 checkpoint。WP5 持久化 `{ sourceStreamId, sourceEpoch, sourceCursor, lastClientEventId, durableThroughPosition }`；只有来源游标连续前缀的事件全部 accepted/duplicate，才推进 `sourceCursor`。`durableThroughPosition` 只描述 L0 已耐久到哪里。启动、attach race、append 后来源 checkpoint 前崩溃都通过按 source cursor 重扫和幂等键恢复；retryable 洞不跨越，永久过滤在 append 前确定性完成或形成可审计终态。Undo、取消、Compaction 和被截断上下文的语义在 WP0 冻结。

来源为 `ContextMessage.origin.kind === 'injection'` 的消息，以及 `derivedFromMemoryRefs` 标注的 Memory 工具输出，不得再次生成新的独立长期事实，避免“召回 → 再捕获 → 置信度自增强”闭环。Capture 只做确定性关联、白名单、大小限制、脱敏、Blob offload 和耐久 append，不在热路径调用 LLM。

## Recall 注入点

MVP 先实现手动 `MemoryRecall`。自动召回在质量与恢复门禁通过后，使用现有 Context Injector 的“新 Turn”路径：

1. 从 `turn.started.prompt` 取得可展示 User Origin 的查询，或扩展 `ContextInjectionContext` 让查询和 `turnId` 成为显式契约；当前 Injector Context 本身不含 Prompt。
2. 获取当前已冻结的 `MemorySubject`、`sessionId` 和 `runtimeAgentId`。
3. 仅在 `isNewTurn = true` 时以严格超时调用 `autoRecall`；Context Injector 会在每个 LLM step 执行，不能每步重复查询。
4. 将所有层级统一格式化成一个带 `origin.kind = 'injection'` 的不可信历史块。现有 Injector 的字符串结果进入 System Reminder，但不是 Profile 永久 system prompt；MVP 不修改 Profile system prompt，也不把 L1 伪装成真实 User 输入。
5. 超时、Turn 切换或请求取消后丢弃晚到结果；后端失败或无结果时不注入，只发布降级指标。
6. Compaction 后按固定 Snapshot 重新注入时必须保持同一引用集合，或者显式获取新的 Snapshot 并记录代际变化。
7. 未信任 Workspace 的手动和自动 Recall 都 fail closed；`untrust()` 立即清除 pinned Snapshot/cache，晚到结果不得进入上下文。

同一个 Turn 使用固定的 opaque `snapshotToken`。Turn 中途其他实例产生的新记忆不会自动改变当前上下文；Agent 主动调用 `MemoryRecall` 时可以获取新 Snapshot。MVP 若不实现 MVCC，`snapshotToken` 只代表缓存中已钉住的结果集，不能宣称支持任意历史版本查询。

## Worker 调度

队列分区规则：

```text
L1 extraction partition = principalId + memoryOwnerId + ownerEpoch + workspaceId + rootBindingId + sessionId
L2 projection partition = principalId + memoryOwnerId + ownerEpoch + workspaceId + rootBindingId
L3 projection partition = principalId + memoryOwnerId + ownerEpoch
```

L1 可以并发处理不同 Session，但同一 Session 按 L0 position 顺序消费。L2 在工作区内串行，L3 在 Profile 主体内串行。MVP 只实现 L1；这里的 L2/L3 分区是后续保留契约。

Worker 命令带以下并发字段：

```ts
export interface MemoryProjectionCommand {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly partitionKey: string;
  readonly expectedVersion: number;
  readonly ownerEpoch: number;
  readonly rootBindingId: string;
  readonly workspaceTrustEpoch: number;
  readonly leaseId: string;
  readonly fencingToken: string; // 分区单调、opaque
  readonly source: {
    readonly fromPositionExclusive: string;
    readonly toPositionInclusive: string;
  };
  readonly inputDigest: string;
  readonly schemaVersion: 1;
  readonly promptVersion: string;
  readonly modelVersion: string;
  readonly changes: readonly MemoryProjectionChange[];
}
```

队列本身是耐久权威，进程事件只负责唤醒 Worker。WP3 至少定义 Queue Record、Partition Head、claim、renew、ack、nack、fence、重试、退避、DLQ、启动扫描和优雅 drain。首版即要求 `leaseId` 与每分区单调的 `fencingToken`：每次重新 claim 都递增 token，旧 token 永久失效；单进程的 lease expiry/reclaim 同样有晚 Worker 竞态，不能推迟到多进程。Repository commit/ack 同时校验 active lease、fencing token、owner epoch、root binding ID 和 workspace trust epoch；旧 binding job 不能因 B 恰好也是 epoch 0 而复活。多进程开放仍需额外证明 lock/CAS 后端和跨进程租约安全。

Worker 不能注入 Agent-scoped `IAgentLLMRequesterService`。`IProfileMemoryWorkerLLM` 是 App-scope 受限适配器，通过 `IModelCatalog.getRequester(configuredAlias)` 发请求；无工具、强制结构化输出、固定超时/Token 预算并记录用量。未配置模型时投影队列暂停并标记 degraded，不能偷偷回退到当前主 Agent 模型。版本不匹配时重新读取并重算，禁止最后写入覆盖。

## Feature Flag 与上线

功能尚未公开时，通过现有实验 Flag 注册表启用，例如：

```text
profile_memory
```

对应环境变量为 `KIMI_CODE_EXPERIMENTAL_PROFILE_MEMORY`，默认关闭。Feature Assembly 仍会组装 `ProfileMemoryFeature`；Flag 与 typed config 只控制运行行为，不实现动态 DI 撤回。所有入口必须共享同一 gate 语义，再逐级开放：

1. L0 capture only。
2. L1 Shadow Projection。
3. Observe Recall。
4. 手动 `MemoryRecall` 与有限 Evidence Read。
5. Proposal / Feedback。
6. 小比例自动 Recall。
7. L2/L3、向量和外部镜像。

每一级都可以独立关闭，便于定位质量问题。回滚是停止新行为而不是卸载已注册的 Wire/config；关闭总 Flag 后，系统应保持可恢复数据但产生零 Store/Capture/Worker/Injection 副作用。

## 包与边缘集成

边缘协议必须分成三个独立工作面，不能把它们当作同一个现成 API：

- `packages/agent-core-v2`：引擎领域契约、Service、工具、注入和本地权威后端。
- `packages/klient`：面向 memory / IPC transport 的 tuple Zod contract 与 facade；当前没有 Workspace facade，需单独设计。
- `packages/kap-server`：HTTP 运维面；当前 `/api/v2` 只有 domain-grouped sessions 查询，不存在通用 action map，也没有 v2 WebSocket。
- `apps/kimi-inspect`：后续调试视图，不属于 MVP 阻塞项。
- `apps/kimi-desktop`：后续记忆管理 UI，不属于核心存储实现。

核心 MVP 不开放公共 API。引擎稳定后先写边缘 ADR，再分别实现 Klient IPC/memory 和 KAP REST Contract Suite；WebSocket 属于后续工作。业务 Domain 不依赖 `kap-server`、REST 或 WebSocket。
