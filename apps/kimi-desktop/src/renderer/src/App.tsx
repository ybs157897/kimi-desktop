/**
 * App shell — Apple-style layout:
 *
 *   drag region (36 px) → macOS traffic lights (80 px left inset), draggable
 *   left rail (260 px)  → New chat / search / session list
 *   main area           → ChatView of the active session (or an empty state)
 *   right dock          → full-height resizable panel container (diff / files /
 *                         terminal / sidechat tabs)
 *
 * REST side rides react-query (list, models, config); the global activity
 * socket is mounted once here and invalidates list/config queries on
 * server-pushed events.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { SidebarSimple } from '@phosphor-icons/react';

import { NewSessionButton } from './components/sidebar/NewSessionButton';
import { SessionList } from './components/sidebar/SessionList';
import { SidebarSearch, type SidebarSearchHandle } from './components/sidebar/SidebarSearch';
import { ChatView, type ChatViewHandle } from './components/chat/ChatView';
import { DiffPanel } from './components/panels/DiffPanel';
import { FileTreePanel } from './components/panels/FileTreePanel';
import { PanelHost, type PanelKind, type PanelTab } from './components/panels/PanelHost';
import { TerminalPanel } from './components/panels/TerminalPanel';
import { SessionActionsMenu } from './components/session/SessionActionsMenu';
import { TaskBrowser } from './components/session/TaskBrowser';
import { Settings } from './components/Settings';
import { StatusBar } from './components/StatusBar';
import { Welcome, type WelcomeStartPayload } from './components/Welcome';
import { useConnection } from './lib/connection';
import {
  useCreateSession,
  useFsHome,
  useGlobalActivitySocket,
  useRestoreSession,
  useV2Sessions,
} from './lib/queries';
import { useShortcuts, type ShortcutHandlers } from './lib/useShortcuts';

const RIGHT_PANEL_WIDTH_KEY = 'app-shell:right-panel-width:v4';
const RIGHT_PANEL_COLLAPSED_KEY = 'app-shell:right-panel-collapsed:v4';
const RIGHT_PANEL_TAB_KEY = 'app-shell:right-panel-tab:v3';

const RIGHT_PANEL_MIN_WIDTH = 360;
const RIGHT_PANEL_MAX_WIDTH = 720;
const RIGHT_PANEL_DEFAULT_WIDTH = 440;
const RIGHT_PANEL_RESIZE_STEP = 24;

const DRAG_REGION_HEIGHT = 36; // px
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
  const { api } = useConnection();
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  useGlobalActivitySocket(activeSessionId);

  const sessions = useV2Sessions({
    archived: 'false',
    sort: 'meta.updated_at_desc',
    includeGit: true,
  });
  const createSession = useCreateSession();
  const fsHome = useFsHome();
  const restoreSession = useRestoreSession();
  const [archivedSession, setArchivedSession] = useState<{ readonly id: string; readonly title: string } | null>(null);
  const [newSessionPending, setNewSessionPending] = useState(false);
  const [newSessionError, setNewSessionError] = useState<string | null>(null);
  const creatingSessionRef = useRef(false);
  const sessionItems = sessions.data?.pages.flatMap((page) => page.items) ?? [];
  const latestProjectCwd = fsHome.data?.recent_roots.find((root) => root !== fsHome.data.home);
  const latestWorkspaceSession =
    sessionItems.find((session) => session.workspace.cwd === latestProjectCwd) ??
    sessionItems.find((session) => session.workspace.cwd !== null && session.workspace.cwd !== fsHome.data?.home) ??
    sessionItems.find((session) => session.workspace.cwd !== null);
  const latestWorkspaceCwd = latestProjectCwd ?? latestWorkspaceSession?.workspace.cwd ?? undefined;
  const activeSession = sessionItems.find((session) => session.id === activeSessionId);
  const activeTitle =
    activeSession?.meta.title ?? activeSession?.meta.lastPrompt ?? '新会话';

  // The server owns new-session defaults. Do not copy a second permission
  // preference from localStorage into agent_config: Settings edits the server
  // config, and session creation should consume that single source of truth.
  const createInWorkspace = useCallback(
    async (cwd: string) => {
      const session = await createSession.mutateAsync({ metadata: { cwd } });
      setActiveSessionId(session.id);
    },
    [createSession],
  );

  const runNewSession = useCallback((getCwd: () => Promise<string>) => {
    if (creatingSessionRef.current) return;
    creatingSessionRef.current = true;
    setNewSessionPending(true);
    setNewSessionError(null);
    void getCwd()
      .then(createInWorkspace)
      .catch(() => setNewSessionError('请检查后端连接后重试。'))
      .finally(() => {
        creatingSessionRef.current = false;
        setNewSessionPending(false);
      });
  }, [createInWorkspace]);

  const createSessionAt = useCallback(
    (cwd: string) => runNewSession(async () => cwd),
    [runNewSession],
  );

  const handleNewSession = useCallback(() => {
    runNewSession(async () => {
      if (latestWorkspaceCwd !== undefined) return latestWorkspaceCwd;
      const home = await api.fsHome();
      return home.recent_roots[0] ?? home.home;
    });
  }, [api, latestWorkspaceCwd, runNewSession]);

  const handleWelcomeStart = useCallback((payload: WelcomeStartPayload) => {
    if (creatingSessionRef.current) return;
    creatingSessionRef.current = true;
    setNewSessionPending(true);
    setNewSessionError(null);
    void createSession.mutateAsync({
      metadata: { cwd: payload.cwd },
      agent_config: {
        plan_mode: payload.planMode,
        goal_objective: payload.goalMode ? payload.prompt : undefined,
      },
    })
      .then(async (session) => {
        const content = [
          { type: 'text' as const, text: payload.prompt },
          ...payload.attachments.map((attachment) => ({
            type: 'file' as const,
            file_id: attachment.fileId,
            name: attachment.name,
            media_type: attachment.mediaType,
            size: attachment.size,
          })),
        ];
        await api.submitPrompt(session.id, {
          content,
          permission_mode: payload.permissionMode,
          model: payload.model,
          thinking: payload.effort,
          plan_mode: payload.planMode,
          goal_objective: payload.goalMode ? payload.prompt : undefined,
        });
        setActiveSessionId(session.id);
      })
      .catch(() => setNewSessionError('请检查后端连接后重试。'))
      .finally(() => {
        creatingSessionRef.current = false;
        setNewSessionPending(false);
      });
  }, [api, createSession]);

  const handleArchiveSuccess = useCallback((sessionId: string) => {
    restoreSession.reset();
    const archived = sessionItems.find((session) => session.id === sessionId);
    setArchivedSession({
      id: sessionId,
      title: archived?.meta.title ?? archived?.meta.lastPrompt ?? '无标题会话',
    });
    setActiveSessionId((current) =>
      current === sessionId
        ? (sessionItems.find((session) => session.id !== sessionId)?.id ?? null)
        : current,
    );
  }, [restoreSession, sessionItems]);

  useEffect(() => {
    if (archivedSession === null || restoreSession.isPending) return;
    const timer = window.setTimeout(() => {
      setArchivedSession(null);
    }, 8_000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [archivedSession, restoreSession.isPending]);

  // ---- right dock: resizable (width persisted), collapsible ----
  const [rightPanelWidth, setRightPanelWidth] = useState(readStoredWidth);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(
    () => localStorage.getItem(RIGHT_PANEL_COLLAPSED_KEY) === 'true',
  );
  // ---- right dock active tab (diff / files / terminal / sidechat) ----
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

  // Side agents, task dialogs, and panel selections are scoped to one
  // session. Clear ephemeral cross-session state whenever navigation changes.
  useEffect(() => {
    setSideChat(null);
    setTasksOpen(false);
    setRightPanelTab((tab) => (tab === 'sidechat' ? 'diff' : tab));
  }, [activeSessionId]);

  const rightPanelWidthRef = useRef(rightPanelWidth);
  useEffect(() => {
    rightPanelWidthRef.current = rightPanelWidth;
    localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(rightPanelWidth));
  }, [rightPanelWidth]);

  useEffect(() => {
    localStorage.setItem(RIGHT_PANEL_COLLAPSED_KEY, String(rightPanelCollapsed));
  }, [rightPanelCollapsed]);

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
      toggleBottomPanel: () => {
        // The bottom dock was removed: this shortcut now toggles the right
        // dock's terminal tab.
        if (rightPanelCollapsed || rightPanelTab !== 'terminal') {
          setRightPanelCollapsed(false);
          setRightPanelTab('terminal');
        } else {
          setRightPanelCollapsed(true);
        }
      },
      openTerminal: () => {
        setRightPanelCollapsed(false);
        setRightPanelTab('terminal');
      },
      openFileTree: () => {
        setRightPanelCollapsed(false);
        setRightPanelTab('files');
      },
      focusSearch: () => {
        setSidebarCollapsed(false);
        window.requestAnimationFrame(() => searchInputRef.current?.focus());
      },
    }),
    [rightPanelCollapsed, rightPanelTab],
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

  const handleResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const direction = event.key === 'ArrowLeft' ? 1 : -1;
    setRightPanelWidth((width) => clampWidth(width + direction * RIGHT_PANEL_RESIZE_STEP));
  }, []);

  // Right dock tabs: the sidechat tab only exists while a side agent is open.
  const rightPanelTabs = useMemo<readonly PanelTab[]>(() => {
    const tabs: PanelTab[] = [
      { kind: 'diff', label: '变更' },
      { kind: 'files', label: '文件' },
      { kind: 'terminal', label: '终端' },
    ];
    if (sideChat !== null) tabs.push({ kind: 'sidechat', label: '侧问' });
    return tabs;
  }, [sideChat]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[var(--color-background-surface)] text-[var(--color-text-foreground)]">
      {/* -------------------------------------------------- drag region (36px) */}
      <header
        className="app-drag-region flex shrink-0 items-stretch border-b border-[var(--color-border-light)] bg-[var(--color-background-surface)]"
        style={{ height: DRAG_REGION_HEIGHT }}
      >
        <div className={`${sidebarCollapsed ? 'w-[124px]' : 'w-[260px]'} flex shrink-0 items-center gap-2 bg-[var(--color-background-surface-under)] transition-[width] duration-[var(--duration-hover)]`}>
          <div className="shrink-0" style={{ width: TRAFFIC_LIGHT_INSET }} aria-hidden="true" />
          {sidebarCollapsed ? null : <span className="flex h-6 w-6 items-center justify-center rounded-[9px] border border-[var(--color-border)] bg-[var(--color-background-panel)] shadow-[var(--shadow-sm)]" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M4.5 3.5v9M11.5 3.5 6.8 8l4.7 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>}
          {sidebarCollapsed ? null : <span className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-[var(--tracking-tight)]">Kimi Code</span>}
          <button
            type="button"
            aria-label={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}
            title={`${sidebarCollapsed ? '展开' : '折叠'}侧栏 (Cmd+B)`}
            onClick={() => setSidebarCollapsed((value) => !value)}
            className="app-no-drag ui-pressable mr-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-tertiary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
          >
            <SidebarSimple size={16} weight="regular" aria-hidden />
          </button>
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2 px-4">
          {activeSessionId !== null ? (
            <>
              <span className="min-w-0 truncate text-[14px] font-semibold tracking-[var(--tracking-tight)]">{activeTitle}</span>
              <span className="min-w-0 truncate text-[11.5px] text-[var(--color-text-tertiary)]">
                {activeSession?.workspace.cwd?.split('/').filter(Boolean).at(-1)}
              </span>
            </>
          ) : (
            <span className="text-[13px] font-medium text-[var(--color-text-secondary)]">工作区</span>
          )}
          <div className="app-no-drag ml-auto flex items-center gap-1">
            <SessionActionsMenu
              sessionId={activeSessionId}
              chatRef={chatViewRef}
              onOpenTasks={() => setTasksOpen(true)}
              onSideChat={(agentId) => {
                setSideChat({ agentId });
                setRightPanelCollapsed(false);
                setRightPanelTab('sidechat');
              }}
              onForked={(session) => setActiveSessionId(session.id)}
            />
            {activeSessionId !== null ? (
              <button
                type="button"
                aria-label={rightPanelCollapsed ? '展开右侧面板' : '折叠右侧面板'}
                title={rightPanelCollapsed ? '展开右侧面板' : '折叠右侧面板'}
                onClick={() => setRightPanelCollapsed((value) => !value)}
                className="ui-pressable flex h-7 w-7 items-center justify-center rounded-lg text-[var(--color-text-tertiary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
              >
                <SidebarSimple size={16} weight="regular" className="scale-x-[-1]" aria-hidden />
              </button>
            ) : null}
          </div>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {/* ---------------------------------------------------------- left rail */}
        {sidebarCollapsed ? null : (
        <aside className="flex w-[260px] shrink-0 flex-col border-r border-[var(--color-border-light)] bg-[var(--color-background-surface-under)]">
          <div className="flex flex-col gap-2 px-3 pb-2.5 pt-3">
            <NewSessionButton
              onCreate={handleNewSession}
              busy={newSessionPending}
              error={newSessionError}
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
            loadingMore={sessions.isFetchingNextPage}
            onLoadMore={() => {
              if (sessions.hasNextPage) void sessions.fetchNextPage();
            }}
            onArchiveSuccess={handleArchiveSuccess}
          />

          {/* --------------------------------------- bottom nav (settings stub) */}
          <div className="border-t border-[var(--color-border-light)] px-2.5 py-2.5">
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="ui-pressable flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-xl px-2 py-1.5 text-left text-[12.5px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
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
              设置
            </button>
          </div>
        </aside>
        )}

        {/* ------------------------------------------------------- main area */}
        <main className="flex min-w-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {activeSessionId !== null ? (
              <ChatView
                key={activeSessionId}
                ref={chatViewRef}
                sessionId={activeSessionId}
                onSwitchWorkspace={createSessionAt}
              />
            ) : (
              <Welcome
                defaultCwd={latestWorkspaceCwd}
                defaultBranch={latestWorkspaceSession?.git?.branch ?? undefined}
                onStart={handleWelcomeStart}
                newSessionPending={newSessionPending}
                newSessionError={newSessionError}
              />
            )}
          </div>
        </main>

        {/* --------------------------------------- right dock (resizable dock) */}
        {activeSessionId === null ? null : (
          <>
            <aside
              className={`${rightPanelCollapsed ? 'hidden' : 'relative flex'} shrink-0 flex-col border-l border-[var(--color-border-light)] bg-[var(--color-background-panel)]`}
              style={{ width: rightPanelWidth }}
            >
              {/* width resize handle (left edge, full height) */}
              <div
                role="separator"
                tabIndex={0}
                aria-orientation="vertical"
                aria-label="调整右侧面板宽度"
                aria-valuemin={RIGHT_PANEL_MIN_WIDTH}
                aria-valuemax={RIGHT_PANEL_MAX_WIDTH}
                aria-valuenow={rightPanelWidth}
                onKeyDown={handleResizeKeyDown}
                onPointerDown={handleResizePointerDown}
                onPointerMove={handleResizePointerMove}
                onPointerUp={handleResizePointerUp}
                onPointerCancel={handleResizePointerUp}
                className="absolute -left-[4px] top-0 z-10 h-full w-[8px] cursor-col-resize outline-none focus-visible:bg-[var(--color-border-focus)]"
              />
              <PanelHost
                tabs={rightPanelTabs}
                active={rightPanelTab}
                onSelect={setRightPanelTab}
              >
                {rightPanelTab === 'diff' ? (
                  <DiffPanel key={activeSessionId} sessionId={activeSessionId} />
                ) : rightPanelTab === 'files' ? (
                  <FileTreePanel key={activeSessionId} sessionId={activeSessionId} />
                ) : rightPanelTab === 'sidechat' && sideChat !== null ? (
                  <div className="flex min-h-0 flex-1 flex-col">
                    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--color-border-light)] px-3">
                      <span className="text-[11px] font-semibold text-[var(--color-text-foreground)]">侧向问答</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--gray-500)]" title={sideChat.agentId}>
                        {sideChat.agentId}
                      </span>
                      <button
                        type="button"
                        aria-label="关闭侧向问答"
                        title="关闭（侧向代理保持运行）"
                        onClick={() => {
                          setSideChat(null);
                          setRightPanelTab('diff');
                        }}
                        className="flex h-6 w-6 items-center justify-center rounded-md text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
                      >
                        ✕
                      </button>
                    </div>
                    <ChatView key={`${activeSessionId}:${sideChat.agentId}`} sessionId={activeSessionId} agentId={sideChat.agentId} />
                  </div>
                ) : null}
                <div
                  className={
                    rightPanelTab === 'terminal'
                      ? 'flex min-h-0 flex-1 flex-col bg-[var(--color-terminal-shell)]'
                      : 'hidden'
                  }
                >
                  <TerminalPanel key={activeSessionId} sessionId={activeSessionId} />
                </div>
              </PanelHost>
            </aside>
          </>
        )}
      </div>

      {archivedSession !== null ? (
        <div
          role="status"
          className="fixed bottom-10 left-1/2 z-30 flex max-w-[32rem] -translate-x-1/2 items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-background-panel)] px-3 py-2 text-[12px] text-[var(--color-text-foreground)] shadow-[var(--shadow-xl)]"
        >
          <span className="min-w-0 flex-1 truncate">已归档“{archivedSession.title}”</span>
          {restoreSession.isError ? (
            <span className="shrink-0 text-[var(--color-text-danger)]">恢复失败</span>
          ) : null}
          <button
            type="button"
            disabled={restoreSession.isPending}
            onClick={() => {
              restoreSession.mutate(archivedSession.id, {
                onSuccess: () => {
                  setActiveSessionId(archivedSession.id);
                  setArchivedSession(null);
                },
              });
            }}
            className="ui-pressable shrink-0 rounded-md px-2 py-1 font-medium text-[var(--color-accent-text)] hover:bg-[var(--color-list-hover)] disabled:opacity-50"
          >
            {restoreSession.isPending ? '正在恢复…' : '撤销'}
          </button>
          <button
            type="button"
            aria-label="关闭归档提示"
            onClick={() => setArchivedSession(null)}
            className="ui-pressable shrink-0 rounded-md p-1 text-[var(--color-text-tertiary)] hover:bg-[var(--color-list-hover)]"
          >
            ✕
          </button>
        </div>
      ) : null}
      {settingsOpen ? (
        <Settings activeSessionId={activeSessionId} onClose={() => setSettingsOpen(false)} />
      ) : null}
      {tasksOpen && activeSessionId !== null ? (
        <TaskBrowser sessionId={activeSessionId} onClose={() => setTasksOpen(false)} />
      ) : null}
      <StatusBar
        sessionId={activeSessionId}
        gitBranch={activeSession?.git?.branch ?? null}
        onToggleTerminal={() => {
          if (rightPanelCollapsed || rightPanelTab !== 'terminal') {
            setRightPanelCollapsed(false);
            setRightPanelTab('terminal');
          } else {
            setRightPanelCollapsed(true);
          }
        }}
        onToggleWorkspace={() => {
          if (rightPanelCollapsed || rightPanelTab === 'terminal') {
            setRightPanelCollapsed(false);
            setRightPanelTab('diff');
          } else {
            setRightPanelCollapsed(true);
          }
        }}
        terminalActive={!rightPanelCollapsed && rightPanelTab === 'terminal'}
        workspaceActive={!rightPanelCollapsed && rightPanelTab !== 'terminal'}
      />
    </div>
  );
}
