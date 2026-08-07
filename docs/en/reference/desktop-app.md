# Desktop App Implementation

This page is the implementation plan for Kimi Code Desktop, an Electron desktop app built on the kimi-code backend. It covers three things: the kimi-code client protocol, findings from reverse-engineering Codex Desktop, and the target architecture, UI mapping, and milestones derived from them.

> Protocol facts come from this repository's code (`packages/kap-server`, `packages/protocol`, `packages/transcript`, `packages/klient`); the code is the source of truth. Codex Desktop findings come from static reverse-engineering of a local install's frontend bundle (`app.asar`; on macOS the app is `ChatGPT.app`, bundle id `com.openai.codex`, observed version 26.730.61639). Behavior can change across releases.

::: info Note
This page is written for engineers building the desktop client. It assumes familiarity with basic Kimi Code CLI concepts (sessions, agents, tool calls, turns); see [Sessions and Context](/en/guides/sessions).
:::

## Overall architecture

The desktop app has three layers — an Electron shell, an embedded kap-server backend, and a React renderer — mirroring Codex Desktop's "Electron shell + codex app-server subprocess" architecture:

```text
┌─────────────────────────────────────────────────────────┐
│ Electron main process                                    │
│  · boots kap-server via startServer() (loopback + token) │
│  · or attaches to a running kimi web instance            │
│    (instance registry)                                   │
│  · windows / menus / protocol registration / OS bridges  │
└──────────────┬──────────────────────────────────────────┘
               │ HTTP + WebSocket (127.0.0.1, bearer token)
┌──────────────▼──────────────────────────────────────────┐
│ kap-server (agent-core-v2 engine)                        │
│  · REST /api/v1/*     · WS /api/v1/ws                    │
│  · transcript channel (turn / block / delta granularity) │
└──────────────▲──────────────────────────────────────────┘
               │ contracts: @moonshot-ai/protocol + @moonshot-ai/transcript
┌──────────────┴──────────────────────────────────────────┐
│ React renderer (Codex-style UI)                          │
│  · sidebar session list / chat timeline / composer       │
│    / panel system                                        │
│  · marked body rendering pipeline (aligned with Codex)   │
└─────────────────────────────────────────────────────────┘
```

Two key decisions: the renderer never imports engine code — all data flows over HTTP/WS, with contract types imported from `@moonshot-ai/protocol` and `@moonshot-ai/transcript`; and the UI structure, timeline items, and body rendering mirror Codex Desktop, with design tokens taken verbatim from the reverse-engineered CSS variables.

## The kimi-code client protocol

This section organizes the full protocol surface the desktop app consumes: connection and authentication, REST, WebSocket, the transcript contract, and the standard reconnect flow.

### Connection and authentication

kap-server is bootstrapped by `startServer(opts)` (`packages/kap-server/src/start.ts`); it is not a standalone executable, and the CLI entry is `kimi web`. When the desktop main process embeds it via `startServer()`, it must pass a `hostIdentity` (product name / version / platform); `webAssetsDir` is optional.

| Item | Value | Notes |
| --- | --- | --- |
| Default host | `127.0.0.1` | Loopback bind |
| Default port | `58627` | On conflict, retries `port + 1` up to 100 times; `0` picks an ephemeral port |
| Auth token | `<KIMI_CODE_HOME>/server.token` | Generated on first start, `0600` permissions, reused across restarts; `KIMI_CODE_HOME` defaults to `~/.kimi-code` |
| HTTP auth | `Authorization: Bearer <token>` | Missing or wrong token returns 401 with envelope `code: 40101` |
| WS auth | Same header, or subprotocol `kimi-code.bearer.<token>` | The subprotocol is the only credential channel available to browser/renderer contexts |
| Auth-exempt paths | `OPTIONS`, `GET /api/v1/healthz`, non-`/api/*` static assets | `/openapi.json` and `/asyncapi.json` still require the token |

After startup, call `GET /api/v1/meta` to validate: `server_version`, `capabilities`, `backend` (`'v2'` for the v2 engine), `dangerous_bypass_auth`, and more. Never run with `--dangerous-bypass-auth` — the token is the only line of defense on loopback.

Attach mode relies on the instance registry: every running server writes `{server_id, pid, host, port, started_at, heartbeat_at}` to `<KIMI_CODE_HOME>/server/instances/<serverId>.json`, refreshed on a 15-second heartbeat and swept by pid liveness. The desktop scans that directory and reads `server.token` to connect to a live instance with zero configuration — the same pattern kimi-inspect uses.

### REST API

All responses use a unified envelope: `{code, msg, data, request_id, details?}`, with `code: 0` on success. The HTTP status only reflects the transport layer; business outcomes live entirely in `code`: `4xxxx` client errors, `5xxxx` internal, `6xxxx` tool runtime, `7xxxx` provider passthrough, `8xxxx` MCP passthrough (`packages/protocol/src/error-codes.ts`).

Core endpoints grouped by function (full schemas live in `packages/protocol/src/rest/`):

| Group | Method + Path | Purpose |
| --- | --- | --- |
| Meta | `GET /api/v1/meta` | Version, capabilities, engine generation |
| Auth | `GET /api/v1/auth`, `POST /api/v1/oauth/login`, etc. | Readiness, OAuth device flow login / poll / cancel / logout |
| Config | `GET/POST /api/v1/config` | Read / patch (providers, default model, permission mode, hooks, …) |
| Models | `GET /api/v1/models`, `POST /api/v1/models/{alias}:set_default` | Model catalog and default model |
| Workspaces | `GET/POST /api/v1/workspaces`, `PATCH/DELETE /api/v1/workspaces/{id}` | Workspace CRUD; id shape `wd_<slug>_<hash12>` |
| Sessions | See next table | Lifecycle core |
| Search | `POST /api/v1/search` | Global full-text search across sessions, with index state |
| Files | `POST /api/v1/files` (multipart), `GET/DELETE /api/v1/files/{id}` | Attachment upload / download |
| Terminals | `GET/POST /api/v1/sessions/{id}/terminals`, etc. | PTY sessions (loopback only) |
| Skills | `POST /api/v1/sessions/{id}/skills/{name}:activate` | Activate a skill; equivalent to the `/skill` slash command |
| Debug | `GET/POST /api/v1/debug/*` | DI reflection RPC; requires `--debug-endpoints` and loopback |

Session lifecycle endpoints:

| Method + Path | Purpose |
| --- | --- |
| `POST /api/v1/sessions` | Create a session; the body must carry either `workspace_id` or `metadata.cwd` |
| `GET /api/v1/sessions` | List (cursor pagination, `busy` / `archived` / `workspace_id` filters) |
| `GET /api/v1/sessions/{id}` | Fetch one full `Session` (including `usage`, `agent_config`, `pending_interaction`) |
| `POST /api/v1/sessions/{id}/profile` | Update title, metadata, `agent_config`, `permission_rules` |
| `POST /api/v1/sessions/{id}:fork` / `:archive` / `:restore` / `:compact` / `:undo` / `:abort` | Fork / archive (soft delete; there is no hard delete) / restore / compact / undo / abort |
| `GET /api/v1/sessions/{id}/status` | Live status: `busy`, `model`, `plan_mode`, `context_usage`, … |
| `GET /api/v2/sessions` | Sidebar session list: `activity.status` (`running` / `approval` / `question` / `failed` / `idle`), `page_token` pagination, optional `include=git` |

Interaction endpoints (sending messages, approvals, questions):

| Method + Path | Purpose |
| --- | --- |
| `POST /api/v1/sessions/{id}/prompts` | Send a user message; body `{content: MessageContent[], model?, thinking?, permission_mode?, plan_mode?, ...}`, returns `{prompt_id, status: 'running' \| 'queued' \| 'blocked'}`; new messages queue automatically while busy |
| `POST /api/v1/sessions/{id}/prompts/{pid}:abort` | Abort a specific prompt (idempotent; finished prompts return `40903`) |
| `GET /api/v1/sessions/{id}/approvals?status=pending` + `POST .../approvals/{approval_id}` | List and answer approval requests; `decision` is `approved` / `rejected` / `cancelled`, `scope: 'session'` remembers the rule |
| `GET /api/v1/sessions/{id}/questions?status=pending` + `POST .../questions/{qid}` / `:dismiss` | List and answer questions (single / multi / custom text / skip) |
| `GET /api/v1/sessions/{id}/messages` | Message history pagination (`before_id` / `after_id`; content is a discriminated union of `text` / `tool_use` / `tool_result` / `image` / `thinking` / …) |
| `GET /api/v1/sessions/{id}/snapshot` | IM-style initial sync; see [Reconnect and consistency](#reconnect-and-consistency) |
| `GET /api/v1/sessions/{id}/transcript` | Turn-granular transcript pages; see [Transcript contract](#transcript-contract) |
| `GET /api/v1/sessions/{id}/transcript/ops?since_seq=` | Point-to-point catch-up; `complete: false` means a full refresh is required |
| `GET /api/v1/sessions/{id}/transcript/plan` | ExitPlanMode plan content and review results |
| `POST /api/v1/sessions/{id}/fs:{action}` | Session workspace file actions: `list` / `read` / `stat` / `mkdir` / `search` / `grep` / `git_status` / `diff` / `open` / `open-in` / `reveal` |
| `GET /api/v1/fs::browse`, `GET /api/v1/fs::home` | Session-free directory browsing (folder picker) |

Two contract artifacts are generated at runtime: `GET /openapi.json` (from fastify schemas) and `GET /asyncapi.json` (the WS message catalog); both require the token. The more reliable consumption path is depending on the TypeScript packages directly: `@moonshot-ai/protocol` (zod schemas for REST / events / envelope) and `@moonshot-ai/transcript` (transcript contract).

### WebSocket protocol

The only WS endpoint is `ws://<host>:<port>/api/v1/ws`. The upgrade request carries the bearer token (header or `kimi-code.bearer.<token>` subprotocol), and the server immediately sends `server_hello`:

```json
{
  "type": "server_hello",
  "timestamp": 1760000000000,
  "payload": {
    "ws_connection_id": "...",
    "protocol_version": 2,
    "max_event_buffer_size": 1000,
    "capabilities": { "event_batching": false, "compression": false }
  }
}
```

The client replies with `client_hello` (only `client_id` is required) to complete the handshake. Frames then come in three kinds: client control frames (each answered by an `ack`), server system frames, and session event frames. An event frame looks like `{type: 'session_event', seq, epoch?, volatile?, offset?, session_id?, timestamp, payload}`, where `seq` / `epoch` are the per-session persistent journal cursors: `seq` is the last applied durable event sequence number, `epoch` is the journal generation (changes on rebuild); `volatile: true` events skip the journal and do not advance `seq`.

The full set of client control frames:

| type | payload | Notes |
| --- | --- | --- |
| `client_hello` | `{client_id, token?}` | Handshake |
| `subscribe` | `{session_ids[], cursors?, agent_filter?}` | Subscribe to session event streams; `cursors` carry replay positions |
| `unsubscribe` | `{session_ids[]}` | Unsubscribe |
| `subscribe_v2` | `{session_id, transcript: Record<agentId \| '*', grade>, transcript_since?}` | The only transcript subscription channel; grade is `off` / `turn` / `block` / `delta` |
| `unsubscribe_v2` | `{session_id, agent_ids?}` | Remove transcript streams per agent |
| `watch_fs_add` / `watch_fs_remove` | `{session_id, paths[], recursive?}` | Workspace file watching (max 100 paths per connection) |
| `pong` | `{nonce}` | Answers `ping`; kap-server itself never sends `ping` and has no idle timeout, so liveness probing is up to the client |

Server system frames: `server_hello`, `ping`, `resync_required` (`reason` is `buffer_overflow` / `session_recreated` / `epoch_changed`; the client must rebuild that session from REST), and `error`.

Session events (the payload of `session_event`) fall into two classes. Durable events are journaled and replayable: `turn.started` / `turn.ended` / `turn.step.*`, `tool.call.started` / `tool.result` / `tool.list.updated`, `subagent.spawned` / `started` / `completed` / `failed`, `compaction.*`, `task.started` / `task.terminated`, `prompt.submitted` / `completed` / `aborted` / `steered`, `goal.updated`, `skill.activated`, `session.meta.updated`, `event.session.created` / `work_changed`, `event.workspace.*`, `event.config.*`, `error`, `warning`, and more. Volatile events skip the journal: `assistant.delta`, `thinking.delta` (text increments with an `offset`), `tool.call.delta`, `tool.progress`, `shell.output`, `agent.status.updated`.

For delivery, global events (`session.meta.updated`, `event.session.*`, `event.workspace.*`, `event.config.*`) fan out to every connection, session/agent-scoped events go only to connections subscribed to that session, and transcript frames (`transcript.ops` / `transcript.reset`) are governed solely by per-agent grades. The server batches within a 16ms window (64-frame batch cap, 1MiB backpressure watermark) and coalesces adjacent `assistant.delta` frames — clients align by `offset`: an `offset` smaller than the locally accumulated length is a duplicate (skip), larger means a gap (re-fetch the snapshot).

### Transcript contract

The transcript (`packages/transcript`) is the single source of truth for chat rendering: every agent has its own transcript, and the UI never rebuilds the timeline from `session_event` directly. The model has two parts — paginated **items** (a mixed timeline of turns / markers / taskrefs) and unpaginated **global state** (`tasks` / `interactions` / `attachments` / `todos` / `prompts` / `meta`, included in every page).

```text
turn (one turn)
 └─ step (one model call)
     └─ frame: text (assistant/user text) | thinking (reasoning) | tool (tool call) | notice
```

A `tool` frame carries `toolCallId`, `name`, `state` (`running` / `done` / `error`), `input` / `output` / `display`, `approvalId`, and more. An `interaction` represents approvals and questions (`interactionKind: 'approval' | 'question'`, state machine `pending` → `approved` / `answered` / `dismissed`, …). `meta` carries agent-level state such as the goal, plan mode, model, and context usage.

Incremental sync uses op batches (L2 idempotent operations), 14 in total: `reset`, `turn.upsert`, `step.upsert`, `frame.upsert`, `append` (text increment with `offset`), `marker.upsert`, `taskref.upsert`, `task.upsert`, `interaction.upsert`, `attachment.upsert`, `todo.upsert`, `prompt.upsert`, `meta.merge`, `items.remove`. Everything except `append` is a whole-state upsert, and flush points resend whole state, so a client that drops frames always converges eventually; the repository ships a ready-made L2 reducer (`packages/transcript/src/ops/`) — do not implement your own merge logic.

Subscription granularity is set per agent:

| grade | Content | Best for |
| --- | --- | --- |
| `off` | Nothing | Not interested |
| `turn` | Turn headers + global state | Notification level (sidebar badges) |
| `block` | + step headers + whole-state frames at flush points, no `append` | Recommended default; cheapest whole-state convergence |
| `delta` | Everything including `append` | Token-by-token typewriter effect |

Pagination is turn-based: `GET .../transcript?agent_id=main` without a cursor returns the newest page, `before_turn` pages to older turns, `after_turn` to newer ones; global state is not paginated. The rendering layer uses the view registry (`packages/transcript/src/view/`) to dispatch by key: tool frames by `frame.view ?? frame.name`, turns by `origin.kind`, tasks by `task.kind` — framework-agnostic, so the desktop injects its own React components.

### Reconnect and consistency

The officially designed gap-free rebuild flow (validated by kimi-inspect) runs in order:

1. `GET /api/v1/sessions/{id}/snapshot` for the baseline: it returns `{as_of_seq, epoch, session, messages, in_flight_turn, pending_approvals, pending_questions}`, where `in_flight_turn` restores in-progress streaming text.
2. WS `subscribe` with `cursors: {sid: {seq: as_of_seq, epoch}}`; the server replays later events from its in-memory tail (capped at 1000) or the on-disk journal.
3. Align the transcript channel via `subscribe_v2` with `transcript_since`; on a seq gap, catch up point-to-point with `GET .../transcript/ops?since_seq=`, and fall back to a full REST refresh on `complete: false` or `resync_required`.

For reconnects, follow kimi-inspect: exponential backoff (500ms doubling, capped at 10s), then a fresh `client_hello` plus the rebuild flow above. kimi-inspect also validates a pattern worth copying: **two independent sockets** — one activity socket that subscribes to nothing and only consumes global events to drive sidebar badges, and one transcript socket serving the currently open session.

## Codex Desktop analysis

This section summarizes the reverse-engineering findings for Codex Desktop's frontend: tech stack, layout, timeline items, the composer, the body rendering protocol, and design tokens. Its backend communication model is included as a reference for our main-process design.

### Tech stack and backend communication

Renderer stack: React 19, Vite 8 + Rolldown, Tailwind v4 + CSS Modules (a two-layer style mapping: custom `--color-*` semantic layer onto a `--vscode-*` compatibility layer), the Slate rich-text editor (composer), Statsig feature gates, and react-intl for i18n.

Backend communication has four layers and directly informs our main-process design:

```text
renderer (loaded via app:// protocol, no network access)
   │  window.electronBridge (contextBridge)
   │  · codex_desktop:message-from-view (invoke) / message-for-view (event)
   │  · chunked large-message protocol (codex-host-chunked-message-v1,
   │    token-by-token transfer with per-chunk ack)
   ▼
Electron main process (AppServerConnection)
   │  transport: stdio (spawn codex app-server, line-delimited JSON)
   │  or websocket (daemon, over a unix socket)
   ▼
codex binary (Rust, built-in app-server, JSON-RPC + MCP extensions)
```

The protocol is JSON-RPC (`{id, method, params}`) with method namespaces such as `thread/*` (start / resume / list / fork / archive / compact…), `turn/*` (start / interrupt / steer), `item/*` (streaming notifications like `agentMessage/delta`, `commandExecution/outputDelta`, `fileChange/patchUpdated`), `fs/*`, `config/*`, `model/*`, and `account/*`. The data model is `thread → turn → item`, which maps one-to-one onto kimi-code's `session → turn → frame` (see the [UI mapping](#ui-mapping) table).

Main-process designs worth borrowing: the renderer has no network access and all data crosses an IPC bridge; the backend subprocess speaks JSONL over stdio, with a daemon mode over a unix socket so multiple windows share one backend; the `initialize` handshake negotiates versions, with separate restart / update paths on mismatch; and a connection registry carries a `hostId` everywhere to leave room for remote environments.

### App shell layout

The shell is a flex layout: left sidebar + main content + right/bottom panels (all resizable by drag, widths persisted). On macOS it uses the system `titleBarStyle: 'hiddenInset'` plus vibrancy rather than a custom titlebar; the main window defaults to 1280×820.

The left sidebar, top to bottom:

- **Top actions**: New chat, Search (`Cmd+K`), Quick chat (a lightweight popover chat).
- **Session sections**: Pinned, project-grouped session lists (priority / updated / manual ordering), custom sections.
- **Bottom navigation**: Pull requests, Library, Sites, Automations (scheduled tasks), Skills / Plugins, Settings.

The right and bottom areas share a unified tab panel system; tab kinds include `browser` / `diff` / `mcp-app` / `plan` / `sandbox` / `timeline` / `terminal` / `file tree`, and tabs move between the two panels. Core shortcuts: `Cmd+B` toggles the sidebar, `Cmd+J` the bottom panel, `` Ctrl+` `` the terminal, `Cmd+Shift+E` the file tree.

### Chat timeline items

The timeline is organized as `thread → turn → item`; the item renderer's full case set (the ones relevant to us in bold within the mapping table): `user-message`, `assistant-message`, `reasoning`, `exec`, `patch`, `web-search`, `mcp-tool-call`, `dynamic-tool-call`, `permission-request`, `todo-list`, `proposed-plan` / `plan-implementation`, `turn-diff`, `subagent-activity`, `multi-agent-action`, `context-compaction`, `generated-image` / `image-view`, `worked-for`, `steered`, `stream-error` / `system-error`, `model-changed`, `forked-from-conversation`, and more.

Visual structure of the key items:

- **exec (command execution) card**: a rounded bordered card containing the command, cwd, output, and a status footer (green check on success / exit code on failure / "Stopped" on interruption); collapsible.
- **patch (file changes)**: state machine `applied` / `rejected` / `stopped` / `streaming` / `pending`; one diff block per file (header with add/remove count badges, monospaced content with colored added/removed lines), aggregated at turn end into `turn-diff` ("N files +X −Y" with a Revert button).
- **reasoning**: "Thinking" / "Thought for {elapsed}"; de-emphasized body color, collapsed by default, expandable.
- **permission-request (approval card)**: a large rounded card with title, reason, and details; buttons "Allow once" (primary, Enter) / "Always allow" / "Allow this conversation" / "Deny" (Esc).
- **worked-for separator**: inserted between turns — "Working…" / "Worked for {time}" / "You stopped after {time}" — with a divider line.
- **web-search**: a single summary line "Searched the web for {query}" with animated dots while running.
- **user-message**: its own bubble with the role label "You said:".

The gap between groups is 16px, within a group 4px; collapsible activity rows use a rotating chevron and two-tone summary text.

### Composer

The composer is Codex's densest interaction component. Its structure: a layout root (column flex) → input body (surface with `backdrop-filter`) → a three-column footer (leading / input / trailing). Highlights:

- **Input**: Slate rich text, `max-height: 25dvh`, 13px font; placeholder switches by context ("Do anything" / goal / plan copy).
- **Intelligence dropdown** (trigger tooltip "Select model"): three sections — Model / Effort / Speed; the effort ladder is `none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` / `ultra`.
- **Permission mode dropdown**: "Ask for approval" / "Full access" (with a confirmation step) / "Custom (config.toml)".
- **Context and attachments**: `@` triggers file mentions, `$` skill mentions, `/` slash commands (`/init` `/goal` `/plan` `/model` `/compact` `/fork` `/review`, …); drag-and-drop attachments ("Drop to attach").
- **Send / stop button**: a solid round button whose tooltip switches by state — Send / Steer / Queue / Stop (Esc shown while stopping); sending while busy means queueing or steering.

### Body Markdown protocol

Codex's assistant body is a single Markdown string, rendered through: preprocessing → the marked lexer (GFM + `breaks: true`) → tokens → React components. Key points (a full analysis exists in a prior reverse-engineering document):

- **Lexer options**: GFM on, soft line breaks become `<br>`, and standard `~~strikethrough~~` is disabled (the `del` tokenizer returns false when input starts with `~~`).
- **Directive extension**: three marker levels — `:::name{attrs}` container, `::name{attrs}` block, `:name{attrs}` inline; attributes support `key=value`, quoted strings, booleans, and numbers; **unknown names fall back to raw text and must never crash the message**.
- **Math**: lazily loaded KaTeX; `\[...\]` / `$$...$$` blocks, `\(...\)` inline; `throwOnError: false`.
- **Code fences**: Shiki highlighting; `mermaid` renders diagrams; `md` / `markdown` / `text` fences can be promoted to an editable writing block; open streaming fences get `isCodeFenceOpen` handling.
- **File citations**: literals like `【path/to/file.ts†L12】` / `【path†L12-L40】` (an `F:` prefix means percent-encoded) render as clickable chips; link forms support line anchors such as `path:12`, `path:12:4-40:8`, `path#L12C4`.
- **Preprocessing**: HTML comments stripped; `<details>` converted to `:::github-details`; `> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION]` converted to styled quote blocks; fenced code protected with placeholders first.
- **Robustness**: each extension tokenizer is wrapped in its own try/catch; an ErrorBoundary with Retry wraps the Markdown root; one bad token must never take down the whole thread.

Beyond the body, Codex's custom directives fall into two classes: visible components (`::codex-file-citation`, `:::github-details`, `::task-stub`, `:::writing`, …) and hidden side effects (`::git-stage` / `::git-commit` / `::git-create-pr` / `::code-comment`, …, which render as null but drive other UI). When aligning body rendering, the desktop copies the visible class and trims the hidden class to kimi-code's capabilities.

### Design tokens

Codex's design tokens have three layers: a named palette → a `--color-*` semantic layer → a `--color-token-*` / `--vscode-*` compatibility layer. The values below are extracted directly from the shipped CSS; copying them verbatim reproduces the look.

Named palette (excerpt, shared by light / dark):

| Variable | Value | Variable | Value |
| --- | --- | --- | --- |
| `--gray-0` / `50` / `75` / `100` | `#fff` / `#f9f9f9` / `#f3f3f3` / `#ededed` | `--gray-300` / `500` / `550` / `600` | `#afafaf` / `#5d5d5d` / `#4f4f4f` / `#414141` |
| `--gray-700` / `750` / `800` / `900` / `1000` | `#303030` / `#282828` / `#212121` / `#181818` / `#0d0d0d` | `--blue-300` / `400` / `500` | `#339cff` / `#0285ff` / `#0169cc` |
| `--green-400` / `500` | `#04b84c` / `#00a240` | `--red-400` / `500` | `#fa423e` / `#e02e2a` |
| `--orange-400` | `#fb6a22` | `--purple-400` | `#924ff7` |

Semantic layer (light / dark):

| Semantic variable | Light | Dark |
| --- | --- | --- |
| `--color-background-surface` | `#ffffff` | `#181818` |
| `--color-background-surface-under` | `#f9f9f9` | `#000000` |
| `--color-text-foreground` | `#1a1c1f` | `#ffffff` |
| `--color-background-editor-opaque` | — | `#212121` |
| Borders (normal / heavy / light) | Foreground at 8% / 12% / 5% mix | White at 8% / 16% / 4% mix |
| Accent (background / text) | `blue-50` / `blue-300` | `blue-900` / `blue-100` |
| Primary button | Foreground-colored background with white text | `gray-1000` background |

Typography and scale:

| Category | Values |
| --- | --- |
| Fonts | sans: `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`; mono: `ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, monospace` |
| Chat font size | `--codex-chat-font-size: 13px`; code 12px |
| Font size ladder | xs 11 / sm 12 / base 14 / lg 16 / xl 28 / 2xl 36 / 3xl 48 / 4xl 72 (px) |
| Radii | base × `--corner-radius-scale` (1 in desktop windows): md 8 / lg 10 / xl 12 / 2xl 16 / 3xl 20 (px); pill rows 9999px |
| Spacing | 4px base (`--spacing: .25rem`); toolbar padding 16px, panel 12px; conversation group gap 16px, within-group 4px |
| Layout | Main window 1280×820; right panel min width 320px; thread content max width 40rem (extension window); markdown wide-block cap 64rem |
| Shadow | Panel divider `-8px 0 16px -8px rgb(0 0 0 / .18)` |

Markdown body typography: body color `--color-token-text-primary` with `overflow-wrap: anywhere`; inline code is monospaced with `border-radius: 6px`, `padding: 1px 6px`, `font-size: .92em`; code blocks use `border-radius: 10px`, `padding: 8px`, `line-height: 20px`, horizontal scrolling; lists use `padding-inline-start: 1.3125rem`; paragraph/list spacing `.625rem`.

## Target design

Combining the protocol capabilities with the Codex findings, this section defines the desktop target design: process model, renderer stack, data layer, the UI mapping table, and window specifications.

### Process model

The desktop supports two run modes, with embedding as the default:

1. **Embedded mode**: the main process calls `startServer({host: '127.0.0.1', port: 0, hostIdentity: {name: 'kimi-code-desktop', ...}})`; `port: 0` grabs an ephemeral port and registers it in the instance registry. The token reuses `<KIMI_CODE_HOME>/server.token` (0600). The engine shares the app's lifecycle and is closed on quit.
2. **Attach mode**: scan `<KIMI_CODE_HOME>/server/instances/` to discover a running `kimi web` instance and connect with its token — multiple windows share one backend, and it is convenient for developing the UI against a CLI-started server.

The renderer holds no network access beyond the token; HTTP goes through `fetch`, and WS uses the `kimi-code.bearer.<token>` subprotocol. Upgrade and version compatibility are validated at startup via `GET /api/v1/meta` (`backend === 'v2'`, minimum `server_version`).

### Renderer tech stack

Aligned with Codex: React 19 + Vite + Tailwind v4 + CSS Modules. The composer input uses Slate (or an equivalent rich-text layer) to host `@` / `$` / `/` mentions. The Markdown pipeline uses marked with custom extensions (directives, math, `【†L】` citations), Shiki for highlighting, and lazily loaded KaTeX. The contract layer depends on `@moonshot-ai/protocol` (REST / event zod schemas) and `@moonshot-ai/transcript` (transcript contract + L2 reducer + view registry) — no hand-written wire types.

### Data layer and rendering pipeline

The data layer copies the pattern kimi-inspect has already validated — two sockets plus a REST baseline:

1. **Activity socket**: after `client_hello`, it subscribes to nothing and only consumes global events (`event.session.work_changed`, `session.meta.updated`, …) to drive sidebar badges and list invalidation.
2. **Transcript socket**: serves the current session via `subscribe_v2`, defaulting to the `block` grade (switch to `delta` for a typewriter effect), with `transcript_since` and `/transcript/ops` for gap repair.
3. **REST baseline**: the session list uses `GET /api/v2/sessions`; opening a session starts from `GET .../snapshot` (or the newest transcript page), and scrolling up pages with `before_turn`.

The rendering pipeline: `transcript.ops` → the L2 reducer (reused from `@moonshot-ai/transcript`) → store → the view registry dispatches by key to React components → body frames go through the marked pipeline. Interactions (approvals / questions) render as cards driven by the transcript's `interactions`, answered over REST; after a reconnect, `GET .../approvals?status=pending` is the backstop.

### UI mapping

Codex timeline items mapped to kimi-code protocol objects (desktop components are implemented accordingly):

| Codex item | kimi-code source | Component notes |
| --- | --- | --- |
| `user-message` | `text` frame (`role: 'user'`) / turn `prompt` | User bubble |
| `assistant-message` | `text` frame (`role: 'assistant'`) | marked body pipeline |
| `reasoning` | `thinking` frame | De-emphasized, collapsed by default |
| `exec` | `tool` frame (`Bash`, …) / `task` (`kind: 'shell'`) | Command card + status footer |
| `patch` / `turn-diff` | `tool` frame (`Edit` / `Write`, …) + `fs:diff` | Per-file diff blocks, turn-level aggregation |
| `web-search` | `tool` frame (`WebSearch`) | Single-line summary + animated dots |
| `permission-request` | `interactions` (`approval`) + `ApprovalRequest` | Approval card (Allow once / Always / Deny) |
| `todo-list` | Global state `todos` | Task checklist |
| `proposed-plan` | Plan interaction (`display.kind: 'plan_review'`) + `GET .../transcript/plan` | Plan card (Accept / Revise) |
| `mcp-tool-call` | `tool` frame (MCP tools) | With MCP server identity |
| `subagent-activity` | `subagent.*` events + the subagent's transcript | Activity row + expandable sub-transcript |
| `context-compaction` | `compaction.*` events / marker | Separator notice |
| `worked-for` | Turn `startedAt` / `endedAt` / `durationMs` | Turn separator |
| `generated-image` / `image-view` | `attachment` / `image` content | Image display |
| `stream-error` / `system-error` | `notice` frame / `turn.ended`'s `error` | Error banner |

Codex items with no kimi-code counterpart yet (`realtime-transcript`, `automation-update`, the pull-requests view, …) are out of scope for the first release; kimi-code capabilities Codex lacks (goals, question cards, skill activation rows) render normally from transcript global state.

### Windows and shortcuts

The main window defaults to 1280×820 with `titleBarStyle: 'hiddenInset'` plus vibrancy on macOS. The right panel (diff / file tree / browser) has a 320px minimum width and persisted sizing; the bottom panel hosts the terminal (`POST .../terminals` PTY, loopback only). Shortcuts align with Codex: `Cmd+B` sidebar, `Cmd+J` bottom panel, `` Ctrl+` `` terminal, `Cmd+K` search, `Cmd+Shift+E` file tree, Enter to approve / Esc to deny approvals.

## Milestones

Deliver in verifiable milestones; each ends in a usable state:

1. **M0 Scaffold and connection**: Electron project (electron-vite), embedded `startServer`, token management, `GET /api/v1/meta` validation, activity socket up. Acceptance: the window opens and the sidebar shows the backend version.
2. **M1 Session list**: `GET /api/v2/sessions` paginated list, activity badges, create / archive / search (`POST /api/v1/search`), workspace picker (`fs::browse`). Acceptance: full session management.
3. **M2 Chat rendering**: transcript REST pagination + `subscribe_v2` (block) + L2 reducer + view registry; the marked body pipeline (GFM + breaks + fault-tolerant directives + Shiki + KaTeX + file citation chips); tool / thinking / notice components. Acceptance: correct history and streaming rendering, seamless reconnect recovery.
4. **M3 Composer and interactions**: Slate input, `@` / `$` / `/` mentions, attachment upload (`POST /files`), send / queue / steer / stop; approval cards, question cards, plan review; permission mode and effort dropdowns (written back via `POST .../prompts` and the profile). Acceptance: complete a full task that includes an approval.
5. **M4 Panel system**: right-side diff (`fs:diff` / `fs:git_status`), file tree (`fs:list` / `fs:read`), bottom terminal (terminals REST plus its own PTY channel), `open-in` external opening. Acceptance: Codex's panel experience.
6. **M5 Polish**: full design-token rollout (light and dark themes), shortcuts, multi-window (shared backend via attach mode), export (`POST .../export` with `desktop: true` to bundle desktop logs).

## Reference implementations and materials

- **kimi-inspect** (`apps/kimi-inspect`): a working web client — instance registry discovery, the dual-socket pattern, and transcript rendering / gap repair can all be copied directly.
- **Contract packages**: `@moonshot-ai/protocol` (REST / WS / events), `@moonshot-ai/transcript` (transcript contract + reducer + view registry).
- **Runtime contracts**: `GET /openapi.json`, `GET /asyncapi.json` (token required).
- **OpenWork** (`.tmp/openwork`): an open-source Codex-style Electron desktop app (React + Electron); its project structure (main / preload / renderer layering, packaging) works as scaffold reference.

## Next steps

- [kimi Command](/en/reference/kimi-command) — `kimi web` startup flags and defaults
- [Interaction and Input](/en/guides/interaction) — Kimi Code interaction conventions
- [Built-in Tools](/en/reference/tools) — how tool output enters session context
