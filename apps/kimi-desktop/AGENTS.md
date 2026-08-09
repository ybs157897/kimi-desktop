# Kimi Code Desktop

The Electron desktop app — Codex-style UI (React renderer) over an embedded or
attached kap-server backend. See the design doc at
`docs/{en,zh}/reference/desktop-app.md` for the protocol facts and the full
milestone breakdown. Post-M5 work (mode system, config center, experience
polish) is tracked in `ROADMAP.md`; M7 items there are a pending backlog
awaiting a decision on protocol-gap features (undo/compact/init/fork/btw/
plugins/MCP).

## Layering

```
src/main       — Electron main process: server lifecycle, window/menu, IPC bridge
src/preload    — contextBridge: getConnection(), readClipboardImage() (paste-to-attach),
                 openExternal() (http/https only) — see KimiDesktopBridge in src/shared
src/shared     — types + IPC channel names shared across the boundary
src/renderer   — React app; NO engine imports, all data over HTTP/WS
  src/lib        — data layer (ApiClient, react-query hooks, WS clients, stores)
  src/components — UI (sidebar / chat / composer / panels / markdown / settings)
```

The renderer never imports `@moonshot-ai/agent-core*`. It depends on the wire
contracts only: `@moonshot-ai/protocol` (REST/event zod schemas) and
`@moonshot-ai/transcript` (transcript contract + L2 reducer). The main process
imports `@moonshot-ai/kap-server`'s `startServer`.

## Data layer

Two independent WebSocket clients (the kimi-inspect pattern) plus a REST
baseline, all in `src/renderer/src/lib/`:

- **Activity socket** (`ws.ts` `createActivitySocket`): subscribes to nothing,
  consumes global events (`event.session.work_changed`, `session.meta.updated`,
  `event.config.changed`) to invalidate react-query queries. Mounted once by
  the app shell (`useGlobalActivitySocket`). It also `follow()`s the active
  session via `subscribe_v2` at transcript grade `'off'` — the one grade that
  does NOT suppress `agent.status.updated` / `goal.updated`, which merge into
  the `['session', id]` / `['goal', id]` caches (the mode bar's live state).
- **Transcript socket** (`ws.ts` `createTranscriptSocket`): serves the open
  session via `subscribe_v2` (grade `delta` — `append` chunks included, so
  thinking / assistant text streams live), with seq-watermark catch-up +
  resync fallback. Wired by `TranscriptSync`.
- **Terminal socket** (`ws.ts` `createTerminalSocket`): PTY I/O
  (`terminal_attach` / `_input` / `_resize`, `terminal_output` / `_exit`);
  REST (`createTerminal` / `listTerminals` / `closeTerminal`) manages lifecycle.

`TranscriptChatStore` reuses `@moonshot-ai/transcript`'s `applyOperation` — do
NOT reimplement the L2 merge. REST pages (`applyPage`) are the only source of
full state; WS ops are incremental.

Session-level actions (M7) ride `POST /sessions/{id}:fork|:undo|:compact|:btw`
and `GET|POST /sessions/{id}/tasks*` (schemas in `@moonshot-ai/protocol`).
After a destructive action (undo) the transcript must be re-seeded from the
REST baseline: `TranscriptSync.refresh()` (public since M7) is the coalesced
refresh trigger — the app shell reaches it through the `ChatViewHandle`
(`forwardRef` on `ChatView`). `ChatView`/`Composer` take an optional `agentId`
for the btw side channel (`agent-<N>` from `:btw`); the prompt body then
carries `agent_id`.

## Contract additions

When adding a new REST surface, prefer importing the zod schema + type from
`@moonshot-ai/protocol` and validate in `ApiClient.request({ schema })`. A few
endpoints have no protocol schema and are typed by hand client-side (skip
schema validation): the export endpoint (kap-server-only), and the provider
create/replace/import/catalog shapes (`CreateProviderRequest` etc. in
`lib/api.ts` — the protocol package only carries the list/get/refresh
responses). Server-config writes go through `POST /api/v1/config` (merge
semantics; the schema IS in `@moonshot-ai/protocol` as
`patchConfigRequestSchema`) — there is no PATCH verb.

## UI conventions

- Design tokens live in `src/renderer/src/styles/tokens.css` (named palette →
  `--color-*` semantic layer → `--color-token-*` prose layer). Component code
  references them via Tailwind arbitrary values
  (`bg-[var(--color-background-surface)]`). The semantic layer is dark by
  default; `[data-theme='light']` on `<html>` switches. Theme management is
  `lib/theme.ts` (`initTheme` runs before React mounts).
- Chat rendering dispatches by transcript frame kind (`TurnBlock` →
  `frames/*Frame.tsx`); tool frames dispatch by `frame.view ?? frame.name`
  against `ToolInputDisplaySchema`. Shared diff helpers are in
  `lib/diffRender.ts` (used by both the tool frame and the diff panel).
- The Composer is a Slate editor (`mentions.ts` declares the `CustomTypes`).
  `@`/`$`/`/` open `MentionMenu`; `/cmd` alone activates a skill; attachments
  upload via `POST /files` and fold into the prompt `content`.

## Panels (M4)

Right dock (`PanelHost`): `DiffPanel` (`fs:git_status` + `fs:diff`) and
`FileTreePanel` (`fs:list` lazy + `fs:read`). Bottom dock: `TerminalPanel`
(xterm.js over the terminal WS). Widths/active tab persisted to localStorage.

## Packaging

`electron-builder.yml` produces **unsigned** DMG/zip (macOS `identity: null`).
This is intentional for local `pnpm dist` — Gatekeeper blocks the unsigned
build on other machines. Real signing + notarization run in CI via `CSC_*`
env vars (Apple Developer ID); this repo deliberately carries no signing
secrets. `dist:dir` builds an unpacked `.app` for fast local smoke tests.

## Testing & verification

- `pnpm --filter @moonshot-ai/kimi-desktop test` — vitest; server lifecycle +
  pure-logic unit tests (diff helpers, export filename, mention serialization).
- `pnpm typecheck` / `pnpm build` — tsc + electron-vite build.
- **No GUI verification in CI/agent environments** — Electron windows,
  terminal PTY, drag-drop, and the diff/file-tree panels require a display.
  Mark these as "needs GUI acceptance" when landing changes.
