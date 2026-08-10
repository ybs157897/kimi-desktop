/**
 * App shell — Apple-style layout:
 *
 *   drag region (36 px) → macOS traffic lights (80 px left inset), session title
 *   left rail (260 px)  → new session / search / session list
 *   main area           → ChatView of the active session (or an empty state)
 *   right dock          → full-height resizable panel container (diff / files /
 *                         terminal / sidechat tabs)
 *
 * REST side rides react-query (list, models, config); the global activity
 * socket is mounted once here and invalidates list/config queries on
 * server-pushed events.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { SidebarSimple, X } from '@phosphor-icons/react';

import { NewSessionButton } from './components/sidebar/NewSessionButton';
import { SessionList } from './components/sidebar/SessionList';
import {
  SidebarSearch,
  type SidebarSearchHandle,
} from './components/sidebar/SidebarSearch';
import {
  ChatView,
  type ChatViewHandle,
  type TranscriptSummary,
} from './components/chat/ChatView';
import {
  PlanDocView,
  planDocFromInfo,
  type PlanDoc,
  type PlanDocRequest,
} from './components/chat/PlanDocViewer';
import { planTitle } from './components/chat/planShared';
import { DiffPanel } from './components/panels/DiffPanel';
import { FileTreePanel } from './components/panels/FileTreePanel';
import { PanelHost, type PanelTab } from './components/panels/PanelHost';
import { PlanPanel } from './components/panels/PlanPanel';
import { TerminalPanel } from './components/panels/TerminalPanel';
import { SessionActionsMenu } from './components/session/SessionActionsMenu';
import { TaskBrowser } from './components/session/TaskBrowser';
import { Settings } from './components/Settings';
import { Welcome, type WelcomeStartPayload } from './components/Welcome';
import { OfficeView } from './office/OfficeView';
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

// The workspace tabs (变更 / 文件 / 终端) are hidden for now — the panels and
// their wiring are kept so they can be re-enabled later by flipping this.
const WORKSPACE_PANELS_ENABLED: boolean = false;

/** Fixed (non-document) tab ids the dock can address in the current build. */
const FIXED_PANEL_IDS: readonly string[] = WORKSPACE_PANELS_ENABLED
  ? ['plan', 'diff', 'files', 'terminal']
  : ['plan'];

/** A dynamically opened, closable document tab in the right dock. */
type DocTab =
  | {
      readonly id: string;
      readonly kind: 'plandoc';
      readonly planId: string;
      /** Frame-local snapshot for plans missing from the projection. */
      readonly fallback?: PlanDoc;
    }
  | {
      readonly id: string;
      readonly kind: 'sidechat';
      readonly agentId: string;
      readonly prompt?: string;
    };

const DRAG_REGION_HEIGHT = 36; // px
const TRAFFIC_LIGHT_INSET = 80; // px, macOS window controls

function clampWidth(width: number): number {
  return Math.min(
    Math.max(width, RIGHT_PANEL_MIN_WIDTH),
    RIGHT_PANEL_MAX_WIDTH,
  );
}

/** Rendered while no ChatView has reported yet (session switch, first load). */
const EMPTY_SUMMARY: TranscriptSummary = {
  plans: new Map(),
  todos: new Map(),
  tasks: new Map(),
  pendingPlanReview: false,
};

function readStoredWidth(): number {
  const raw = localStorage.getItem(RIGHT_PANEL_WIDTH_KEY);
  if (raw === null) return RIGHT_PANEL_DEFAULT_WIDTH;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed)
    ? clampWidth(parsed)
    : RIGHT_PANEL_DEFAULT_WIDTH;
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
  const [archivedSession, setArchivedSession] = useState<{
    readonly id: string;
    readonly title: string;
  } | null>(null);
  const [newSessionCwd, setNewSessionCwd] = useState<string | undefined>();
  const [newSessionKey, setNewSessionKey] = useState(0);
  const [newSessionPending, setNewSessionPending] = useState(false);
  const [newSessionError, setNewSessionError] = useState<string | null>(null);
  const [newSessionInitialPrompt, setNewSessionInitialPrompt] = useState('');
  const creatingSessionRef = useRef(false);
  const sessionItems = sessions.data?.pages.flatMap((page) => page.items) ?? [];
  const latestProjectCwd = fsHome.data?.recent_roots.find(
    (root) => root !== fsHome.data.home,
  );
  const latestWorkspaceSession =
    sessionItems.find(
      (session) => session.workspace.cwd === latestProjectCwd,
    ) ??
    sessionItems.find(
      (session) =>
        session.workspace.cwd !== null &&
        session.workspace.cwd !== fsHome.data?.home,
    ) ??
    sessionItems.find((session) => session.workspace.cwd !== null);
  const latestWorkspaceCwd =
    latestProjectCwd ?? latestWorkspaceSession?.workspace.cwd ?? undefined;
  const draftWorkspaceCwd = newSessionCwd ?? latestWorkspaceCwd;
  const draftWorkspaceSession = sessionItems.find(
    (session) => session.workspace.cwd === draftWorkspaceCwd,
  );
  const activeSession = sessionItems.find(
    (session) => session.id === activeSessionId,
  );
  const activeTitle =
    activeSession?.meta.title ?? activeSession?.meta.lastPrompt ?? '新会话';

  // Enter a local draft first. The real session is created by
  // `handleWelcomeStart` only after the user submits the first prompt.
  const beginNewSession = useCallback((cwd?: string, initialPrompt = '') => {
    if (creatingSessionRef.current) return;
    setNewSessionCwd(cwd);
    setNewSessionError(null);
    setNewSessionInitialPrompt(initialPrompt);
    setActiveSessionId(null);
    setNewSessionKey((key) => key + 1);
  }, []);

  const createSessionAt = useCallback(
    (cwd: string) => beginNewSession(cwd),
    [beginNewSession],
  );

  const handleNewSession = useCallback(() => {
    beginNewSession(latestWorkspaceCwd);
  }, [beginNewSession, latestWorkspaceCwd]);

  const handleWelcomeStart = useCallback(
    (payload: WelcomeStartPayload) => {
      if (creatingSessionRef.current) return;
      creatingSessionRef.current = true;
      setNewSessionPending(true);
      setNewSessionError(null);
      void createSession
        .mutateAsync({
          metadata: { cwd: payload.cwd },
          agent_config: {
            // Bind the composer's effective model to the session at creation,
            // so the first prompt (and every later one) never depends on the
            // engine-side default being configured.
            model: payload.model,
            plan_mode: payload.planMode,
            swarm_mode: payload.swarmMode ? true : undefined,
            goal_objective: payload.goalMode ? payload.prompt : undefined,
          },
        })
        .then(async (session) => {
          const managerMatch = /^\/expert-manager(?:\s+([\s\S]*))?$/.exec(
            payload.prompt,
          );
          if (managerMatch !== null) {
            await api.activateSkill(session.id, 'expert-manager', {
              args: managerMatch[1]?.trim() || undefined,
            });
          } else {
            await api.submitPrompt(session.id, {
              content: [{ type: 'text', text: payload.prompt }],
              permission_mode: payload.permissionMode,
              model: payload.model,
              thinking: payload.effort,
              plan_mode: payload.planMode,
              swarm_mode: payload.swarmMode ? true : undefined,
              goal_objective: payload.goalMode ? payload.prompt : undefined,
            });
          }
          setActiveSessionId(session.id);
        })
        .catch(() => setNewSessionError('请检查后端连接后重试。'))
        .finally(() => {
          creatingSessionRef.current = false;
          setNewSessionPending(false);
        });
    },
    [api, createSession],
  );

  const handleArchiveSuccess = useCallback(
    (sessionId: string) => {
      restoreSession.reset();
      const archived = sessionItems.find((session) => session.id === sessionId);
      setArchivedSession({
        id: sessionId,
        title:
          archived?.meta.title ?? archived?.meta.lastPrompt ?? '无标题会话',
      });
      setActiveSessionId((current) =>
        current === sessionId
          ? (sessionItems.find((session) => session.id !== sessionId)?.id ??
            null)
          : current,
      );
    },
    [restoreSession, sessionItems],
  );

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
  // ---- right dock active tab (fixed panels + document tab ids) ----
  const [rightPanelTab, setRightPanelTab] = useState<string>(() => {
    const stored = localStorage.getItem(RIGHT_PANEL_TAB_KEY);
    // Document tabs are session-ephemeral and the workspace tabs may be
    // hidden, so only restore a tab that is actually addressable.
    if (stored !== null && FIXED_PANEL_IDS.includes(stored)) return stored;
    return 'plan';
  });
  // ---- sidebar collapsible (Cmd+B) ----
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('app-shell:sidebar-collapsed:v3') === 'true',
  );
  // ---- settings modal ----
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  // ---- AI office visualization view ----
  const [officeOpen, setOfficeOpen] = useState(false);
  // Dynamically opened document tabs (zcode tab-strip parity): plan documents
  // and subagent chats, each closable, several open at once.
  const [docTabs, setDocTabs] = useState<readonly DocTab[]>([]);
  // Live plan-panel slice reported by the main ChatView (plans / progress /
  // child agents + pending plan review).
  const [transcriptSummary, setTranscriptSummary] = useState<
    TranscriptSummary | undefined
  >(undefined);
  const searchInputRef = useRef<SidebarSearchHandle>(null);
  const chatViewRef = useRef<ChatViewHandle>(null);

  // Document tabs are scoped to one session. Clear ephemeral cross-session
  // state whenever navigation changes.
  useEffect(() => {
    setDocTabs([]);
    setTasksOpen(false);
    setTranscriptSummary(undefined);
    setRightPanelTab((tab) => (FIXED_PANEL_IDS.includes(tab) ? tab : 'plan'));
  }, [activeSessionId]);

  /** Focus the doc tab with `tab.id`, appending it first when missing. */
  const openDocTab = useCallback((tab: DocTab) => {
    setDocTabs((current) =>
      current.some((existing) => existing.id === tab.id)
        ? current
        : [...current, tab],
    );
    setRightPanelCollapsed(false);
    setRightPanelTab(tab.id);
  }, []);

  const openSideChat = useCallback(
    (agentId: string, prompt?: string) => {
      openDocTab({ id: `agent:${agentId}`, kind: 'sidechat', agentId, prompt });
    },
    [openDocTab],
  );

  const openOfficeAgent = useCallback(
    (agentId: string) => {
      setOfficeOpen(false);
      openSideChat(agentId);
    },
    [openSideChat],
  );

  const openPlanDoc = useCallback(
    (request: PlanDocRequest) => {
      const planId = request.initialId ?? request.doc?.id;
      if (planId === undefined) return;
      openDocTab({
        id: `plan:${planId}`,
        kind: 'plandoc',
        planId,
        fallback: request.doc,
      });
    },
    [openDocTab],
  );

  const closeDocTab = useCallback((id: string) => {
    setDocTabs((current) => current.filter((tab) => tab.id !== id));
    setRightPanelTab((tab) => (tab === id ? 'plan' : tab));
  }, []);

  /** The live document behind a plan tab: the projection entry when present
   *  (state updates ride it), else the frame-local snapshot from the opener. */
  const resolvePlanDoc = useCallback(
    (tab: Extract<DocTab, { kind: 'plandoc' }>): PlanDoc | undefined => {
      const info = (transcriptSummary ?? EMPTY_SUMMARY).plans.get(tab.planId);
      return info !== undefined ? planDocFromInfo(info) : tab.fallback;
    },
    [transcriptSummary],
  );

  const rightPanelWidthRef = useRef(rightPanelWidth);
  useEffect(() => {
    rightPanelWidthRef.current = rightPanelWidth;
    localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(rightPanelWidth));
  }, [rightPanelWidth]);

  useEffect(() => {
    localStorage.setItem(
      RIGHT_PANEL_COLLAPSED_KEY,
      String(rightPanelCollapsed),
    );
  }, [rightPanelCollapsed]);

  useEffect(() => {
    // Document tabs are session-ephemeral; only fixed panels are restorable.
    if (FIXED_PANEL_IDS.includes(rightPanelTab)) {
      localStorage.setItem(RIGHT_PANEL_TAB_KEY, rightPanelTab);
    }
  }, [rightPanelTab]);

  // zcode parity: a newly pending plan review brings the plan panel forward
  // (rising edge only — the user can still switch tabs freely afterwards).
  const prevPendingPlanReviewRef = useRef(false);
  useEffect(() => {
    const pending = transcriptSummary?.pendingPlanReview === true;
    if (pending && !prevPendingPlanReviewRef.current) {
      setRightPanelCollapsed(false);
      setRightPanelTab('plan');
    }
    prevPendingPlanReviewRef.current = pending;
  }, [transcriptSummary?.pendingPlanReview]);

  useEffect(() => {
    localStorage.setItem(
      'app-shell:sidebar-collapsed:v3',
      String(sidebarCollapsed),
    );
  }, [sidebarCollapsed]);

  // Global shortcuts (Codex-aligned). Memoized so the effect is stable.
  const shortcuts = useMemo<ShortcutHandlers>(
    () => ({
      toggleSidebar: () => setSidebarCollapsed((value) => !value),
      toggleBottomPanel: () => {
        // The bottom dock was removed: this shortcut toggles the right dock's
        // terminal tab (no-op while the workspace panels are hidden).
        if (!WORKSPACE_PANELS_ENABLED) return;
        if (rightPanelCollapsed || rightPanelTab !== 'terminal') {
          setRightPanelCollapsed(false);
          setRightPanelTab('terminal');
        } else {
          setRightPanelCollapsed(true);
        }
      },
      openTerminal: () => {
        if (!WORKSPACE_PANELS_ENABLED) return;
        setRightPanelCollapsed(false);
        setRightPanelTab('terminal');
      },
      openFileTree: () => {
        if (!WORKSPACE_PANELS_ENABLED) return;
        setRightPanelCollapsed(false);
        setRightPanelTab('files');
      },
      focusSearch: () => {
        setSidebarCollapsed(false);
        window.requestAnimationFrame(() => searchInputRef.current?.focus());
      },
      toggleOffice: () => {
        setOfficeOpen((value) => !value);
      },
    }),
    [rightPanelCollapsed, rightPanelTab],
  );
  useShortcuts(shortcuts);

  // Dragging is driven by pointer capture on the handle element, so a mouseup
  // outside the window (or a lost capture) still ends the resize cleanly.
  const resizingRef = useRef(false);
  const resizeStartRef = useRef({ x: 0, width: 0 });

  const handleResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      resizingRef.current = true;
      resizeStartRef.current = {
        x: event.clientX,
        width: rightPanelWidthRef.current,
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [],
  );

  const handleResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!resizingRef.current) return;
      const { x, width } = resizeStartRef.current;
      setRightPanelWidth(clampWidth(width + (x - event.clientX)));
    },
    [],
  );

  const handleResizePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!resizingRef.current) return;
      resizingRef.current = false;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    },
    [],
  );

  const handleResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const direction = event.key === 'ArrowLeft' ? 1 : -1;
      setRightPanelWidth((width) =>
        clampWidth(width + direction * RIGHT_PANEL_RESIZE_STEP),
      );
    },
    [],
  );

  // Right dock tabs: fixed panels first (workspace tabs only when enabled),
  // then the open document tabs, each closable.
  const rightPanelTabs = useMemo<readonly PanelTab[]>(() => {
    const tabs: PanelTab[] = [{ id: 'plan', kind: 'plan', label: '计划' }];
    if (WORKSPACE_PANELS_ENABLED) {
      tabs.push(
        { id: 'diff', kind: 'diff', label: '变更' },
        { id: 'files', kind: 'files', label: '文件' },
        { id: 'terminal', kind: 'terminal', label: '终端' },
      );
    }
    for (const tab of docTabs) {
      if (tab.kind === 'plandoc') {
        const doc = resolvePlanDoc(tab);
        tabs.push({
          id: tab.id,
          kind: 'plandoc',
          label: doc !== undefined ? planTitle(doc.plan) : '计划文档',
          closable: true,
        });
      } else {
        tabs.push({
          id: tab.id,
          kind: 'sidechat',
          label: tab.prompt?.trim() || tab.agentId,
          closable: true,
        });
      }
    }
    return tabs;
  }, [docTabs, resolvePlanDoc]);
  const activeDocTab = docTabs.find((tab) => tab.id === rightPanelTab);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[var(--color-background-surface)] text-[var(--color-text-foreground)]">
      {/* -------------------------------------------------- drag region (36px) */}
      <header
        className="app-drag-region app-window-titlebar flex shrink-0 items-stretch border-b border-[var(--color-border-light)] bg-[var(--color-background-surface)]"
        style={{ height: DRAG_REGION_HEIGHT }}
      >
        <div
          className={`${sidebarCollapsed ? 'w-[124px]' : 'w-[260px]'} flex shrink-0 items-center gap-2 bg-[var(--color-background-panel)] transition-[width] duration-[var(--duration-hover)]`}
        >
          <div
            className="shrink-0"
            style={{ width: TRAFFIC_LIGHT_INSET }}
            aria-hidden="true"
          />
          {/* Brand logo + "Kimi Code" title hidden per design; the spacer
              keeps the collapse button right-aligned. */}
          <div className="min-w-0 flex-1" aria-hidden="true" />
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
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3">
          {activeSessionId !== null ? (
            <>
              <span
                className="min-w-0 max-w-[min(42vw,36rem)] truncate text-[length:var(--client-title-font-size)] font-semibold tracking-[var(--tracking-tight)]"
                title={activeTitle}
              >
                {activeTitle}
              </span>
              <span className="min-w-0 truncate text-[length:var(--client-caption-font-size)] text-[var(--color-text-tertiary)]">
                {activeSession?.workspace.cwd
                  ?.split('/')
                  .filter(Boolean)
                  .at(-1)}
              </span>
            </>
          ) : (
            <>
              <span className="text-[length:var(--client-title-font-size)] font-semibold tracking-[var(--tracking-tight)]">
                新会话
              </span>
              {draftWorkspaceCwd === undefined ? null : (
                <span className="min-w-0 truncate text-[length:var(--client-caption-font-size)] text-[var(--color-text-tertiary)]">
                  {draftWorkspaceCwd.split('/').filter(Boolean).at(-1)}
                </span>
              )}
            </>
          )}
          <div className="app-no-drag ml-auto flex items-center gap-1">
            <SessionActionsMenu
              sessionId={activeSessionId}
              chatRef={chatViewRef}
              onOpenTasks={() => setTasksOpen(true)}
              onSideChat={openSideChat}
              onForked={(session) => setActiveSessionId(session.id)}
            />
            {activeSessionId !== null && !officeOpen ? (
              <button
                type="button"
                aria-label={
                  rightPanelCollapsed ? '展开右侧面板' : '折叠右侧面板'
                }
                title={rightPanelCollapsed ? '展开右侧面板' : '折叠右侧面板'}
                onClick={() => setRightPanelCollapsed((value) => !value)}
                className="ui-pressable flex h-7 w-7 items-center justify-center rounded-lg text-[var(--color-text-tertiary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
              >
                <SidebarSimple
                  size={16}
                  weight="regular"
                  className="scale-x-[-1]"
                  aria-hidden
                />
              </button>
            ) : null}
          </div>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {/* ---------------------------------------------------------- left rail */}
        {sidebarCollapsed ? null : (
          <aside className="flex w-[260px] shrink-0 flex-col border-r border-[var(--color-border-light)] bg-[var(--color-background-panel)]">
            <div className="flex flex-col gap-0.5 px-2 pb-1 pt-2">
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
                placeholder="搜索"
              />
            </div>
            <SessionList
              sessions={sessionItems}
              activeSessionId={activeSessionId ?? undefined}
              onSelect={setActiveSessionId}
              onCreateWorkspace={createSessionAt}
              loading={sessions.isLoading}
              error={
                sessions.error instanceof Error ? sessions.error.message : null
              }
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
                onClick={() => setOfficeOpen((value) => !value)}
                title="AI 办公室（多智能体协作可视化）"
                aria-pressed={officeOpen}
                className="ui-pressable mb-0.5 flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-xl px-2 py-1.5 text-left text-[length:var(--client-content-font-size)] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] aria-pressed:bg-[var(--color-list-active)] aria-pressed:text-[var(--color-text-foreground)]"
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
                  className="shrink-0 text-[var(--color-text-tertiary)]"
                >
                  <rect x="3" y="6" width="18" height="14" rx="1" />
                  <path d="M9 20v-4h6v4" />
                  <path d="M3 10h18" />
                  <path d="M7 6V4h4v2M13 6V4h4v2" />
                </svg>
                AI 办公室
              </button>
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="ui-pressable flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-xl px-2 py-1.5 text-left text-[length:var(--client-content-font-size)] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
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
                  className="shrink-0 text-[var(--color-text-tertiary)]"
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
            {officeOpen ? (
              <OfficeView
                sessionId={activeSessionId}
                onOpenAgent={openOfficeAgent}
                onClose={() => setOfficeOpen(false)}
              />
            ) : activeSessionId !== null ? (
              <ChatView
                key={activeSessionId}
                ref={chatViewRef}
                sessionId={activeSessionId}
                onOpenAgent={openSideChat}
                onOpenPlanDoc={openPlanDoc}
                onTranscriptSummary={setTranscriptSummary}
                onOpenModelSettings={() => setSettingsOpen(true)}
              />
            ) : (
              <Welcome
                key={newSessionKey}
                defaultCwd={draftWorkspaceCwd}
                defaultBranch={draftWorkspaceSession?.git?.branch ?? undefined}
                onStart={handleWelcomeStart}
                newSessionPending={newSessionPending}
                newSessionError={newSessionError}
                initialPrompt={newSessionInitialPrompt}
                onOpenModelSettings={() => setSettingsOpen(true)}
              />
            )}
          </div>
        </main>

        {/* --------------------------------------- right dock (resizable dock) */}
        {activeSessionId === null || officeOpen ? null : (
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
                activeId={rightPanelTab}
                onSelect={setRightPanelTab}
                onCloseTab={closeDocTab}
              >
                {rightPanelTab === 'plan' ? (
                  <PlanPanel
                    sessionId={activeSessionId}
                    plans={(transcriptSummary ?? EMPTY_SUMMARY).plans}
                    todos={(transcriptSummary ?? EMPTY_SUMMARY).todos}
                    tasks={(transcriptSummary ?? EMPTY_SUMMARY).tasks}
                    onOpenAgent={openSideChat}
                    onOpenPlanDoc={openPlanDoc}
                  />
                ) : WORKSPACE_PANELS_ENABLED && rightPanelTab === 'diff' ? (
                  <DiffPanel
                    key={activeSessionId}
                    sessionId={activeSessionId}
                  />
                ) : WORKSPACE_PANELS_ENABLED && rightPanelTab === 'files' ? (
                  <FileTreePanel
                    key={activeSessionId}
                    sessionId={activeSessionId}
                  />
                ) : activeDocTab?.kind === 'plandoc' ? (
                  <PlanDocTabBody tab={activeDocTab} resolve={resolvePlanDoc} />
                ) : activeDocTab?.kind === 'sidechat' ? (
                  <ChatView
                    key={`${activeSessionId}:${activeDocTab.agentId}`}
                    sessionId={activeSessionId}
                    agentId={activeDocTab.agentId}
                    introPrompt={activeDocTab.prompt}
                    onOpenAgent={openSideChat}
                    onOpenPlanDoc={openPlanDoc}
                  />
                ) : null}
                {WORKSPACE_PANELS_ENABLED ? (
                  <div
                    className={
                      rightPanelTab === 'terminal'
                        ? 'flex min-h-0 flex-1 flex-col bg-[var(--color-terminal-shell)]'
                        : 'hidden'
                    }
                  >
                    <TerminalPanel
                      key={activeSessionId}
                      sessionId={activeSessionId}
                    />
                  </div>
                ) : null}
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
          <span className="min-w-0 flex-1 truncate">
            已归档“{archivedSession.title}”
          </span>
          {restoreSession.isError ? (
            <span className="shrink-0 text-[var(--color-text-danger)]">
              恢复失败
            </span>
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
            <X size={12} weight="regular" aria-hidden />
          </button>
        </div>
      ) : null}
      {settingsOpen ? (
        <Settings
          activeSessionId={activeSessionId}
          onClose={() => setSettingsOpen(false)}
          onStartExpertManager={() => {
            setSettingsOpen(false);
            beginNewSession(latestWorkspaceCwd, '/expert-manager ');
          }}
        />
      ) : null}
      {tasksOpen && activeSessionId !== null ? (
        <TaskBrowser
          sessionId={activeSessionId}
          onClose={() => setTasksOpen(false)}
        />
      ) : null}
    </div>
  );
}

/** Body of a plan-document tab: resolve the live projection entry (falling
 *  back to the opener's snapshot) and render it as a document. */
function PlanDocTabBody({
  tab,
  resolve,
}: {
  readonly tab: Extract<DocTab, { kind: 'plandoc' }>;
  readonly resolve: (
    tab: Extract<DocTab, { kind: 'plandoc' }>,
  ) => PlanDoc | undefined;
}) {
  const doc = resolve(tab);
  if (doc === undefined) {
    return (
      <div className="px-3 py-6 text-center text-[12px] text-[var(--color-text-tertiary)]">
        计划内容不可用
      </div>
    );
  }
  return <PlanDocView doc={doc} />;
}
