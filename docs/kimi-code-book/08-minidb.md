# 第 8 章 minidb：自研嵌入式数据库

> 研究对象：`packages/minidb`（约 1.8 万行 TS，零运行时依赖，仅 `node:*` 内置模块）。
> 学习目标：理解一个"教科书级"的日志结构嵌入式数据库——Redis 风格内存 KV + SQLite 风格持久化（WAL + 快照 + 组提交 + 崩溃恢复），外加二级索引、全文检索与多进程分片。

## 8.1 定位与演化

minidb 是 **pure-Node.js 嵌入式键值/JSON 文档数据库**：`"A pure-Node.js embedded key-value database mixing Redis-style in-memory KV with SQLite-style durable persistence (WAL + snapshot)"`。

- **Redis 侧**：内存 `Map` 主索引 O(1) GET/SET、TTL（惰性 + 主动过期）、AOF 式 WAL 重写（BGREWRITEAOF 思想）、跳表（zskiplist）、RESP 协议服务器、maxmemory 驱逐策略。
- **SQLite 侧**：append-only WAL + 快照、group commit、三种 fsync 策略（`synchronous` FULL/NORMAL/OFF 对应物）、单写者多读者、索引化查询。

**在 Kimi Code 中的角色**：

1. **kap-server**：用 `MiniDb` 构建全局会话/消息全文搜索服务（`searchService.ts`——写入用 `batch()`，读取用 `searchBoundedAsync`）；
2. **agent-core-v2**：用 **`ClusterDb`**（`/cluster` 子路径）做会话查询存储——多进程分片、跨分片合并查询；
3. **apps/kimi-code**：把 text-build worker 打包进 SEA 资产。

**演化脉络**（从代码注释里的 stage 编号还原）：stage 1-4 基础存储（Map + WAL + 快照 + 压缩 + 索引 + RESP server）；stage 5 **persistent index generations**（加载检查点 + WAL 增量重放，替代"打开时全量重建"）；stage 6 统一维护调度器 + worker 线程化文本构建 + 异步读 API；stage 7-12 围绕**提交语义**（WAL 毒化/组回滚/模糊提交）、在线备份、openOrRebuild、并发正确性加固。README 中大量 `review #N` 注释表明这是一份被多轮代码评审打磨过的代码库。

**为什么自研**（DESIGN_NOTES 的答案）：log-structured 而非 paged B-tree（顺序写 + 重放式恢复 + 简单崩溃安全，代价是内存索引 + 压缩策略，分别用 Map/跳表和二级索引解决）；V8 `Map` 免费获得 Redis 的增量 rehash；单线程事件循环天然串行化（NeDB 的并发-1 executor 免费获得）；**约束第一条就是 pure Node.js、零原生绑定**——Kimi Code 需要把数据库打进 SEA 单文件可执行。

## 8.2 数据模型与磁盘帧

记录 = `{ key, value, dt1..dtN }`：key 字符串 ≤128 字节、**有序**（内部以 binary 字符串规范化保证字节序）；value 任意 JSON（`buffer|string|json` 三种 codec）；dt 列是任意多个顶层时间列（epoch-ms），与 value 分离、独立索引。

磁盘帧（codec.ts:26-42）：

```
off   size  字段
 0    2    magic = 0x4D 0x44 ("MD")
 2    1    type   1=SET 2=DEL(墓碑) 3=BATCH
 4    1    flags
 6    2    keyLen uint16
 8    4    valLen uint32 (DEL 为 0)
10    4    metaLen uint32 (可无)
14    8    expireAt int64 ms (0=无)
22   k     key
22+k v     value
22+k+v m   meta (dt 列等)
22+k+v+m 4  crc32 —— 对 [type..meta] 的 CRC-32 TRAILER
```

**定长头让读者在读 payload 前即可算出全长**；CRC 作 trailer 支持单趟验证；BATCH 帧的 value 域内再嵌一组子 op——一个 batch 只有一帧 = 一次组提交。

## 8.3 写入提交路径（单次 set）

```
set(key, value, {ttl, dt})
  ├─ ensureOpen / ensureWritable
  ├─ writeOps.enter()                    ← backup 门闩：备份期间返回 BACKUP_IN_PROGRESS
  ├─ awaitRotation()                     ← 压缩旋转临界区则停车
  ├─ prepareSet():
  │    checkKey (≤128 非空)；normDt / ttl 校验（finite）
  │    encode(value) → vbuf
  │    canonical = decode(vbuf)          ← json codec：编码后重解码=持久视图（索引一致性的根）
  │    textTokens = 各 TextIndex.prepareAdd(canonical)   ← 分词器抛错在此拒绝写入
  ├─ indexes.checkUnique（存在 unique 索引时包在 serializeUniqueWrites 链中）
  ├─ memoryGuard.ensureMemoryFor（TTL 排空 → evict-lru → reject）
  ├─ retryOnWalSeal(commitSetOp)         ← WAL_SEALED / 旋转中 → 等旋转后重跑一次
  └─ commitSetOp():                      （与 wal.append 同一同步段）
       frame = encodeFrame(SET)
       appended = wal.appendLoc(frame)   ← 同步得预测偏移 + batchId
       applyOp(op, applyBox)             ← 同一 tick 改 store + dt/compound/secondary/text 索引
       groupNoteKey(group, pk, prev)     ← 组回滚登记
       await appended.done               ← 提交点：帧进入 OS page cache（always 策略含 fsync）
         └─ 失败: rollbackGroup / restoreKey（seq 守卫）+ kickWalRecovery → 抛 ambiguous 错误
       settleGroup
       if valueMode==='disk': publishWalRef   ← done 后才发布磁盘指针
       maybeAutoCompact()
```

三个关键契约：

1. **为什么 apply 与 append 必须同 tick**：压缩的快照阶段与写并发——`applyOp` 在 `wal.append` 之后同步执行，保证 fence 时刻 store 已含该写；若跨 await，压缩可能拍下"WAL 有帧但 store 没有"的中间态。disk 模式下指针发布延迟到 `done` 之后，是因为 `appendLoc` 的偏移是**预测值**，字节还在内存队列里。
2. **applyOp 契约**（write-path.ts:525）："must not throw"是结构性的——一切可能失败的验证（key 长度、TTL、编码、自定义分词器抛错）都在 prepare 边界完成，使 `applyOp` 成为纯赋值函数。
3. **提交点 = 帧的 `done` Promise resolve**。`set()` resolve 前内存状态可能已变（apply 先行），因此失败路径必须回滚，否则重开重放会"复活"被拒写的状态。**`ambiguous` 语义**：WAL 写失败发生时磁盘上到底有没有这批字节是未知的（writev 部分落盘），调用方不能假设"rejected 即无效果"。

## 8.4 组提交（group commit）

```
tick N:  set(A) → appendLoc(frameA, batchId=7)
        set(B) → appendLoc(frameB, batchId=7)     ← 同 tick 共享组
        set(C) → appendLoc(frameC, batchId=7)
        └─ setImmediate(flushBatch)
macrotask: flushBatch():  writev([A,B,C]) → writeGen++ → resolve A/B/C（always 策略再 fsync）
```

- 一个 `writev(2)` 覆盖整批——Node 纯 JS 下最大的吞吐收益（bench：并发写 everysec 组提交 ~725k ops/s，vs 逐条同步 always 模式 ~328 ops/s，差 2200 倍）。
- **失败整组回滚**：组注册表（wal-group.ts）按 (WAL, batchId) 记录每 key 的批前记录；失败时逆序 reject、按组把 store/索引整体恢复到批前（与重开重放"整组帧一起消失"等价）。
- **毒化语义**（WAL_POISONED）：写失败后所有 append 立即拒绝；owner 通过 `recoverWalInPlace` **原地恢复**——`truncate(db.wal, poison.failedAtOffset)` 精确去掉未确认字节。截断失败 → `writeDisabled` 状态（写全拒绝、读继续、close 跳过最终 flush——被拒写的残留帧在重开重放时"复活"）。`poisonPending` 是同机制的另一入口：**applyOp 违反"不抛错"契约**时，已入队未确认的帧必须永远不上盘。

## 8.5 非阻塞压缩（compaction）

```
compact():
  phase 1 fence:      wal.flush(); baseOffset = wal.size
  phase 2 snapshot:   writeSnapshot(store → db.snapshot.tmp)   ← 非阻塞，写者继续
  phase 2.5 pre-copy: 循环 ≤5 轮：flush → head=wal.size → gap=head-copiedUpTo
                      gap ≤ 64KiB 停；不收敛（gap > prevGap*0.7）停
                      copyFileRange(wal → db.wal.tmp)
  phase 3 rotation（唯一阻塞段）:
      _rotateLock = new Promise        ← 新写者在此停车
      wal.seal()                       ← 在飞写者 append 立即 WAL_SEALED → 对端重试
      drain 循环: flush → 拷贝剩余尾部（密封后 head 不再动 → 必然终止）
      rotateReplace(snapshot.tmp → db.snapshot) + fsyncDir(strict)   ← 快照先
      rotateReplace(wal.tmp → db.wal)        + fsyncDir(strict)      ← WAL 后
      fresh WAL open；remap()（磁盘指针重映射）；valueReader.reopenBoth()
      releaseRotation()
  phase 4 bookkeeping: stats + onCompacted()（generations 开启 = 同一事务发布新代数）
```

- **崩溃安全论证**：恢复总是"加载快照 + 重放 WAL"（LWW）。两个 rename **先快照后 WAL**：若崩溃落在两者之间，新快照配旧完整 WAL——重放整个旧 WAL 对 fence 前帧幂等、对 fence 后帧正确；反序则旧快照配截断新 WAL，丢失 fence 前数据。该论证依赖每次 rename 后**严格 fsync 目录**（不支持的平台显式降级）。
- **pre-copy 收敛控制**：写风暴中 append 速率 ≈ 拷贝速率时 gap 永不缩小（实测 WAL 无界增长、磁盘放大 ~20x）——5 轮 + 0.7 收敛比，不收敛就让旋转段吸收残余尾部。
- **旋转失败自愈**：seal 是单向的，seal 后任何失败都会让后续写永久卡死 → catch 块换入**全新 WAL**（在路径当前真实 EOF 追加）。

## 8.6 索引体系

| 索引 | 数据结构 | 查询 |
|---|---|---|
| 主键 | `Map` + 有序跳表 | O(1) get；O(log N) range/prefix |
| dt 列 | 每列一个 `SkipList<number,string>` | O(log N) range / 有序迭代 |
| 二级 equality | `Map<scalarKey, Set<pk>>` | O(1) findEq |
| 二级 range | `SkipList` | O(log N + limit) |
| 复合索引 | 每组值一个 `SkipList`（orderBy 键, pk） | 组内有序范围，无全排序 |
| 全文索引 | 内存字典 + 磁盘 postings + 内存 delta/墓碑 | TF-IDF 评分、AND/OR |

- **SkipList**：Redis zskiplist 泛化，**span 字段**实现 O(log N) rank 与高效分页；`bulkLoad` 对已排序输入做确定性平衡 4 叉塔构建（O(N)），供 generation 镜像载入。
- **二级索引事务**（index-manager.ts:221）：`staged → persist → publish` 三步——create 时索引先进 `staged` 私有区（对查询不可见，但写维护路径已开始喂它，unique 校验也对其生效），sidecar 原子持久化成功后 `publish()` 才移入 live map。消除"并发 create 共用同一 tmp 文件"与"持久化失败导致注册表与磁盘分叉"两类竞态。
- **unique 校验**：`checkUniqueBatch` 是"批后状态"验证——按 value 建批内 claim map + 对 live holder 做 `assertVacated`（holder 是 claimant 本人或批内删除/迁走者才算合法）——因此"两个 key 交换唯一值"这类合法转换被接受，且与顺序无关。

**查询引擎**（query-engine.ts）：候选集收集顺序 = key（惰性迭代器）→ dt 各列求交 → text 全文命中求交 → filter 中可索引谓词交集 → 全空则全表扫描。**dt 有序 fast path**（tryDtOrderedLimit）：查询恰好"单 dt 列范围 + 按该列排序 + 有 limit"时，直接按 dt 跳表顺序游走、命中 limit 即停——不物化、不排序。同步 `query()` 与异步 `queryAsync()` 双管道严格镜像。

**全文索引**（text-index）：内存词典 + delta 写缓冲（写路径零磁盘 IO）+ 磁盘 postings（delta+varint 压缩、CRC 帧）+ 墓碑；磁盘 postings 只在**基座提交**（generation 构建/压缩/打开重建）时重写。**rebase 机制**：`beginRebase()` 开始捕获写入 → 后台构建新基座 → `commitRebase()` 整体换绑（O(1) 交换）→ 重放捕获的 op；`baseEpoch` 保证跨基座交换的异步读不脏读。**ngram 分词器**：NFKC+小写归一后按码点切 2/3 元，crc32 哈希到 2^22 桶；查询端短词只发 2 元、长词只发 3 元（更少更选择性）；下游 `normalizeLiteral` 确认步骤保证**零假阳性**——解决 `C++`、`$\frac{a}{b}$`、emoji 这类符号密集文本的子串精确搜索。

## 8.7 Generation：持久化索引检查点（stage 5）

```
db.snapshot / db.wal                权威数据（不变）
db.indexes.json / db.textindexes.json   索引定义 sidecar（真源）
generations/
  g-000001/                         已发布代数（不可变）
    store / dt.index / secondary.index / compound.index / text-<n>.*
    snapshot       db.snapshot 的硬链接（disk 模式 ref 指向它）
    manifest.json  最后写 —— 目录内文件"有意义"的判据
CURRENT                            一行：当前代数 id
```

- **发布协议**（崩溃安全）：构建进 `g-N.tmp-*` → 逐文件写 + fsync → fsync tmp 目录 → rename 为 `g-N` → fsync `generations/` → 原子替换 CURRENT → fsync db 目录。CURRENT 只会指向完全 fsync 过的代数；中途崩溃只残留 tmp 目录。
- **加载协议**：读 CURRENT → 校验 manifest（未知版本 = 结构化回退，**永不删除**）→ 校验 WAL/快照锚点（dev/ino + size）→ 载入 store 镜像 + 每个**定义哈希**仍匹配的索引镜像 → 重放 checkpoint 之后的 WAL 帧。任何失败回退到传统完整恢复，回退路径不碰权威数据。
- **定义哈希**：每个索引的 `crc32(stableJson(def))` 决定该索引镜像是否仍有效——定义变更只作废该索引（从已载入 store 重建单索引）。

## 8.8 ClusterDb：多进程分片

- **路由**：`stableHash32(key) % shardCount` 纯哈希，所有进程无需协调即一致。
- **写**：`ShardLockPool` 按需获取分片写锁（LRU 缓存、默认 16 分片），**锁租约**：`lockRenewMs` 定时续期（证明存活）+ `lockHoldMs`（默认 250ms）上限——到点让出锁，防连续写入进程饿死他人。
- **读**：不取锁。本进程持有写锁时用缓存 writer，否则用**只读 MiniDb 实例 + 指纹再校验**（WAL 增量为快路径）；落后时**增量追赶** `catchUpFromWal`（只应用新增 WAL 帧，而非整体重开）。
- **一致性**：单 key / 同分片 batch 强一致（每分片单写者 + 原子 WAL 帧）；跨分片 best-effort，`crossShard:'2pc'` 预留未实现（打开即拒绝）。
- **索引**：集群级注册表为真源；每个分片 writer 打开后应用缺失定义；`query` 用 skip=0、limit=skip+limit 扇出再全局重排。

## 8.9 多进程正确性（lockfile.ts）

O_EXCL 创建 + **令牌**（`pid:uuid`）；stale 接管**只在 owner PID 已死时**发生（`process.kill(pid,0)`），永不因"太老"接管。接管是竞争协议：先写 watch（让竞争者全程可见）→ 检查 → 写 bid → rename → **自适应 settle 等待**（60ms~2s，按本次接管耗时的 4 倍缩放——固定值在共享 CI 上会被调度停顿击穿）→ 终验。

**只读副本与 generation 配对**：只读 opener 扫描 snapshot/WAL 时若恰逢写者压缩旋转，可能把旧快照配新截断 WAL——`recover()` 跑**有界多趟**：每趟对两个文件做 dev/ino/size 指纹（打开 fd 前 + 最后读后重 stat），任何代数切换 → 整趟作废、指数退避重试。耗尽重试抛 `RecoveryGenerationChurnError`。

## 8.10 事件循环友好性

- 快照编码**分块 + 每 2000 条让出**；disk 模式快照值读取按 (file, offset) 分组排序 → 限并发（默认 8）异步定位读 + 每片 8MiB 字节预算——顺序 I/O 而非随机 readSync。
- 全文构建走 **worker_thread**（有界内存聚合，超预算落排好序的段 → 分段外部归并）；worker 只写 tmp 目录，主线程**验证（sanity + 流式 crc）后才 `commitRebase`**；worker 缺失/槽位不足/自定义分词器/小语料（<4096 文档）→ 内联在主线程。
- 维护调度器：每库同时一个重型任务、队列背压、statfs 磁盘预检、AbortSignal 取消、`markPublishing()` 后关闭**等待**而非取消。

## 8.11 关键代码位置索引

| 位置 | 说明 |
|---|---|
| `src/codec.ts:26-33` | 帧常量（MAGIC "MD"、22 字节头、CRC trailer） |
| `src/wal.ts:30` | `FsyncPolicy`：always/everysec/no |
| `src/wal.ts:188-217` | `appendLoc`：预测偏移 + 组 id |
| `src/wal.ts:225-312` | `flushBatch`：writev 组提交、毒化点 = 批首帧偏移 |
| `src/wal.ts:340-344` | `poisonPending`：applyOp 违约兜底 |
| `src/store.ts:118-147` | `Store`：map + 跳表 + TTL 堆 + 字节记账 |
| `src/store.ts:218-243` | `setRef`：seq 身份守卫 |
| `src/store.ts:375-390` | `bulkLoadRefs`：generation O(N) 灌入 |
| `src/write-path.ts:202-228` | `set` 全管道 |
| `src/write-path.ts:232-300` | `commitSetOp`：同 tick append+apply |
| `src/write-path.ts:525-534` | applyOp "must not throw" 契约注释 |
| `src/write-path.ts:607-640` | `restoreKey`/`restoreGroupKey`：seq 守卫回滚 |
| `src/compaction.ts:238-400` | `runCompaction` 全流程 |
| `src/compaction.ts:321-331` | `remap` 磁盘指针重映射 |
| `src/recovery.ts:105-113` | `frameToOps`：三方共享解释层 |
| `src/skiplist.ts:59-120` | `SkipList` + `bulkLoad` |
| `src/index-manager.ts:209-228` | staged 事务区 |
| `src/index-manager.ts:335-364` | `checkUniqueBatch` 批后验证 |
| `src/query-engine.ts:155-223` | `tryDtOrderedLimit` fast path |
| `src/text-index/index.ts:81-189` | `TextIndex`：delta/墓碑/双基座/baseEpoch |
| `src/trigram.ts:66-80` | ngram 分词器（crc32 哈希桶） |
| `src/generation.ts:139-211` | manifest / indexDefHash |
| `src/generation-builder.ts` | 代数构建与 CURRENT 原子发布 |
| `src/backup.ts:60-80` | 在线备份 fence |
| `src/lockfile.ts:74-120` | watch-bid-rename 接管协议 |
| `src/cluster/index.ts:69-139` | `ClusterDb` |
| `src/cluster/lock-pool.ts` | 分片锁池（租约/让出/LRU） |
| `src/maintenance.ts:28-52` | 维护调度器 |
| `src/worker/text-build-core.ts` | worker 全文构建（外部归并） |
| `src/memory-guard.ts:77-101` | `ensureMemoryFor`：TTL 排空 → evict-lru → reject |

## 8.12 本章小结

- minidb 是日志结构嵌入式数据库（Bitcask/Redis AOF 血统）：**WAL 是唯一真源，一切索引都是可重建的派生状态，恢复永远"加载快照 + 重放 WAL（LWW）"**。
- 最精细的工程投入在提交语义：applyOp 与 WAL append 同 tick、组回滚 + 毒化截断原地恢复、`ambiguous` 错误语义、WAL_SEALED 透明重试、seq 身份守卫——注释里几十处 `review #N` 显示这是被多轮评审打磨的代码。
- 查询能力远超"KV 库"：zskiplist 的 span 字段支撑 O(log N) rank、Mongo 风格统一 `query()`、CJK 分词 + TF-IDF 全文索引、n-gram 哈希子串精确检索、persistent generations 检查点让启动免于全量重建。
- 多进程扩展走"分片 + 每分片单写者"而非全局锁：哈希路由、锁租约 + lockHoldMs 让出防饿死、只读实例指纹再校验 + WAL 增量追赶；强一致限于单分片，跨分片 best-effort（2pc 预留未实现）。
