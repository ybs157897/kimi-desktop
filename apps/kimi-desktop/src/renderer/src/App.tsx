/**
 * App shell — Codex-style layout:
 *
 *   drag region (46 px) → macOS traffic lights (80 px left inset), draggable
 *   left rail (280 px)  → New chat / search / session list
 *   main area           → ChatView of the active session (or an empty state)
 *   right dock          → resizable panel container (diff / file tree / plan /
 *                         terminal land here in later milestones — M4)
 *   bottom dock         → collapsible panel container, hidden by default
 *
 * REST side rides react-query (list, models, config); the global activity
 * socket is mounted once here and invalidates list/config queries on
 * server-pushed events.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import { NewSessionButton } from './components/sidebar/NewSessionButton';
import { SessionList } from './components/sidebar/SessionList';
import { SidebarSearch, type SidebarSearchHandle } from './components/sidebar/SidebarSearch';
import { ChatView, type ChatViewHandle } from './components/chat/ChatView';
import { DiffPanel } from './components/panels/DiffPanel';
import { FileTreePanel } from './components/panels/FileTreePanel';
import { PanelHost, type PanelKind } from './components/panels/PanelHost';
import { TerminalPanel } from './components/panels/TerminalPanel';
import { ModeBar } from './components/session/ModeBar';
import { SessionActionsMenu } from './components/session/SessionActionsMenu';
import { SideChatPanel } from './components/session/SideChatPanel';
import { TaskBrowser } from './components/session/TaskBrowser';
import { Settings } from './components/Settings';
import { StatusBar } from './components/StatusBar';
import { Welcome } from './components/Welcome';
import { useConnection } from './lib/connection';
import { loadDefaultPermissionMode } from './lib/permissionMode';
import { useCreateSession, useGlobalActivitySocket, useV2Sessions } from './lib/queries';
import { useShortcuts, type ShortcutHandlers } from './lib/useShortcuts';
import { webAppUrl } from './lib/webUrl';

const RIGHT_PANEL_WIDTH_KEY = 'app-shell:right-panel-width:v3';
const RIGHT_PANEL_COLLAPSED_KEY = 'app-shell:right-panel-collapsed:v3';
const BOTTOM_PANEL_OPEN_KEY = 'app-shell:bottom-panel-open:v3';
const RIGHT_PANEL_TAB_KEY = 'app-shell:right-panel-tab:v3';

const RIGHT_PANEL_MIN_WIDTH = 320;
const RIGHT_PANEL_MAX_WIDTH = 720;
const RIGHT_PANEL_DEFAULT_WIDTH = 380;
const BOTTOM_PANEL_HEIGHT = 260;

const DRAG_REGION_HEIGHT = 46; // px
const TRAFFIC_LIGHT_INSET = 80; // px, macOS window controls

function clampWidth(width: number): number {
  return Math.min(Math.max(width, RIGHT_PANEL_MIN_WIDTH), RIGHT_PANEL_MAX_WIDTH);
}

function readStoredWidth(): number {
  const raw = localStorage.getItem(RIGHT_PANEL_WIDTH_KEY);
  if (raw === null) return RIGHT_PANEL_DEFAULT_WIDTH;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? clampWidth(parsed) : RIGHT_PANEL_DEFAULT_WIDTH;
}

export function App() {
  const { api, baseUrl, token, mode, serverVersion } = useConnection();
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  useGlobalActivitySocket(activeSessionId);

  const sessions = useV2Sessions({
    archived: 'false',
    sort: 'meta.updated_at_desc',
    includeGit: true,
  });
  const createSession = useCreateSession();
  const sessionItems = sessions.data?.pages.flatMap((page) => page.items) ?? [];
  const activeSession = sessionItems.find((session) => session.id === activeSessionId);
  const activeTitle =
    activeSession?.meta.title ?? activeSession?.meta.lastPrompt ?? '新会话';

  // Session creation at a specific cwd (New chat button's recent-roots
  // dropdown); auto-selects the new session. Busy state is shared with the
  // primary `handleNewSession` via `createSession.isPending`. New sessions
  // inherit the user's default permission mode (localStorage) as their
  // session-level `agent_config`.
  const createSessionAt = useCallback(
    (cwd: string) => {
      void (async () => {
        if (createSession.isPending) return;
        try {
          const session = await createSession.mutateAsync({
            metadata: { cwd },
            agent_config: { permission_mode: loadDefaultPermissionMode() },
          });
          setActiveSessionId(session.id);
        } catch {
          // The mutation surface reports the error via createSession.error.
        }
      })();
    },
    [createSession],
  );

  // New chat without a workspace picker (a later milestone): create the
  // session at the server host's home directory.
  const handleNewSession = useCallback(() => {
    void (async () => {
      try {
        const home = await api.fsHome();
        createSessionAt(home.home);
      } catch {
        // fsHome failure: nothing to create; the button's busy state resets.
      }
    })();
  }, [api, createSessionAt]);

  // ---- right dock: resizable (width persisted), collapsible ----
  const [rightPanelWidth, setRightPanelWidth] = useState(readStoredWidth);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(
    () => localStorage.getItem(RIGHT_PANEL_COLLAPSED_KEY) === 'true',
  );
  // ---- bottom dock: collapsible, hidden by default ----
  const [bottomPanelOpen, setBottomPanelOpen] = useState(
    () => localStorage.getItem(BOTTOM_PANEL_OPEN_KEY) === 'true',
  );
  // ---- right dock active tab (diff / files) ----
  const [rightPanelTab, setRightPanelTab] = useState<PanelKind>(
    () => (localStorage.getItem(RIGHT_PANEL_TAB_KEY) as PanelKind | null) ?? 'diff',
  );
  // ---- sidebar collapsible (Cmd+B) ----
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('app-shell:sidebar-collapsed:v3') === 'true',
  );
  // ---- settings modal ----
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [sideChat, setSideChat] = useState<{ readonly agentId: string } | null>(null);
  const searchInputRef = useRef<SidebarSearchHandle>(null);
  const chatViewRef = useRef<ChatViewHandle>(null);

  const rightPanelWidthRef = useRef(rightPanelWidth);
  useEffect(() => {
    rightPanelWidthRef.current = rightPanelWidth;
    localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(rightPanelWidth));
  }, [rightPanelWidth]);

  useEffect(() => {
    localStorage.setItem(RIGHT_PANEL_COLLAPSED_KEY, String(rightPanelCollapsed));
  }, [rightPanelCollapsed]);

  useEffect(() => {
    localStorage.setItem(BOTTOM_PANEL_OPEN_KEY, String(bottomPanelOpen));
  }, [bottomPanelOpen]);

  useEffect(() => {
    localStorage.setItem(RIGHT_PANEL_TAB_KEY, rightPanelTab);
  }, [rightPanelTab]);

  useEffect(() => {
    localStorage.setItem('app-shell:sidebar-collapsed:v3', String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  // Global shortcuts (Codex-aligned). Memoized so the effect is stable.
  const shortcuts = useMemo<ShortcutHandlers>(
    () => ({
      toggleSidebar: () => setSidebarCollapsed((value) => !value),
      toggleBottomPanel: () => setBottomPanelOpen((value) => !value),
      openTerminal: () => {
        setBottomPanelOpen(true);
      },
      openFileTree: () => {
        setRightPanelCollapsed(false);
        setRightPanelTab('files');
      },
      focusSearch: () => searchInputRef.current?.focus(),
    }),
    [],
  );
  useShortcuts(shortcuts);

  // Dragging is driven by pointer capture on the handle element, so a mouseup
  // outside the window (or a lost capture) still ends the resize cleanly.
  const resizingRef = useRef(false);
  const resizeStartRef = useRef({ x: 0, width: 0 });

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizingRef.current = true;
    resizeStartRef.current = { x: event.clientX, width: rightPanelWidthRef.current };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const handleResizePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizingRef.current) return;
    const { x, width } = resizeStartRef.current;
    setRightPanelWidth(clampWidth(width + (x - event.clientX)));
  }, []);

  const handleResizePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizingRef.current) return;
    resizingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[var(--color-background-surface)] text-[var(--color-text-foreground)]">
      {/* -------------------------------------------------- drag region (46px) */}
      <header
        className="app-drag-region flex shrink-0 items-stretch border-b border-[var(--color-border-light)] bg-[var(--color-background-surface)]"
        style={{ height: DRAG_REGION_HEIGHT }}
      >
        <div className="flex w-[280px] shrink-0 items-center bg-[var(--color-background-surface-under)]">
          <div className="shrink-0" style={{ width: TRAFFIC_LIGHT_INSET }} aria-hidden="true" />
          <span className="text-[14px] font-semibold tracking-[-0.01em]">Kimi Code</span>
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2 px-4">
          {activeSessionId !== null ? (
            <>
              <span className="min-w-0 truncate text-[13px] font-semibold">{activeTitle}</span>
              <span className="min-w-0 truncate text-[11px] text-[var(--color-text-tertiary)]">
                {activeSession?.workspace.cwd?.split('/').filter(Boolean).at(-1)}
              </span>
            </>
          ) : (
            <span className="text-[13px] font-medium text-[var(--color-text-secondary)]">工作区</span>
          )}
          <ModeBar sessionId={activeSessionId} />
          <div className="app-no-drag flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                // TUI `/web` equivalent: open the embedded server's web UI in
                // the system browser, deep-linked to the active session.
                void window.kimiDesktop.openExternal(webAppUrl(baseUrl, activeSessionId, token));
              }}
              title="在浏览器打开"
              aria-label="在浏览器打开"
              className="flex h-7 w-7 items-center justify-center rounded-lg text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
            >
              🌐
            </button>
            <button
              type="button"
              onClick={() => setBottomPanelOpen((open) => !open)}
              className={`rounded-lg px-2.5 py-1.5 text-[11px] font-medium ${
                bottomPanelOpen
                  ? 'bg-[var(--color-list-active)] text-[var(--color-text-foreground)]'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)]'
              }`}
            >
              终端
            </button>
            <button
              type="button"
              onClick={() => setRightPanelCollapsed((collapsed) => !collapsed)}
              className={`rounded-lg px-2.5 py-1.5 text-[11px] font-medium ${
                !rightPanelCollapsed
                  ? 'bg-[var(--color-list-active)] text-[var(--color-text-foreground)]'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)]'
              }`}
            >
              工作区信息
            </button>
            <SessionActionsMenu
              sessionId={activeSessionId}
              chatRef={chatViewRef}
              onOpenTasks={() => setTasksOpen(true)}
              onSideChat={(agentId) => setSideChat({ agentId })}
              onForked={(session) => setActiveSessionId(session.id)}
            />
          </div>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {/* ---------------------------------------------------------- left rail */}
        {sidebarCollapsed ? (
          <button
            type="button"
            aria-label="展开侧栏"
            title="展开侧栏 (Cmd+B)"
            onClick={() => setSidebarCollapsed(false)}
            className="flex w-10 shrink-0 items-center justify-center border-r border-[var(--color-border)] bg-[var(--color-background-surface-under)] text-[13px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
          >
            ›
          </button>
        ) : (
        <aside className="flex w-[280px] shrink-0 flex-col border-r border-[var(--color-border-light)] bg-[var(--color-background-surface-under)]">
          <div className="flex flex-col gap-1.5 px-2.5 pb-2 pt-2.5">
            <NewSessionButton
              onCreate={handleNewSession}
              onCreateWithCwd={createSessionAt}
              busy={createSession.isPending}
            />
            <SidebarSearch
              ref={searchInputRef}
              value={searchQuery}
              onChange={setSearchQuery}
              onSubmit={() => {
                // Global search results panel lands with the sidebar search UI
                // (M1); the data layer already ships `POST /api/v1/search`.
              }}
              onSelect={setActiveSessionId}
              placeholder="搜索会话… (Cmd+K)"
            />
          </div>
          <SessionList
            sessions={sessionItems}
            activeSessionId={activeSessionId ?? undefined}
            onSelect={setActiveSessionId}
            loading={sessions.isLoading}
            error={sessions.error instanceof Error ? sessions.error.message : null}
            onRetry={() => void sessions.refetch()}
            hasMore={sessions.hasNextPage}
            onLoadMore={() => {
              if (sessions.hasNextPage) void sessions.fetchNextPage();
            }}
          />

          {/* --------------------------------------- bottom nav (settings stub) */}
          <div className="border-t border-[var(--color-border-light)] px-2 py-2">
            <div
              className="px-2 pb-1 text-[10px] text-[var(--color-text-tertiary)]"
              title={`kap-server ${serverVersion} (${mode})`}
            >
              Backend {serverVersion} · {mode === 'embedded' ? '内嵌' : '附着'}
            </div>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
                className="shrink-0 text-[var(--gray-500)]"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              Settings
            </button>
          </div>
        </aside>
        )}

        {/* ------------------------------------------------------- main area */}
        <main className="flex min-w-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            {activeSessionId !== null ? (
              <ChatView ref={chatViewRef} sessionId={activeSessionId} />
            ) : (
              <Welcome onNewSession={handleNewSession} />
            )}
          </div>
          {sideChat !== null && activeSessionId !== null ? (
            <SideChatPanel
              sessionId={activeSessionId}
              agentId={sideChat.agentId}
              onClose={() => setSideChat(null)}
            />
          ) : null}
        </main>

        {/* --------------------------------------- right dock (resizable dock) */}
        {rightPanelCollapsed ? (
          <button
            type="button"
            aria-label="展开右侧面板"
            title="展开右侧面板"
            onClick={() => setRightPanelCollapsed(false)}
            className="absolute right-0 top-0 z-10 flex h-full w-6 shrink-0 items-center justify-center border-l border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] text-[13px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
          >
            ‹
          </button>
        ) : (
          <aside
            className="relative m-3 ml-2 flex h-[calc(100%-1.5rem)] max-h-[680px] shrink-0 flex-col self-start overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-background-panel)] shadow-[var(--shadow-floating-panel)]"
            style={{ width: rightPanelWidth }}
          >
            {/* width resize handle */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="调整右侧面板宽度"
              onPointerDown={handleResizePointerDown}
              onPointerMove={handleResizePointerMove}
              onPointerUp={handleResizePointerUp}
              onPointerCancel={handleResizePointerUp}
              className="absolute -left-[4px] top-3 z-10 h-[calc(100%-1.5rem)] w-[8px] cursor-col-resize"
            />
            {activeSessionId !== null ? (
              <PanelHost
                tabs={[
                  { kind: 'diff', label: '变更' },
                  { kind: 'files', label: '文件' },
                ]}
                active={rightPanelTab}
                onSelect={setRightPanelTab}
              >
                {rightPanelTab === 'diff' ? (
                  <DiffPanel sessionId={activeSessionId} />
                ) : (
                  <FileTreePanel sessionId={activeSessionId} />
                )}
              </PanelHost>
            ) : (
              <div className="flex flex-1 items-center justify-center px-3 py-6 text-center text-[12px] leading-5 text-[var(--color-text-tertiary)]">
                选择一个会话查看面板
              </div>
            )}
          </aside>
        )}
      </div>

      {/* ------------------------------------------------------ bottom dock */}
      {bottomPanelOpen && (
        <section
          className="mx-3 mb-3 flex shrink-0 flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-terminal-shell)] shadow-[var(--shadow-floating-panel)]"
          style={{ height: BOTTOM_PANEL_HEIGHT }}
        >
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-white/8 pl-3 pr-1.5 text-white">
            <span className="text-[11px] font-semibold tracking-wide text-white/65">终端</span>
            <button
              type="button"
              aria-label="隐藏底部面板"
              title="隐藏底部面板"
              onClick={() => setBottomPanelOpen(false)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-[13px] text-white/55 hover:bg-white/8 hover:text-white"
            >
              ▾
            </button>
          </div>
          {activeSessionId !== null ? (
            <TerminalPanel sessionId={activeSessionId} />
          ) : (
            <div className="flex flex-1 items-center justify-center px-3 py-6 text-center text-[12px] leading-5 text-[var(--color-text-tertiary)]">
              选择一个会话后使用终端
            </div>
          )}
        </section>
      )}
      {settingsOpen ? (
        <Settings activeSessionId={activeSessionId} onClose={() => setSettingsOpen(false)} />
      ) : null}
      {tasksOpen && activeSessionId !== null ? (
        <TaskBrowser sessionId={activeSessionId} onClose={() => setTasksOpen(false)} />
      ) : null}
      <StatusBar sessionId={activeSessionId} gitBranch={activeSession?.git?.branch ?? null} />
    </div>
  );
}
