# 任务 7/8：minidb —— 嵌入式 KV/文档数据库研究报告

> 分析对象：`packages/minidb`（约 1.79 万行 TS，`@moonshot-ai/minidb` v0.2.0）
> 分析方法：入口/README/DESIGN_NOTES 骨架 + 核心模块逐段精读（WAL、store、write-path、lifecycle、compaction、recovery、索引层、generation、cluster、text-index 等 30+ 个文件）
> 结论先行：这是一个**"教科书级"的零依赖纯 Node.js 嵌入式数据库**——Redis 风格的内存 KV + SQLite 风格的持久化（WAL + 快照 + 组提交 + 崩溃恢复），外加一整套从二级索引到全文检索、从单进程到多进程分片（ClusterDb）、从内存态到持久化检查点（generations）的完整演进。它在 Kimi Code 中的真实身份是 **kap-server 搜索服务与 agent-core-v2 会话/查询存储的持久化底座**。

---

## 1. 子系统定位与职责

### 1.1 一句话定位

minidb 是一个 **pure-Node.js（零原生插件、零运行时依赖，仅 `node:*` 内置模块）的嵌入式键值/JSON 文档数据库**：`package.json` 自述为 *"A pure-Node.js embedded key-value database mixing Redis-style in-memory KV with SQLite-style durable persistence (WAL + snapshot)"*。它把两种经典架构揉在一起：

- **Redis 侧**：内存 `Map` 主索引 O(1) GET/SET、TTL（惰性 + 主动过期）、AOF 式 WAL 重写（BGREWRITEAOF 思想）、跳表（zskiplist）、RESP 协议服务器、maxmemory 驱逐策略。
- **SQLite 侧**：单目录持久化、append-only WAL + 快照、group commit、三种 fsync 策略（对应 `synchronous` FULL/NORMAL/OFF）、单写者多读者、索引化查询。

### 1.2 在 Kimi Code 整体中的角色

`packages/minidb/AGENTS.md` 的第一句就是定位：**"The embedded JSON document store (`MiniDb`) behind kap-server's search index"**。具体使用方（见第 7 节）：

1. **kap-server**（`packages/kap-server/src/search/searchService.ts:70`）：用 `MiniDb` + `OpTracker` + `TextIndexBuildingError` + `tokenize`/`normalizeLiteral` 构建**全局会话/消息全文搜索服务**——写入侧用 `batch()` 批量落盘，读取侧用 `searchBoundedAsync`/`queryAsync`。这是 minidb 最大的消费方，也解释了为什么 minidb 会有全文索引、n-gram 精确检索、TextIndexBuildingError（索引构建中状态）、OpTracker 生命周期原语（"shared with embedders that run lifecycle-managed background work (kap-server's search service)"，见 `src/index.ts:18`）等特性。
2. **agent-core-v2**（`packages/agent-core-v2/src/persistence/backends/minidb/miniDbQueryStore.ts:58-59`）：用 **`ClusterDb`（`@moonshot-ai/minidb/cluster` 子路径导出）** 做会话查询存储——多进程分片、跨分片合并查询。这解释了为什么 minidb 会有完整的 cluster 层。
3. **apps/kimi-code**（终端应用本体）：`src/native/minidb-worker.ts` 把 minidb 的 text-build worker 打包进 SEA（Single Executable Application）资产，通过 `configureTextBuildWorkerRuntime` 注入 worker 入口路径；`src/native/smoke.ts` 直接用 `MiniDb` 做冒烟验证。

**演化脉络**（从代码注释里的 stage 编号可以还原）：stage 1-4 完成基础存储（Map + WAL + 快照 + 压缩 + 索引 + RESP server）；stage 5 引入 **persistent index generations**（把"打开时全量重建派生索引"优化为"加载检查点 + WAL 增量重放"）；stage 6 引入 **统一维护调度器 + worker 线程化文本构建 + 异步读 API**；stage 7-12 是围绕**提交语义**（WAL 毒化/组回滚/模糊提交）、**在线备份**（写门闩 fence）、**openOrRebuild**（可重建缓存）、**并发正确性**（review #N 系列修复）的加固。README 中大量 `review #N` 注释表明这是一份被多轮代码评审打磨过的代码库。

### 1.3 与 agent-core-v2 / agent-core / kap-server 的关系

```
agent-core-v2 (会话/查询存储)  ──┐
kap-server (搜索服务)          ──┼──►  @moonshot-ai/minidb（本包）
apps/kimi-code (SEA 打包 worker) ──┘        │
                                            ├── 单机嵌入: MiniDb
                                            ├── 多进程分片: ClusterDb
                                            └── 搜索: TextIndex (CJK 分词 + TF-IDF + n-gram)
```

- **依赖方向**：agent-core-v2 与 kap-server 都依赖 minidb（`workspace:*`），minidb 不依赖任何 workspace 内包——它是持久化基础层。
- **能力边界**：minidb 只负责"存与查"，不负责"会话管理/消息路由/权限"——那些是上层服务的事。kap-server 的 searchService 在其上叠加了工作追踪（OpTracker）、构建状态暴露（`textIndexBuilding()` → `TextIndexBuildingError`）等协议。

---

## 2. 包/目录清单与依赖关系

### 2.1 依赖关系（谁依赖谁）

```
apps/kimi-code  →  @moonshot-ai/minidb            (workspace:^, 直接使用 + worker-runtime 子路径)
packages/kap-server  →  @moonshot-ai/minidb      (workspace:*, src/search/searchService.ts)
packages/agent-core-v2  →  @moonshot-ai/minidb   (workspace:^, 含 ./cluster 子路径)
packages/minidb  →  (无 workspace 内部依赖；仅 node:fs / node:net / node:worker_threads / node:buffer)
```

- **workspace 内部依赖**：上面三个消费方均为 `workspace:*` / `workspace:^`（pnpm monorepo 协议）。minidb 自身**零第三方运行时依赖**（`package.json` 无 dependencies 字段），只有 devDependencies（vitest/tsdown/tsx 等构建测试工具）。
- **包导出面**（`package.json` exports，三个入口）：
  - `"."` → `src/index.ts`（MiniDb 主 API 桶文件）
  - `"./cluster"` → `src/cluster/index.ts`（ClusterDb 分片层，独立子路径导出以**避免 import 环**，见 `src/index.ts:39-40` 注释）
  - `"./worker-runtime"` → `src/worker-runtime.ts`（SEA 打包场景下配置 text-build worker 入口）
- `"type": "module"`，源码直接以 `.ts` 运行（`tsdown` 构建，`tsx` 运行），import 带 `.js` 后缀。

### 2.2 目录清单（src/，按职责分层）

**存储引擎层（磁盘格式与恢复）**

| 文件 | 职责 |
|---|---|
| `codec.ts` (849) | WAL/快照共用的二进制帧编解码：22 字节定长头 + CRC-32 trailer，SET/DEL/BATCH 三种帧，同步/异步扫描器，resync 逻辑 |
| `crc32.ts` (47) | 查表法 CRC-32 |
| `wal.ts` (483) | WAL：缓冲 append + group commit（writev）+ 三种 fsync 策略 + 密封/毒化状态机 |
| `snapshot.ts` (189) | 分块快照写入（每 N 条让出事件循环；disk 模式分组异步定位读） |
| `recovery.ts` (491) | 启动恢复：加载快照 + 重放 WAL + 撕裂尾部截断 + generation 配对 + `catchUpWal`（只读追赶） |
| `compaction.ts` (400) | 非阻塞压缩：fence → 快照 → 预拷贝 → 旋转临界区（两处原子 rename + 严格目录 fsync） |
| `store.ts` (458) | 内存主索引：`Map<kstr, {ref, expireAt, seq, dt}>` + 有序键跳表 + TTL 最小堆（惰性 + 主动过期） |
| `value-reader.ts` (126) | 磁盘值定位读（同步 `readSync` + 异步 `fs.read`），dev/ino 锚定 |
| `value-codec.ts` (122) | buffer/string/json 三种值编解码器、key 的 binary 字符串归一化、原子写文件助手 |
| `generation.ts` (260) | **持久化索引代数（stage 5）**：generations/ 目录布局、manifest 格式、全部持久文件名权威清单 |
| `gen-codec.ts` (925) | generation 各镜像文件的二进制编解码（magic + 版本 + crc32 信封） |
| `generation-builder.ts` (845) | 构建并原子发布新代数（store 镜像 + 各索引镜像 + 文本 postings） |
| `generation-loader.ts` (493) | 加载已发布代数（镜像载入 + WAL delta 重放），失败回退完整恢复 |
| `generation-files.ts` (190) | 代数目录的清单读写与 tmp 清扫 |
| `rename-replace.ts` (36) | Windows 兼容的"rename 覆盖已存在目标"助手 |
| `lockfile.ts` (354) | O_EXCL 独占锁 + 令牌（pid:uuid）+ PID 存活判定 + 自适应 stale 接管 + 读锁降级 |
| `backup.ts` (183) | 在线备份：写门闩 fence + 逐文件 fsync + manifest 最后写 + 原子换目录 |
| `serialize.ts` (33) | 共享 promise-chain 互斥原语（`createSerializer`） |

**内存索引与查询层**

| 文件 | 职责 |
|---|---|
| `skiplist.ts` (362) | Redis zskiplist 泛化：span 字段 O(log N) rank、范围扫描、`bulkLoad` O(N) 确定性批量构建 |
| `index-manager.ts` (545) | JSON 字段二级索引：equality（`Map<标量, Set<pk>>`）+ range（跳表），unique/sparse，staged 事务 |
| `dt-index.ts` (169) | 日期时间列索引（每列一个数值跳表） |
| `compound-index.ts` (295) | 复合索引（groupBy + orderBy），组内有序范围 O(log N + limit) |
| `query.ts` (153) | jq/Mongo 风格值查询：路径 get/set、filter 操作符、projection |
| `query-engine.ts` (496) | 统一查询引擎：候选集收集（key/dt/text/二级索引交集）+ dt 有序 fast path + 同步/异步双管道 |
| `text-index/` (tokenize 69 / types 136 / builder 125 / image 173 / index 964) | 全文倒排索引：CJK unigram/bigram 分词、TF-IDF、磁盘 postings + 内存字典、delta/墓碑、rebase 交换 |
| `text-postings.ts` (308) | 磁盘 postings 文件（delta+varint 压缩、CRC 帧、LRU 解码缓存） |
| `text-registry.ts` (292) | 文本索引注册表 facet（定义持久化、create/drop、search 转发） |
| `trigram.ts` (80) | n-gram（2/3 元）哈希分词器：子串精确匹配（NFKC + lowercase + crc32 哈希桶） |

**MiniDb 门面与 facet 层（重构后的可测试架构）**

| 文件 | 职责 |
|---|---|
| `index.ts` (40) | 公共 API 桶（仅 re-export） |
| `mini-db.ts` (1390) | `MiniDb` 类：全部公共方法 + 十几个 facet 的依赖注入组装 |
| `types.ts` (133) | 公共类型 + 内部 `PreparedOp`（写入路径的预制备变更结构） |
| `write-path.ts` (784) | set/del/batch/expire 提交机制：prepare → apply → WAL append 同 tick → 组回滚/毒化恢复 |
| `read-path.ts` (145) | KV 读、扫描、dt 读、live-record 生成器 |
| `index-admin.ts` (246) | 二级/复合索引管理 facet（含打开时重建） |
| `lifecycle.ts` (525) | open/close/openOrRebuild/renewLock 流程（依赖注入的自由函数） |
| `wal-group.ts` (191) | WAL 组提交回滚注册表 + 原地恢复门闩 |
| `memory-guard.ts` (102) | maxMemory 守卫：LRU 访问集 + 投影字节 + TTL 排空 → evict-lru → reject |
| `stats.ts` (104) | stats 对象工厂 |
| `maintenance.ts` (365) | 统一维护调度器（一次一个重型任务、队列背压、磁盘预检、取消、关闭排空） |
| `op-tracker.ts` (129) | close 门闩 + 在飞计数原语（pause/resume 可重开） |
| `server.ts` (241) | 可选 RESP TCP 服务器（redis-cli 兼容） |
| `worker/text-build.ts` (420) / `text-build-core.ts` (751) / `text-build-worker.ts` (49) | worker 线程化全文构建（有界内存聚合 + 分段外部归并） |
| `worker-runtime.ts` (71) | SEA 场景下 worker 入口配置 |

**集群层（多进程分片）**

| 文件 | 职责 |
|---|---|
| `cluster/index.ts` (695) | `ClusterDb`：N 个 MiniDb 目录分片、哈希路由、读写协调 |
| `cluster/router.ts` (31) | 纯哈希 key → shard 路由（stableHash32） |
| `cluster/topology.ts` (94) | 集群元数据（cluster.meta.json） |
| `cluster/coordinator.ts` (101) | 跨分片操作协调（按 shard 分组、best-effort 语义） |
| `cluster/lock-pool.ts` (432) | 分片写锁池：按需获取 + LRU 缓存 + 锁租约续期 + 持有时间上限（lockHoldMs） |
| `cluster/shard.ts` (65) | 分片打开选项 |
| `cluster/types.ts` (124) | ClusterDb 公共类型 |
| `cluster/utils.ts` (70) | shard 目录名/哈希/常量 |

**测试**：`test/` 三层——单元测试（每模块一个）、`test/e2e/`（fuzz-model、crash-recovery、index-consistency、compaction-race、recovery-matrix、durability、boundary、soak）、`test/cluster/`（真多进程并发与崩溃接管）。`bench/` 有 14 个基准脚本（含 `import-kimi-code.ts`、`session-store.ts`——直接对标 Kimi Code 会话数据的负载）。

---

## 3. 模块结构与核心类型

### 3.1 数据模型

记录 = `{ key, value, dt1..dtN }`：

- **key**：字符串 ≤ 128 字节（帧头 uint16 上限 64KiB，`MiniDb` 层限制 128），**有序**（支持 range/prefix/有序扫描）。内部以 **binary 字符串**（`Buffer.toString('binary')`，每字符码 == 一个 UTF-8 字节）规范化存储，保证任意字节键的字典序与字节序一致。
- **value**：任意 JSON（`valueCodec: 'buffer' | 'string' | 'json'` 决定编解码），内部恒为 `Buffer`。
- **dt 列**：任意多个顶层时间列（epoch-ms），存于帧的可选 `meta` blob（`{ dt: {...} }`），与 value 分离、独立索引。

### 3.2 磁盘帧格式（`codec.ts:26-42`）

```
off   size  字段
 0    2    magic = 0x4D 0x44 ("MD")   —— 同步标记
 2    1    type   1=SET 2=DEL(墓碑) 3=BATCH
 3    1    flags  保留(0)
 4    2    keyLen uint16
 6    4    valLen uint32 (DEL 为 0)
10    4    metaLen uint32 (可无)
14    8    expireAt int64 ms (0=无)
22   k     key
22+k v     value
22+k+v m   meta (dt 列等)
22+k+v+m 4  crc32 —— 对 [type..meta] 的 CRC-32 TRAILER
```

设计要点：**定长头让读者在读 payload 前即可算出全长**（`22+k+v+m+4`）；CRC 作 trailer 支持单趟验证；小端序匹配 x86。BATCH 帧的 value 域内再嵌一组子 op（`encodeBatchOps`），一个 batch 只有一帧 = 一次组提交。

### 3.3 核心类型（`types.ts`）

```ts
ValueCodec<V>          { encode(v): Buffer; decode(b): V }
ValueModeSetting       'memory' | 'disk' | 'auto'   // auto: 按 snapshot+wal 尺寸 vs maxMemoryBytes 启动时选
OpenOptions            dir / valueCodec / fsyncPolicy / syncIntervalMs / compactThresholdBytes /
                       autoCompact / activeExpireIntervalMs / recovery('resync'|'strict') /
                       readOnly / onLockFail('readonly') / valueMode / maxMemoryBytes /
                       maxMemoryPolicy('reject'|'evict-lru') / indexGenerations(默认true) /
                       textBuildWorker(默认true) / textBuildMemoryBytes(默认128MiB) /
                       deferOpenTextBuilds(默认true) / maintenanceIoConcurrency(默认8)
PreparedOp<V>          // 写入路径的预制备变更（不对外导出）
  type / key(Buffer) / value / meta / expireAt / dtNorm / pk(binary串) /
  canonical(V)         // json codec 下是"编码后重新解码"的权威值——所有索引消费同一视图
  textTokens           // 每个 TextIndex 预计算的分词结果（prepare 边界分词，apply 不抛错）
```

`PreparedOp.canonical` 与 `textTokens` 是 stage-11 的产物：**一切可能失败的验证（key 长度、TTL 有限性、编码、自定义分词器抛错）都在 prepare 边界完成**，使 `applyOp` 成为"必须不抛错"的纯赋值函数（见 `write-path.ts:525-534` 的 CONTRACT 注释）。

### 3.4 Store（`store.ts:118`）

```ts
class Store {
  map: Map<string, StoreRecord>            // kstr -> { ref: ValueRef, expireAt, seq, dt }
  order: SkipList<string, string>          // 有序键索引（与 map 双写）
  heap: MinHeap                            // TTL 最小堆（过期时间 -> key + seq）
  bytes: number                            // 近似逻辑字节（key+value+dt 元数据）
  seq: number                              // 单调递增写序号：恢复/回滚的"身份守卫"
}
ValueRef = { kind:'memory', value:Buffer } | { kind:'disk', loc:{file:'snapshot'|'wal', off, len} }
```

关键点：
- **seq 身份守卫**：每个记录带全局递增 seq；`publishWalRef`（disk 模式把内存 ref 换成 WAL 指针）和 `restoreKey`（失败回滚）都先比对 `cur.seq === seq`，防止"后来的同 key 提交/过期已发生却回滚掉已持久化状态"。
- **TTL**：惰性（get/has/scan 时顺带删）+ 主动（100ms 定时器，每 tick 限量 + **时间预算**：`activeExpireTimeBudgetMs` 内持续排空过期风暴 + aggressive 模式，对应 Redis 的 fast expire cycle）。最小堆 `peek().t <= now` 短路；堆中陈旧条目超过 `map.size*2+64` 时整体重建（防 TTL 频繁更新导致堆无限增长）。
- **bulkLoadRefs**（`store.ts:375`）：generation 载入路径 O(N) 批量灌入（有序键跳表用 `SkipList.bulkLoad` 确定性构建）。

### 3.5 WAL（`wal.ts:82`）

```ts
class WAL {
  queue: PendingWrite[]        // 内存追加队列
  nextOffset                   // 逻辑下一追加偏移（含排队帧）——appendLoc 同步预测
  nextBatchId                  // flush 组 id：同一 tick 的 append 共享一个组
  writeGen / syncedGen         // Redis AOF 式持久水位：writev 代 / fsync 覆盖代
  sealed                       // 压缩旋转时密封：新 append 立即拒绝(WAL_SEALED)
  poisoned: WalPoison|null     // 写失败毒化：{ failedAtOffset, error }，提交点语义
}
```

- **appendLoc()**（`wal.ts:188`）：同步返回预测偏移 + 组 id + done Promise；`setImmediate` 调度 `flushBatch()`。
- **flushBatch()**（`wal.ts:225`）：把队列整批 `writev`（可多段、处理 short-write 重试）；`policy==='always'` 再 `sync()`；失败 → `poisonWith(batchStartOffset)`（该批首帧预测偏移 = 恢复截断点）→ 逆序 reject 仍排队帧 → reject 本批帧。成功后 resolve 本批、链式调度下一批。
- **everysec 后台 sync**（`wal.ts:160`）：空闲 WAL 不 fsync（`writeGen===syncedGen` 直接跳过，省掉每秒一次无谓 syscall）；失败不拒绝任何写，只记 stats；`OpTracker` 追踪在飞后台 sync，`close()` 先排空再关 fd。
- **毒化语义**：写失败后所有 append 立即拒绝（`WAL_POISONED`，与 `WAL_SEALED` 区分——密封是正常旋转可重试，毒化是硬故障）；owner 通过 `recoverWalInPlace`（`mini-db.ts:1031`）**原地恢复**：`truncate(db.wal, poison.failedAtOffset)` 精确去掉未确认字节 → `refreshSize()` → `clearPoison()`。截断失败 → `writeDisabled` 状态（写全拒绝、读继续、close 跳过最终 flush——被拒写的残留帧在重开重放时"复活"，这正是所有提交点失败都标记 `ambiguous` 的原因）。

### 3.6 索引体系

| 索引 | 数据结构 | 查询 |
|---|---|---|
| 主键 | `Map` + 有序跳表 | O(1) get；O(log N) range/prefix |
| dt 列 | 每列一个 `SkipList<number,string>`（ms, pk） | O(log N) range / 有序迭代 |
| 二级 equality | `Map<scalarKey, Set<pk>>` | O(1) findEq |
| 二级 range | `SkipList<number,string>` | O(log N + limit) findRange |
| 复合索引 | 每组值一个 `SkipList`（orderBy 键, pk） | 组内有序范围，无全排序 |
| 全文索引 | 内存字典 + 磁盘 postings + 内存 delta/墓碑 | TF-IDF 评分、AND/OR |

**SkipList**（`skiplist.ts:59`）：Redis zskiplist 泛化——节点 `{ key, val, backward, level[]{forward, span} }`，max level 32、P=0.25；**span 字段**实现 O(log N) rank 与高效分页；`bulkLoad`（`skiplist.ts:82`）对已排序输入做确定性平衡 4 叉塔构建（O(N)），供 generation 镜像载入使用。

**二级索引事务**（`index-manager.ts:221`）：`staged → persist → publish` 三步——create 时索引先进入 `staged` 私有区（对查询不可见，但**写维护路径已开始喂它**，unique 校验也对其生效），sidecar 原子持久化成功后 `publish()` 才把它移入 live map；失败 `discardStaged()`。这消除了"并发 create 共用同一 tmp 文件互相 rename 掉"与"持久化失败导致注册表与磁盘分叉"两类竞态。

**unique 校验**（`index-manager.ts:335-364`）：单写 `checkUnique` 直接查索引；**批量** `checkUniqueBatch` 是"批后状态"验证——按 value 建批内 claim map + 对 live holder 做 `assertVacated`（holder 是 claimant 本人或批内删除/迁走者才算合法），因此"两个 key 交换唯一值"这类合法转换被接受，且**与顺序无关**；只探测被 claim 的 value 的当前 posting（O(1)/O(log N)），不复制全索引。

### 3.7 查询引擎（`query-engine.ts:47`）

`db.query(q)` 的候选集收集顺序（`query-engine.ts:225-273`）：

1. `q.key`（单 key / range / prefix）→ 有序键迭代器（惰性，不物化）
2. `q.dt` 各列 → `Set(pk)` 与现有候选求交
3. `q.text` → 全文搜索命中（带评分顺序），与候选求交
4. `q.filter` 中的**可索引谓词**（顶层或 `$and` 内的、有匹配 equality/range 索引的字段）→ `indexedCandidateKeys` 交集
5. 全空 → 全表扫描（`store.rawKeys({})`，对应 Mongo 无索引退化）

**dt 有序 fast path**（`tryDtOrderedLimit`，`query-engine.ts:155`）：当查询恰好"单 dt 列范围 + 结果按该列排序 + 有 limit"时，直接按 dt 跳表顺序游走、命中 limit 即停——不物化、不排序。`cheapEqChecks` 用 equality 索引做**不解码**的候选预筛。

同步 `query()` 与异步 `queryAsync()` 双管道严格镜像（注释要求两者保持同步演进）。

### 3.8 全文索引（`text-index/index.ts:81`）

```
内存:  postings: Map<term, {off,len,df}>   ← 词典（小）
       docLen / keys / keyToId             ← 每文档一条
       delta: Map<term, Map<docID,freq>>   ← 写缓冲（写路径零磁盘 IO）
       removed: Set<docID>                 ← 墓碑
       deltaDocs: Map<docID, Set<term>>    ← delta 反视图（remove 只走被删文档自己的词）
磁盘:  PostingsFile（delta+varint 压缩、CRC 帧）
```

- **写**：`addPrepared` 进 delta；`remove` 置墓碑；磁盘 postings 只在**基座提交**（generation 构建 / 压缩 / 打开时重建）时重写。
- **读**：search 对每个查询词从磁盘读 postings（或 LRU 缓存，词数与字节数双上限），与 delta 合并、滤墓碑、TF-IDF 评分。**同步 API 保持**（`search`/`query` 同步），异步变体 `searchAsync`/`searchBoundedAsync` 走 `PostingsFile.readAsync`。
- **rebase 机制**：`beginRebase()` 开始捕获写入（`buildQueue`）→ 后台构建新基座 → `commitRebase()` 整体换绑（词典/postings/doc 表一次 O(1) 交换）→ 重放 buildQueue 中的 op。**baseEpoch**（`text-index/index.ts:153`）保证跨基座交换的异步读不脏读：读到一半基座换绑则重新读。
- **basePending / TextIndexBuildingError**（`text-index/index.ts:73`）：打开时延迟构建期间搜索抛类型化错误而不是返回部分结果。
- **ngram 分词器**（`trigram.ts`）：NFKC+小写归一后按码点切 2/3 元，crc32 哈希到 2^22 桶（宽前缀防 2/3 元别名）；查询端短词只发 2 元、长词只发 3 元（更少更选择性）；索引端全发；下游 `normalizeLiteral` 确认步骤保证零假阳性。解决 `C++`、`$\frac{a}{b}$`、emoji 这类符号密集文本的子串精确搜索。

### 3.9 Generation 机制（stage 5，`generation.ts`）

```
db.snapshot / db.wal                权威数据（不变）
db.indexes.json / db.compound-indexes.json / db.textindexes.json   索引定义 sidecar（真源）
generations/
  g-000001/                         已发布代数（不可变）
    store          store 镜像（内联值或磁盘 ref）
    dt.index / secondary.index / compound.index    各派生索引镜像
    text-<n>.dictionary / .postings / .docs        全文索引工件
    snapshot       db.snapshot 的硬链接（disk 模式 ref 指向它）
    manifest.json  最后写 —— 目录内文件"有意义"的判据
CURRENT                            一行：当前代数 id
```

- **发布协议**（崩溃安全）：构建进 `g-N.tmp-*` → 逐文件写 + fsync → fsync tmp 目录 → rename 为 `g-N` → fsync `generations/` → 原子替换 CURRENT（tmp+rename）→ fsync db 目录。CURRENT 只会指向完全 fsync 过的代数；中途崩溃只残留 tmp 目录（下次 writer open 清扫）。旧代数惰性删除，保留当前 + 上一个（上一个在无压缩时共享 WAL 锚点，是真正的回退）。
- **加载协议**：读 CURRENT → 校验 manifest（未知版本 = 结构化回退，**永不删除**）→ 校验 WAL 锚点（dev/ino + size ≥ checkpoint）与快照锚点 → 载入 store 镜像 + 每个定义哈希仍匹配的索引镜像 → 重放 checkpoint 之后的 WAL 帧。**任何校验/IO 失败回退到传统完整恢复**，回退路径不碰权威数据。
- **定义哈希**（`generation.ts:202`）：`crc32(stableJson(def))`——每个索引的定义哈希决定该索引镜像是否仍有效，定义变更只作废该索引（从已载入 store 重建单索引）。
- **载入加速**：`SkipList.bulkLoad` O(N) 建跳表、`store.bulkLoadRefs` O(N) 灌主索引；WAL delta 重放逐帧走 `applyRecoveredOp`（与打开时恢复、catch-up 完全同一解释层 `frameToOps`，杜绝三方漂移）。
- **运行时保鲜**：`maybeAutoGenerationBuild`（`mini-db.ts:993`，4MiB 陈旧阈值 + 失败退避 + 节流）覆盖"从空库起步、WAL 增长但未达压缩阈值"的窗口；`close()` 前 best-effort 发布（`lifecycle.ts:373`）。

### 3.10 ClusterDb（`cluster/index.ts:69`）

- **路由**：`stableHash32(key) % shardCount` 纯哈希，所有进程无需协调即一致（`router.ts`）。
- **写**：`ShardLockPool` 按需获取分片写锁（重试至 `lockAcquireTimeoutMs`），LRU 缓存（`lockPoolMaxShards`，默认 16），**锁租约**：`lockRenewMs` 定时续期（证明存活）、`lockHoldMs`（默认 250ms）上限——到点让出锁，防连续写入进程饿死他人。
- **读**：不取锁。本进程持有该分片写锁时用缓存 writer，否则用**只读 MiniDb 实例 + 指纹再校验**（`FINGERPRINT_FILES`：WAL 第一，其余按位置比对；WAL-only append 有 fast path）；落后时**增量追赶** `catchUpFromWal`（只应用新增 WAL 帧，而非整体重开）。
- **一致性**：单 key / 同分片 batch 强一致（每分片单写者 + 原子 WAL 帧）；跨分片 `mset`/`batch` 为 best-effort（每分片原子、全局不原子），`crossShard:'none'` 直接拒绝，`'2pc'` 预留未实现（打开即拒绝）。
- **索引**：集群级注册表 `cluster.indexes.json` 为真源；每个分片 writer 打开后应用缺失定义；create/drop 向全部分片扇出（需要全分片写锁，宜在单进程、热路径外做）；`findEq`/`findRange`/`search`/`query` 逐分片执行后全局合并（文本分数是分片本地的；`query` 用 skip=0、limit=skip+limit 扇出再全局重排）。

---

## 4. 关键数据流 / 状态机 / 时序

### 4.1 写入提交路径（单次 `set`）

```
set(key, value, {ttl, dt})
  │  ensureOpen / ensureWritable
  │  writeOps.enter()                    ← backup 门闩：备份期间返回 BACKUP_IN_PROGRESS
  │  awaitRotation()                     ← 压缩旋转临界区则停车（计 compactionRotationPauseMs）
  │  prepareSet():
  │    checkKey (≤128 非空)
  │    normDt / ttl 校验（finite）
  │    encode(value) → vbuf
  │    canonical = decode(vbuf)          ← json codec：编码后重解码=持久视图（索引一致性的根）
  │    textTokens = 各 TextIndex.prepareAdd(canonical)   ← 分词器抛错在此拒绝写入
  │  indexes.checkUnique(pk, canonical)  （存在 unique 索引时整体包在 serializeUniqueWrites 链中）
  │  memoryGuard.ensureMemoryFor([op])   ← TTL 排空 → evict-lru（逐出走完整 DEL 提交）→ reject
  │  retryOnWalSeal(commitSetOp)         ← WAL_SEALED / 旋转中 closed → 等旋转后重跑一次
  │
  └─ commitSetOp():                      （与 wal.append 同一同步段）
       recoveryGate? → await            ← 毒化恢复期间排队
       frame = encodeFrame(SET)
       appended = wal.appendLoc(frame)   ← 同步得预测偏移 + batchId
       applyOp(op, applyBox)             ← 同一 tick 改 store + dt/compound/secondary/text 索引
                                            （压缩快照因此永远看到写后状态）
       groupNoteKey(group, pk, prev)     ← 组回滚登记（首个捕获为准）
       await appended.done               ← 提交点：帧进入 OS page cache（always 策略则含 fsync）
         └─ 失败: rollbackGroup（整组回到 pre-group 记录）/ restoreKey（seq 守卫）
                 + kickWalRecovery（truncate 到 poison 偏移）→ 抛 ambiguous 错误
       settleGroup
       if valueMode==='disk': publishWalRef   ← done 后才发布磁盘指针（此前字节不在文件里！）
       maybeAutoCompact()
```

**为什么 apply 与 append 必须同 tick**：压缩的快照阶段与写并发——`applyOp` 在 `wal.append` 之后同步执行，保证 fence 时刻 store 已含该写；若两者跨 await，压缩可能拍下"WAL 有帧但 store 没有"或反之的中间态（虽有 WAL 重放兜底，但会让快照-指针错位）。disk 模式下指针发布延迟到 `done` 之后，是因为 `appendLoc` 的偏移是**预测值**，字节还在内存队列里，提前发布会让同步定位读越过文件尾部。

### 4.2 组提交（group commit）

```
tick N:  set(A) → appendLoc(frameA, batchId=7)
        set(B) → appendLoc(frameB, batchId=7)     ← 同 tick 共享组
        set(C) → appendLoc(frameC, batchId=7)
        └─ setImmediate(flushBatch)
macrotask: flushBatch():  writev([A,B,C]) → writeGen++ → resolve A/B/C（always 策略再 fsync）
```

- 一个 `writev(2)` 覆盖整批 → Node 纯 JS 下最大的吞吐收益（bench：并发写 everysec 组提交 ~725k ops/s，vs 逐条同步 always 模式 ~328 ops/s，差 2200 倍）。
- **失败整组回滚**：组注册表（`wal-group.ts` 的 `pendingGroups`）按 (WAL, batchId) 记录每 key 的批前记录；失败时逆序 reject、按组把 store/索引整体恢复到批前（与重开重放"整组帧一起消失"等价）；`lastGroup` 缓存让同组 op 两次引用比较命中。
- 压缩旋转替换 WAL 后，新旧 WAL 的 batchId 空间独立（`pendingGroups` 按 WAL 实例分键）。

### 4.3 非阻塞压缩（compaction）时序

```
compact():
  phase 1 fence:      wal.flush(); baseOffset = wal.size
  phase 2 snapshot:   writeSnapshot(store → db.snapshot.tmp)   ← 非阻塞，写者继续
                      （内存 ref 先写；磁盘 ref 按源文件+偏移排序、限并发/限字节分片异步读）
  phase 2.5 pre-copy: 循环 ≤5 轮：flush → head=wal.size → gap=head-copiedUpTo
                      gap ≤ 64KiB 停；不收敛（gap > prevGap*0.7）停
                      copyFileRange(wal → db.wal.tmp)
  phase 3 rotation（唯一阻塞段）:
      _rotateLock = new Promise        ← 新写者在此停车
      wal.seal()                       ← 在飞写者 append 立即 WAL_SEALED → 对端重试
      drain 循环: flush → 拷贝剩余尾部（密封后 head 不再动 → 必然终止）
      wal.close()
      rotateReplace(snapshot.tmp → db.snapshot) + fsyncDir(strict)   ← 快照先
      rotateReplace(wal.tmp → db.wal)        + fsyncDir(strict)      ← WAL 后
      fresh WAL open；remap()（磁盘指针重映射：wal 偏移 -baseOffset，旧快照指针换新快照）
      valueReader.reopenBoth()
      releaseRotation()
  phase 4 bookkeeping: stats + onCompacted()（generations 开启 = 与旋转同一事务发布新代数；
                       否则旧路径 rebuildTextPostings）
```

- **崩溃安全论证**（`compaction.ts:42-53`）：恢复总是"加载快照 + 重放 WAL"（LWW）。两个 rename **先快照后 WAL**：若崩溃落在两者之间，新快照配旧完整 WAL——重放整个旧 WAL 对 fence 前帧幂等、对 fence 后帧正确；反序（WAL 先）则旧快照配截断新 WAL，丢失 fence 前数据。该论证依赖每次 rename 后严格 fsync 目录，故 rotation 的目录 fsync 是 **strict**（失败即中止旋转回滚）；不支持目录 fsync 的平台显式降级（`dirFsyncUnsupported` 警告一次）。
- **pre-copy 收敛控制**：写风暴中 append 速率 ≈ 拷贝速率时 gap 永不缩小，死循环会让压缩永久停滞（注释记录实测：WAL 无界增长、磁盘放大 ~20x）——所以给 5 轮 + 0.7 收敛比，不收敛就让旋转段吸收残余尾部（Redis AOF diff flush 同样接受有界尾部停顿）。
- **磁盘指针重映射**（`remap`，`compaction.ts:321`）：`loc.file==='wal' && off>=baseOffset` → 新 WAL 中偏移 `off-baseOffset`；否则查 `snapRes.locs` 换新快照位置。与 fd 重开同一同步段完成，同步读者永远看不到"新指针配旧 fd"。
- **旋转失败自愈**：seal 是单向的，seal 后任何失败都会让后续写永久卡死 → catch 块换入**全新 WAL**（在路径当前真实 EOF 追加）；`rotated` 标记决定是否需要 remap + reader reopen；若自愈也失败，磁盘对保持一致，下个进程打开仍可恢复。

### 4.4 打开流程（`lifecycle.ts:114`）

```
MiniDb.open(opts)
  ├─ 校验 opts；readOnly 先 readdir 探测目录存在（不创建）
  ├─ resolveValueMode('auto' → 比较 snapshot+wal 尺寸 vs maxMemoryBytes)
  ├─ MaintenanceScheduler 创建（free-space 预检估计函数注入）
  ├─ LockFile.acquire()         失败 → onLockFail:'readonly' 降级 或 LockError
  ├─ writer: 清扫陈旧 tmp（STALE_TMP_FILES / 唯一后缀 tmp / postings tmp / 代数 tmp）
  ├─ Store 创建；WAL 创建（readOnly 不 open——'a' 模式会创建文件）
  ├─ 加载索引定义 sidecar（在恢复之前！generation 载入要按定义哈希匹配镜像）
  ├─ indexGenerations 开启 → tryLoadGeneration()
  │    └─ 成功: store 镜像 bulkLoad + 索引镜像 + WAL delta 重放
  ├─ 否则（回退）recover():  stat 配对快照/WAL（dev/ino 指纹，防读副本错配）
  │    └─ 加载快照 → 重放 WAL → 撕裂尾部截断（resync 模式可跨损坏帧重同步）
  │    └─ valueMode==='disk' → ValueReader 打开并校验 inode 一致
  │    └─ rebuildAllIndexes()（文本索引按 deferOpenTextBuilds 决定延迟到后台）
  ├─ 写者: autoCompact && shouldCompact → 后台 submitCompaction（fire-and-forget）
  ├─ generation 缺失/陈旧 → 后台 buildGeneration('open')
  └─ 失败路径: 等压缩/排空、关文本索引/WAL/ValueReader/Store/锁、打 readOnlyOpen 标记
```

### 4.5 关闭流程（`lifecycle.ts:363`）

```
close()
  ├─ 并发 close 共享同一 closePromise；失败后 state 保持 'closing' 可重试
  ├─ generationStale() → best-effort buildGeneration('close')   （state 翻转前，写者仍可写）
  ├─ state='closing'
  └─ closeResources（依赖序）:
       genBuildAbort().abort()           → 立即回收 worker
       maintenance.close()               → publishing 段等待、其余取消
       等在飞压缩（失败不传播）；等在飞 generation 构建
       while (!walRecoveryIdle) await chain    ← 毒化恢复链排空（循环等！）
       closeAllTextIndexes → 删 roScratchDir → store.close → valueReader.close
       → wal.close（bgSync 排空 → final flush+sync → 关 fd）→ 再等恢复链 → lock.release
       → 全部错误聚合成 AggregateError 抛出
```

### 4.6 WAL 毒化 → 原地恢复状态机

```
            writev/fsync 失败
  正常 ──────────────────────────► 毒化(poisoned={failedAtOffset,error})
   │   append 拒绝 'WAL_POISONED'       │  owner: wal.whenIdle()（等 in-flight 批尘埃落定）
   │   flush 抛错 / sync no-op          │  truncate(db.wal, failedAtOffset)  ← 精确去未确认字节
   │   close 跳过 final flush           │  refreshSize() → clearPoison()
   └───────────────────────────────────► 正常（恢复）
  截断失败 → writeDisabled（写全拒+ambiguous、读正常、close 不 flush；重开重放时被拒写复活）
```

`poisonPending`（`wal.ts:340`）是同机制的另一入口：**applyOp 违反"不抛错"契约**（防御层）时，已入队未确认的帧必须永远不上盘——按"队列起点"毒化并逆序 reject，与写失败统一走恢复。

### 4.7 在线备份 fence（`backup.ts:60`）

```
backup(dest)
  ├─ 等在飞压缩；非 readOnly 且未禁用 → compact()
  ├─ writeOps.pause()     ← 门同步关闭；新写 enter()=false → BACKUP_IN_PROGRESS
  ├─ await drain          ← 排水完成 = 线性化点（此前确认的写全在备份里）
  ├─ serializeBackups(…)
  │    ├─ 复制全部持久文件 → 同级 tmp 目录（逐文件 fsync）
  │    ├─ manifest.json 最后写          ← 提交标记（在盘即全量完整且持久）
  │    └─ tmp 目录原子 rename 到目标（旧备份先挪开，rename 失败则还原）
  ├─ writeOps.resume()    ← 引用计数：最后一个 pauser 才重开
  失败在 rename 前 → 目标不动、tmp 删除，绝无半备份
```

### 4.8 ClusterDb 读写路径

```
set(k, v):  shardId = stableHash32(k) % N
  ├─ pool.withWriter(shardId): 缓存命中 → 直接提交；未命中 → acquire()（重试竞争）→ open → applyDefs
  │    └─ lockRenew 定时器保活；lockHoldMs 到点让出
  └─ 提交后留在缓存（下次命中零成本）

get(k):  pool.withReader(shardId):
  ├─ 本进程持写锁 → 用缓存的 writer 实例
  └─ 否则 → 缓存只读实例 → 指纹比对（WAL 增量为快路径，帧数超阈值或其它文件变更 → 重开）
       └─ 落后 → catchUpFromWal(offset) 增量应用 WAL 帧（含派生索引维护，跳过 unique 校验）

scan()/query()/search(): 全分片扇出 → 全局归并（scan 按 UTF-8 字节序；query skip=0 limit=skip+limit 再重排）
```

---

## 5. 重要实现细节

### 5.1 设计权衡：为什么自研（DESIGN_NOTES 的答案）

DESIGN_NOTES.md 明确记录了动机——对照研读五份参考源码后的取舍：

1. **log-structured 而非 paged B-tree**：cstack/db_tutorial 的教训是"分页引擎的真实成本"——页缓存、原地覆写、节点分裂/合并、父指针、分隔键、根节点特例，而那个玩具版**仍然没有 WAL/fsync/崩溃恢复**。日志结构换来顺序写（磁盘最快访问）、重放式恢复、简单崩溃安全，代价是"需要内存索引 + 压缩策略 + 范围扫描更麻烦"——后两者分别用 Map/跳表和二级索引解决。
2. **用 V8 Map 代替自研哈希表**：Redis 的增量 rehash、幂二扩容、负载因子管理，Node 的 `Map` 免费提供——"That is the big win of targeting Node"。
3. **NeDB 的并发-1 executor 免费获得**：单线程事件循环天然串行化内存索引更新与 WAL 追加，只需显式 flush 门保证帧不乱序。
4. **为什么不用 SQLite/LevelDB（原生绑定）**：约束第一条就是 *pure Node.js, zero native addons*——Kimi Code 需要把数据库打进 SEA 单文件可执行（`apps/kimi-code/src/native/minidb-worker.ts` 佐证），且会话数据量（万级文档、JSON、全文检索）不值得引入原生依赖。
5. **性能定位**（README bench）：读 ~8M ops/s（贴裸 Map 的 ~8.6M）、并发写 everysec 组提交 ~725k ops/s、压缩 100k key 快照 ~69ms——对会话/搜索负载绰绰有余；代价是"数据集须在 RAM"（`valueMode:'disk'` 提供溢出通道，实测堆开销 ~0.6KB/小 key，1M 小 key ≈ 600MB 堆）。

### 5.2 提交点语义（commit point）——全库最精细的部分

- **提交点 = 帧的 `done` Promise resolve**（写进 OS page cache；`always` 策略含 fsync）。`set()` resolve 前，内存状态可能已变（apply 先行），因此**失败路径必须回滚**，否则重开重放会"复活"被拒写的状态。
- **组回滚 + 模糊标记**：写失败 → 整 flush 组回滚到批前记录（`restoreGroupKey` 逐 key 恢复 store/dt/compound/secondary/text 全派生态）；错误被 `markAmbiguous` 标记——因为"WAL 写失败"发生时，磁盘上到底有没有这批字节是**未知的**（writev 部分落盘），调用方不能假设"rejected 即无效果"。`ambiguous` 语义贯穿毒化/截断/`writeDisabled`。
- **applyOp 契约**（`write-path.ts:525`）："must not throw"是结构性的——所有可失败输入验证都在 prepare；唯一残留的可失败分支（写操作与 createTextIndex 竞态注册）由提交体防御性 try + 毒化兜底（stage 7/11 注释）。
- **WAL_SEALED 透明重试**（`retryOnWalSeal`，`write-path.ts:107`）：gate 检查与 append 不在同一同步段（内存预算检查可能让出微任务），因此"通过门禁的写"可能在 final flush 与 close 之间撞上刚密封的旧 WAL——op 先回滚自身副作用，等旋转结束对**新 WAL** 重跑（幂等 commit body）。这是压缩"绝不丢已 resolve 的写"的最后一环。

### 5.3 只读副本与 generation 配对（recovery.ts 头部）

- **stat 配对**：只读 opener 扫描 snapshot/WAL 时，若恰逢写者压缩旋转（两次 rename 之间），可能把旧快照配新截断 WAL——静默丢数据 + disk 模式指针指向错误 inode。`recover()` 因此跑**有界多趟**：每趟对两个文件做 dev/ino/size 指纹（打开 fd 前 + 最后读后重 stat），任何代数切换（inode 变、尺寸缩、文件出现/消失）→ 整趟作废、指数退避重试；同一 inode 上 WAL 仅增长是安全的（append-only，多余帧由 catch-up 覆盖）。耗尽重试抛 `RecoveryGenerationChurnError`。
- **catchUpFromWal**（`mini-db.ts:1356`）：读副本的增量同步——续接偏移必须匹配上次扫描终点 + WAL inode 必须一致，否则返回 null（调用方整体重开）；写者 writev 未落全的撕裂尾部**不是错误**，扫描停在最后一个完整帧，稍后重试 CRC 即通过。

### 5.4 内存管理与 TTL

- **maxMemory 预算**是"近似逻辑字节"（key+value+dt 元数据），非真实堆（实测每 key ~0.6KB 堆开销，文档明确警告）。`ensureMemoryFor`（`memory-guard.ts:77`）顺序：`reapExpiredDue()`（堆驱动 O(due)，非全表扫）→ 投影字节计算（按 op 逐 key 差分）→ evict-lru（`access` Set 插入序 = LRU..MRU，O(1) 受害者选取；逐出走**完整 DEL 提交**——WAL 帧 + 组注册 + 幂等重试）→ 仍超 → reject。
- **TTL 主动过期**的三种保护：per-tick 限量（默认 100）+ **时间预算**（2ms 内持续排空风暴）+ aggressive 模式切换（整 tick 排满 → 下轮加大预算，Redis fast cycle 对应物）；min-heap 短路空闲。

### 5.5 锁文件（`lockfile.ts`）——多进程正确性的隐蔽工程

- O_EXCL 创建 + **令牌**（`pid:uuid`）承载于 lock/bid/watch 三个文件；`mine` 比较令牌（同进程两个实例互相可见）。
- stale 接管**只在 owner PID 已死**时发生（`process.kill(pid,0)`），永不因"太老"接管。
- 接管是**竞争协议**：先写 watch（让竞争者全程可见）→ 检查 → 写 bid → rename → **自适应 settle 等待**（`60ms~2s`，按本次接管耗时的 4 倍缩放——固定值在共享 CI 上会被调度停顿击穿）→ 终验。注释承认残余窗口（竞标者 bid 被延迟超过胜者终验）需要"整次尝试 + settle 时长"级的进程级停顿才会双赢。
- `beforeExit` 钩子同步释放全部持有锁（安全网）。

### 5.6 事件循环友好性（异步不阻塞主线程的层层设计）

- 快照编码**分块 + 每 2000 条让出**（`yieldToLoop` via setImmediate）。
- disk 模式快照值读取：按 (file, offset) 分组排序 → **限并发（默认 8）异步定位读** + 每片 8MiB 字节预算——顺序 I/O 而非随机 readSync，CPU 与在飞内存都平坦。
- 全文构建走 **worker_thread**（`worker/text-build-core.ts`）：有界内存聚合（超 `textBuildMemoryBytes` 落排好序的段 → 分段外部归并）+ Node 原生 type-stripping（`--experimental-transform-types`）；worker 只写 tmp 目录，主线程**验证（sanity + 流式 crc）后**才 `commitRebase` 换基座；worker 缺失/槽位不足/自定义分词器/小语料（<4096 文档）→ 同一有界核心内联在主线程；整个聚合缓冲不再随 (doc,term) 对总数线性增长。
- 维护调度器（`maintenance.ts`）：每库同时一个重型任务、队列背压（满则 `MAINTENANCE_BACKPRESSURE`）、statfs 磁盘预检、AbortSignal 取消、`markPublishing()` 后关闭**等待**而非取消、嵌套提交经 AsyncLocalStorage 内联防自死锁。

### 5.7 边界情况与防御（从注释/测试归纳）

- key 空串/超长（128 上限，帧层 64KiB）、TTL NaN/±Infinity 预拒、写操作零副作用排序（校验 → evict → 提交，被拒写不驱逐任何东西）。
- 恢复模式：`resync`（默认，跳过坏帧 + 扫描 MD magic 重同步 + 报告 corruptRanges，随机字节通过 magic+len+crc32 ≈ 1/2³² 概率）vs `strict`（首错即弃尾）。
- `openOrRebuild`（可重建缓存语义）：只对"能拥有目录的打开"重建；`readOnlyOpen` 标记错误直接重抛（只读旁观者绝不可删活写者的文件——注释记录过真实事故：readonly 回退删掉了写者的 sidecar）；SyntaxError（sidecar 损坏）先删 sidecar 重试一次再整体重建；瞬时 IO 错误（EACCES/ENOSPC/EMFILE）一律重抛不重建。
- Windows 特殊处理：rename 覆盖开放目标 EPERM → `renameReplace` 重试助手；旋转前关 ValueReader；POSIX 保留 fd 读已 unlink 的旧 inode。
- BATCH 帧结构校验：外层 CRC 合法但子 op 畸形 → 整批跳过（`corruptBatches` 统计），绝不半应用。
- generation 载入的并发安全：写者打开时把镜像灌入**全新状态**再整体换绑（`beginRebuild`/`loadImage` 都是 swap-in），中途失败旧索引完好。

### 5.8 测试与基准的严谨度

- e2e 套件：`fuzz-model`（种子化随机 op vs 参考模型）、`crash-recovery`（kill -9 于写中/压缩中）、`index-consistency`（五类索引与 store 永不漂移）、`compaction-race`、`recovery-matrix`（头/中/尾损坏 × resync/strict）、`durability`、`boundary`、`soak`（opt-in 30s 堆稳定）。
- cluster 套件：真多进程（mp-worker）、锁竞争/租约续期、跨分片索引/压缩、崩溃接管（kill -9 → 连续恢复 + stale-lock 交接）。
- bench：`import-kimi-code.ts`/`session-store.ts`/`message-composed.ts`/`message-range.ts` 直接模拟 Kimi Code 会话数据形状；`search-baseline` vs `search-kimi-code` 对比。

---

## 6. 关键代码位置索引

### 存储引擎

| 位置 | 说明 |
|---|---|
| `src/codec.ts:26-33` | 帧常量：MAGIC "MD"、TYPE_SET/DEL/BATCH、HEADER_SIZE=22、CRC_SIZE=4 |
| `src/codec.ts:96-103` | `CorruptFrameError`（带损坏偏移） |
| `src/codec.ts:110-130` | `encodeFrame`：22 字节头 + payload + CRC trailer 单缓冲编码 |
| `src/wal.ts:30` | `FsyncPolicy`：'always'/'everysec'/'no'（Redis AOF 三态） |
| `src/wal.ts:82-134` | `WAL` 类与 open()：'a' 模式打开、尺寸/偏移初始化、everysec 定时器 |
| `src/wal.ts:160-171` | `backgroundTick`：空闲不 fsync、失败不拒绝写只记 stats |
| `src/wal.ts:188-217` | `appendLoc`：同步预测偏移+batchId，setImmediate 调度 flush |
| `src/wal.ts:225-312` | `flushBatch`：writev 组提交、short-write 重试、毒化点 = 批首帧偏移、逆序 reject 队列 |
| `src/wal.ts:340-344` | `poisonPending`：applyOp 违约时按队列起点毒化 |
| `src/wal.ts:409-426` | `sync`：fsync 只推进到发起时的 writeGen（在飞并发 flush 不算数） |
| `src/store.ts:118-147` | `Store`：map + 有序跳表 + TTL 堆 + 近似字节记账 |
| `src/store.ts:218-243` | `setRef`：seq 递增、陈旧堆条目 2 倍阈值重建 |
| `src/store.ts:392-415` | `activeExpire`：限量 + 时间预算 + aggressive 模式 |
| `src/store.ts:375-390` | `bulkLoadRefs`：generation 载入 O(N) 灌入 |
| `src/snapshot.ts:55-189` | `writeSnapshot`：内存值先写、磁盘值分组排序限并发异步读、~1MiB writev 批 |
| `src/recovery.ts:44-85` | `RecoveryMode`/`ValueMode`/`RecoveryInfo`（含 generation 配对信息） |
| `src/recovery.ts:105-113` | `RecoveredOp` 与 `frameToOps`：打开恢复/catch-up/代数重放三方共享的解释层 |
| `src/compaction.ts:115-117` | `shouldCompact`：WAL ≥ 阈值 |
| `src/compaction.ts:142-166` | `fsyncDir`：strict 失败即抛；不支持平台显式降级 |
| `src/compaction.ts:211-236` | `compact`：compacting 去重 + `_compactDone` 共享 |
| `src/compaction.ts:238-400` | `runCompaction` 全流程（fence/snapshot/pre-copy/rotation/remap/失败自愈） |
| `src/compaction.ts:321-331` | `remap`：磁盘指针重映射（wal 偏移平移 + 快照换新） |

### MiniDb 门面与 facet

| 位置 | 说明 |
|---|---|
| `src/mini-db.ts:74-138` | `MiniDb` 类字段：状态机（open/closing/closed）、`_rotateLock`、writeOps 门闩、各 serializer |
| `src/mini-db.ts:487-510` | `MiniDb.open` / `openOrRebuild` |
| `src/mini-db.ts:1031-1057` | `recoverWalInPlace`：毒化 → 截断 → refreshSize → clearPoison（含陈旧坐标守卫） |
| `src/mini-db.ts:1092-1145` | `set`/`del`/`batch`/`expire` 等写 API 委托 writePath |
| `src/mini-db.ts:1149-1165` | `scan`/`prefix`/`dtColumns`/`dtRange` |
| `src/mini-db.ts:1169-1183` | `createIndex`/`findEq`/`findRange` |
| `src/mini-db.ts:1203-1209` | `compoundRange`：组内有序范围（O(log N + limit)） |
| `src/mini-db.ts:1213-1259` | `createTextIndex`/`search`/`searchBounded(Async)` |
| `src/mini-db.ts:1263-1273` | `query`/`queryAsync` |
| `src/mini-db.ts:1296-1328` | `backup`/`restore` |
| `src/mini-db.ts:1356-1364` | `catchUpFromWal`：读副本增量追赶（inode 锚定续接） |
| `src/mini-db.ts:1379-1381` | `close` |
| `src/write-path.ts:202-228` | `set` 全管道：校验→prepare→unique→ensureMemoryFor→retryOnWalSeal |
| `src/write-path.ts:232-300` | `commitSetOp`：同 tick append+apply、组登记、done 后发指针 |
| `src/write-path.ts:358-465` | `batch`：单 BATCH 帧 + 批级回滚 + 每 key 最后 set 才发指针 |
| `src/write-path.ts:473-518` | `prepareSet`/`prepareDel`：canonical 重解码、prepare 边界分词 |
| `src/write-path.ts:534-594` | `applyOp`：不抛错契约；同 tick 喂五类派生索引 + generation 构建队列 |
| `src/write-path.ts:607-640` | `restoreKey`/`restoreGroupKey`：seq 守卫回滚、回滚会中止在飞代数构建 |
| `src/lifecycle.ts:114-358` | `openMiniDb` 全流程（含失败清理与 readOnlyOpen 标记） |
| `src/lifecycle.ts:363-468` | `closeMiniDb`/`closeResources`：依赖序 teardown + AggregateError 聚合 |
| `src/lifecycle.ts:488-524` | `openOrRebuildMiniDb`：LockError/IO 错误重抛、SyntaxError 先删 sidecar 重试 |
| `src/wal-group.ts:40-79` | `WalGroupTracker`：组回滚注册表 + lastGroup 缓存 + 恢复链门闩 |
| `src/op-tracker.ts:57-129` | `OpTracker`：enter/leave/pause(引用计数)/resume/close——全库 drain 原语 |
| `src/memory-guard.ts:77-101` | `ensureMemoryFor`：TTL 排空 → evict-lru → reject |

### 索引与查询

| 位置 | 说明 |
|---|---|
| `src/skiplist.ts:7-19` | 跳表常量（max level 32、P=0.25）与 `randomLevel` |
| `src/skiplist.ts:59-120` | `SkipList` 类与 `bulkLoad`（平衡 4 叉塔 O(N) 构建） |
| `src/index-manager.ts:209-228` | `IndexManager` 与 `staged` 事务区 |
| `src/index-manager.ts:335-364` | `checkUnique`/`checkUniqueBatch`（批后状态验证 + assertVacated） |
| `src/index-manager.ts:406-441` | `findEq`/`hasEq`/`findRange` |
| `src/index-manager.ts:455-477` | `beginRebuild`：全新状态 swap-in，失败不伤旧索引 |
| `src/index-manager.ts:481-544` | `exportImage`/`loadImage`：代数镜像序列化/载入 |
| `src/dt-index.ts:23-98` | `DtIndex`：每列跳表 + byKey 反查 + 惰性列创建/空列回收 |
| `src/compound-index.ts:43-56` | `CompoundIndexManager`：组值 → 有序 pk 跳表 |
| `src/query.ts:12-53` | `tokenizePath`/`getPath`/`setPath`（点 + 方括号路径） |
| `src/query-engine.ts:155-223` | `tryDtOrderedLimit`：dt 有序 fast path |
| `src/query-engine.ts:225-329` | `query` 主管道：候选集交集 + 惰性迭代 + 早期 skip/limit |
| `src/text-index/index.ts:73-79` | `TextIndexBuildingError` |
| `src/text-index/index.ts:81-189` | `TextIndex`：delta/墓碑/词典/双基座（memBase/磁盘 pf）/baseEpoch |
| `src/trigram.ts:66-80` | `createNgramTokenizer`：2/3 元 crc32 哈希（查询端更少更选择性） |
| `src/text-postings.ts` | 磁盘 postings（delta+varint + CRC 帧 + 解码 LRU） |

### 代数（generation）、维护与集群

| 位置 | 说明 |
|---|---|
| `src/generation.ts:64-111` | 持久文件名权威清单（SNAPSHOT/WAL/sidecar/postings 模式） |
| `src/generation.ts:139-211` | `ManifestFileInfo`/`GenerationCheckpoint`/`GenerationManifest`/`indexDefHash` |
| `src/generation.ts:223-260` | `FINGERPRINT_FILES`/`isPersistentFile`/陈旧 tmp 模式 |
| `src/gen-codec.ts:29-37` | `GenerationCorruptError`；magic+版本+crc 信封格式 |
| `src/generation-builder.ts` | 代数构建：fence 密封检查点、镜像序列化、CURRENT 原子发布 |
| `src/generation-loader.ts` | 代数载入：镜像校验、定义哈希匹配、WAL delta 重放 |
| `src/maintenance.ts:28-52` | `MaintenanceKind`/`MaintenanceContext`（signal + markPublishing） |
| `src/maintenance.ts:70-93` | 背压/关闭/取消三类类型化错误 |
| `src/backup.ts:40-44` | `backupInProgressError`（BACKUP_IN_PROGRESS） |
| `src/backup.ts:60-80` | `backup`：fence → drain → 原子复制 |
| `src/lockfile.ts:24-30` | `LockError`（ELOCKED） |
| `src/lockfile.ts:74-120` | `LockFile`：令牌、watch-bid-rename 接管协议、串行化 |
| `src/cluster/index.ts:69-139` | `ClusterDb`：open（拓扑/路由/锁池/协调器组装）与 applyDefs |
| `src/cluster/types.ts:17-65` | `CrossShardMode`（2pc 预留拒绝）与全部集群选项 |
| `src/cluster/lock-pool.ts` | 分片锁池：租约续期、lockHoldMs 让出、LRU 淘汰、指纹再校验 |
| `src/server.ts:34-88` | `RespParser`：内联 RESP 解析（inline 命令 + 数组协议） |
| `src/server.ts:90-130` | `handle`：PING/ECHO/GET/SET/DEL/EXISTS/MGET/MSET/TTL/DBSIZE/COMPACT/INFO/QUIT |
| `src/worker-runtime.ts:33-60` | `configureTextBuildWorkerRuntime`：SEA 打包 worker 入口注入 |

---

## 7. 与其它子系统的接口

### 7.1 对外暴露的 API 面（三个导出入口）

**入口 `"."`（`src/index.ts`）**：`MiniDb` 类 + `UniqueViolationError` + `LockError` + `OpTracker`（明确标注为 kap-server 搜索服务共享）+ `TextIndexBuildingError` + `normalizeLiteral`/`createNgramTokenizer`/`tokenize` + 全部公共类型（`OpenOptions`/`SetOptions`/`BatchInputOp`/`QueryOptions`/`IndexDef` 等）+ `RecoveryInfo` 类型。

`MiniDb` 的主要公共方法（约 40 个）：
- 生命周期：`MiniDb.open` / `MiniDb.restore` / `MiniDb.openOrRebuild` / `close` / `renewLock` / `maintenanceStatus`
- KV：`get`(同步) / `getAsync` / `set` / `del` / `has` / `size` / `mget` / `mset` / `batch` / `expire` / `ttl`
- 扫描：`scan` / `prefix`
- 索引：`createIndex` / `dropIndex` / `listIndexes` / `findEq` / `findRange` / `createCompoundIndex` / `dropCompoundIndex` / `listCompoundIndexes` / `compoundRange` / `dtColumns` / `dtRange`
- 全文：`createTextIndex` / `dropTextIndex` / `search` / `searchBounded` / `searchAsync` / `searchBoundedAsync` / `textIndexBuilding`
- 查询：`query` / `queryAsync`
- 维护：`compact` / `backup` / `rebuildGeneration` / `getIndexGeneration`

**入口 `"./cluster"`**：`ClusterDb`（`open`/`set`/`mset`/`get`/`scan`/`query`/`search`/`createIndex`/`compact`/`close` 等）+ `Router`/`Topology` + 集群选项类型。

**入口 `"./worker-runtime"`**：`configureTextBuildWorkerRuntime` / `getTextBuildWorkerRuntimeState` / `resetTextBuildWorkerRuntime`（仅 SEA 打包场景）。

### 7.2 调用方与用法（grep 实证）

| 调用方 | 用法 | 关键 API |
|---|---|---|
| `packages/kap-server/src/search/searchService.ts:70` | 全局搜索服务后端 | `MiniDb`(json codec)、`batch()`、`searchBoundedAsync`、`OpTracker`、`TextIndexBuildingError`、`normalizeLiteral`、`tokenize` |
| `packages/agent-core-v2/src/persistence/backends/minidb/miniDbQueryStore.ts:58-59` | 会话查询存储 | `ClusterDb`（`@moonshot-ai/minidb/cluster`）、`QueryOptions` |
| `apps/kimi-code/src/native/minidb-worker.ts:4-6` | SEA 单文件打包 | `configureTextBuildWorkerRuntime`（注入打包后的 text-build worker 资产路径） |
| `apps/kimi-code/src/native/smoke.ts:5` | 冒烟验证 | `MiniDb` |

### 7.3 契约要点（调用方必须知道）

1. **同步读、异步写**：`get`/`scan`/`query`/`search` 同步返回（disk 模式下同步定位读可能短暂阻塞事件循环——README 明确警告冷读与冷 postings 列表）；`set`/`del`/`batch` 是 Promise，按 fsync 策略 resolve。
2. **单写者**：一个目录同时只允许一个 writer；`onLockFail:'readonly'` 可降级只读；多进程并发必须用 ClusterDb 或 RESP server。
3. **写失败可能模糊**：提交点失败的错误带 `ambiguous` 语义，重开可能复活被拒写——调用方不应在 reject 后假设 key 一定没写。
4. **备份期间写被拒**：`BACKUP_IN_PROGRESS` 错误，可重试。
5. **文本索引可能"构建中"**：延迟构建未完成时 `search` 抛 `TextIndexBuildingError`，通过 `textIndexBuilding(name)` 查询状态。
6. **数据集须在 RAM**（memory 模式）；`valueMode:'disk'` 支持超 RAM 但冷读付磁盘代价；`auto` 按持久化文件尺寸 vs `maxMemoryBytes` 启动时自动选择。

---

## 附：一句话架构总结

minidb 是一个被反复打磨的**日志结构嵌入式数据库**（Bitcask/Redis AOF 血统）：内存 `Map` 做主索引、CRC 帧 WAL 做持久化、非阻塞快照压缩做空间回收、跳表家族做范围/排序查询、倒排索引做全文检索、generation 检查点消除启动重建、ClusterDb 用"分片 + 每分片单写者"换取多进程水平扩展——整套设计围绕一个核心不变式：**WAL 是唯一真源，一切索引都是可重建的派生状态，恢复永远"加载快照 + 重放 WAL（LWW）"**。
