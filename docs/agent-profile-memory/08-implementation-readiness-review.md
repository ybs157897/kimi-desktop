# 实现就绪审查与工作包

本文是对 `01`–`07` 的实现前审查，目的不是重复架构，而是回答三个问题：

1. 哪些描述已经足够让实现 Agent 开工？
2. 哪些描述仍会让不同 Agent 做出不兼容实现？
3. 应按什么依赖顺序拆包、验收和交接？

审查基于当前仓库源码，而不是只根据已有设计文档。若本页与 `01`–`07` 中的概念性草图冲突，**MVP 实施以本页为准**；实施中发现源码继续演进时，先更新决策记录，再修改公共契约。

## 结论

现有文档已经足以确认产品方向和总体分层，但还不能让多个编码 Agent 直接并行修改公共接口。当前成熟度如下：

| 领域 | 状态 | 结论 |
| --- | --- | --- |
| 产品目标、L0–L3 分层、证据门禁 | 已明确 | 可以作为业务不变量 |
| v2 Feature 与 Scope 落位 | 已校正 | 可以创建骨架 |
| MVP 身份与隔离策略 | 本页冻结 | 只开放 builtin `coder` + Workspace |
| L0 耐久追加、offset、幂等、checkpoint | 尚无现成契约 | 必须先建领域 Store |
| Capture 的事实来源 | 已找出真实事件，读取契约待实现 | 事件触发 + 耐久 Context/Wire 取数 |
| Worker Queue 与 Worker LLM | 仓库无可复用完整实现 | 必须先定义 SPI 和崩溃恢复语义 |
| 词法搜索 | 通用 Query Store 不提供相关性搜索 | 必须定义领域 Search Store |
| Agent 工具请求/响应 | 方向明确，Schema 未闭合 | WP0 由一个契约负责人统一完成 |
| 自动 Recall 注入 | 当前 Hook 信息不足 | 手动 Recall 先行；自动注入后置 |
| Klient / KAP / WS | 现有文档曾超前于代码 | 核心 MVP 不开放；后续分别写 ADR |
| TencentDB | 可参考，不适合作为首版权威源 | 后续只做 v3 镜像适配 |
| 删除、保留、owner 重建 | 状态机未闭合 | MVP 预留 epoch/tombstone，外部发布前完整实现 |

**并行门禁：** WP0 和 WP1 完成前，只允许并行做只读探索、测试方案和原型验证；不允许多个 Agent 分别发明公共 TypeScript 类型、错误码、存储 key 或导出路径。

## 当前代码事实

| 主题 | 当前源码事实 | 对设计的约束 |
| --- | --- | --- |
| Profile 类型 | `app/agentProfileCatalog/agentProfileCatalog.ts` 的 `AgentProfile` 没有 `memory` 字段 | 不能只改一处 interface 就宣称所有 Profile 支持记忆 |
| Profile 来源 | `session/sessionAgentProfileCatalog` 的 `inspect(name)` 才包含胜出 `sourceId` | 裸 `profileName` 不是安全主体 |
| Profile binding | 现有 `profile.bind` / `ProfileBindingSnapshot` 只保存 `profileName`；`useProfile/applyProfile`、fork 和恢复 refresh 也可能丢失/重猜来源 | WP1 必须让所有持久 identity 入口消费同一 source-addressed binding；不能在恢复时按同名 winner 回退 |
| 文件 Profile | `workspace/workspaceAgentProfileLoader/internal/agentFile.ts` 忽略未知字段，factory 不传播 memory | MVP 不扩展 agent-file；自定义 Profile 默认关闭 |
| Profile 工具 | builtin `coder` 在 `session/agentLifecycle/profile/profiles.ts` 使用精确 allowlist | 贡献 Memory 工具后还必须显式加入 allowlist |
| Tool policy | 非 MCP 工具按精确名称判断，glob 只对 `mcp__` 生效 | 不能用 `Memory*` 通配符激活普通工具 |
| Feature seam | `src/features/plan/` 是当前自包含 Feature 参考 | Profile Memory 运行时能力放在 `src/features/profileMemory/` |
| 事件总线 | `IEventBus` 是 Agent Scope；`IEventService` 是 App Scope | Capture 订阅前者，跨实例状态通知使用后者 |
| Turn 结束 | `turn.ended` 不含最终 Assistant 文本 | 事件只作为完成信号，正文从耐久 Context/Wire 读取 |
| Tool 结果 | started 含 name/args；result 只含 `toolCallId`/output/error | 需要有限关联表或 Tool Executor 完成 hook |
| 子 Agent | `subagent.completed` 已存在，含 summary/usage | 父子/Profile 信息仍从可信 spawn/session 元数据关联 |
| Context 注入 | Injector Context 只有注入位置和 `isNewTurn`，没有 query/turnId | 手动 Recall 先行；自动 Recall 需桥接或扩展契约 |
| 注入形态 | string 进入 System Reminder，数组进入注入 User message | MVP 只使用统一不可信数据块，不修改永久 system prompt |
| L0 原语 | `IAppendLogStore.append()` 返回 `void`，`flush()` 才可等待 | 不能把 append 调用当作 durable offset receipt |
| 文档原语 | `IAtomicDocumentStore` 没有 CAS | 不能宣称多进程 expectedVersion 已安全实现 |
| 文档耐久性 | node-fs `FileStorageService.write()` 的 rename 后只调用 `syncDirOnce()` | 第二次及后续 replacement 未证明 parent-directory fsync；Trust epoch 不能直接依赖它作为耐久线性化点 |
| Workspace handler | `IWorkspaceLifecycleService` 的 live/materializing 以传入 `workspaceId` 为键 | legacy/alias workspaceId 可为同一 canonicalRoot 形成多个 Scope；Trust mutex 不能放在 facade 实例内 |
| Root identity | `workspaceRootKey()` 只做词法归一；`IHostFileSystem.realpath()` 才解析 symlink/dot segments | Authority 先 realpath，失败 fail closed，再对 real path 做平台归一和 SHA-256 key；hardlink/bind mount/inode 等价不在首版保证 |
| Root drift | Workspace Context 保留调用方传入的词法 `cwd`，attach 后 symlink 仍可被 retarget | 不能只在 attach 时解析一次后继续用词法路径；Trust permit 与持久分区必须绑定 opaque `rootBindingId`，Trust-gated project MCP 必须使用冻结的 canonical root |
| Scope teardown | `Scope.dispose()` / `InstantiationService.dispose()` 会 `void ledger.teardown()` | 不能靠 Ledger async disposer证明 writer lease 已释放；需要 App shutdown drain 并在所有 composition root 显式 await |
| MCP Trust gate | `WorkspaceMcpConfigService` 监听本进程 `onDidChange`，reload 使用同步 `isTrusted()` | Authority 必须强制跨进程 watch/reconcile，MCP 初始化/reload 改为 await 权威 snapshot |
| Persistence watch | `IAtomicDocumentStore.watch()` 只有 `Event<void>`；node-fs watcher error 只进 `onUnexpectedError` | WP1 需扩展为可观察 change/error/close 的 handle 或新增 SPI，否则无法实现 watch failure fail closed |
| ACP shutdown | `packages/acp-server/src/start.ts` 也创建 App 并直接同步 dispose | 它与 KAP/SDK/CLI/harness 一样必须显式 await Memory drain |
| 查询原语 | `IQueryStore` 没有全文相关性搜索/score 方法 | 定义 `IProfileMemorySearchStore`；不承诺 BM25 |
| 持久根 | `IBootstrapService` 已有 `scope('store')` | MVP 复用 store 根，由唯一 key codec 建子命名空间 |
| Worker 模型 | App Scope 的 `IModelCatalog.getRequester(id)` 可取得 requester | 建受限 App `IProfileMemoryWorkerLLM`，不依赖 Agent LLM Service |
| KAP v2 | 当前只有 domain-grouped `/api/v2/sessions` 查询 | 不声称 action map、记忆 routes 或 v2 WS 已存在 |
| Klient | 当前是 global/session/agent facade 的 IPC/memory 客户端 | Klient 契约与 KAP HTTP 是不同工作面；当前无 workspace facade |

## 冻结的 MVP 决策

这些是首轮实现的默认答案。改变其中任何一项都应先写 ADR，并重新评估数据迁移与安全测试。

| ID | 决策 |
| --- | --- |
| M1 | 目标架构仍是“每个明确配置的 Profile 一份记忆”；首个可运行切片只启用仓库内置 `coder` |
| M2 | 同一本地安装主体下所有 builtin `coder` 实例共享 `memoryOwnerId = builtin:coder`；同名 plugin/user/workspace Profile 不继承 |
| M3 | `MemorySubject` 至少包含 `principalId`、`memoryOwnerId`、`ownerEpoch`、Profile name/source、`workspaceId` 和 opaque `rootBindingId`；后者参与所有 Workspace 分区 key |
| M4 | 本地模式的 `principalId` 是持久化在 Store 元数据中的随机安装级 UUID；由 WP2 在 single-writer lock 下以 create-if-absent 等价语义创建并复用。`IBootstrapService.clientIdentity` 只含产品/版本/平台，`IAgentIdentity` 的显示名称和共享 bearer token 也都不是用户鉴权主体 |
| M5 | 只提供 Workspace 长期范围；global、跨 Workspace 晋升和跨 Profile 学习关闭 |
| M6 | 本地 Repository 是唯一权威；TencentDB、向量服务和远程数据库不进入 MVP |
| M7 | 一个本地 Profile Memory authority 只允许一个 writer。Feature 初始 disabled 不申请锁；首次 enabled 操作/permit 前懒获取覆盖同一 home 的进程级 writer lease并持有到显式 App shutdown drain，第二个进程的 Profile Memory fail closed。Workspace Trust 不依赖该长 lease，而是每次按 canonical record key 取得短持有的跨进程锁，因此现有 trust route 不被 Memory 开关/第二 writer 破坏 |
| M8 | 交付顺序为 L0 Capture → L1 Shadow Projection → 手动词法 Recall → Agent Tools → 自动 Recall |
| M9 | MVP 搜索契约只叫“词法全文检索”，具体 TF-IDF/BM25 算法不是公共承诺 |
| M10 | 所有召回层级统一作为不可信历史块注入；不修改 Profile system prompt，不伪装成用户指令 |
| M11 | `MemoryInspect` 首版是 operator/debug capability，不暴露为模型工具 |
| M12 | 人类反馈可以高可信地证明偏好和验收，但不能单独证明任意技术事实；后者仍需 Tool/Artifact 证据 |
| M13 | 人工纠错通过新增治理 Evidence 和状态转换实现，不原地覆盖 L1/L2/L3 历史 |
| M14 | 核心 MVP 不新增公开 REST、WS 或 Klient API；引擎稳定后分别设计和发布 |
| M15 | L0 在 retention/delete 命令前只追加；MVP 预留 `ownerEpoch`、tombstone 和 deletion state，不能把“不可变”解释为永不删除 |
| M16 | `ProfileMemoryFeature` 始终由 Feature Assembly 组装；实验 Flag 不动态 unprovide 整个 Feature。每个业务入口统一计算 `operationEnabled = flags.enabled('profile_memory') && config.enabled && config.<operation>Enabled`，任一字段缺失按 false；Agent Service、Tool activation 和后台 Worker 启动入口都 fail closed。关闭时不打开 Store、不订阅 Capture、不启动 Worker、不注入上下文，工具调用返回 `memory.disabled`。Operator inspect 可报告“disabled/原因”，但不得据此打开 Store |
| M17 | Workspace Trust 是强门禁：App-scope `IWorkspaceTrustAuthority` 先 realpath，再以 `canonicalRoot = workspaceRootKey(realRoot)` 共享唯一 snapshot、mutex 和事件，以 `v2-<sha256(utf8(canonicalRoot))>.json` 作持久 key，并生成 opaque `rootBindingId = rb-v1-<sha256(utf8(canonicalRoot))>`；Workspace `IWorkspaceTrust` 只是 facade。coordinator 只签发 permit、取消工作和清 cache；签发和 read 返回都必须异步锁内重读并同时校验 `{ rootBindingId, epoch }`，不能用缓存 snapshot/同步 check。Authority 强制 watch/reconcile 跨进程变更；MCP 初始化/reload 使用要求健康撤销通道的 guarded snapshot。App 后台只能经 `IWorkspaceLifecycleService.handlerFor()` 取得实时 permit。所有 durable effects 经过 permit 的 `commit()`；旧 binding、旧 epoch、alias handler 和晚到 read 都失败 |
| M18 | Profile bind 只做一次 `inspection = catalog.inspect(name)`，直接使用同一 inspection 的 `profile` 与 `sourceId`，避免 `get()` + `inspect()` 的 TOCTOU。来源持久化进 `profile.bind` / `ProfileBindingSnapshot`；Wire 字段为兼容历史回放可选，新写在 Service 边界必填。旧记录缺来源时只关闭 Memory，不自动推断或迁移 |
| M19 | 安装主体的“首次原子创建”属于 WP2 的 single-writer 元数据合同。现有 `IAtomicDocumentStore` 无 create-if-absent/CAS，node-fs acquire 也不能证明跨进程互斥；WP1 只能依赖 `IInstallationPrincipalStore` 接口/fake，不能把一次 `get()` + `set()` 宣称为安全初始化 |
| M20 | Workspace Trust fence 与 bool 由 canonical trust-record key 下的单份版本化记录持有；旧 `workspace-trust/<encodeWorkDirKey(root)>` marker 只是迁移输入。`untrust()` 同 keyed mutex 重读最新记录并以每次 file fsync + rename + parent-directory fsync 写 `false,epoch+1`，`trust()` 写 true 但保留 epoch；`{rootBindingId, epoch}` 同时写入 MemorySubject、Evidence、Snapshot、Queue Record 和 Projection Command，并参与 Workspace 分区 key，跨 alias handler、重启/重新 trust 保留，防止 ABA 与 A/B 根混淆 |
| M21 | Queue 首版即使用 `leaseId + partition-monotonic fencingToken`；每次重新 claim 递增 token，Projection commit 与 ack 同时校验 active lease、token、owner epoch 和 trust epoch，不能把 fencing 推迟到多进程 |
| M22 | Capture 来源 cursor 与 L0 position 分离：Evidence receipt 返回 `durableThroughPosition`；WP5 独立持久化 source checkpoint，只有连续来源前缀全部 accepted/duplicate 才推进 source cursor |
| M23 | MVP 的 builtin `coder` 使用受保护运行时映射 `{ memoryOwnerId: 'builtin:coder', ownerEpoch: 0 }`；首版删除编排尚未实现，epoch 不递增，但所有 key/record 仍必须携带 `0`。未来 owner registry/删除治理以显式迁移替换此映射，不从模型、Profile 文件或普通 config 读取 |
| M24 | Authority handle 保存词法 `boundRoot`、冻结的 `canonicalRoot` 和 `rootBindingId`。每个安全 API 在旧 record lock 前重新解析 `boundRoot`；漂移/解析失败立即 fail closed、取消旧 permit并广播，绝不自动把 A 的信任授予 B。Trust-gated project MCP 只从冻结 canonical root 读取并以它解析项目 stdio cwd；显式重新 materialize/重新 trust 才能为 B 建新 binding |
| M25 | Authority entry 独立维护 `watchHealth = starting | healthy | degraded | disposed`。change/error/close 只加速通知；即使 healthy 也必须以可测试时钟在 ≤2 秒内周期锁内 reconcile，超时/读失败进入 degraded。基础 project MCP 只能使用“record trusted + watch healthy + 当前订阅已完成 reconcile”的 package-private guarded project access；它携带冻结 canonicalRoot 与读后复验 capability。撤销必须走高优先级可取消 lane，先 deny new use、abort/隔离 pending connect，再卸载，绝不排在普通 initialize/connect/apply tail 后；不可取消 connector先从 registry撤下再后台清理。从 reconcile 到 deny/unload 也受同一有界验收约束。Memory permit 正确性仍由每次 record-lock 复验保证，不依赖 watch health |
| M26 | Queue 的普通业务 mutation 使用 permit；当旧 job 已无法取得 permit时，coordinator 先要求 target 的 workspaceId/rootBindingId 等于当前 Workspace/handle，Authority 再在 mutex + record lock 内重做 realpath并重读记录，只有 root-drift、stale-epoch 或 untrusted 三种权威条件成立才返回精确绑定 `jobId + workspaceId + rootBindingId + workspaceTrustEpoch` 的 package-private branded `WorkspaceRevocationProof`；当前 exact trusted、跨 Workspace/binding chosen-target与损坏记录均拒绝。Queue 独立的 `fenceRevoked(jobId, expectedState, proof)` 是唯一消费者：在 partition lock 内重读 job，job ID、目标三元组及 active lease/fencing state 必须与 proof/expectedState 完全匹配，才允许单调 `pending|leased -> fenced`；跨目标重放或错配拒绝。Projection commit、success ack 与其他写 API 的签名不接受该 proof，也不存在任意 callback effect。handler 不存在且无法证明时持久退避/隔离，不热循环也不猜测 |

## 编码前必须闭合的契约

### 1. 可信主体

建议内部类型最少包含：

```ts
export interface MemorySubject {
  readonly principalId: string;
  readonly memoryOwnerId: string;
  readonly ownerEpoch: number;
  readonly profileName: string;
  readonly profileSourceId: string;
  readonly workspaceId: string;
  readonly rootBindingId: string;
}

export interface MemoryInvocationContext extends MemorySubject {
  readonly requestId: string;
  readonly sessionId?: string;
  readonly runtimeAgentId?: string;
  readonly taskId?: string;
  readonly turnId?: number;
  readonly source: 'runtime' | 'agent-tool' | 'worker' | 'operator';
}
```

不变量：

- 模型参数中不存在 owner、principal、Workspace 或 Profile source 字段。
- 安装级 `principalId` 不能从用户名、home path、产品名或 bearer 派生；它由 WP2 的专属 Store 在 single-writer lock 下以 create-if-absent 等价语义创建，落盘/目录同步后才返回，文件权限限制为当前用户，复制数据目录视为显式迁移。不得用现有 AtomicDocumentStore 的普通 get/set 伪装 CAS。
- 每次调用都从 Agent/Workspace/Session Scope 中绑定上下文；Repository 不接受“调用者已经验证过”的布尔值。
- `profileName` 只用于显示和审计；物理 key 使用编码后的稳定 ID 与 epoch。
- builtin `coder` 的 `ownerEpoch` 首版固定为受保护常量 `0`；不是配置字段或模型参数。删除/重建治理落地前不递增，但任何持久 key/record 都不得省略它。
- Profile source 切换、重命名、删除后重建都不静默继承旧数据。
- 冻结 `ResolvedAgentProfileBinding {profile, sourceId}`（或等价 branded 类型）。所有会改变/复制持久 Profile identity 的 `bind/useProfile/applyProfile/applyBindingSnapshot/fork` 只消费或保留该整体；初次名称解析只调用一次 `catalog.inspect(name)`。generic `IAgentProfileService.update()` / 新 `config.update` 写入不得再改变 `profileName`（从新写类型/路径移除或明确拒绝）；旧 Wire 的 `config.update.profileName` 只为历史回放兼容。`applyBindingSnapshot` 的新写调用必须 sourceId 必填并与 profileName 原子落同一 bind op；只有历史 replay decode 可以缺 source。任何仍被允许的新 identity write 都遵守同一规则。Wire/ProfileData 为兼容旧记录可 optional，但新 bind/fork 必填；恢复与 refresh 只验证持久 source-addressed binding，无法证明同一来源时关闭 refresh/Memory，绝不按当前同名 winner回退。旧记录缺来源不阻断 Session 回放，也不自动迁移。
- App-scope `IWorkspaceTrustAuthority` 是唯一变更权威：先以 `IHostFileSystem.realpath(root)` 解析 symlink/dot segments，再用 `canonicalRoot = workspaceRootKey(realRoot)` 建进程内等价类，以 `v2-<sha256(utf8(canonicalRoot))>.json` 作安全定长持久 key，并以同一 digest 生成 opaque `rootBindingId`；解析失败 fail closed。原路径、dot segments、symlink 和现有 Windows alias 归到同一 canonicalRoot；hardlink/bind mount/inode 等价不在首版保证。每次 mutation/validation/commit 经通用 persistence Service 取得 record key 的跨进程锁并重读耐久记录。Workspace `IWorkspaceTrust` 只持有 ref-counted handle并转发；KAP route 仍调用 facade。禁止调用方直接写 marker，也禁止 facade/coordinator 另存一份 epoch 或 mutex。
- Authority handle 固定保存 `boundRoot + canonicalRoot + rootBindingId`。每个 `getSnapshot/validateCurrent/commitIfCurrent` 在进入旧 record lock前重新 realpath `boundRoot` 并比较 binding；漂移或解析失败立即把该 handle fail closed、abort旧 permit并广播，绝不能自动 attach 新 target或沿用旧 epoch。安全 API 校验的最小 fence 是 `{ rootBindingId, epoch }`，不是裸 epoch。Trust-gated project MCP 从冻结 canonicalRoot 读取配置并用它解析 project-origin stdio cwd，读取前后再校验 binding；禁止在安全读取中继续使用可 retarget 的词法 root。
- Workspace coordinator 等待 facade/Authority ready，先验证 home writer lease，再通过 Authority record lock 重读最新记录后签发 opaque capability permit；permit 带 `workspaceId + rootBindingId + workspaceTrustEpoch + AbortSignal + async assertCurrent() + commit(effect)` 和 package-private brand，不进入 Zod/Wire/Tool Schema。每个 read 返回前也必须异步锁内复验。App Repository/Queue 不能注入 Workspace facade 或缓存 bool；只有 Trust Domain 的 App Authority 可以作为该 facade 的依赖。
- Persistence 层提供唯一 `IExclusiveKeyLockStore` access pattern，明确包含短临界区 `withLock()` 和返回 owner-token lease 的长持有 `acquire()/validate()/release()` 与 loss `AbortSignal`。活着且仍持 owner token 的进程不能仅因墙钟超时/事件循环暂停被接管；死亡 owner 可经 PID/token 证明后恢复。Trust Authority 对 canonical record key 每次短持锁；Profile Memory 的 App `IProfileMemoryWriterLease` 在 Flag/config 首次允许实际 Store/Worker/permit 前懒获取 home key并持有到显式 shutdown drain。Service/Fiber effect 可注册崩溃式兜底 disposer，但正常 close 必须显式 await `IProfileMemoryShutdown.drain()`；acquire 与 closing 竞态时当场释放并 fail closed。两者复用 primitive，但 namespace/粒度/生命周期不同。第二进程 writer lease 失败时只关闭 Profile Memory mutation/permit，不关闭基础 Workspace Trust。它不是 `IAtomicDocumentStore.acquire()` 的 flush handle，也不能延迟到 WP2 才实现。
- `untrust()` 在 canonical-key 进程内 mutex + 跨进程 record lock 中重读最新记录，以“新目录 entry 同步（如有）→ file fsync → rename → 每次 parent-directory fsync”的原语写入 `trusted=false, epoch+1`，成功后才更新 shared snapshot/广播；`trust()` 同锁重读并写 true 但保留 epoch。WP1 修正通用 `FileStorageService.write()/writeStream()` 的每次 rename 目录同步，`syncDirOnce()` 只留给首次 append 等明确场景；Trust 业务代码不得直接 import `node:fs`。Memory `commit(effect)` 还复验 home writer lease，再经 facade 委托 Authority 复验 live trust/epoch并持 record lock到耐久 effect 完成。失败不改 snapshot、不发事件；已进入临界区的 effect 可完成，尚未进入的旧 permit 失败。alias handler/process、重启和重新 trust 不重置 epoch；进程内共享 `onDidChange` 只负责取消和清 cache，不是安全钩子。
- 锁序固定为“已持有 writer lease 的 validate → canonical-key 进程内 mutex → canonical record lock → effect 前再次 validate”；record-lock effect 不递归 Trust API、不同时取第二 record lock。基础 Trust mutation不申请 writer lease。跨进程事件仅改善时效，签发 permit、read 返回和 commit 的锁内重读才是安全依据。
- 上述锁序扩展到全系统：writer lease validate → Trust mutex → Trust record lock → domain/queue/repository partition lock。禁止持领域锁获取 permit或调用 Trust；Worker 先短锁 peek 并释放，再由 `permit.commit()` 包住仍获授权的 claim/renew/ack/nack/投影 effect，避免 ABBA。失效 job 清退走同一锁序下的 branded `WorkspaceRevocationProof`：coordinator 先校验 target 属于当前 Workspace和冻结 binding，Authority再在锁内重做 realpath/重读记录并证明 root-drift、stale-epoch或 untrusted；exact trusted与 chosen-target拒绝。Queue 的 `fenceRevoked(jobId, expectedState, proof)` 才能消费，并在 partition lock 内重读 job，逐字段校验完整 target和 active lease/fencing state 后只做单调 `pending|leased -> fenced`。跨目标重放/错配拒绝；Projection commit、success ack和其他写 API不接受该 proof，也不允许任意 callback effect。无法 materialize handler且无法证明时进入有界持久退避/隔离，不热循环。
- Authority entry 从 attach 到最后 handle dispose 强制 watch canonical record；WP1 需扩展 change/error/close handle，并在订阅 healthy 时也按可注入时钟 ≤2 秒周期进入 mutex + record lock重读，防止 watcher 静默漏事件。watch error/close、周期 reconcile超时或读失败原子置 `degraded`、投影 untrusted并广播；重订阅首次锁内 reconcile 前仍不健康。`WorkspaceMcpConfigService` 使用 package-private `getGuardedProjectAccess()`（或等价结构），同时取得 guarded snapshot、冻结 canonicalRoot 与 `validateAfterRead()`；loader/watch/project stdio cwd全链使用该 root并读后复验。Trust revoke另走专用高优先级可取消通道，不等待当前 `ready/connectAll`或普通 serialized mutation tail；先将 project-origin MCP从可调用 registry撤下并取消/隔离 pending connect，后台清理可晚到。普通 Memory `getSnapshot/permit` 的最终授权仍不依赖 watch。
- 新增 App `IProfileMemoryShutdown.drain()`（或等价窄接口）：幂等阻止新 permit/Store 操作、等待 in-flight commits/Worker、await writer lease release。当前同步 Scope dispose 不等待 Ledger Promise；`packages/kap-server/src/start.ts`、`packages/acp-server/src/start.ts`、node-sdk v2 client、CLI v2 print、agent-core-v2 harness 及 Contract Freeze 时发现的其他 bootstrap owners 必须在 dispose 前显式 await drain，Feature 未启用时 no-op。
- App 后台 claim 根据可信 Queue Record 的 `jobId + workspaceId + rootBindingId + workspaceTrustEpoch` 经 `IWorkspaceLifecycleService.handlerFor({ workspaceId })` 取得 Workspace handle，再解析 coordinator并比较当前 binding；Workspace 缺失且无法证明 job 已失效时持久退避，binding/epoch 失效时只能经 `handler.accessor -> coordinator.proveRevoked(target) -> facade/Authority` 为完整 `WorkspaceRevocationTarget` 取得 proof，再由 Queue `fenceRevoked()` 锁内重读并清退，可信 permit 可达时才运行普通业务 mutation。App Worker 不直接注入 Workspace Trust。
- 未解析到可信主体时返回 `memory.owner_unavailable`，绝不回退为 runtime Agent ID、默认 owner 或空 Workspace。

### 2. Evidence Store

WP2 必须给出领域专用契约及 Contract Suite。最低语义：

```ts
export interface EvidenceAppendInput {
  readonly schemaVersion: 1;
  readonly stream: MemoryStreamKey;
  readonly expectedOwnerEpoch: number;
  readonly expectedRootBindingId: string;
  readonly expectedWorkspaceTrustEpoch: number;
  readonly events: readonly NewEvidenceEvent[];
}

export interface EvidenceAppendReceipt {
  readonly outcomes: readonly EvidenceAppendOutcome[];
  readonly durableThroughPosition: string;
  readonly flushed: true;
}
```

每个 `NewEvidenceEvent` 有独立 `clientEventId` 和 `idempotencyKey`。每个 outcome 明确为 accepted、duplicate 或 rejected，并在 accepted/duplicate 时返回稳定 event ID 和 opaque position。

必须定义：

- append 返回前哪些字节已经耐久；进程此刻退出后如何证明事件仍存在。
- ambiguous append 如何重开和去重，不靠猜测“可能成功”。
- batch 部分失败时，`durableThroughPosition` 只描述 L0 的耐久水位，不冒充 Capture 来源 cursor；outcome 必须足够让 WP5 判断连续来源前缀，不能跨过可重试洞。
- 读取区间统一使用 `(fromPositionExclusive, toPositionInclusive]`。
- writer identity、schema version、recordedAt、digest、causation/correlation、origin、redaction 和 `derivedFromMemoryRefs`。
- 破损尾行、截断、磁盘满、权限错误和错误 key 的处理。

### 3. 耐久 Projection Queue

最少三个记录：

- Queue Record：job ID、partition、source interval、owner epoch、root binding ID、workspace trust epoch、attempt、notBefore、payload digest、schema/prompt/model version。
- Partition Head：连续已完成 position、active lease、单调 next fencing token、last error 和 DLQ 水位。
- Lease Record：leaseId、claimant、expiresAt、fencingToken；每次重新 claim 都递增 token，旧 token 永久失效。

最少操作：`enqueue`、`claim`、`renew`、`ack`、`nack`、`moveToDlq`、`listRecoverable`、`drain`。启动时以耐久记录扫描恢复，不能依赖一次 `memory.evidence.appended` 事件仍在内存里。

首版即校验 fencing，不因 MVP 单进程而省略。Projection Command 携带 `leaseId`、`fencingToken`、`rootBindingId` 和 `workspaceTrustEpoch`；Repository commit 与 Queue ack 都校验当前 active lease、token、owner epoch、root binding ID 和 trust epoch。Lease 到期重领后，旧 Worker 即使先完成也不得提交。

### 4. Capture 数据权威

Capture 需冻结以下映射：

| 信号 | 读取来源 | 规则 |
| --- | --- | --- |
| `turn.started` | event prompt + origin | 只记录允许展示的 User/Slash origin；系统触发文本不泄漏 |
| `turn.ended` | event status + durable Context/Wire view | 读取最终折叠 Assistant 结果；不从 delta 拼接 |
| `tool.call.started/result` | bounded correlation 或 executor hook | 精确工具白名单、大小上限、脱敏后再 Blob offload |
| `subagent.completed/failed` | event + trusted spawn/session metadata | summary 是数据，不允许自报 owner/source |
| Proposal/Feedback | 领域命令 | 先写 L0，再由 Worker 评估 |

Capture 还必须定义独立于 L0 position 的持久来源 checkpoint：

```ts
export interface CaptureCheckpoint {
  readonly sourceStreamId: string;
  readonly sourceEpoch: string;
  readonly sourceCursor: string;
  readonly lastClientEventId?: string;
  readonly durableThroughPosition: string;
}
```

只有 source cursor 连续前缀对应的事件全部 accepted/duplicate，才推进 checkpoint；retryable 洞不跨越。永久过滤必须在 append 前确定性完成，或写成可审计的终态 outcome。还必须明确 abort、undo、retry、compaction、attach race 和重复完成事件的行为。Capture 只做确定性转换，不调用 LLM。

### 5. Search Store 与 Snapshot

`IProfileMemorySearchStore` 至少支持先授权过滤、再产生候选，结果包含稳定 ID 和可解释 score。不允许先从所有 owner 搜索再只在展示层过滤。

对外只使用 opaque `snapshotToken`。内部 token 至少绑定：

- subject/owner epoch；
- workspace projection generation；
- L0 watermark 与 search checkpoint；
- 创建/过期时间；
- 缓存结果 digest。

若 MVP 没有 MVCC，`snapshotToken` 只允许复用已钉住的结果集，不能接受任意历史时间点查询。

### 6. Worker LLM

`IProfileMemoryWorkerLLM` 必须：

- 在 App Scope 通过显式 model alias 取得 requester；
- 没有 Shell、文件、网络或 Agent 工具；
- 只接受有界结构化输入并强制结构化输出 Schema；
- 固定 timeout、max input/output token、并发和重试预算；
- 记录 schema/prompt/model version、usage、latency 和 input/output digest；
- 测试使用确定性 fake；
- 缺少模型配置时暂停 Projection，而不是回退到当前 Agent 模型。

### 7. 协议 Schema

WP0 要为 MVP 被引用类型提供严格 Zod Schema，不能只留下 TypeScript 名称。至少闭合：

- `MemorySubject` / `MemoryInvocationContext`，以及 `{rootBindingId, workspaceTrustEpoch}` fence；
- L0 Evidence Event 与 Append Receipt；
- Atom、Conflict 的持久模型和只读 View；
- Recall、ReadEvidence、Propose、Feedback 请求/响应；
- Projection Command/Result；
- Queue、Checkpoint、Snapshot Token payload；
- Domain Event envelope；
- owner epoch、tombstone 和 deletion state 的最小持久字段；完整 Deletion command/receipt 移到治理工作包；
- 领域错误到 edge error envelope 的映射表。

Scenario 和 Self Model 的完整持久 Schema、View 与 Prompt output 属于 WP10C，不在 WP0 冻结；WP0 只保留独立 schema/prompt version namespace，不能为尚未消费的 L2/L3 提前固化字段。完整删除编排也不在 MVP，但 L0/Atom/Queue key 必须从首版携带 `ownerEpoch`、`rootBindingId` 和 tombstone state，避免以后无法 fence 旧任务或隔离 retarget 前后的数据。

统一限制：

| 字段 | 必须定义的限制 |
| --- | --- |
| ID | 字符集、最大长度、是否 opaque；不得用路径片段直接落盘 |
| 时间 | ISO 8601 UTC 或单调内部时间，明确发生时间与记录时间 |
| confidence/priority | 有限数值范围，拒绝 NaN/Infinity |
| query/summary/note | 字符和 UTF-8 byte 上限 |
| evidence refs | 单项和批量最大数量 |
| limit/budget | 服务端 min/max，不能信任调用方预算 |
| pagination | opaque page token，绑定 subject、filter、query、snapshot 和 expiry |
| unknown fields | 写入/Projection strict；兼容读 View 可只增加 optional 字段 |
| errors | `retryable`、可选有界 `retryAfterMs`、脱敏 details；无 stack/raw backend body |

Evidence Read 返回 `unavailableRefs`，不区分“不存在”和“无权访问”，避免 ID 枚举。它必须绑定 Recall 的 `snapshotToken` 或短期 evidence grant，并对每条记录重新授权。

## 工作包与依赖

```text
WP0 Contract / ADR freeze
  └─ WP1 Feature skeleton + subject binding Wire/config/flag/App trust authority + Workspace facade/coordinator
       ├─ WP2 Durable Evidence Store
       ├─ WP3 Worker SPI + Durable Queue
       └─ WP4 Feature runtime gating / operator boundary
            │
WP2 ────────┴─ WP5 Capture + checkpoint + recovery
WP2 + WP3 ──── WP6 L1 projection + Evidence Gate
WP2 + WP6 ──── WP7 Lexical Search + manual Recall
WP4 + WP6 + WP7 ─ WP8 Agent tools + contributions + coder allowlist
WP5 + WP7 + WP8 ─ WP9 Auto Recall

稳定核心之后：
WP10A Klient IPC/memory contract
WP10B KAP REST operator surface
WP10C L2 Scenario，再做 L3 Self Model
WP10D TencentDB v3 mirror/outbox
后续：向量/RRF、WS、Inspect UI、跨 Workspace/global
```

### 并行规则

- WP0、WP1 由同一个 Contract Owner 串行完成。
- WP1 合入后，WP2、WP3、WP4 可以并行，但公共类型只由 Contract Owner 修改；其他 Agent 提交变更请求而不是另建重复类型。
- WP5–WP9 严格按依赖开始，不能用 mock 掩盖尚未冻结的耐久语义后直接合入生产路径。
- 每个 Agent 只编辑自己的 ownership path；根导出、Feature 注册、公共错误码和 manifest 由 Integration Owner 统一处理。
- 一个工作包必须先通过自己的 Contract/Scope/Failure 测试，才允许下游 Agent 依赖。

### 文件 Ownership

WP1 完成时，Contract Owner 必须把真实文件名替换进下表并随 handoff 冻结；在此之前 WP2–WP4 不开始。默认 ownership 如下：

| Owner | 独占路径/文件 | 不得修改 |
| --- | --- | --- |
| Contract Owner（WP0/WP1，同时是首轮 Integration Owner） | `features/profileMemory/types.ts`、`schemas.ts`、`errors.ts`、`profileMemory.ts`、`profileMemoryFeature.ts`、`identity/contract/**`、`identity/resolver/**`、`workspaceCoordinator/**`、`writerLease/**`、`shutdown/**`、`configSection.ts`、`flag.ts`、契约测试；现有 `agent/profile/profile.ts`、`profileOps.ts`、`profileService.ts`、`session/agentLifecycle/agentLifecycleService.ts` 及 `test/agent/profile/binding.test.ts`、`apply-profile.test.ts`、`profileOps.test.ts`、`test/session/agentLifecycle/agentLifecycle.test.ts`、Wire manifest/compat tests；基础 Trust Domain 的 `app/workspaceTrustAuthority/**`、`app/workspaceLifecycle/workspaceLifecycleService.ts`、`workspace/workspaceTrust/workspaceTrust.ts`、`workspaceTrustService.ts`；`workspace/workspaceMcpConfig/workspaceMcpConfigService.ts`、`workspace/workspaceMcpConfig/internal/config-loader.ts`；persistence 的 durable-replace/exclusive-key-lock/watch interface、node-fs/in-memory backend和对应测试；`test/app/workspaceTrustAuthority/**`、`test/workspace/workspaceTrust/workspaceTrust.test.ts`、`test/workspace/workspaceResources.test.ts`、`test/workspace/workspaceMcp/initialization.test.ts`、`test/workspace/workspaceMcpConfig/workspaceMcpConfig.test.ts`、`test/app/workspaceLifecycle/workspaceLifecycle.test.ts`；v2 composition roots `packages/kap-server/src/start.ts`、`packages/acp-server/src/start.ts`、`packages/node-sdk/src/sdk-rpc-client-v2.ts`、`apps/kimi-code/src/cli/v2/run-v2-print.ts`、`packages/agent-core-v2/test/harness/agent.ts` 及精确测试 `packages/kap-server/test/boot.test.ts`、`packages/acp-server/test/close.test.ts`、`packages/node-sdk/test/sdk-rpc-client-v2.test.ts`、`apps/kimi-code/test/cli/run-v2-print.test.ts`、`v2-run-print.test.ts`、`packages/agent-core-v2/test/harness/profileMemoryShutdown.test.ts`；`packages/kap-server/src/routes/workspaces.ts` 与 `packages/kap-server/test/workspaces.test.ts` 的 trust 接线/回归改动。Authority/facade/watch/MCP guarded path 必须静态 scoped 注册，禁止放入 `ProfileMemoryFeature` 的可 retract book。CLI v2 print 是既存 native-v2 composition-root 例外：只允许沿用它已有的 core-v2 import/Accessor resolve并 await shutdown，不新增其他 direct-core依赖 | Evidence/Queue backend、builtin profile allowlist、无关 KAP routes |
| WP2 | `features/profileMemory/identity/installationPrincipalStore/**`、`features/profileMemory/evidence/**` 及对应 Store/contract tests | 公共 schema/error、identity resolver、Feature root、queue、tools |
| WP3 | `features/profileMemory/projection/workerLlm*`、`projection/queue/**`、Queue/Worker contract tests | Evidence backend、公共 schema/error、tools |
| WP4 | `features/profileMemory/runtimeGate/**`、Feature gate/operator-boundary tests | `profileMemoryFeature.ts`、builtin coder allowlist、工具业务、公共 schema |
| Integration Owner | `packages/agent-core-v2/src/index.ts`、builtin `profiles.ts`、Feature 注册、基础 Trust静态 scoped registration、manifest 产物、跨 WP 装配、本文状态更新 | 不替各 WP 重写领域实现；不把 Trust Authority/facade/watch/MCP guarded path注册进可 retract Feature |

WP1 负责通用 persistence 层的 exclusive-key-lock primitive、Trust key/root-binding codec 与 `FileStorageService.write()/writeStream()` 的“每次 parent-directory fsync” durable replacement，因为 Trust 在 WP2 之前就必须安全使用它；这些能力不得做成 Trust 业务代码中的 `node:fs` 特例。WP2 的唯一 key codec 仅指 Profile Memory 数据空间，不得再定义 Trust key。WP1 同时实现 Profile Memory home writer lease 的懒获取/生命周期骨架、带 `watchHealth` 的强制跨进程 Trust watch/reconcile、固定 canonical root 的 MCP guarded reload 和 App shutdown drain/composition-root 接线。Trust Authority、Workspace facade、watch/reconcile 与 MCP guarded path走基础域静态 scoped registration，始终存在且不由 `ProfileMemoryFeature` book 拥有；Feature disabled/retract不得 dispose它们。WP2 消费同一个 lease，负责安装主体 Store 的真实 create-if-absent、权限和重开复用，以及 Evidence backend。WP0/WP1 只拥有 `identity/contract/**`、`identity/resolver/**` 与 fake；WP2 独占 `identity/installationPrincipalStore/**` 的真实 backend。WP1 在 Feature root 预留明确 extension seam；WP4 只实现独占的 runtime gate 模块，Integration Owner 串行接入 `profileMemoryFeature.ts`。WP4 不提前把尚不存在的工具名加入 builtin `coder` allowlist；该单文件修改由 Integration Owner 在 WP8 工具真实贡献完成时一次接入。

WP1 还独占 `features/profileMemory/workspaceCoordinator/**`、`writerLease/**`、新的 App Trust Authority、Workspace Trust facade 及上表列出的 persistence/test 文件。App Authority 是 `trusted + rootBindingId + epoch + watchHealth` 的唯一持久/运行权威；其 entry 按 canonical trust-record key 共享进程内 mutex/snapshot/event，每个 mutation/commit 另持对应跨进程 record lock。Coordinator 是 Workspace-scope permit/cancel/cache/revocation adapter，明确提供 `proveRevoked(target)` 并委托 facade/Authority；签发 permit前验证 writer lease与 target Workspace/binding，Authority再锁内判定合法 reason，不能声明第二个 epoch store。WP1 负责 target/proof brand、Authority/facade/coordinator delegation，以及 `A.proveRevoked(targetB)`、binding错配、exact trusted拒绝和三种合法 reason 的 deterministic tests。现有 KAP route 必须继续只经 `IWorkspaceTrust.trust()/untrust()` facade 变更，不得直接写文档；Contract Owner 负责回归测试。WP3 的 App 后台只消费 coordinator permit/revocation契约，不能反向修改它或直接注入 Workspace facade；WP3 负责 Queue `fenceRevoked()` 唯一消费、partition-lock匹配、重放与 interleaving tests。WP2 不拥有独立 trust epoch/锁 backend，但必须复用 WP1 的 home writer lease；Trust v2 记录使用 WP1 新增/修正的全耐久 replacement，不能沿用当前 `syncDirOnce()` 行为。

上表只冻结第一波 WP2–WP4。每一波后续工作开始前，Integration Owner 必须把所有 ready 工作包的真实文件列表、公共接线 owner 和测试路径追加到 handoff 任务表并计算新契约 digest；路径未冻结的 WP 不得派发。特别是 WP5 Capture checkpoint 与 WP6 Repository/projection 不能同时拥有同一文件，公共 Repository 接线始终由 Integration Owner 串行处理。

### 工作包交付与验收

| WP | 主要交付 | 最低验收 |
| --- | --- | --- |
| WP0 | ADR、类型/Zod、错误码、状态机、key/interval/snapshot 语义 | 所有引用类型可编译；正反 Schema fixture；无未决 P0 问题 |
| WP1 | `ProfileMemoryFeature`、config/flag、MemorySubject resolver 契约/fake、Profile source Wire、realpath+hashed App Trust authority + Workspace facade、root binding fence、带 health 的 cross-process watch/MCP reconcile、全耐久 replacement/exclusive-key lock、懒获取的 home writer lease、App shutdown drain、Workspace coordinator与 branded revocation-proof contract | Disabled 不申请 Memory lease/无副作用；开关真值表；单次 inspection bind；alias 串行与 symlink retarget fail closed；第二 Memory writer fail closed但 Trust 可用；watch degraded 时 MCP 不重开；跨进程 untrust 有界卸载 MCP；proof 不能进入投影/成功 ack；trust ABA/失败原子性/掉电重开；所有生产 root close await lease；KAP 无旁路 |
| WP2 | Evidence Store、安装主体 backend、key codec、复用 home writer lease、Blob policy、contract tests | durableThroughPosition；append/flush/kill/reopen；corrupt tail/disk error |
| WP3 | Worker LLM SPI、Queue/lease/fencing/retry/DLQ、startup recovery、`fenceRevoked()` proof consumer | 单进程重领也拒绝旧 token；只允许 proof 驱动 `pending|leased -> fenced`，投影/成功 ack 类型拒绝 proof；崩溃恢复、超时、无模型 degraded；无 Agent 工具权限 |
| WP4 | Feature runtime contribution、disabled gate、operator inspect boundary | Feature 始终组装但 disabled 无副作用；其他 Profile 不泄漏；不提前接 coder allowlist |
| WP5 | Turn/Tool/Subagent Capture、redaction、source checkpoint/replay | source cursor/L0 position 分离；attach race、append/checkpoint crash、undo/cancel、recapture loop |
| WP6 | L1 Extractor、Evidence Gate、Atom/Conflict 状态机、projection generation | 无证据不晋升；冲突不覆盖；版本冲突重算；Prompt output strict validate |
| WP7 | Search Store、pre-filter、ranking/budget、manual Recall、snapshot cache | Workspace/owner 隔离发生在 rank 前；稳定排序；过期 token；索引重建 |
| WP8 | Recall/ReadEvidence/Propose/Feedback 工具、真实 contributions、coder exact allowlist | 工具无身份参数；Evidence grant；限流/预算/错误映射；反馈只形成 Evidence |
| WP9 | new-turn query bridge、Context injection、timeout/cancel/compaction | 每 Turn 最多一次；晚结果丢弃；不改 system prompt；注入不被再捕获 |
| WP10A | Klient tuple contract、facade、memory+IPC conformance | 两 transport 行为等价，非法 payload 在边界拒绝 |
| WP10B | 显式 KAP routes、鉴权/授权、数值错误码、REST contract tests | shared bearer 不冒充用户主体；无栈/正文泄漏；枚举与 timing 测试 |
| WP10C | L2/L3 投影与恢复 | 多任务门槛、反证、最后良好 generation、可解释证据链 |
| WP10D | v3 mapping/provision、Outbox、reconcile、delete receipt、SSRF/TLS guard | 双写分叉可恢复；跨 team 注入测试；无 `/v2` 降级 |

## 删除与恢复预留

即使完整删除放在后续，首版持久模型也必须带 `ownerEpoch` 和 deletion state，避免以后无法安全迁移。建议状态：

```text
active
  -> delete_requested
  -> fenced
  -> erasing
  -> completed | partial | failed | blocked_by_hold
```

顺序：先写 tombstone 并递增/fence epoch，再拒绝旧 Worker/Outbox 命令，然后清理 L0、Blob、投影、索引、缓存、Queue/DLQ、外部镜像，最后返回异步 receipt。备份无法即时物理擦除时，要记录 `residualUntil`；恢复流程必须重放 tombstone，不能让旧备份复活 owner。

Workspace unregister 不是 Memory erase。Profile rename/source switch 也不是隐式数据迁移。

## 必测威胁与故障矩阵

| 类别 | 必测场景 | 期望 |
| --- | --- | --- |
| 身份 | 工具参数伪造 owner/workspace/session | Schema 中无字段或边界拒绝 |
| Profile | 同名 builtin/user/workspace Profile | 不共享；来源切换显式迁移 |
| Trust | 未信任 Workspace，或执行中从 trusted 切到 untrusted | 所有记忆读写 fail closed；队列 fenced；缓存/注入撤回 |
| Trust keyed authority | 原路径、dot-segment、symlink target、Windows alias 指向同一真实目录；另测 hardlink/bind mount 非保证边界 | realpath+platform normalization 后共享 canonical-key snapshot/mutex/event；持久 key 不含路径且不能逃逸 namespace；解析失败 fail closed |
| Root binding drift | `link -> A` trust/acquire permit 后 retarget 到 B、悬空、A/B 快速切换、project MCP 读取中切换 | 旧 permit/read/commit/ack 失败；B 配置和数据不被读取；A 的 Evidence/Queue/Snapshot 不进入 B；只有显式 materialize + trust 产生新 binding |
| Trust durability | epoch/file fsync/rename/parent-dir fsync 任一点失败；untrust 返回后立即 hard-kill/reopen；旧 marker 迁移 | 失败不改 snapshot/不发事件；返回成功后重启 epoch 不回退；迁移只有一个 canonical v2 权威 |
| Trust cross-process lock | 两个进程、同一 canonicalRoot/不同 alias 同时 trust/untrust/commit | canonical record lock 内重读；epoch 不丢失；操作可串行完成，不依赖另一进程事件 |
| Trust cross-process revoke | 进程 B 已加载 project MCP，进程 A untrust；watch 乱序/重复/关闭/静默漏事件；error 后记录仍 true；重订阅尚未 reconcile；project `connectAll()` promise永不完成且普通 apply tail堆积 | B 即使完全没有 change/error/close 事件也由周期锁内 reconcile发现；撤销不排在卡住的 tail 后，立即 deny new use、取消/隔离 connect并从 registry撤下，端到端在 2 秒测试上界内完成；degraded/starting期间 guarded access始终拒绝，首次 reconcile完成且记录仍 true后才恢复；Memory操作仍独立复验 |
| Memory writer lease | Feature disabled；两个进程对同一 home 首次启用 Memory；持锁进程事件循环暂停超过任意 stale 时长；持锁进程 hard-kill 后接管 | disabled 不创建 lease/Store；恰好一个 Memory writer；活着 owner 不被超时接管；死亡 owner 可恢复；第二个 Memory mutation/permit fail closed但 Trust route 可用；安全释放后才允许新 writer |
| Shutdown drain | 人为延迟 in-flight commit/lease release 后调用 KAP/ACP/SDK/CLI/harness close | close 在 drain 完成前不 resolve；不再签发 permit；release 后第二 App 才可接管；disabled drain 无副作用 |
| Lock order / revocation | untrust 与 queue claim/renew/ack/nack、projection commit 交错；untrusted、binding drift、handler missing；A coordinator请求 targetB、exact trusted target、把 A proof 重放给 B，或尝试传给 projection/success ack | 签发端拒绝跨 Workspace/binding chosen-target与 exact trusted，只为三种合法 reason签发；无 ABBA/超时；Queue 锁内重读并校验 proof target + active lease/fencing state后才单调 fence；跨 job/workspace/binding/epoch 重放拒绝；负向类型/contract test 证明 projection与成功 ack拒绝 proof；无法证明时持久退避且不热循环；retrust 不复活旧 job |
| 租户 | 外部搜索返回其他 principal/team ID | post-filter 再授权，结果丢弃并审计 |
| 枚举 | 猜 evidence ID、比较 denied/not-found/timing | 统一 `unavailableRefs` 与有界时间差 |
| Prompt | XML/JSON 闭合标签、Unicode 控制符、永久人格指令 | 转义并只作为数据，不改变指令优先级 |
| 自增强 | Recall 内容被 Capture 再记忆 | provenance 识别并排除独立证据 |
| Secret | Tool output 中 token 进入 L0/Blob/log/trace/DLQ | 写前脱敏；日志只含 ID/length/digest |
| 并发 | 两进程指向同一单 writer store | 第二个 writer fail closed |
| Trust ABA | trusted → untrusted → trusted、重启后旧 Worker 提交 | 持久 trust epoch 不匹配，commit/ack 拒绝 |
| Queue | lease 过期重领后旧 Worker 晚提交 | 首版单调 fencing token 拒绝旧 lease |
| Checkpoint | batch 中间可重试失败 | source cursor 不跨洞；L0 position 单独记录 |
| 崩溃 | append 成功/checkpoint 前退出 | 重扫后 duplicate，不丢失 |
| 原子性 | read model 更新成功/checkpoint 失败及反向 | 重放幂等，最终收敛 |
| 存储 | torn write、尾行损坏、磁盘满 | 明确 degraded/fail 写，不假成功 |
| 外部 | TencentDB 成功/Outbox 本地状态失败及反向 | reconciliation 找到并修复 |
| 删除 | 删除期间 Worker、DLQ、备份尝试重建 | epoch/tombstone 拒绝复活 |
| 生命周期 | owner 删除后同名重建 | 新 epoch 不消费旧任务和 token |
| 合规 | legal hold 与删除冲突 | receipt 为 blocked，披露原因和残留范围 |
| 配置 | 外部 base URL 指向 metadata/localhost、TLS 关闭 | allowlist/URL parser/HTTPS policy 拒绝 |

## 实现可并行的完成条件

只有满足以下全部条件，协调 Agent 才能宣布“Contract Freeze 完成”：

- `MemorySubject`、Evidence、Queue、Projection、Recall、Snapshot 和 Error 都有唯一类型与 Zod Schema。
- 所有 ID、范围、分页、预算、区间端点和 retry 语义已写明。
- MVP 单 writer、local authority、builtin coder only、workspace only 已编码为默认关闭策略。
- 事件触发与耐久数据权威的边界有测试方案。
- Agent 工具的身份字段完全由运行时绑定。
- Workspace Trust 的 bool/root-binding/epoch/commit mutex 有且只有一个 realpath+hashed App keyed mutation authority；alias/process 通过 canonical record lock 串行，symlink retarget 会 fence 旧 binding；watch health/MCP guarded revoke、每次 parent-dir fsync 已通过故障测试；Profile Memory home writer lease 懒获取、所有生产入口的 shutdown drain 真正 await release，且不影响现有 KAP trust route。
- 根导出、Feature 注册、config manifest 和 flag ID 的 ownership 已指定。
- WP2、WP3、WP4 的允许修改路径互不冲突。
- 当前 ready wave 的所有工作包都有精确文件 ownership、公共接线 owner 和测试路径；后续 wave 必须重新冻结，不能沿用占位模板。
- 不存在用 `TODO: decide` 隐藏的 P0 数据边界问题。

满足这些条件后，才把 [多 Agent 实施提示词](./09-implementation-agent-prompt.md) 中对应工作包分发给其他 Agent。
