# 多 Agent 实施提示词

本文提供可以直接复制给其他编码 Agent 的任务说明。它不是 Memory Worker 的运行时 Prompt；运行时提炼 Prompt 在 [07-worker-prompts.md](./07-worker-prompts.md)。

正确用法是：先让一个 Contract Owner 完成 WP0/WP1，再根据 [08 的依赖图](./08-implementation-readiness-review.md#工作包与依赖) 分发后续工作包。不要在第一次执行时同时派发 WP2–WP9。

## 首轮推荐提示词：WP0 + WP1

把下面整段交给一个负责公共契约的编码 Agent。该 Agent 同时担任首轮 Integration Owner，串行拥有公共接线；它是当前最合适的第一项任务。

```text
你在 Kimi Code monorepo 中负责 Agent Profile Memory 的 WP0（契约冻结）和 WP1（Feature 骨架），并同时担任首轮 Integration Owner。公共 exports、Feature root、Profile binding Wire 和 manifest 只由你串行修改。本轮不要实现完整存储、Worker、Capture、Recall、REST、WS 或 TencentDB。

工作目录：仓库根目录（下文记为 `<repo-root>`；不要硬编码某台机器的绝对路径）

开始前必须完整阅读：
1. 根 AGENTS.md。
2. docs/AGENTS.md（本轮 Contract/Integration Owner 会更新 08 状态）。
3. packages/agent-core-v2/AGENTS.md。
4. packages/kap-server/AGENTS.md（只因本轮要验证现有 Workspace Trust route 无旁路）。
5. apps/kimi-code/AGENTS.md（本轮会接入 CLI composition root）。
6. .agents/skills/agent-core-dev/SKILL.md 及它为本任务要求的 references。
7. docs/agent-profile-memory/README.md。
8. docs/agent-profile-memory/03-v2-implementation.md。
9. docs/agent-profile-memory/04-integration-protocol.md。
10. docs/agent-profile-memory/02-memory-model-and-pipeline.md。
11. docs/agent-profile-memory/05-features-and-roadmap.md。
12. docs/agent-profile-memory/06-security-reliability-and-testing.md。
13. docs/agent-profile-memory/07-worker-prompts.md（只用于冻结 Prompt/Schema/Model version 契约，不实现 L2/L3）。
14. docs/agent-profile-memory/08-implementation-readiness-review.md；它是 MVP 决策和工作包的最高优先级来源。

修改任何上述清单外的路径前，也必须先读取该路径最近的 AGENTS.md；没有局部文件时才沿用根规则。

目标：让 WP2、WP3、WP4 可以在不重复发明公共类型的情况下并行开发。

必须交付：
- 在 packages/agent-core-v2/src/features/profileMemory/ 建立自包含 Feature 骨架，参考 src/features/plan/；只有 Profile Memory coordinator、writer lease/repository、Agent Service、工具、Capture/Worker和注入走 Feature seam。基础 Trust Authority、Workspace Trust facade、cross-process watch/reconcile 与 MCP guarded path必须静态 scoped注册、始终存在，不得放进可 retract 的 `ProfileMemoryFeature` book。
- 静态注册 profileMemory config section；注册实验 Flag ID `profile_memory`，默认关闭。Feature 始终组装；每类入口固定计算 `operationEnabled = flags.enabled('profile_memory') && config.enabled && config.<operation>Enabled`，缺字段按 false。capture、projection、manual recall、auto recall 分别使用对应 operation gate，不通过动态 unprovide Feature 实现开关。Operator inspect 只可在不开 Store 的前提下报告 disabled 原因，不能绕过 gate。
- 冻结并实现唯一的 MVP 领域 types + strict Zod schemas：MemorySubject、InvocationContext、Evidence event/append receipt、Queue/Projection command、Atom/Conflict view、Recall/ReadEvidence/Propose/Feedback、Snapshot token payload、Domain event envelope、稳定错误码。工具 input schema 按仓库惯例 `.strict()`；内部可信 InvocationContext 是 DI/Scope 数据，不序列化进模型参数。Scenario/Self Model 完整 Schema 归 WP10C，WP0 只保留独立版本 namespace；删除只预留 ownerEpoch/tombstone state，不实现完整 command/receipt。只实现契约和必要纯函数，不实现完整业务服务。
- 错误码由 `features/profileMemory/errors.ts` 自注册 `ProfileMemoryErrors`，并由 `src/errors.ts` 聚合进 `ErrorCodes`；抛出 coded `Error2`，外来存储/模型错误在领域边界保留 cause 后翻译。`src/errors.ts` 的单文件修改由 Integration Owner应用。
- 定义 `IInstallationPrincipalStore` 契约和 fake，并实现 MemorySubject resolver 的 fail-closed 骨架。真实 create-if-absent、single-writer lock、fsync/权限归 WP2；现有 `IAtomicDocumentStore` 无 CAS，不得用普通 `get()` + `set()` 宣称“首次原子创建”。`principalId` 是随机 UUID，不从 home path、用户名、产品名、`clientIdentity` 或 bearer 派生。MVP 只允许来源为 builtin 的 `coder`，只允许 Workspace scope；同名 user/plugin/workspace/explicit Profile 不继承。builtin coder owner 映射固定为受保护常量 `{memoryOwnerId:'builtin:coder', ownerEpoch:0}`；普通 config/Profile/模型不能覆盖，删除治理落地前不递增，但所有首版 key/record仍携带 0。
- 冻结 `ResolvedAgentProfileBinding { profile, sourceId }`（或等价 branded 类型）。所有会改变持久 Profile identity 的 `bind()`、`useProfile()`、`applyProfile()`、`applyBindingSnapshot()`、fork、恢复和 refresh 都必须消费/保留该整体；初次按名称解析只做一次 `inspection = catalog.inspect(name)`，直接以同一次 inspection 的 `profile + sourceId` 完成 bind，禁止 `catalog.get()` + `inspect()` 双读取。generic `update()` / 新 `config.update` 写入必须从类型和运行边界禁止改变 `profileName`；旧 `config.update.profileName` 只允许历史 replay decode。`applyBindingSnapshot()` 的新调用必须 sourceId必填并与 profileName原子落同一 bind op，只有旧 replay payload可缺。你被明确授权修改现有 `agent/profile/profile.ts`、`profileOps.ts`、`profileService.ts`、`session/agentLifecycle/agentLifecycleService.ts`，以及 `test/agent/profile/binding.test.ts`、`apply-profile.test.ts`、`profileOps.test.ts`、`test/session/agentLifecycle/agentLifecycle.test.ts` 和 Wire tests。`ProfileData`/Wire decode 字段为历史兼容可选，但所有新 bind/fork 在 Service 边界必填；恢复后的 `resolveActiveProfile/refreshSystemPrompt` 只能验证持久 source-addressed binding，Catalog 无法证明同一来源时关闭 refresh与 Memory，绝不按当前同名 winner fallback。旧记录缺来源时只关闭 Memory、不阻断 Session 回放，也不在本包自动迁移。
- 将 Trust Domain 拆成 App-scope `IWorkspaceTrustAuthority` 与现有 Workspace-scope `IWorkspaceTrust` facade，并以基础域静态 scoped registration 组装；二者、watch/reconcile和 MCP guarded path不得由 `ProfileMemoryFeature` book拥有或随其 retract/dispose。Authority 必须先 `await IHostFileSystem.realpath(root)` 解析 symlink/dot segments，失败 fail closed；再以 `canonicalRoot = workspaceRootKey(realRoot)` 作为本进程等价类，用同一 digest 生成安全定长 `v2-<sha256>.json` 和 opaque `rootBindingId = rb-v1-<sha256>`，原始路径/canonicalRoot/workspaceId 不得直接作文件 key。原路径、dot segments、symlink 与现有 Windows alias 指向同一真实路径时共享 ready、snapshot、watchHealth、promise-chain mutex 和 change broadcaster；hardlink/bind mount/网络 inode 不在首版保证。handle 固定保存 `boundRoot + canonicalRoot + rootBindingId`，所有安全 API 在旧 record lock前重做 realpath；retarget/悬空立即 fail closed、abort并广播，绝不自动 attach新 target。facade 只持 ref-counted handle并转发旧 API与新增异步权威 API `getSnapshot()`、package-private `getGuardedProjectAccess()`、`validateCurrent({rootBindingId,epoch})`、`commitIfCurrent(fence,effect)`、`proveRevoked(target)`。`getGuardedProjectAccess()` 返回 guarded snapshot、冻结 canonicalRoot 与 `validateAfterRead()`；`target` 是 `jobId + workspaceId + rootBindingId + workspaceTrustEpoch`。Coordinator 先要求 target workspace/binding 等于当前 context/handle并验证 writer lease；Authority再在 mutex + record lock内重做 realpath/重读记录，仅为 root-drift、stale-epoch、untrusted三种条件签发不可由外部构造且绑定完整 target 的 branded `WorkspaceRevocationProof`。target/handle不匹配不能冒充 root-drift；exact trusted、记录损坏或 writer lease失效必须拒绝。`jobId` 仅作 opaque nonce，存在性由 WP3 Queue锁内验证。不存在接受任意 effect 的撤销 API。权威校验都必须取得 record lock并重读，不能实现成同步缓存检查；旧同步 `isTrusted()` 只为兼容，不是 Memory/MCP 安全门禁。禁止把 mutex/snapshot 留在 `WorkspaceTrustService` 实例内。明确授权新增/修改 `app/workspaceTrustAuthority/**`、必要的 `app/workspaceLifecycle/workspaceLifecycleService.ts`、`workspace/workspaceTrust/workspaceTrust.ts`、`workspaceTrustService.ts`、`workspace/workspaceMcpConfig/workspaceMcpConfigService.ts`、`workspace/workspaceMcpConfig/internal/config-loader.ts` 及这些精确测试路径：`test/app/workspaceTrustAuthority/**`、`test/workspace/workspaceTrust/workspaceTrust.test.ts`、`test/workspace/workspaceResources.test.ts`、`test/workspace/workspaceMcp/initialization.test.ts`、`test/workspace/workspaceMcpConfig/workspaceMcpConfig.test.ts`、`test/app/workspaceLifecycle/workspaceLifecycle.test.ts`。
- Authority 的新权威记录使用上述 canonical key 且内容保存同一 `canonicalRoot`；key/内容不一致视为损坏并 fail closed。无 v2 时，在 record lock 内枚举旧 scope、strict 解码 `{root,trustedAt}`，对 old.root 成功 realpath 并归一后与 canonicalRoot 比较，收集所有 alias；合法旧 marker 只表达 `{true,0}`，完全无合法记录才是 `{false,0}`。第一次 mutation 写 v2，MVP 不删旧 marker；v2 存在后永远忽略旧 marker。每个 mutation 进入 keyed mutex + canonical record lock 后重读最新记录。`untrust = 全耐久写 false,epoch+1 → shared snapshot/event`；`trust = 全耐久写 true,保留 epoch → snapshot/event`；`commitIfCurrent = 重读并复验 true+epoch → 持 record lock 到 effect 耐久完成`。Profile Memory permit 在调用前另验证 home writer lease。同 key 写失败时 snapshot/epoch/event 不变。
- Authority entry 从 attach 到最后 handle dispose 必须强制 watch canonical v2 record并维护 `watchHealth: starting|healthy|degraded|disposed` 与 subscription generation。扩展 persistence watch为可观察 change/error/close，但事件只加速；即使 healthy也用可注入时钟在 ≤2 秒固定上界内周期进入 keyed mutex + record lock重读，防止 watcher静默漏事件。watch error/close、周期 reconcile超时或读取失败原子置 degraded并撤销；新订阅首次锁内 reconcile前仍不健康。`WorkspaceMcpConfigService` 初始化/reload只能用 package-private `getGuardedProjectAccess()`（或等价结构）取得 guarded snapshot、冻结 canonicalRoot与 `validateAfterRead()`；loader、file watch和project-origin stdio default/relative cwd全链使用该 root并读后复验。撤销不得只 schedule到普通 serialized apply/connect tail：实现高优先级幂等 revocation lane，立即 deny new use、abort/隔离 pending project connect并从 registry卸载；底层不可取消时先原子撤下再后台清理，不等待 `ready/connectAll()`。测试必须覆盖“无 change/error/close但record已被另一进程修改 + connect promise卡住 + 普通 tail堆积”，从周期 reconcile到 deny/unload仍在2秒内完成。Memory最终授权仍以每次锁内复验为准。
- 在 persistence access-pattern/backend 层实现/复用 `IExclusiveKeyLockStore` 风格的跨进程锁，接口同时提供 `withLock(namespace,key,effect)` 与返回 owner-token lease 的 `acquire(namespace,key)`；lease 至少有异步 `validate()`/`release()` 和所有权丢失时 abort 的 `signal`。`withLock` 必须 try/finally release，争用/丢失所有权不能静默成功；活着且持 owner token 的进程不能仅因墙钟超时/事件循环暂停被接管，死亡 owner 才可经 PID/token 证明后恢复。Trust 业务域不得直接 import `node:fs`。Authority 的每次 mutation/validation/commit 都在进程内 keyed mutex 中取得 canonical record lock、重读 v2、完成操作后释放；这让多个进程的基础 Workspace Trust route 仍能串行工作。不能用当前 no-op `IAtomicDocumentStore.acquire()`，也不能假定未导出的依赖可直接 import。
- 另实现 App-scope `IProfileMemoryWriterLease` 与 `IProfileMemoryShutdown` 骨架：Flag/config 初始 disabled 时绝不申请 lease或打开 Store；首次 enabled 操作/permit 前按同一 home 的专用 key 懒获取。lease 提供 idempotent ensureHeld、never-acquire 的 validateHeld 和 loss signal。当前 Scope/DI dispose 会 fire-and-forget Ledger teardown，不能只靠 Service/Fiber effect；`shutdown.drain()` 必须幂等阻止新 permit/Store 操作、abort、等待 in-flight commits/Worker并 await release。作为 Integration Owner，审计所有 `bootstrap(`/`createAppScope(` owners，至少接入 `packages/kap-server/src/start.ts`、`packages/acp-server/src/start.ts`、`packages/node-sdk/src/sdk-rpc-client-v2.ts`、`apps/kimi-code/src/cli/v2/run-v2-print.ts`、`packages/agent-core-v2/test/harness/agent.ts`：先 await drain，再同步 dispose；disabled 时 no-op。`run-v2-print.ts` 是仓库中既存 native-v2 composition-root 例外：只允许沿用该文件已有的 core-v2 import/Accessor 取得并 await shutdown，不得把 direct core依赖扩散到其他 `apps/kimi-code` 代码；其余 CLI能力仍只能经 SDK。第二个进程获取失败时只让 Profile Memory mutation/permit fail closed，不得关闭或破坏基础 Workspace Trust。WP2 后续必须消费该 lease，不能另建锁。
- 修正通用 `FileStorageService.write()/writeStream()` 的全耐久 replacement：安全创建缺失 scope 目录并同步每个新目录 entry；每一次 rename 后都 parent-directory fsync，不能走 `syncDirOnce()`。`syncDirOnce()` 只保留在 append 文件首次创建等明确场景。in-memory backend 给出等价原子可见性/故障合同；Trust 不得另造专属 byte writer。你被授权修改对应 persistence interface、node-fs/in-memory backend 和现有 tests；必须覆盖第二次 replacement、嵌套新 scope、file fsync/rename/dir fsync 故障并跑全部 persistence 定向测试和包级测试。
- 实现 Workspace-scope `IWorkspaceProfileMemoryCoordinator` 骨架：它不另建 `IWorkspaceTrustEpochStore`。`acquirePermit()` 先在所有领域锁外确保/验证长期 home writer lease，再调用锁内重读的 `await getSnapshot()`，不能只信 shared/cached snapshot；生成包含 `workspaceId + rootBindingId + epoch + AbortSignal + async assertCurrent() + commit(effect)` 的 package-private branded permit。普通 read 取数前后 `await assertCurrent()`，最后一次锁内校验是 read 线性化点；AbortSignal 只负责加速取消。Coordinator 还必须公开内部方法 `proveRevoked(target: WorkspaceRevocationTarget)`：先校验 target.workspaceId等于当前 Workspace，再委托 facade/Authority；这是后续 App Worker 获得 proof 的唯一入口，不申请普通 permit、不接受任意 effect。全局锁序冻结为 writer lease validate → canonical-key in-process mutex → canonical record lock → Evidence/Projection/Queue partition lock → effect 前再次 validate；record-lock effect 禁止递归 Trust API或同时持第二个 record lock，持 domain/partition lock 禁止取 permit/调用 Trust/等待 lease。后续 Worker 必须短锁 peek并释放，再由 permit包住仍获授权的业务 mutation。对于 untrusted/root drift/旧 fence而拿不到 permit的 job，coordinator/Authority 只能在锁内返回精确绑定候选 `jobId + workspaceId + rootBindingId + workspaceTrustEpoch` 的 branded `WorkspaceRevocationProof`；WP3 Queue 的 `fenceRevoked(jobId, expectedState, proof)` 是唯一消费者，必须在 partition lock内重读 job，确认完整 target及 active lease/fencing state完全匹配后才允许 `pending|leased -> fenced`，跨目标重放/错配拒绝。Projection commit、success ack与其他写 API 的类型不接受该 proof，也不能通过任意 callback 绕过；handler missing且无法证明时持久退避，不热循环。coordinator 监听共享 Trust change做取消/cache 清理；App 后台经 `IWorkspaceLifecycleService.handlerFor()` 取 coordinator。检查 KAP route继续只调用 facade，绝不直接写 marker。
- `profileName` 仅是显示字段；主体包含 principalId、memoryOwnerId、ownerEpoch、profileSourceId、workspaceId、rootBindingId。身份字段绝不出现在模型工具输入 Schema 中。
- 冻结区间为 `(fromPositionExclusive, toPositionInclusive]`，所有持久 position 和 snapshot token 对调用者 opaque。Evidence receipt 的 `durableThroughPosition` 只表示 L0 水位；Capture source cursor 是 WP5 独立 checkpoint，禁止合并。
- Queue 首版即冻结 `leaseId + partition-monotonic fencingToken`；每次重新 claim 递增 token，Projection commit/ack 同时校验 active lease、token、owner epoch、root binding ID 和 workspace trust epoch，单进程也不例外。
- 定义 Evidence Store、Projection Queue、Search Store、Worker LLM 的接口；不要错误地把 IAppendLogStore、IAtomicDocumentStore、IQueryStore 当成已经满足领域语义。
- 为 2×2×2 operation gate 真值表、主体解析、`bind/useProfile/applyProfile/applyBindingSnapshot/fork/recovery/refresh` source 保持、direct `update({profileName})`拒绝与旧 `config.update` replay、旧 Wire 回放、Workspace binding+epoch/ABA/race、静态 alias 与动态 symlink retarget/悬空/A↔B、hardlink 非保证边界、two processes + same canonical record、并发 trust/untrust/retrust、旧 marker alias 迁移、durability fault、untrust hard-kill/reopen、watch duplicate/out-of-order/error/close/静默漏事件/reconcile 三阶段、卡死 connect/堆积 tail下的跨进程 MCP 有界卸载、disabled/第二 writer/owner pause/death/loss、KAP/ACP/SDK/CLI/harness drain、KAP route 无旁路、Schema 边界、工具无身份字段、错误映射写测试。WP1 只用 deterministic fake 验证 coordinator/permit/revocation proof 的锁序和“不持 partition lock 取 permit”；覆盖 `A.proveRevoked(targetB)`、binding错配、exact trusted拒绝和 root-drift/stale-epoch/untrusted三种合法签发，并用负向类型/contract test 证明 projection与 success ack不接受 proof。真实 queue claim/renew/ack/nack 与 untrust 交错属于 WP3，不越权实现 Queue。`ProfileMemoryFeature` 始终组装；Flag/config 不动态 unprovide，关闭时不得打开 Store、申请 lease、订阅 Capture、启动 Worker或注入上下文。
- 作为首轮 Integration Owner，更新精确 leaf export/import、Feature 注册与 config/wire/state manifest 相关接线，但不要创建任意 barrel；除 package index.ts 外遵守仓库 index.ts 规则。

冻结的 MVP 决策：
- builtin coder only；workspace only；local authority only；single local writer contract。
- 不支持 custom agent-file memory policy、global scope、vector、L2/L3、auto recall、公开 API、TencentDB。
- MemoryInspect 是 operator/debug 能力，不是模型工具。
- 召回内容以后统一作为 untrusted injection，不修改 Profile system prompt。

不可做：
- 不新增 KAP routes、v2 WS 或 Klient facade；只允许为现有 trust/untrust route 的新接口类型和无旁路语义做必要回归接线。
- 不把 bearer token 或 IAgentIdentity display name 当用户主体。
- 不用裸 profileName 作为全局存储 key。
- 不让任何请求从客户端传 owner/workspace/session/principal。
- 不在每次调用时重新 `catalog.inspect(profileName)` 推断已经绑定 Agent 的来源。
- 不实现安装主体或 Evidence 的真实文件 backend；这些归 WP2。
- 不宣称 IAppendLogStore.append 返回 durable offset；它返回 void。
- 不宣称 IAtomicDocumentStore 提供 CAS；它没有。
- 不把 `syncDirOnce()` 宣称为每次 replacement 的 parent-directory durability；Trust epoch 必须使用经测试的全耐久原语。
- 不把 same-root alias handler 的去重当作已有保证；Authority 必须按 canonical trust-record key 共享。
- 不修改不相关代码，不重写用户已有变更，不提交 .lh-harness/。
- 不创建 handoff.md、设计 mockup 或临时跟踪文件；临时内容放 .tmp/。
- 未经用户明确要求，不 commit、push 或开 PR。

实施方式：
1. 先做代码事实核验，并在回复中列出你确认的相关接口和路径。
2. 先提交一个简短 implementation plan，指出公共契约 ownership 和测试路径。
3. 从 types/schema/error 开始，再做 Feature/config/flag/subject resolver，最后接 exports/manifests。
4. 每个接口都写清不变量、失败语义和未来实现责任；不要留会改变安全边界的 TODO。
5. 发现文档与代码冲突时，以代码为事实，在 handoff 提交精确 change request；只有 Contract/Integration Owner 串行更新 08，普通并行工作包不编辑它。

最低验证：
- `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/features/profileMemory`
- `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/app/workspaceTrustAuthority test/app/workspaceLifecycle/workspaceLifecycle.test.ts`
- `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/workspace/workspaceTrust/workspaceTrust.test.ts`
- `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/workspace/workspaceResources.test.ts test/workspace/workspaceMcp/initialization.test.ts test/workspace/workspaceMcpConfig/workspaceMcpConfig.test.ts`
- `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/persistence/interface/storage.test.ts test/persistence/backends/node-fs/fileStorageService.test.ts test/persistence/backends/node-fs/atomicDocumentStore.test.ts`
- `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/agent/profile/binding.test.ts test/agent/profile/profileOps.test.ts test/wire/wireManifest.test.ts test/wire/wire-compat.test.ts`
- `pnpm --filter @moonshot-ai/kap-server exec vitest run test/workspaces.test.ts`
- `pnpm --filter @moonshot-ai/kap-server exec vitest run test/boot.test.ts`
- `pnpm --filter @moonshot-ai/acp-server exec vitest run test/close.test.ts`
- `pnpm --filter @moonshot-ai/kimi-code-sdk exec vitest run test/sdk-rpc-client-v2.test.ts`
- `pnpm --filter @moonshot-ai/kimi-code exec vitest run test/cli/run-v2-print.test.ts test/cli/v2-run-print.test.ts`
- `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/harness/profileMemoryShutdown.test.ts`（若现有 harness 测试布局要求合并进另一文件，必须在 implementation plan 先以唯一精确路径替换本命令）。
- `pnpm --filter @moonshot-ai/agent-core-v2 test`（Contract Freeze 前必须跑包级全量；若存在基线失败，给出不含本次变更时的复现证据）
- `pnpm --filter @moonshot-ai/agent-core-v2 run typecheck`
- `pnpm --filter @moonshot-ai/kap-server run typecheck`
- `pnpm --filter @moonshot-ai/acp-server run typecheck`
- `pnpm --filter @moonshot-ai/kimi-code-sdk run typecheck`
- `pnpm --filter @moonshot-ai/kimi-code run typecheck`
- `pnpm --filter @moonshot-ai/agent-core-v2 run lint:imports`
- 新增 config section 后运行 `pnpm --filter @moonshot-ai/agent-core-v2 gen:config-manifest`，检查产物，再运行同命令加 `--check`
- 若新增 Wire/State 注册，分别运行 `pnpm --filter @moonshot-ai/agent-core-v2 gen:wire-manifest` / `gen:state-manifest`，检查产物，再运行对应命令加 `--check`
- git diff --check
- git status --short，并明确区分你的改动和进入任务前已有的用户改动

最终交接必须包含：
- 实际完成的 WP0/WP1 条目与未完成条目。
- 起始 commit SHA、结束时 `git status --short` 和 `git diff --stat`；标明基线已有改动。
- 所有修改文件的路径和每个文件职责。
- 冻结后的公共接口清单与关键不变量。
- 运行的命令和结果。
- 下游 WP2/WP3/WP4 各自可以依赖什么，哪些仍禁止开始。
- 冻结契约文件清单、每文件 SHA-256、起始 commit SHA，以及 WP2/WP3/WP4 的真实 ownership 文件表。
- 风险、后续决策和已知限制。不要只给一两句总结。
```

## 总协调 Agent 提示词

当 WP0/WP1 已经通过审查后，再把下面提示词交给一个负责协调多 Agent 的实现者。使用前把尖括号变量替换为实际值。

```text
你是 Agent Profile Memory 项目的 Integration Owner，负责按已冻结契约协调多个编码 Agent，不负责让每个 Agent自由设计自己的协议。

仓库：<repo-root>
当前已完成工作包：<填写 WP 列表和 commit/diff 状态>
本轮目标工作包：<填写一个或多个依赖已满足的 WP>

权威材料按优先级：
1. 当前源码和最近的 AGENTS.md。
2. docs/agent-profile-memory/08-implementation-readiness-review.md。
3. 已合入的 WP0 schemas/interfaces/errors。
4. docs/agent-profile-memory/03-v2-implementation.md、04-integration-protocol.md、06-security-reliability-and-testing.md。

总规则：
- 使用 agent-core-dev skill，严格遵守 DI × Scope、Feature seam、边缘分层和验证规则。
- 在派工前先核验依赖；WP0/WP1 未完成时不得启动 WP2 以后生产实现。
- 每个公共类型、错误码、root export、Feature 注册和 manifest 只有一个 owner；存储 key codec 由 WP2 独占。
- 子 Agent 只能编辑 08 中冻结给它的 ownership 路径；遇到公共契约缺口，返回包含目标 owner、类型/字段、原因、兼容性和建议 patch 的 change request，由 Contract Owner 修改。
- 同一时间最多让不相互依赖、路径不重叠的工作包并行。
- 每一波派工前冻结该波所有 ready WP 的精确文件表、公共接线 owner、定向测试和“契约文件清单 + 每文件 SHA-256”；未填完整时不派发。后续 WP 不能沿用上一波 ownership。
- 不允许为了通过测试弱化 owner/workspace filter、durability、idempotency、Evidence Gate 或 fail-closed 行为。
- 不把概念性文档片段当作现成源码；每个集成点都要读真实接口。
- 保留用户进入任务前的未提交改动；不碰无关 .lh-harness/。
- 未经用户要求，不 commit、push、开 PR。

你要先输出并维护一张任务表：
WP | Agent | 允许修改路径 | 依赖 | 交付接口 | 定向测试 | 状态

每个子任务 Prompt 必须包含：
- 工作包 ID、范围和明确非目标。
- 可依赖的已冻结接口及其文件路径。
- 允许/禁止修改的路径。
- 至少 5 个关键不变量。
- 正常、恶意和崩溃测试。
- 验证命令。
- 结构化 handoff 格式。

协调流程：
1. 读代码和 git status，记录基线。
2. 根据依赖图只派发 ready 的工作包。
3. 子 Agent 完成后先做接口/安全/测试审查，再整合；不要只相信它的总结。
4. 统一处理公共 exports、Feature 注册、manifest 和跨包错误映射。
5. 跑包级 typecheck、imports lint、定向测试和 git diff --check。
6. 对最终 diff 做一次只读审计：内部标识泄漏、身份越权、Memory recapture、自定义 Profile 同名共享、秘密进入日志、耐久假确认。
7. 只有你或 Contract Owner 串行更新 08 中真实完成状态和决策；普通并行子 Agent 不编辑 08，也不要把临时 handoff 写入仓库。

本轮最终输出：
- 完成/未完成工作包及依赖原因。
- 关键设计选择和代码证据。
- 修改文件分组。
- 测试命令及结果。
- 下一轮可以并行的工作包。
- 所有残余 P0 风险；有 P0 风险时不要宣称核心可用。
```

## 工作包子 Agent 模板

协调 Agent 每次只填写一个工作包；不要把模板原样丢给 Agent 后让它自己选范围。

```text
你负责 Agent Profile Memory 的 <WP ID：名称>。

仓库：<repo-root>
基线/父分支状态：<填写>
依赖已经完成：<填写具体接口文件和版本>

先读：根 AGENTS.md、最近目录 AGENTS.md、agent-core-dev skill、docs/agent-profile-memory/08-implementation-readiness-review.md，以及 <本工作包相关文档/源码>。

你的唯一目标：<一段可验收目标>。

允许修改：
- <路径 1>
- <路径 2>

禁止修改：
- 公共 schemas/interfaces/errors：由 Contract Owner 管理；缺口以 change request 返回。
- 根 exports/Feature registration/manifests：由 Integration Owner 管理，除非本任务明确授权。
- <其他工作包路径>。

必须保持的不变量：
1. <身份不变量>
2. <Workspace/owner 隔离不变量>
3. <耐久或幂等不变量>
4. <Prompt/证据不变量>
5. <失败/降级不变量>

必须实现：
- <交付 1>
- <交付 2>
- <Contract tests/fixtures>

明确非目标：
- <非目标 1>
- <非目标 2>

必须覆盖测试：
- 正常路径：<场景>。
- 重复/并发：<场景>。
- 崩溃/恢复：<场景>。
- 恶意输入/越权：<场景>。
- 禁用/降级：<场景>。

验证命令：
- <定向 vitest>
- pnpm --filter @moonshot-ai/agent-core-v2 run typecheck
- pnpm --filter @moonshot-ai/agent-core-v2 run lint:imports
- git diff --check

不要 commit、push 或开 PR，除非用户明确要求。不要覆盖其他 Agent 或用户的改动。

最终 handoff 使用以下结构：
1. Outcome：完成/部分完成/阻塞。
2. Changed：逐文件说明路径、职责和关键选择。
3. Contract：实现或消费的接口、不变量、错误语义。
4. Verification：命令、通过/失败和关键输出。
5. Risks：未解决边界、兼容性、性能和安全风险。
6. Change requests：需要 Contract/Integration Owner 做的精确修改。
7. Next：下游工作包现在可依赖什么。
8. Baseline：起始 commit SHA、契约文件清单与每文件 SHA-256、结束时 status/diff stat、已知失败是否为基线问题。
```

## 各工作包专用要求

下面内容追加到通用模板的“必须实现/不变量/测试”部分。

### WP2：Durable Evidence Store

```text
只实现安装主体 Store、领域 Evidence Store、本地 backend、唯一 Profile Memory key codec、Blob policy 和 Contract Suite；不要实现 LLM Projection、Agent 工具或第二个 workspace trust epoch backend。Trust v2 记录、App keyed Authority、全耐久 replacement、exclusive-key-lock primitive 与 Profile Memory home writer lease 已由 WP1 完成；本包必须复用同一个 home lease 和冻结的 `{ownerEpoch,rootBindingId,workspaceTrustEpoch}` 字段，不能另建锁文件/第二 owner。允许修改路径限定为 `features/profileMemory/identity/installationPrincipalStore/**`、`features/profileMemory/evidence/**` 及对应测试；`identity/contract/**`、`identity/resolver/**`、公共 schema/error、Trust/persistence primitive和根装配只提交 change request。

关键语义：appendBatch 返回前已经 durable；逐 event 幂等；position opaque 且单调；receipt 返回 `durableThroughPosition`，不返回/冒充 Capture source checkpoint；区间为 (exclusive, inclusive]；ambiguous append 重开可判定；ownerEpoch、rootBindingId 或 workspaceTrustEpoch 不匹配都 fail closed，rootBindingId 参与物理分区 key。

安装主体 Store 必须先确认 WP1 的 App home writer lease 有效，再以 create-if-absent 等价语义创建随机 UUID；文件和父目录耐久同步后才返回，权限仅当前用户，重开复用，不从路径或显示身份派生。现有 `IAtomicDocumentStore` 的普通 get/set 和 node-fs no-op acquire 不满足安装主体的 create-if-absent 合同；使用 WP1 提供的 durable/lock primitive 与已持有 lease，不另写竞争锁。用 fault injection/子进程覆盖：两个进程同时首次启用、创建后退出、append 后 checkpoint 前退出、重复/部分 batch、破损尾行、磁盘满、路径穿越、第二 writer、旧 owner/trust epoch。Harness 路径先由 Integration Owner 批准。
```

### WP3：Worker SPI + Durable Queue

```text
只实现 IProfileMemoryWorkerLLM adapter、Queue Record/Partition Head/claim-renew-ack-nack-retry-DLQ、启动恢复和确定性 fake；不要写 L1 Prompt 业务或 Recall。

Worker 显式 model alias、无工具、strict schema、timeout/token/concurrency budget。未配置模型时 queue paused/degraded。进程事件只唤醒；耐久 queue 是权威。

App-scope Worker 不得直接注入 `IWorkspaceTrust`。每次 job 从可信 Queue Record 取得 `jobId + workspaceId + rootBindingId + workspaceTrustEpoch`，经 `IWorkspaceLifecycleService.handlerFor()` 取得 coordinator并比较 binding；不能持 partition lock 获取 handler/permit。先无锁或短锁 peek并释放，再由 permit `commit()` 包住仍获授权的 claim/renew/ack/nack/projection effect，同时校验 binding、trust epoch、active leaseId、fencingToken和 ownerEpoch。全局锁序固定为 writer lease → Trust mutex → Trust record → partition/domain。untrusted/root drift/旧 fence导致 permit不可得时，只能经 `handler.accessor -> coordinator.proveRevoked(target) -> facade/Authority` 为该完整 target 取得 branded `WorkspaceRevocationProof`，再由本包 Queue 的 `fenceRevoked(jobId, expectedState, proof)` 在 partition lock内重读 job，逐字段确认 target及 active lease/fencing state后才单调执行 `pending|leased -> fenced`；跨 job/workspace/binding/epoch重放或错配必须拒绝。Projection commit、success ack与其他写 API的类型必须拒绝该 proof，且不能提供接受任意 callback 的撤销接口；handler missing且无法证明时把 job 置有界持久退避/隔离，禁止热循环。retrust 后旧 job 不复活。

MVP 单进程，不宣称多节点安全，但首版必须实现 leaseId 和每分区单调 fencing token；每次重新 claim 都递增，旧 token 永久失效。多节点仍需后续 CAS/跨进程锁合同。测试覆盖 lease 过期重领后旧 Worker 先完成、重复 claim、处理时崩溃、retry backoff、DLQ、graceful drain、模型超时/脏结构化输出、无模型配置，以及 untrust 与 claim/renew/ack/nack 交错时无 ABBA/超时且结果按 epoch 线性化；另以负向类型/contract fixture证明 proof 只能传给 `fenceRevoked()`，不能传给 projection commit 或 success ack，并覆盖 A job/workspace proof向 B、binding/epoch错配、lease/token重领后的重放均被拒绝。
```

### WP4：Profile / Tool Wiring

```text
只实现 WP1 已预留 extension seam 后面的 runtime gate 和 operator-only inspect 边界；不要实现工具业务、存储、REST，也不要提前修改 builtin coder allowlist。允许修改 `features/profileMemory/runtimeGate/**` 和对应测试；`profileMemoryFeature.ts`、公共契约及根装配只提交 change request，由 Integration Owner 串行接入。

Feature 始终组装，disabled 时不得打开 Store、订阅 Capture、启动 Worker、注入上下文或对模型 materialize 工具；直接调用返回 `memory.disabled`。只有胜出来源为 builtin 的 coder 可启用。agent/explore/plan、自定义同名 coder 均不可继承。普通工具名按精确匹配，不能用 Memory* glob。实际 coder allowlist 在 WP8 工具存在后由 Integration Owner 单文件接入。
```

### WP5：Capture + Recovery

```text
实现实时事件触发 + 耐久 Context/Wire 取数、ToolCall bounded correlation、Subagent metadata 关联、脱敏/size/blob policy、独立 Capture source checkpoint 和 startup replay。Checkpoint 至少含 sourceStreamId/sourceEpoch/sourceCursor/lastClientEventId/durableThroughPosition；不要调用 LLM。

turn.ended 本身没有最终文本；tool.result 本身没有工具名/参数。只有连续来源前缀全部 accepted/duplicate 才推进 sourceCursor；retryable 洞不跨越，`durableThroughPosition` 只记录 L0 水位。排除 origin.kind=injection 和 derivedFromMemoryRefs。覆盖 abort、undo、retry、compaction、attach race、重复结束、append 后 source checkpoint 前崩溃、trust ABA 和 secrets。
```

### WP6：L1 Projection + Evidence Gate

```text
实现受限 L1 extractor 调用、strict output validation、Atom/Conflict 状态机、Evidence Gate、generation/checkpoint 和 optimistic conflict 重算。不要实现 L2/L3。

模型输出永远只是 Proposal；Repository 验证 subject、ownerEpoch、source interval、evidence refs、input digest、schema/prompt/model version 和 expectedVersion。一次成功不能成为稳定能力；模型自述不能证明技术事实；冲突形成双边记录而非覆盖。
```

### WP7：Lexical Search + Manual Recall

```text
实现 IProfileMemorySearchStore、本地词法检索、授权 pre-filter、稳定排序、预算裁剪、opaque snapshot result cache 和手动 service-level Recall。不要实现向量/RRF、自动注入或公开 API。

算法名称不是 contract。外部/索引候选返回后还要逐项再授权。未信任 Workspace 的显式 Recall 也 fail closed。测试跨 owner/workspace 注入结果、untrust 后缓存不可用、相同分数稳定排序、分页 token 篡改、snapshot 过期、索引 checkpoint 落后和全量重建。
```

### WP8：Agent Tools

```text
实现 MemoryRecall、MemoryReadEvidence、MemoryPropose、MemoryFeedback 的 strict Zod Schema 工具、真实 `Feature.contributeTool()` 接线和 Agent 门面；由 Integration Owner 同时把真实工具精确名称加入 builtin coder allowlist。工具输入中不得出现 owner/principal/profile/workspace/session/runtimeAgentId；未知字段必须拒绝。

ReadEvidence 只接受 Recall 产生的 snapshot/evidence grant，返回 unavailableRefs，不区分无权和不存在。Proposal/Feedback 只追加 L0，不直接修改权重/状态。覆盖调用预算、长度/数组上限、timeout、feature disabled、workspace untrusted、同名 Profile、Evidence ID 枚举和敏感错误 details。
```

### WP9：Auto Recall

```text
实现 new-turn query bridge、strict timeout/cancel、opaque snapshot pin、统一 untrusted Formatter、Context Injector 注册与 compaction reinjection。不得修改 Profile system prompt，不得把记忆作为真实 User 指令。

当前 ContextInjectionContext 没有 query/turnId，必须选择并测试显式桥接方案。Injector 每个 step 都运行，只有 isNewTurn 时查询一次；晚到结果在 Turn 改变后丢弃。system-triggered turn 没有可展示 prompt 时默认不自动召回。untrust 立即清除缓存并停止后续注入。注入结果标 provenance，Capture 不得再记忆。
```

## 审查 Agent 提示词

每个实现工作包完成后，建议另派一个只读 Agent 做下面审查；它不修改代码。

```text
请只读审查 Agent Profile Memory 的 <WP> diff，不实现修复。先读 docs/agent-profile-memory/08-implementation-readiness-review.md 和该 WP 的冻结接口，再检查真实代码与测试。

按严重度 P0/P1/P2 报告：
- 是否存在可伪造的 owner/principal/workspace/session/profile source。
- 是否把缓冲入队误当耐久提交，或 checkpoint 可跨失败洞。
- 是否存在同名 Profile、跨 Workspace、索引 post-filter 或 Evidence ID 侧信道。
- 是否能被 Memory Injection 自我捕获并提高置信度。
- 是否把 LLM 输出直接当写命令，绕过 evidence/state/version gate。
- 是否在日志、trace、DLQ、错误 details 泄漏正文或秘密。
- 是否错误使用 v2 Scope、Feature seam、IEventBus/IEventService 或短生命周期依赖；基础 Trust Authority/facade/watch/MCP guarded path 是否静态 scoped 注册并明确不在可 retract `ProfileMemoryFeature` book 中。
- Trust authority 是否真的按 realpath+platform-normalized+hashed canonicalRoot key 共享，而不是每个 Workspace facade 各自持锁；跨进程 record lock 是否锁内重读；每次 epoch replace 是否包含 parent-directory fsync；Memory home writer lease 是否懒获取且第二 writer 只关闭 Memory、不破坏 Trust。
- canonical root 是否先 realpath 再平台归一并哈希为 storage-safe key/rootBindingId；安全 API 是否检测 attach 后 symlink retarget；MemorySubject/Evidence/Queue/Snapshot/Projection 分区是否都绑定 rootBindingId；project MCP 是否始终读取冻结 canonical root。
- watch health 是否区分 starting/healthy/degraded/disposed，且 error 后普通 snapshot 为 true也不会重开 MCP；MCP revoke 是否有不等待 `ready/connectAll`或普通 apply tail 的高优先级取消/deny通道；KAP/ACP/SDK/CLI/harness composition root 是否真的 await Memory drain 后才 dispose/允许第二 App 接管。
- 是否遵守 writer lease → Trust mutex → Trust record → domain/partition 的全局锁序，且没有持领域锁获取 permit/调用 Trust 的反向路径。
- untrusted/root drift/stale job 是否只经精确 target-bound branded `WorkspaceRevocationProof` + Queue锁内重读的 `fenceRevoked()` 单调 fence，跨 job/workspace/binding/epoch/lease-token重放是否拒绝，projection/success ack是否在类型层拒绝该 proof，handler missing 是否退避且 retrust不复活旧 job。
- 是否测试了重复、崩溃、取消、禁用和恶意输入，而不只 happy path。
- 是否修改了工作包范围外的公共契约。

每个问题给出绝对文件路径、精确行号、可复现场景、违反的不变量和建议修复方向。若没有问题，明确说明检查范围和残余风险；不要泛泛总结。
```

## 何时允许进入下一阶段

协调 Agent 不能只根据“子 Agent 说完成了”推进。每个 WP 至少要同时满足：

- 交付接口真实存在且唯一，没有平行重复类型。
- 定向测试包含正常、恶意、重复/并发、崩溃/恢复和禁用路径中适用的部分。
- 包级 typecheck、imports lint 和 `git diff --check` 通过。
- 只读审查没有未解决 P0。
- Handoff 明确列出残余限制，下游 Agent 的 Prompt 把这些限制当作约束而不是猜测补齐。

若用户之后要求提交 PR，还要另行遵守仓库的 changeset、内部标识审计、PR template 和 Conventional Commit 规则；这些动作不包含在上述实施提示词的默认授权中。
