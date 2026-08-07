# 任务 8/8：基础设施层研究报告

> 覆盖范围：`packages/oauth`、`packages/telemetry`、`packages/kaos`、`packages/migration-legacy`、`packages/tree-sitter-bash` 与 `apps/kimi-inspect`。
> 分析方式：全部源码通读 + 两个并行子代理深读（tree-sitter-bash 的 3.8k 行 parser、kimi-inspect 的 1.2 万行前端）。
> 仓库基线：Moonshot AI kimi-code monorepo（TypeScript / pnpm），Node ≥ 24.15，pnpm 10.33。

---

## 1. 子系统定位与职责

本报告覆盖的六个单元共同构成 kimi-code 的"基础设施带"——它们不是 agent 循环本身，而是支撑认证、观测、执行环境、旧版迁移、命令安全分析与运行时调试的底座。六个单元分属三类：

| 类别 | 包 | 一句话职责 |
|---|---|---|
| 身份与观测 | `packages/oauth` | Kimi OAuth（RFC 8628 设备码流）与"managed auth"全套：token 生命周期、托管配置下发、用量/用户信息/反馈 API 客户端 |
| | `packages/telemetry` | 客户端遥测：事件缓冲、批量上报、崩溃捕获、磁盘失败持久化 |
| 执行与解析 | `packages/kaos` | **Kimi Agent OS**——对本地进程/文件系统（以及可选的 SSH 远程环境）的统一执行抽象，供 agent 工具层调用 |
| | `packages/tree-sitter-bash` | 纯 TypeScript 手写 bash 解析器，语法树与 tree-sitter-bash 官方 0.25.0 节点类型一一对应，用于 agent 的 shell 命令权限分析 |
| 迁移 | `packages/migration-legacy` | 把旧版 kimi-cli（`~/.kimi/`）的配置/MCP/技能/会话数据安全迁移到 kimi-code（`~/.kimi-code/`） |
| 调试 | `apps/kimi-inspect` | kap-server `/api/v1/debug` RPC 反射面的 Web 检查器：会话浏览、转录本回放、Service 面板、DI 单元检查 |

### 1.1 在 Kimi Code 整体中的角色

- **oauth 是唯一官方认证通道**。Kimi Code 的 `/login` 走 Moonshot 托管认证（`managed:kimi-code` provider），而非让用户自备 API key。oauth 包同时承担"managed 配置下发"：登录后从 `https://api.kimi.com/coding/v1/models` 拉取模型目录，写入 `~/.kimi-code/config.toml` 的 `providers/models/services`，把云端模型目录"物化"为本地配置。agent-core 的 `managedAuth.ts`、`oauthService.ts`、`modelCatalogService.ts`、kap-server 的 `sessionExport.ts` 都依赖它。
- **telemetry 是唯一遥测通道**。上报端点 `https://telemetry-logs.kimi.com/v1/event`，事件名统一加 `kfc_` 前缀。CLI 与 `kimi web` 服务器共用同一份基础设施；agent-core 内部事件（`mcp_connected`、`session_load_failed` 等）经由传入的 `TelemetryClient` 汇入同一 sink。
- **kaos 是 agent 触手**。agent-core 的 `tools/builtin/file/*`（read/write/edit/grep/glob）、`tools/support/*`（run-rg、git-worktree、list-directory）、`path-access.ts` 策略全部经由 kaos 接口执行——它把"在哪个环境执行"抽象成接口，本地与 SSH 实现可互换，并为未来容器运行时留位。
- **tree-sitter-bash 是权限分析的判官**。agent-core-v2 的 `app/bashParser/` 服务在**执行 shell 命令前**对命令做语法解析，配合权限策略决定放行/询问/拒绝。解析器必须在延迟预算内完成且永不抛异常——权限判断不允许被解析器故障卡死。
- **migration-legacy 是升级路径**。kimi-cli（老产品线，Python 实现）用户首次启动 kimi-code 时由 `apps/kimi-code/src/migration/` 调用它，一次完成 config/mcp/user-history/skills/sessions 五类数据搬迁；vsCode 扩展也复用。
- **kimi-inspect 是 kap-server 的"仪表盘"**。kap-server 暴露了 `/api/v1/debug/*` RPC 反射面（`--debug-endpoints`，loopback 绑定 + bearer 鉴权），kimi-inspect 是它的官方客户端：不经过它，工程师只能 curl 裸 RPC。

### 1.2 与 agent-core / agent-core-v2 / kap-server 的关系

```
apps/kimi-code (CLI/TUI) ──► node-sdk ──► agent-core ──► kaos / oauth / telemetry
apps/kimi-code (web)     ──► kap-server ──► agent-core-v2 ──► kaos / oauth / tree-sitter-bash
                                              │
apps/kimi-inspect ──► kap-server /api/v1/debug  ◄──(RPC 反射面)
```

- agent-core（v1 引擎）直接依赖 oauth、kaos、telemetry（经 node-sdk 传递）；migration-legacy 依赖 agent-core 的 schema（`KimiConfigSchema`、`HookDefSchema`、`McpServerConfigSchema`）做兼容性校验。
- agent-core-v2（DI × Scope 引擎）依赖 oauth 与 **tree-sitter-bash**（bash 解析服务）；它不直接依赖 kaos（执行抽象由 v1 侧工具层承担）。
- kap-server 依赖 oauth（会话导出鉴权）与 agent-core-v2；kimi-inspect 是 kap-server 的消费者，经 `@moonshot-ai/klient` 风格的 channel 层调用 debug RPC。

---

## 2. 包/目录清单与依赖关系

### 2.1 文件清单与规模（src 下，不含测试）

```
packages/oauth/src/            (约 5.2k 行, 23 文件)
  index.ts / constants.ts / types.ts / utils.ts / errors.ts / api-error.ts
  identity.ts / storage.ts / token-state.ts / oauth.ts / oauth-manager.ts / toolkit.ts
  managed-kimi-code.ts / managed-usage.ts / managed-userinfo.ts / managed-feedback.ts
  managed-feedback-upload.ts / open-platform.ts / custom-registry.ts
  refreshProviderModels.ts / model-alias-merge.ts
packages/telemetry/src/        (约 1.2k 行, 9 文件)
  index.ts / types.ts / bootstrap.ts / client.ts / sink.ts / transport.ts / crash.ts
  systemMetrics.ts / remote.ts
packages/kaos/src/             (约 3k 行, 11 文件)
  index.ts / kaos.ts / types.ts / errors.ts / current.ts / process.ts
  local.ts / environment.ts / login-shell-path.ts / internal.ts / ssh.ts
packages/migration-legacy/src/ (约 2.9k 行, 25 文件)
  index.ts / detect.ts / stub-detect.ts / run-migration.ts / types.ts / paths.ts
  prompt.ts / marker.ts / report.ts / migration-errors-log.ts / atomic-write.ts
  session-index.ts / kimi-cli-schema.ts
  steps/{config,mcp,skills,user-history}.ts
  sessions/{index,classify,migrate-one,translator,wire-writer,state-writer,
            close-tool-calls,tool-call-display,workdir-bucket,content-part}.ts
packages/tree-sitter-bash/src/ (约 4.8k 行, 7 文件)
  index.ts / parse.ts / budget.ts / node.ts / grammar.ts / lexer.ts / parser.ts
apps/kimi-inspect/src/         (约 1.2 万行, 50+ 文件)
  main.tsx / App.tsx / connection.tsx / servers.ts / panels.ts / ui.tsx
  channel/{channel,channels,client,proxy,proxyChannel,wsLike,errors,index}.ts
  sessions/{api,views}.ts  transcript/{api,store,ws}.ts  activity/{di,store,ws,useSessionActivity}.ts
  audit/{trail,diff,serialize,truncate}.ts  search/api.ts
  components/{ChatView(1.3k),Sidebar(639),ModelCatalogView(608),DiInspectionView(610),
              Inspector,BashParserView,AuditPanel,StateTree,...}.tsx
```

### 2.2 依赖图（workspace 内部）

```
@moonshot-ai/kaos 依赖: pathe, ssh2(仅 ./ssh 子路径)
  ← 被依赖: agent-core, acp-adapter, node-sdk, migration-legacy(dev)

@moonshot-ai/kimi-code-oauth 依赖: proper-lockfile, zod (catalog)
  ← 被依赖: agent-core, agent-core-v2, kap-server, node-sdk, apps/kimi-code

@moonshot-ai/kimi-telemetry 依赖: 无 (纯 node 内置)
  ← 被依赖: apps/kimi-code (经 node-sdk 的 TelemetryClient 桥)

@moonshot-ai/tree-sitter-bash 依赖: 无运行时依赖 (零依赖纯 TS)
  devDeps: tree-sitter-bash@0.25.0(wasm), web-tree-sitter@0.25.10 (差分测试对照)
  ← 被依赖: agent-core-v2 (bashParser 服务)

@moonshot-ai/migration-legacy 依赖: agent-core(workspace), smol-toml, zod
  devDeps: kaos(workspace)
  ← 被依赖: apps/kimi-code, apps/vscode

@moonshot-ai/kimi-inspect 依赖: agent-core-v2(workspace), transcript(workspace),
                                react19, react-query5, vite6, tailwind4
  ← 被依赖: 无 (叶子应用)
```

要点：oauth 是全 repo 被引用最广的基础包（4 个核心包 + 1 个应用）；tree-sitter-bash 刻意零依赖（连 wasm 都只有 devDeps，用于测试对照）；migration-legacy 是唯一"反向依赖 agent-core"的基础包（要读它的 config schema）；kimi-inspect 是纯前端叶子，只通过 HTTP/WS 与 kap-server 通信。

---

## 3. 模块结构与核心类型

### 3.1 oauth —— 三层结构

oauth 包分三层：**纯 HTTP 层**（oauth.ts）、**状态管理层**（oauth-manager.ts + storage.ts + token-state.ts）、**托管编排层**（toolkit.ts + managed-*.ts）。

- `oauth.ts` — 设备码流的三个 HTTP 封装（`requestDeviceAuthorization` / `pollDeviceToken` / `refreshAccessToken`），全部 POST form-encoded，无状态。`DevicePollResult` 判别联合：`success | pending(errorCode,description) | expired | denied`。`refreshAccessToken` 带指数退避（`2^attempt * 1000`ms，最多 3 次），401/403/`invalid_grant` 直接判 `OAuthUnauthorizedError`，429/5xx 可重试（`RetryableRefreshError`）。
- `oauth-manager.ts` — `OAuthManager`：token 生命周期（load/refresh/login/logout），核心是 `ensureFresh()` 的惰性刷新 + 进程内 coalescing + 跨进程文件锁。`TokenState` 三态：`valid | revoked(墓碑) | missing`。
- `storage.ts` — `FileTokenStorage`：`~/.kimi-code/credentials/<name>.json`，0600 权限，tmp+fsync+rename 原子写；load 失败一律返回 `undefined`（从不抛）；`pathFor` 防目录穿越（basename 校验）。
- `token-state.ts` — 三态视图 + `revokedTombstone()`（把被拒 token 写成空 access_token 的墓碑记录，保留 scope/token_type）。
- `identity.ts` — 设备身份头：`X-Msh-*` 五件套 + User-Agent；`createKimiDeviceId` 在 `~/.kimi-code/device_id` 落盘（0600）；`KIMI_CODE_CUSTOM_HEADERS_ENV` 解析（仿 ANTHROPIC_CUSTOM_HEADERS 的 `Name: Value` 换行格式）。
- `managed-kimi-code.ts` — **managed auth 核心**：`resolveKimiCodeOAuthKey`（凭据槽位解析，默认 `oauth/kimi-code`，非默认环境派生 `oauth/kimi-code-env-<sha256:16>`）、`fetchManagedKimiCodeModels`（`/models` 拉取 + `ManagedKimiCodeModelInfo` 解析）、`applyManagedKimiCodeConfig`（把模型目录写进 config.toml 的 providers/models/services）、`applyManagedKimiCodeLogoutConfig` / `clearManagedKimiCodeConfig`、`provisionManagedKimiCodeConfig`（拉模型 → 读配置 → apply → 原子写）。
- `toolkit.ts` — `KimiOAuthToolkit<TConfig>`：面向宿主（CLI/SDK）的门面，`login/logout/status/ensureFresh/tokenProvider/getManagedUsage/getManagedUserInfo/submitFeedback/...`；内部按 `storageName\0oauthHost` 缓存 `OAuthManager` 实例。
- `managed-usage.ts` — `/usages` 解析：金额定点数（`FIXED_POINT_CENTS=1_000_000`）转 cents、proto 枚举 `TIME_UNIT_*` 归一化（300 分钟 → 5h）、summary 合成周窗口。
- `open-platform.ts` / `custom-registry.ts` — 另外两种 provider 来源：Moonshot 开放平台 API key（`moonshot-cn`/`moonshot-ai` 两个预置平台）与第三方 api.json 注册表（`kind: 'apiJson'`，key 由 URL 标识）。
- `refreshProviderModels.ts` — 启动/定时刷新编排：对 config 里每个 provider 分类（managed OAuth / open platform / custom registry / 用户自建），拉取并**选择性合并**模型别名（上游字段覆盖、用户手写字段保留、消失的模型删除、悬空 defaultModel 收敛）。

### 3.2 telemetry —— 管道式五段

```
client(track) → sink(缓冲/富化) → transport(HTTP上报/磁盘兜底)
      ↑ queue(启动前预缓冲)        ↑ systemMetricsCollector / crash handler
```

- `client.ts` — `TelemetryClient`：全局单例 `defaultClient` + `ScopedTelemetryClient`（`withContext` 派生，覆盖 deviceId/sessionId）。`track` 时若 sink 未挂接则进内存队列（上限 1000 条，溢出丢最旧）。事件字段：`event_id`（无横线 UUID）、`device_id`、`session_id`、`timestamp`（秒）、`properties`（仅允许 primitive，`sanitizeProperties` 过滤非法值）。
- `sink.ts` — `EventSink`：每事件注入静态 context（`app_name/version/runtime/platform/arch/node_version/os_version/ci/locale/terminal/ui_mode/model/build_sha`）；缓冲满 50 条或每 30s 定时 flush；`flushSync` 走 `saveToDisk`（关闭时保证不丢）。
- `transport.ts` — `AsyncTransport`：POST `telemetry-logs.kimi.com/v1/event`，Bearer 401 时剥掉鉴权头重试一次；429/5xx 视为 `TransientTelemetryError`，按 `[1s,4s,16s]` 退避重试；最终失败 `saveToDisk` 写 `~/.kimi-code/telemetry/failed_<rand>.jsonl`（0600）；下次启动 `retryDiskEvents` 补发（>7 天删除）。`buildPayload` 把事件拍平成 `{user_id, events[]}`，事件名统一加 `kfc_` 前缀，properties/context 展平为 `property_x` / `context_x`。
- `crash.ts` — `installCrashHandlers`：`uncaughtExceptionMonitor`（不干扰默认崩溃行为）+ `unhandledRejection` 监听（记录后按"是否唯一监听者"决定是否 rethrow 以保留 Node 默认行为；`recordedRejections` 去重防双报）；`CrashPhase` 区分 startup/runtime/shutdown；AbortError 一律不报。
- `systemMetrics.ts` — 启动 1.5s 暖采样 + 每 5 分钟一个 `system_metrics` 事件（rss/heap/cpu_user_system/loadavg/freemem/constrained_memory 等）。
- `remote.ts` — `normalizeRemote`：git remote URL 归一化（scp 语法、`.git` 后缀剥离、host:port/path 拼接），用于把 remote 作为事件属性。

### 3.3 kaos —— Kimi Agent OS

- `kaos.ts` — `Kaos` 接口：**模拟 Python os/pathlib 语义**的统一环境抽象。路径（同步：`normpath/gethome/getcwd/pathClass`）、目录（`chdir/withCwd/withEnv/stat/iterdir/glob`）、文件（`readBytes/readText/readLines/writeBytes/writeText/mkdir`）、进程（`exec/execWithEnv → KaosProcess`）。
- `process.ts` — `KaosProcess`：`stdin/stdout/stderr` 流 + `pid/exitCode/wait/kill/dispose`，最小化接口以便本地/SSH/容器三种后端共用。
- `local.ts` — `LocalKaos`：本地实现。关键设计：**每实例独立 `_cwd`**（不碰 `process.cwd()`，多实例可并存）；`exec` 用 `detached:true` 使子进程成为进程组组长，`kill` 用 `process.kill(-pid)` 杀整组（Windows 走 `taskkill /T /F`）；glob 手写 `**` 展开 + `(dev,ino)` 环检测（ino=0 的文件系统放弃环检测）；`readLines/readTailLines/readLineRange` 流式逐块读；UTF-8 严格校验器（`createUtf8Validator`，E0/ED/F0/F4 边界特判）。
- `environment.ts` — `detectEnvironment`：纯函数探测 OS/shell（注入 deps 便于测试）；Windows 下定位 Git Bash（`KIMI_SHELL_PATH` 覆盖 → PATH 里 git.exe 推断 → `git --exec-path` → 固定候选路径），找不到抛 `KaosShellNotFoundError`。
- `login-shell-path.ts` — 用 `$SHELL -l -c /usr/bin/env` 提取登录 shell 的 PATH 并**只追加**当前 PATH 缺失的绝对路径项（防 cwd 依赖注入），memoise 一次。
- `ssh.ts` — `SSHKaos`（`@moonshot-ai/kaos/ssh` 子路径导出）：ssh2 客户端 + SFTP 实现同一接口；`shellQuote` 拼接远程命令、SFTP 错误码映射为 `KaosSSHError` 子类（NotFound/Permission/Connection）、远程 cwd 用 `cd <dir> && ...` 前缀模拟、进程树 kill 用 `pkill -P` 递归。
- `current.ts` — AsyncLocalStorage 绑定当前 Kaos 实例（`runWithKaos/setCurrentKaos/getCurrentKaos`），模块级便捷函数（`exec/readText/...`）转发到当前实例——工具层代码无需处处传递 kaos 对象。

### 3.4 migration-legacy —— 检测→提示→执行三段

- `detect.ts` — `detectMigration`：扫描 `~/.kimi/`，产出 `MigrationPlan`（hasConfig/hasMcp/hasUserHistory/oauthCredentials/workdirs/totalSessions/sessionScanFailures）。sessions 目录按 `kimi.json` 的 `work_dirs` 反向解析 md5 bucket → 真实路径。
- `prompt.ts` — 纯决策映射：两层问题（`now|later|never` × `config-only|all-sessions`）→ `resolveMigrationScope`。
- `run-migration.ts` — 五步顺序执行（config → mcp → userHistory → skills → sessions），产出 `MigrationReport` 落盘 `migration-report.json`；成功时写 `.migrated-to-kimi-code` marker。
- `steps/config.ts` — 最复杂的步骤：schema 兼容过滤（providers/models/hooks 逐条用 agent-core schema 校验）、TUI 键拆分（theme/default_editor → tui.toml）、`default_yolo` → `default_permission_mode` 映射、未知键丢弃、`loop_control/background/experimental` 字段白名单、目标三种模式（overwrite/merge/sibling）、冲突时写 `config.migrated-from-kimi-cli.toml` 兄弟文件。
- `sessions/` — 会话迁移子管线：`classify`（placeholder/empty/malformed/real 四分类）→ `translator`（context.jsonl → NormalizedMessage，丢弃 `_system_prompt/_checkpoint/_usage` 角色）→ `close-tool-calls`（为悬空 toolCall 合成占位结果，防 kimi-core 挂起后续消息）→ `wire-writer`（写 `agents/main/wire.jsonl` 的 `context.append_message` 记录）→ `state-writer`（写 state.json，`custom.imported_from_kimi_cli: true` 标记，供重跑幂等识别）。
- `marker.ts` — 迁移完成标记（`.migrated-to-kimi-code`，`target_paths` 列表支持多目标）；`shouldSuppressMigration` 决定首启是否弹迁移屏；`.skip-migration-from-kimi-cli` 是用户显式跳过标记。

### 3.5 tree-sitter-bash —— 五段流水线

- `parse.ts` — 唯一入口 `parse(source, {timeoutMs=50, maxNodes=50_000})`，返回 `{ok:true, rootNode, hasError} | {ok:false, reason:'aborted'}`；**永不抛异常**——内部 bug 被兜底为 program+ERROR 降级树。
- `budget.ts` — `ParseBudget`：`tick()`（建节点时计数 + 查 maxNodes/deadline，超限抛 `Aborted`）、`progress()`（只查 deadline，供长 token 扫描循环）。
- `lexer.ts` — 手写逐字符分词器：`word|op|io_number|newline|comment|eof` 六类 token；heredoc 延迟到行尾扫描（队列挂 newline token）；`skipDoubleQuoted/scanBalanced/scanBalancedStatements` 带嵌套感知与 case 感知（`caseDepths` 栈）；`MAX_SCAN_DEPTH=1024`。
- `parser.ts` — 递归下降（每个 grammar 规则一个方法，注释明示）；先建轻量 `Frame` 中间树（heredoc body 事后补范围），再 `materialize()` 迭代转换；内嵌 Pratt 表达式引擎处理算术/`[[ ]]`；多个深度上限（`MAX_PARSE_DEPTH=500`、`MAX_SUBSTITUTION_DEPTH=150`）防爆栈。
- `grammar.ts` — 静态元数据表：保留字、重定向操作符（含官方不支持的 `<>`）、表达式优先级表（`EXPRESSION_PRECEDENCE`）。
- `node.ts` — `SyntaxNode`（type/text/startIndex/endIndex/isNamed/parent/children/namedChildren）；偏移用 UTF-16 码元（刻意偏差，与 JS 切片一致）；`descendantsOfType` 迭代遍历防深树爆栈。

### 3.6 kimi-inspect —— 五层结构

- `channel/` — **自研 RPC 传输层**（模型是 VS Code `ProxyChannel`）：`channel.ts` 定义传输无关契约 `IChannel {call, listen}` 与 `ServiceProxy<T>` 映射类型（方法→async 调用、`onXxx`→事件、普通成员→零参属性读）；`client.ts` 的 `InspectClient` 提供四级作用域入口 `core / workspace / session / agent`，拼出 Service base URL（`service = String(decoratorId)`，即 DI id 就是 wire 通道名）；`proxy.ts` 用 JS `Proxy` 把属性访问变成 `channel.call`；`proxyChannel.ts` 是 HTTP 实现；`channels.ts` 拉全量 wire 协议（`GET /api/v1/debug/channels`，无白名单）并 `serviceByName` 反向物化 proxy；`errors.ts` 的 `RPCError` 用数字 code 做跨线分支键。
- `connection.tsx / servers.ts` — 连接与服务器发现：Vite dev server 的 `GET /__inspect/servers` 扫本机 kap-server 实例注册表（`~/.kimi-code/server/instances/*.json` + 旧版 lock，pid 存活过滤）与共享 bearer token；`pickDefaultServer` 按"记住的 URL → dev-proxy 目标 → 运行最久实例"选默认；探针（`probeDebugSurface`）先 `GET /api/v1/debug/channels` 验证表面存在，失败渲染阻塞错误屏。
- 数据面：`sessions/api.ts`（v2 REST 信封 `{code,msg,data}` + 不透明游标）、`transcript/{api,store,ws}.ts`（REST 全量 + WS 增量 + seq 水位对账，store 复用 `@moonshot-ai/transcript` 的 `applyOperation` reducer）、`activity/`（第二条 WS 消费全局事件，`SessionActivityHub` 订阅/版本 store）、`audit/`（`AuditTrail` 记录 store 每一步构建历史 + 结构 diff）、`search/api.ts`（`POST /api/v1/search` 跨会话全文）。
- 视图面：`App.tsx`（header + `NavRail` 七视图 + session resume 门控）、`panels.ts`（Service 面板手写覆盖层：descriptor 换 curated 卡片，`CORE_PANELS/SESSION_PANELS/AGENT_PANELS` 三组）、`components/`（ChatView/Sidebar/SearchView/ModelCatalogView/AppServicesView/WorkspaceServicesView/BashParserView/DiInspectionView/RightPanel/SessionPane + audit 面板 + StateCard）。
- `ui.tsx` — 通用 UI 原语：`JsonView`（500 字符折叠）、`JsonTree`（可选路径 JSON 树）、Badge/ActionButton/relTime/errorMessage。

---

## 4. 关键数据流 / 状态机 / 时序

### 4.1 oauth：设备码登录时序

```
用户运行 /login
  │
  ├─ KimiOAuthToolkit.login()
  │     └─ OAuthManager.login(15min 本地预算)
  │           ┌───────────────────────────────┐
  │           │ POST /api/oauth/device_authorization │
  │           │   {client_id} + X-Msh-* 设备头      │
  │           └───────────────┬───────────────┘
  │                     user_code + device_code + interval
  │           onDeviceCode(auth) → TUI 显示 "打开 https://… 输入 XXXX-XXXX"
  │           ┌────────────────────── 轮询循环（interval 秒）──────────┐
  │           │ POST /api/oauth/token {device_code, grant_type:device} │
  │           │   authorization_pending → sleep(interval) 继续          │
  │           │   slow_down → interval += 5s 继续                       │
  │           │   expired_token → 重新请求 device_authorization（外层） │
  │           │   access_denied → 抛错                                   │
  │           │   成功 → TokenInfo {accessToken, refreshToken,          │
  │           │                  expiresAt=now+expiresIn}                │
  │           └───────────────┬───────────────┘
  │              storage.save('kimi-code', token)   ← 0600 原子写
  │
  └─ provisionManagedKimiCodeConfig()
        GET {base}/models  (Bearer accessToken)
        → 解析 ManagedKimiCodeModelInfo[]（context_length/supports_*/think_efforts）
        → adapter.apply(): config.providers['managed:kimi-code'] = {type:'kimi',
            baseUrl, apiKey:'', oauth:{storage:'file', key:'oauth/kimi-code'}}
          + config.models['kimi-code/<id>'] = alias（capabilities 推导：
            supports_thinking_type only→thinking+always_thinking 等）
          + config.defaultModel / config.thinking.enabled
          + config.services.moonshotSearch/moonshotFetch
        → atomicWrite config.toml（0600）
```

### 4.2 oauth：token 生命周期状态机与刷新协调

```
                 ┌────────────────────────────────────────────┐
                 │  FileTokenStorage(<name>.json)             │
                 │  valid:   {accessToken≠"", refreshToken,    │
                 │            expiresAt, scope, tokenType}      │
                 │  revoked: {accessToken:"", refreshToken:"",  │
                 │            expiresAt:0, scope, tokenType} ← 墓碑│
                 │  missing: 文件不存在                          │
                 └────────────────────────────────────────────┘
  ensureFresh(force=false):
    load → missing      → throw OAuthUnauthorizedError("Run /login")
         → revoked      → throw OAuthUnauthorizedError("re-login required")
         → valid 且 remaining > max(300s, expiresIn*0.5) → 直接返回 accessToken
         → valid 且需刷新 → acquireRefreshLock()  ← proper-lockfile 跨进程锁
              │  (锁路径 {home}/oauth/{name}.lock；Windows/环境变量可禁用)
              ├─ 锁后重读 storage：
              │    revoked → 抛 unauthorized
              │    missing → 用锁前快照
              │    valid 且不再需刷新 → 用 peer 的 token（返回别人的结果）
              │    valid 且 force 且文件已变 → 用 peer 的 token
              ├─ refreshAccessToken(refreshToken) → save → return
              └─ catch OAuthUnauthorizedError：
                    sleep(100ms) 后重读 storage：
                      peer 已轮换 refresh_token → 用 peer 的（stale-token 竞态）
                      否则 → save(revokedTombstone)  ← 让新进程看到"需重登"
```

进程内并发：`inFlightRefresh` 合并同一时刻的多个 `ensureFresh` 调用（force 语义差异化：non-force 可搭车任意结果，force 只能搭车 force）。

### 4.3 telemetry：事件管道

```
track('event', props)
  → sanitizeProperties（仅 primitive）
  → sink 未挂? → queue（≤1000 条）┐
  → sink 已挂 → EventSink.accept：追加 context 富化 → buffer
        buffer ≥ 50 条 或 每 30s → flush()
  → AsyncTransport.send(events)
        buildPayload: 事件名加 'kfc_' 前缀，properties/context 展平
        POST telemetry-logs.kimi.com/v1/event
        401 → 去 Authorization 重试一次
        429/5xx → 退避 1s/4s/16s 重试
        仍失败 / 超时(10s) / abort → saveToDisk: failed_<rand>.jsonl (0600)
  下次启动 → retryDiskEvents(): 逐文件补发，>7 天删除
  关闭   → flushSync() → saveToDisk（绝不因遥测失败退出）

  crash: uncaughtExceptionMonitor + unhandledRejection → track('crash',
         {error_type, where: startup|runtime|shutdown, source}) + flushSync
```

### 4.4 kaos：exec 与 glob

```
工具层 exec('ls','-la')
  → getCurrentKaos()（AsyncLocalStorage 解析当前环境）
  → LocalKaos.exec: spawn(command, args, {cwd:_cwd, env:merged,
        detached:!win32, stdio:pipe})
        waitForSpawn: 'spawn'|'error' 事件竞速（ENOENT 提前暴露）
  → LocalProcess{stdin/stdout/stderr(经 BufferedReadable), pid}
  → kill: POSIX → process.kill(-pid, SIGTERM) 杀进程组
          Windows → taskkill /T /F /PID <pid> 杀整树

glob(base, '**/*.ts'):
  _globWalk(base, parts):
    '**' → 先零目录匹配（remainingParts 递归 / 自身 yield），
           再逐子目录递归（保持 '**' 在队首，防重复计数）
    普通段 → globPatternToRegex（Python pathlib 语义：* 不跨 '/', 含 dotfile）
    visited: (dev,ino) 集 → 环检测；ino=0（FAT/exFAT）→ 放弃检测
```

### 4.5 migration-legacy：管线与时序

```
首启检测 detectPendingMigration (apps/kimi-code)
  → detectMigration: 扫描 ~/.kimi/（config.toml/mcp.json/user-history/credentials/
       plugins/mcp-oauth/kimi.json 反查 sessions buckets）
  → marker 抑制检查（.migrated-to-kimi-code / .skip-migration-from-kimi-cli）
  → 两层提示 → resolveMigrationScope
  → runMigration（五步）：
      config:   schema 校验过滤 → 目标 overwrite|merge|sibling
      mcp:      McpServerConfigSchema 过滤 → 同名 server 保留目标（keptNewForConflicts）
      userHistory: 文件复制（tmp+rename 原子）
      skills:   顶层条目递归复制（tmp+rename）
      sessions: readdir buckets → resolveBucket(local|nonlocal|unknown)
                → classifySessionDir(placeholder|empty|malformed|real)
                → 按 wireMtime 降序 → migrateOneSession × N
      → migration-report.json + migration-errors.log（追加式，跨 run）
      → marker 写入（sessionsFailed 为空时才写，允许重试）
```

`migrateOneSession` 内部：目标目录 `sessions/<wd_xxx>/ses_<uuid>`；已存在时分类 `imported|foreign|debris`（有 `custom.imported_from_kimi_cli` 标记 = 上次自己写的 → 幂等跳过；无标记 → 真冲突；state.json 缺失/损坏 → debris 删除重迁）。翻译 context.jsonl → NormalizedMessage → `closeDanglingToolCalls` → 写 `agents/main/wire.jsonl`（`type:'context.append_message'`）+ `state.json`；最后 `utimes` 把文件 mtime 还原成原始 `wire_mtime`——**关键**：SessionStore.list 按文件系统 mtime 排序，不还原就会把迁移时间戳当成会话时间，`--continue` 顺序全乱。

### 4.6 tree-sitter-bash：解析流水线

```
parse(source, {timeoutMs, maxNodes})
  → ParseBudget（deadline + 节点配额）
  → new Parser → parseProgram
      Lexer 惰性 token 流（peek/next/reposition + heredoc 队列）
      parseStatementList(';'/'&'/换行/注释/ERROR 恢复)
        → parseList(&&/||) → parsePipeline(|/|&) → parseStatementCore
            → parseCommand（赋值前缀识别 ASSIGNMENT_RE）
            → parseCompoundGuarded（if/while/for/case/函数定义）
            → parseSubshell / $() → parseScopedStatements（新 Parser, depth+1）
            → [[ ]] → ExprState + Pratt parseExpression
            → heredoc → completeHeredocs 事后扩展祖先 end
  → materialize（Frame → SyntaxNodeBuilder 两趟迭代，不 tick）
  → {ok:true, rootNode, hasError}   |   {ok:false, reason:'aborted'}
  catch Aborted → aborted；catch 其它 → program+ERROR 降级树（仍 ok:true）
```

预算语义：**封顶总工作量而非输入大小**——500KB heredoc body 只有几个节点可正常解析；百万级 `case` 或数万表达式触发 50 000 节点上限被 abort。abort 是"干净失败"，调用方（权限分析）拒绝执行而不是误放行。

### 4.7 kimi-inspect：RPC 消息流与 WS 对账

**RPC 调用（HTTP 通道）**

```
React 组件访问 svc.someMethod(args)
  → makeProxy 的 JS Proxy 拦截（channel/proxy.ts）
  → ProxyChannel.call(method, args)
  → POST {base}/api/v1/debug[/session/:sid[/agent/:aid]]/{service}/{method}
      body = JSON.stringify(完整参数数组)；无参时无 body
  → 服务器（kap-server dispatcher）：
      scope.accessor.get(id) 取 Service 实例
      member = service[method]；非函数 → 属性读原样返回
      函数 → member.apply(service, args)
  → 响应信封 { code, msg, data, request_id }
      code === 0 → 返回 data
      code !== 0 → 抛 RPCError(code, msg, details)（数字 code 是稳定分支键）
  → 事件：HTTP 通道没有 listen（v2 事件 socket 已移除），UI 一律按需 fetch
```

**transcript 增量对账（唯一的"复杂状态"）**

```
初始加载：GET /api/v1/sessions/{id}/transcript?page_size=1（最新一页, 含 seq 水位）
     → store.applyPage(replace) → 翻页恢复窗口（before_turn 前翻, IntersectionObserver 哨兵）
WS 订阅：/api/v1/ws 子协议 kimi-code.bearer.<token>（浏览器 WS 无法带 header）
     client_hello{subscriptions:[sid]} → subscribe_v2{grade:{agent:'block'},
       transcript_since: 游标}
     服务器 ack（回带相同 id）→ 流挂载的精确时刻（重连在此刻 reconcile）
增量：transcript.ops（block grade = 整状态帧 upsert, 丢弃逐 token append）
     帧带 seq 批次号 → store 逐条 applyOperation（@moonshot-ai/transcript L2 reducer）
对账触发（四路）：
     resync_required 帧 | subscribe ack(重连) | seq 缺口(meta.seq > lastSeq+1)
       | store.onGap(append 无法落位) → catchUp()
     → GET .../transcript/ops?since_seq= 点对点补齐
     complete:false / legacy 无 seq → 全量 reloadPages（REST replace）
REST 刷新在飞时 WS ops 进 buffer，flush 到新页上（upsert 幂等 + append 按 offset 落位）

全局事件（第二条 WS, 零订阅广播）：
     event.session.work_changed → SessionActivityHub 更新徽章
     event.session.created / session.meta.updated → 失效 ['sessions'] 查询
     event.di.unit_changed → 失效 ['di'] 前缀（DI 视图 250ms 尾沿节流）
     重连 → open 即 onReconnected → REST re-seed（live 帧掉线即丢, 不可靠）
```

---

## 5. 重要实现细节

### 5.1 oauth

1. **凭据槽位哈希（`resolveKimiCodeOAuthKey`）**：默认环境（oauth host=默认 且 baseUrl=默认）用固定键 `oauth/kimi-code`；任何环境覆盖（`KIMI_CODE_BASE_URL` / `KIMI_OAUTH_HOST` / 配置）都派生 `oauth/kimi-code-env-<sha256(JSON{oauthHost,baseUrl}) 前16位>`。登录、配置下发、运行时 provider 全部通过同一函数解析 ref——"写入槽位永远等于读取槽位"，防止环境切换导致凭据混用。
2. **401 竞态恢复**：刷新拿 401 后先 sleep(100ms) 重读存储，若 peer 进程已轮换 refresh_token 则用 peer 的新 token（把"凭据真失效"与"并发轮换竞态"区分开）；确认失效才写墓碑。
3. **`force` 合并语义**：`inFlightRefresh` 记录在飞调用的 force 标志；non-force 可搭车任何结果，force 只能搭车 force，force 压 non-force 时会等前者 settle 后自己重刷。
4. **跨进程锁（proper-lockfile）**：锁目标是 `{configDir}/oauth/{name}` 哨兵文件，锁实体是兄弟 `.lock` 目录；`stale: 5s` 处理崩溃残留；Windows 与 `KIMI_DISABLE_OAUTH_LOCK=1` 禁用锁但仍保留"锁后重读"兜底。生产环境必须显式传 `configDir`（不传则静默禁用锁，只有 NODE_ENV=test 时回退 KIMI_CODE_HOME）。
5. **墓碑设计**：刷新被 401 后不是删文件而是写空 token 记录——新进程能看到"曾经登录过、现在需要重登"而非"从未登录过"；`classifyToken` 用 `accessToken.length===0` 判定。
6. **token 解析严格性**：`tokenFromResponse` 对 `access_token/refresh_token/expires_in` 做必填校验，缺任一即抛 `OAuthError`——拒绝把坏响应持久化。
7. **`isManagedKimiCodeBaseUrl`**：URL 按 origin+pathname 规范化严格比对，代理/网关/自托管镜像**不会被自动刷新**（其 /models schema 不可信）。
8. **模型别名选择性合并（`mergeRefreshedModelAlias`）**：上游字段集合（`MANAGED_KIMI_MODEL_FIELDS`）内的覆盖、集合外（用户手写、`overrides` 嵌套）保留；刷新时上游消失的模型删除。`applyCustomRegistryEntries` 修过一个 bug：批量导入多 provider 时"内存 apply + 磁盘 RPC 混用"导致 N-1 个 provider 静默丢失，现改为全内存 apply 后一次写盘。
9. **`refreshProviderModels` 的快照对比**：刷新前后对比 `providerConfigSnapshot`（JSON 串）与模型集合，只有真实变化才触发 config 写盘；`preserveUserProviderAliases` 保护用户自建 provider 的别名。

### 5.2 telemetry

1. **遥测永不致命**：所有上报路径 catch 吞错；`flushSync` 兜底磁盘；`crash` 事件先 `flushSync` 再让原异常继续传播。
2. **启动前事件缓冲**：sink 挂接前 `track` 的事件进内存队列（≤1000），`attachSink` 时按事件自身的 contextOverrides 补填 device_id/session_id。
3. **401 剥头重试**：token 失效时上报仍要成功——去掉 Authorization 再发一次（遥测端点可能不需要鉴权）。
4. **磁盘兜底格式**：`failed_<rand6>.jsonl`（`flag:'wx'` 防覆盖），补发成功即删；7 天过期清理。
5. **unhandledRejection 的双重义务**：TUI 注册了 rejection 监听把崩溃变成静默 exit(1)（无遥测）→ 这里必须自己监听；但监听会抑制 Node 默认崩溃 → 若自己是唯一监听者则 rethrow 保留默认行为；`recordedRejections` Set 防止 monitor 双报。
6. **数值卫生**：`isTelemetryNumber` 限制 |v| ≤ MAX_SAFE_INTEGER；`sanitizeProperties` 丢弃非 primitive 属性。
7. **`normalizeRemote`** 把 git remote 归一化（scp 语法/`.git` 后缀）后再作为事件属性，防止同一仓库因 URL 写法不同产生重复属性值。

### 5.3 kaos

1. **实例级 cwd**：`LocalKaos` 从不调 `process.chdir()`；`withCwd/withEnv` 返回新实例（不可变风格），多实例并存互不污染——`runWithKaos` 切上下文时不担心全局状态。
2. **进程组 kill**：POSIX 用 `detached:true` + `process.kill(-pid)`；EPERM 时回退单进程 kill；pid≤0（spawn 失败）拒绝 kill 防 `kill(-1)` 误杀全组。
3. **`waitForSpawn` 竞速**：spawn 后必须等 `'spawn'` 事件再返回——否则向"从未存在的进程"写 stdin。
4. **glob 环检测**：`(dev,ino)` 键；`ino===0` 的文件系统（Windows FAT/exFAT、SMB/NFS）返回 null 键放弃检测——若用共享键会让所有目录互相"访问过"而全部跳过。
5. **UTF-8 严格校验器**：手写 DFA（E0 第二字节 ≥A0、ED ≤9F、F0 ≥90、F4 ≤8F 边界），`readLines` 流式解码时保证不把多字节字符切成两半；`decodeTextWithErrors` 的 `'ignore'` 语义刻意与 TextDecoder 不同——跳过非法序列但**保留合法的 U+FFFD**（与 Python `errors="ignore"` 一致）。
6. **mkdir 语义**：`{parents:true, existOk:false}` 时先 stat 探测（Node 的 recursive:true 静默容忍已存在）；`existOk` 只对"已是目录"生效，被普通文件占用时抛 `KaosFileExistsError` 而非撒谎返回。
7. **登录 shell PATH**：只追加当前 PATH 缺失的**绝对路径**项——空/`.`/相对项都是 cwd 依赖查找，追加会扩大搜索面（安全考量）；用绝对路径 `/usr/bin/env` 执行（防仓库里被植入的 `env` 可执行文件）。
8. **SSH 实现**：每条命令 `cd <cwd> && <cmd>` 前缀模拟远程 cwd；SFTP stat 组装 `stMode`（mode_t 位）；`shellQuote` 单引号包裹防注入；进程 kill 用递归 `pkill -P`。

### 5.4 migration-legacy

1. **幂等与自愈**：目标目录 `custom.imported_from_kimi_cli` 标记 → 重跑直接 `already-migrated`；`debris`（state.json 缺失/损坏 = 上次跑到一半被杀）→ 删除重迁；`ensureSessionIndexEntry` 幂等追加——上次崩溃漏写的 index 行下次补上。
2. **mtime 还原**：`utimes` 把 wire.jsonl/state.json/目录 mtime 全还原为源会话 `wire_mtime`（见 4.5），否则 `SessionStore.list()` 排序反转。
3. **OAuth 凭据刻意不迁移**（`MigrationNotices.oauthLoginsRequiringRelogin`）：refresh token 服务端轮换，复制会让两个安装互相踢下线——用户必须在新产品里重新 `/login`。
4. **冲突降级为兄弟文件**：目标 config.toml/tui.toml/mcp.json 无法解析或用户改过时，迁移结果写到 `*.migrated-from-kimi-cli.*` 兄弟文件并提示手动合并，绝不覆盖用户数据。
5. **schema 白名单跟随上游**：`SUPPORTED_TOP_LEVEL_KEYS` 从 `KimiConfigSchema.shape` 动态推导（camelToSnake），上游加键自动跟；未知键、schema 拒绝的值逐键删除（循环 safeParse 直到通过，归因失败的键停手防死循环）。
6. **悬空 tool call 合成占位**：kimi-core 的 context 模块在 tool 交换未闭合时**延迟后续所有消息**——被中断的 kimi-cli 会话直接迁移会导致后续消息全被吞。`closeDanglingToolCalls` 为每个未满足的 toolCallId 插入 `[tool result unavailable — session imported from kimi-cli]` 占位结果，保持消息顺序。
7. **分类严格性**：`analyzeContextContent` 区分 `empty`（只有标记角色）与 `corrupt`（每行都解析失败）——corrupt 是数据问题，必须进 `sessionsFailed` 与 `migration-errors.log`（带 role 直方图诊断），不能混进 skip 计数。
8. **旧格式字段白名单**：`OldSessionStateSchema` 用 `.passthrough()` 容忍新版本 kimi-cli 的额外字段；`OldKimiJsonSchema` 反查 workdir。
9. **marker 多目标支持**：`target_paths` 数组记录所有迁移过的目标家目录，换 `KIMI_CODE_HOME` 重跑不重复提示。

### 5.5 tree-sitter-bash

1. **确定性预算优先**：`tick` 只挂在 `frame()`（一帧=一节点），`progress` 挂在所有长扫描循环（每 2048 字符）——病态单 token（几百 KB 未终止引号）也能按时撞线且不虚增节点。fuzz 测试断言 400KB 节点炸弹 <100ms abort。
2. **永不抛异常的退出契约**：abort 走 `Aborted` 控制流异常；解析器 bug 被兜底成 `program + 全源 ERROR` 降级树（ok:true + hasError）——权限分析下游需要"能用的树"继续工作，且不能因为解析器故障卡死代理。
3. **heredoc 两阶段**：body 要到行尾才能扫，所以中间树用可变 `Frame`（parent 指针 + 可变 end），`completeHeredocs` 沿 parent 链事后扩展 `end`，`materialize` 再转不可变 `SyntaxNode`。
4. **case 歧义双保险**：lexer 层 `scanBalancedStatements` 维护 `caseDepths[]` 栈（case item 的 `)` 是 pattern 闭合符，naive 计数会提前闭合）；parser 层 `scanCasePatternEnd` 逐字符扫 pattern（extglob 组括号在 token 流中不可表示）+ `lexer.reposition` 回卷。
5. **多深度上限防爆栈**：`MAX_PARSE_DEPTH=500`（复合命令局部降级）、`MAX_SUBSTITUTION_DEPTH=150`（每次 `$()` 新 Parser 约 13 栈帧/层，实测 380-500 层爆栈，150 留 2.5 倍余量）、lexer `MAX_SCAN_DEPTH=1024`。
6. **差异被 fixture 钉住**：80 处 `@known-diff` 对照官方 wasm 的双向校验（dump 漂移或意外匹配参考都算失败）；`<>` 操作符官方 0.25.0 解析失败这里支持；`((a++)` 形态、`[[ $n == -0.5 ]]` extglob 分类等行为对齐 scanner.c。
7. **测试方法论**：devDependencies 的 tree-sitter-bash wasm + web-tree-sitter 只用于差分测试——同一 source 两边解析，按含匿名节点的前序 dump 字节级对比（web-tree-sitter 对字符串输入报 UTF-16 偏移，可直接比较）；官方 corpus 全量导入 + 自建 fixtures + 固定种子 fuzz（token soup/字节变异/嵌套炸弹）。

### 5.6 kimi-inspect

1. **RPC 无重试、业务错误走信封 code**：HTTP 状态码只反映传输层（401 等），业务结果全在 `code`；`RPCError` 的数字 code 是跨线稳定分支键（不靠 instanceof）；HTTP 通道 `listen` 直接抛错——v2 事件 socket 已移除，UI 全部按需 fetch/轮询。
2. **WS 握手与 ack 时刻**：浏览器 WebSocket 无法自定义 header，token 通过 `kimi-code.bearer.<token>` 子协议在升级时呈现；客户端每个控制帧带自增 id，服务器 `ack` 回带同 id——**ack 是流挂载的精确时刻**，重连后在此刻而非 `open` 触发 reconcile。
3. **transcript 可靠性**：WS 帧是 volatile 的（从不入 durable journal），可靠性靠 op-batch seq——断线错过的批次由 `transcript_since` 游标 / `ops?since_seq=` 点对点补齐，`complete:false` 则全量 REST 刷新；四路触发（resync/ack/seq 缺口/append gap）都汇入同一 catchUp。
4. **audit diff 的引用相等快速路径**：`diffValue` 先做引用相等比较——copy-on-write reducer 下未动子树共享引用，直接判 `unchanged` 免遍历；数组元素按 ID 字段优先级匹配（`frameId → stepId → interactionId → turnId → taskId`），避免中间 upsert 引发级联假修改；Map/Set 序列化时排序以保住引用共享。
5. **虚拟化零依赖**：`content-visibility: auto` + `contain-intrinsic-size`，浏览器原生虚拟化超长会话（无 windowing 库）；顶部 IntersectionObserver 哨兵自动翻旧页。
6. **服务器发现**：Vite 中间件扫 `~/.kimi-code/server/instances` 实例注册表 + 家目录共享 token，浏览器 10s 轮询发现列表，选中服务器只记住 URL 不持久化完整配置（刷新后重新发现回选）。
7. **方法参数解析（methodArgs.ts，与 DI 无关）**：服务器把 `Function#toString` 的形参文本放进 channels 描述符，前端 `parseParamFields` 切出可编辑字段——具名参数单输入框、解构对象参数每键一框、rest/数组回落裸 JSON 输入；DI 单元的 trigger 是固定的 `(scopePath, token)` 三元组，不是反射出来的。
8. **已知注释漂移**：`ChatView.tsx:10` 头注释写 `delta` grade，实际发送的是 `'block'`（ws.ts:177）——陈旧注释，代码为准。

---

## 6. 关键代码位置索引

### oauth
| 位置 | 说明 |
|---|---|
| `packages/oauth/src/oauth.ts:119` | `requestDeviceAuthorization`（RFC 8628 §3.2 请求） |
| `packages/oauth/src/oauth.ts:168` | `pollDeviceToken`（pending/expired/denied 判别） |
| `packages/oauth/src/oauth.ts:226` | `refreshAccessToken`（退避重试 + 401/403 快速失败） |
| `packages/oauth/src/oauth-manager.ts:254` | `ensureFresh`（惰性刷新 + in-flight 合并） |
| `packages/oauth/src/oauth-manager.ts:284` | `doEnsureFresh`（锁后重读 + 401 竞态恢复 + 墓碑写入） |
| `packages/oauth/src/oauth-manager.ts:406` | `login`（15min 预算 + slow_down 步进） |
| `packages/oauth/src/oauth-manager.ts:195` | `acquireRefreshLock`（proper-lockfile 跨进程锁） |
| `packages/oauth/src/storage.ts:41` | `FileTokenStorage`（0600 + tmp/fsync/rename） |
| `packages/oauth/src/token-state.ts:28` | `classifyToken` 三态判定 |
| `packages/oauth/src/managed-kimi-code.ts:319` | `resolveKimiCodeOAuthKey`（凭据槽位哈希） |
| `packages/oauth/src/managed-kimi-code.ts:487` | `fetchManagedKimiCodeModels` |
| `packages/oauth/src/managed-kimi-code.ts:563` | `applyManagedKimiCodeConfig`（配置下发） |
| `packages/oauth/src/managed-kimi-code.ts:530` | `toManagedModelAlias`（能力推导 + betaApi） |
| `packages/oauth/src/toolkit.ts:110` | `KimiOAuthToolkit` 门面 |
| `packages/oauth/src/toolkit.ts:472` | `resolveKimiTokenStorageName`（storage 名安全映射） |
| `packages/oauth/src/refreshProviderModels.ts:377` | `refreshProviderModels` 编排 |
| `packages/oauth/src/custom-registry.ts:416` | `applyCustomRegistryEntries`（批量导入 bug 修复） |
| `packages/oauth/src/identity.ts:53` | `createKimiDeviceId` |
| `packages/oauth/src/managed-usage.ts:156` | `parseManagedUsagePayload`（金额/窗口归一化） |

### telemetry
| 位置 | 说明 |
|---|---|
| `packages/telemetry/src/bootstrap.ts:36` | `initializeTelemetry`（组装 client+sink+transport+metrics） |
| `packages/telemetry/src/client.ts:29` | `TelemetryClient`（队列/Scoped/disable） |
| `packages/telemetry/src/client.ts:88` | `trackWithContext`（sanitize + 缓冲） |
| `packages/telemetry/src/sink.ts:32` | `EventSink`（context 富化 + 阈值/定时 flush） |
| `packages/telemetry/src/transport.ts:64` | `send`（重试 + 磁盘兜底） |
| `packages/telemetry/src/transport.ts:171` | `sendHttp`（401 剥头重试） |
| `packages/telemetry/src/transport.ts:124` | `retryDiskEvents` |
| `packages/telemetry/src/transport.ts:243` | `applyServerPrefix`（kfc_ 前缀） |
| `packages/telemetry/src/crash.ts:20` | `installCrashHandlersForClient` |
| `packages/telemetry/src/systemMetrics.ts:19` | `SystemMetricsCollector` |

### kaos
| 位置 | 说明 |
|---|---|
| `packages/kaos/src/kaos.ts:12` | `Kaos` 接口定义 |
| `packages/kaos/src/process.ts:10` | `KaosProcess` |
| `packages/kaos/src/local.ts:188` | `LocalKaos`（实例级 cwd） |
| `packages/kaos/src/local.ts:71` | `LocalProcess`（进程组 kill） |
| `packages/kaos/src/local.ts:299` | `glob`（** 展开 + 环检测） |
| `packages/kaos/src/local.ts:593` | `_readUtf8Lines`（流式分行解码） |
| `packages/kaos/src/local.ts:495` | `scanTextFile`（UTF-8 校验 + 行尾探测） |
| `packages/kaos/src/environment.ts:75` | `detectEnvironment`（Git Bash 定位） |
| `packages/kaos/src/login-shell-path.ts:47` | `probeLoginShellPath` |
| `packages/kaos/src/current.ts:8` | AsyncLocalStorage 绑定 |
| `packages/kaos/src/ssh.ts:435` | `SSHKaos` |
| `packages/kaos/src/internal.ts:135` | `decodeTextWithErrors`（Python errors= 语义） |
| `packages/kaos/src/internal.ts:245` | `BufferedReadable` |

### migration-legacy
| 位置 | 说明 |
|---|---|
| `packages/migration-legacy/src/detect.ts:32` | `detectMigration`（kimi.json 反查 workdir） |
| `packages/migration-legacy/src/run-migration.ts:34` | `runMigration` 五步编排 |
| `packages/migration-legacy/src/steps/config.ts:193` | `migrateConfigStep`（schema 过滤 + 三模式写入） |
| `packages/migration-legacy/src/steps/config.ts:165` | `mergeConfig`（目标优先 + 冲突记录） |
| `packages/migration-legacy/src/sessions/index.ts:33` | `migrateSessionsStep`（排序/计数/幂等） |
| `packages/migration-legacy/src/sessions/migrate-one.ts:32` | `migrateOneSession`（目标分类 + 写盘 + mtime 还原） |
| `packages/migration-legacy/src/sessions/translator.ts:73` | `translateContextLines` |
| `packages/migration-legacy/src/sessions/close-tool-calls.ts:20` | `closeDanglingToolCalls` |
| `packages/migration-legacy/src/sessions/state-writer.ts:14` | `writeSessionState`（imported 标记） |
| `packages/migration-legacy/src/sessions/tool-call-display.ts:13` | `extractToolCallDisplays`（wire.jsonl 富化） |
| `packages/migration-legacy/src/marker.ts:37` | `shouldSuppressMigration` |
| `packages/migration-legacy/src/prompt.ts:32` | `resolveMigrationScope` |
| `packages/migration-legacy/src/session-index.ts:29` | `ensureSessionIndexEntry`（幂等） |

### tree-sitter-bash
| 位置 | 说明 |
|---|---|
| `packages/tree-sitter-bash/src/parse.ts:31` | `parse` 入口 + 退出契约 |
| `packages/tree-sitter-bash/src/budget.ts:29` | `ParseBudget`（tick/progress） |
| `packages/tree-sitter-bash/src/lexer.ts:445` | `scanToken` 分发 |
| `packages/tree-sitter-bash/src/lexer.ts:497` | heredoc 队列 + `scanBoundary` |
| `packages/tree-sitter-bash/src/lexer.ts:258` | `scanBalancedStatements`（case 感知） |
| `packages/tree-sitter-bash/src/parser.ts:293` | `parseProgram` |
| `packages/tree-sitter-bash/src/parser.ts:1438` | `parseCommand`（赋值前缀消歧） |
| `packages/tree-sitter-bash/src/parser.ts:1366` | `isFunctionDefinitionAhead` |
| `packages/tree-sitter-bash/src/parser.ts:969` | `parseCaseItem` + `scanCasePatternEnd` |
| `packages/tree-sitter-bash/src/parser.ts:2808` | `parseExpression`（Pratt 引擎） |
| `packages/tree-sitter-bash/src/parser.ts:1882` | `completeHeredocs`（事后扩展 end） |
| `packages/tree-sitter-bash/src/parser.ts:3759` | `materialize`（Frame→SyntaxNode） |
| `packages/tree-sitter-bash/src/grammar.ts:55` | `EXPRESSION_PRECEDENCE` |
| `packages/tree-sitter-bash/src/node.ts:19` | `SyntaxNode` |

### kimi-inspect
| 位置 | 说明 |
|---|---|
| `apps/kimi-inspect/src/connection.tsx:74` | `resolveBaseUrl`（同源代理/尾斜杠归一） |
| `apps/kimi-inspect/src/connection.tsx:157` | 探针成功后才 `createInspectClient` |
| `apps/kimi-inspect/src/connection.tsx:239` | `DebugSurfaceError` 阻塞屏 |
| `apps/kimi-inspect/src/servers.ts:29` | `fetchServerDiscovery` + 10s 轮询 |
| `apps/kimi-inspect/src/servers.ts:59` | `pickDefaultServer` 优先级 |
| `apps/kimi-inspect/src/channel/channel.ts:24` | `IChannel {call, listen}` 契约 |
| `apps/kimi-inspect/src/channel/channel.ts:39` | `ServiceProxy<T>` 映射类型 |
| `apps/kimi-inspect/src/channel/client.ts:54` | `InspectClient` 四级作用域 URL 拼接 |
| `apps/kimi-inspect/src/channel/proxy.ts` | JS Proxy → channel.call |
| `apps/kimi-inspect/src/channel/proxyChannel.ts:47` | HTTP 调用 + `{code,msg,data}` 信封 |
| `apps/kimi-inspect/src/channel/channels.ts:25` | channels 描述符（methods/params） |
| `apps/kimi-inspect/src/channel/errors.ts:7` | `RPCError` 数字 code 分支键 |
| `apps/kimi-inspect/src/sessions/api.ts:140` | v2 sessions 查询参数 + 游标 |
| `apps/kimi-inspect/src/sessions/views.ts:23` | `SESSION_VIEWS` 预设视图 |
| `apps/kimi-inspect/src/transcript/api.ts:60` | transcript REST（page_size=1 + seq 水位） |
| `apps/kimi-inspect/src/transcript/api.ts:134` | `fetchTranscriptOps`（since_seq 补齐） |
| `apps/kimi-inspect/src/transcript/api.ts:203` | `fetchTranscriptPlan`（plan 回放） |
| `apps/kimi-inspect/src/transcript/store.ts:21` | 薄封装 `applyOperation` reducer |
| `apps/kimi-inspect/src/transcript/store.ts:81` | `createCoalescedRunner`（合并并发刷新） |
| `apps/kimi-inspect/src/transcript/ws.ts:172` | `subscribe_v2`（block grade + 游标） |
| `apps/kimi-inspect/src/transcript/ws.ts:234` | `catchUp` 四路触发点对点补齐 |
| `apps/kimi-inspect/src/activity/ws.ts:88` | `GlobalEventsWs`（零订阅广播） |
| `apps/kimi-inspect/src/activity/store.ts:40` | `applyWorkChanged` 四字段去重 |
| `apps/kimi-inspect/src/activity/di.ts:23` | `useDiQueryInvalidation`（250ms 节流） |
| `apps/kimi-inspect/src/audit/trail.ts:75` | `AuditTrail`（5000 条上限） |
| `apps/kimi-inspect/src/audit/diff.ts:35` | 数组 ID 字段优先级匹配 |
| `apps/kimi-inspect/src/audit/diff.ts:114` | 引用相等快速路径 |
| `apps/kimi-inspect/src/components/ChatView.tsx:123` | 对账管线（seq 水位/buffer/catchUp） |
| `apps/kimi-inspect/src/components/DiInspectionView.tsx:139` | `useDiTrigger`（unprovide/update/dispose） |
| `apps/kimi-inspect/src/components/ModelCatalogView.tsx:584` | `findSource` 逐值 provenance |
| `apps/kimi-inspect/src/components/methodArgs.ts:115` | `parseParamFields` 参数表单 |
| `apps/kimi-inspect/src/components/StateCard.tsx:40` | 1s 轮询活 diff 树 |
| `apps/kimi-inspect/src/components/panels.ts:75` | CORE/SESSION/AGENT_PANELS 覆盖层 |
| `apps/kimi-inspect/src/components/BashParserView.tsx:134` | `IBashParserService.parse` 调试视图 |

---

## 7. 与其它子系统的接口

### 7.1 oauth —— 被四个包 + 一个应用依赖
- 暴露：`OAuthManager`、`KimiOAuthToolkit`、`FileTokenStorage`、`refreshProviderModels`、`applyManagedKimiCodeConfig` 系列、`fetchManagedUsage/UserInfo/Feedback` 系列、`createKimiDeviceId/Headers` 系列。
- 调用方：
  - `agent-core/src/services/auth/managedAuth.ts` — `KimiOAuthToolkit` 实例化，会话认证门面；
  - `agent-core/src/services/oauth/oauthService.ts`、`authSummaryService.ts`、`modelCatalogService.ts`、`environment.ts`、`session/provider-manager.ts` — 登录状态、用量摘要、模型目录；
  - `kap-server/src/routes/sessionExport.ts` — 导出会话时鉴权；
  - `apps/kimi-code` — `/login` 命令、telemetry 的 `getAccessToken`。

### 7.2 telemetry —— 被 CLI 与 web 服务器共用
- 暴露：`initializeTelemetry`、`track`、`setTelemetryContext`、`withTelemetryContext`、`flushTelemetrySync`、`shutdownTelemetry`、`installCrashHandlers`。
- 调用方：`apps/kimi-code/src/cli/telemetry.ts`（CLI 与 web 双 bootstrap，`KimiAuthFacade` 提供 token）；agent-core 经 `coreProcessOptions.telemetry` 接收同一 client，内部事件汇入同一管道。

### 7.3 kaos —— agent-core 工具层的执行后端
- 暴露：`Kaos` 接口、`LocalKaos`、`SSHKaos`（`/ssh` 子路径）、`detectEnvironment`、AsyncLocalStorage 便捷函数。
- 调用方：`agent-core/src/tools/builtin/file/*`（read/write/edit/grep/glob/read-media）、`tools/support/*`（run-rg/git-worktree/list-directory）、`tools/policies/path-access.ts`、`acp-adapter`、`node-sdk`。

### 7.4 migration-legacy —— 应用层一次性调用
- 暴露：`detectMigration`、`runMigration`、`resolveMigrationScope`、`shouldSuppressMigration`。
- 调用方：`apps/kimi-code/src/migration/{detect-pending,migration-screen,index,badge}.ts`、`apps/kimi-code/src/tui/kimi-tui.ts`（TUI 迁移屏）、`apps/vscode/src/migration/legacy-migration.manager.ts`。

### 7.5 tree-sitter-bash —— agent-core-v2 的命令安全分析
- 暴露：`parse(source, opts)` 单函数。
- 调用方：`agent-core-v2/src/app/bashParser/bashParser.ts` + `bashParserService.ts`（DI Service，执行前解析命令，权限策略消费 `hasError` 决定降级）。

### 7.6 kimi-inspect —— kap-server debug 面的官方客户端
- 消费（REST）：`/api/v1/debug/channels`（协议自描述）、`/api/v1/debug[/session/:sid[/agent/:aid]]/:service/:method`（RPC）、`/api/v2/sessions`、`/api/v1/search`、`/api/v1/sessions/{id}/transcript*`（transcript/ops/plan）；消费（WS）：`/api/v1/ws`（transcript.ops/reset + 全局事件帧），鉴权走 `kimi-code.bearer.<token>` 子协议。
- 复用：`@moonshot-ai/transcript` 的 contract zod schema 与 L2 `applyOperation` reducer（本地零重实现）；`agent-core-v2` 的 `createDecorator` ServiceIdentifier（decorator id 即 wire 通道名）与 Service 接口类型。
- 不消费：`/api/v2/ws`（服务器端已移除，无降级数据源——debug 表面不可用即阻塞错误屏）。

---

