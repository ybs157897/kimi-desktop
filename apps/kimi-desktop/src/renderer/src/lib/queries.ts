/**
 * react-query hooks over the desktop `ApiClient` — the REST side of the data
 * layer. Transcript state is NOT here (it flows through `TranscriptSync` +
 * `TranscriptChatStore`); this module owns the sidebar list, the session
 * record, the model catalog, config, and the interaction mutations
 * (prompt / approval / question).
 *
 * The global activity socket (`useGlobalActivitySocket`) is mounted once by
 * the app shell and invalidates the list/config queries on server-pushed
 * global events; the sidebar also polls on a 15 s interval as a baseline (the
 * kimi-inspect pattern).
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import type {
  ActivateSkillRequest,
  ApprovalResolveRequest,
  CompactSessionRequest,
  CreateTerminalRequest,
  ForkSessionRequest,
  FsListRequest,
  FsReadRequest,
  GetSessionGoalResponse,
  GetTaskQuery,
  PatchConfigRequest,
  PromptSubmission,
  QuestionResolveRequest,
  Session,
  SessionCreate,
  SessionStatusResponse,
  UndoSessionRequest,
  UpdateSessionProfileRequest,
} from '@moonshot-ai/protocol';

import {
  ApiError,
  type CreateProviderRequest,
  type ImportCatalogRequest,
  type ReplaceProviderRequest,
  type V2SessionsQuery,
} from './api';
import { useConnection } from './connection';
import { applyStatusEventToSession, applyStatusEventToStatus } from './sessionModes';
import { createActivitySocket, type ActivitySocket } from './ws';

// ------------------------------------------------------------------ queries

export function useV2Sessions(query: V2SessionsQuery = {}) {
  const { api } = useConnection();
  return useInfiniteQuery({
    queryKey: ['v2-sessions', query],
    queryFn: ({ pageParam }) => api.listSessionsV2({ ...query, pageToken: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextPageToken : undefined),
    refetchInterval: 15_000,
    staleTime: 5_000,
  });
}

export function useSession(sessionId: string | null) {
  const { api } = useConnection();
  return useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => api.getSession(sessionId as string),
    enabled: sessionId !== null,
    staleTime: 5_000,
  });
}

/** `GET /api/v1/sessions/{id}/goal` — the session's active goal snapshot
 *  (`null` when none). Refetches on a 30 s interval as a fallback: the
 *  `goal.updated` ws event is durable but the socket may be down, and profile
 *  writes invalidate this key directly. */
export function useGoal(sessionId: string | null) {
  const { api } = useConnection();
  return useQuery({
    queryKey: ['goal', sessionId],
    queryFn: () => api.getGoal(sessionId as string),
    enabled: sessionId !== null,
    staleTime: 5_000,
    refetchInterval: 30_000,
  });
}

/** `GET /api/v1/sessions/{id}/status` — live session status (model / thinking
 *  level / modes / context usage). Refetches on a 30 s interval as a fallback:
 *  `agent.status.updated` events (volatile, missed while the socket is down)
 *  merge into the same cache key. */
export function useSessionStatus(sessionId: string | null) {
  const { api } = useConnection();
  return useQuery({
    queryKey: ['session-status', sessionId],
    queryFn: () => api.getSessionStatus(sessionId as string),
    enabled: sessionId !== null,
    staleTime: 5_000,
    refetchInterval: 30_000,
  });
}

export function useModels() {
  const { api } = useConnection();
  return useQuery({
    queryKey: ['models'],
    queryFn: () => api.models(),
    staleTime: 60_000,
  });
}

export function useConfig() {
  const { api } = useConnection();
  return useQuery({
    queryKey: ['config'],
    queryFn: () => api.config(),
    staleTime: 30_000,
  });
}

/** `POST /api/v1/config` — merge-patch the server config (default model /
 *  permission / plan …). The server also pushes `event.config.changed`, which
 *  invalidates the same key; the mutation re-seeds it immediately. */
export function usePatchConfig() {
  const { api } = useConnection();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: PatchConfigRequest) => api.patchConfig(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['config'] });
    },
  });
}

/** Global cross-session search (`POST /api/v1/search`), driven by the sidebar
 *  search input. Disabled on blank queries; results are cached 30 s. */
export function useSearch(query: string, pageSize = 20) {
  const { api } = useConnection();
  const trimmed = query.trim();
  return useQuery({
    queryKey: ['search', trimmed, pageSize],
    queryFn: () => api.search({ query: trimmed, pageSize }),
    enabled: trimmed !== '',
    staleTime: 30_000,
  });
}

/** `GET /api/v1/fs:home` — host home + recent workspace roots (the folder
 *  picker bootstrap for `NewSessionButton`). */
export function useFsHome() {
  const { api } = useConnection();
  return useQuery({
    queryKey: ['fs-home'],
    queryFn: () => api.fsHome(),
    staleTime: 60_000,
  });
}

/** `GET /api/v1/fs:browse` — one level of subdirectories under `path` (or the
 *  host home when undefined). Drives the `FolderPicker` popover. Disabled while
 *  the connection is still resolving (api is guarded by `useConnection`). */
export function useFsBrowse(path: string | undefined) {
  const { api } = useConnection();
  return useQuery({
    queryKey: ['fs-browse', path],
    queryFn: () => api.fsBrowse(path),
    staleTime: 30_000,
    retry: false,
  });
}

/** `GET /api/v1/sessions/{id}/skills` — skills activatable in a session (the
 *  composer's `/` and `$` mention menus). */
export function useSkills(sessionId: string | null) {
  const { api } = useConnection();
  return useQuery({
    queryKey: ['skills', sessionId],
    queryFn: () => api.listSkills(sessionId as string),
    enabled: sessionId !== null,
    staleTime: 60_000,
  });
}

/** `POST /api/v1/sessions/{id}/fs:list` — workspace tree listing. The default
 *  request lists the workspace root one level deep. Pass `enabled: false` to
 *  keep a tree row from fetching until it is expanded. */
export function useFsList(sessionId: string | null, request: Partial<FsListRequest>, enabled = true) {
  const { api } = useConnection();
  return useQuery({
    queryKey: ['fs-list', sessionId, request],
    queryFn: () => api.fsList(sessionId as string, request),
    enabled: sessionId !== null && enabled,
    staleTime: 10_000,
  });
}

/** `POST /api/v1/sessions/{id}/fs:read` — file content for the file viewer. */
export function useFsRead(sessionId: string | null, request: (Partial<FsReadRequest> & { path: string }) | null) {
  const { api } = useConnection();
  return useQuery({
    queryKey: ['fs-read', sessionId, request],
    queryFn: () => api.fsRead(sessionId as string, request as Partial<FsReadRequest> & { path: string }),
    enabled: sessionId !== null && request !== null,
    staleTime: 10_000,
  });
}

/** `POST /api/v1/sessions/{id}/fs:git_status` — branch + per-path status for
 *  the diff panel's changed-files list. */
export function useFsGitStatus(sessionId: string | null) {
  const { api } = useConnection();
  return useQuery({
    queryKey: ['fs-git-status', sessionId],
    queryFn: () => api.fsGitStatus(sessionId as string),
    enabled: sessionId !== null,
    staleTime: 5_000,
    refetchInterval: 15_000,
  });
}

/** `POST /api/v1/sessions/{id}/fs:diff` — unified diff for one changed path. */
export function useFsDiff(sessionId: string | null, path: string | null) {
  const { api } = useConnection();
  return useQuery({
    queryKey: ['fs-diff', sessionId, path],
    queryFn: () => api.fsDiff(sessionId as string, path as string),
    enabled: sessionId !== null && path !== null,
    staleTime: 5_000,
  });
}

/** `GET /api/v1/sessions/{id}/terminals` — the session's PTYs. */
export function useTerminals(sessionId: string | null) {
  const { api } = useConnection();
  return useQuery({
    queryKey: ['terminals', sessionId],
    queryFn: () => api.listTerminals(sessionId as string),
    enabled: sessionId !== null,
    staleTime: 5_000,
  });
}

// ---------------------------------------------------------------- providers

/** `GET /api/v1/providers` — configured providers (credentials redacted). */
export function useProviders() {
  const { api } = useConnection();
  return useQuery({
    queryKey: ['providers'],
    queryFn: () => api.listProviders(),
    staleTime: 30_000,
  });
}

/** `GET /api/v1/providers/{id}` — one provider plus its stored api key
 *  (loopback only; prefills the edit dialog). */
export function useProviderDetail(providerId: string | null) {
  const { api } = useConnection();
  return useQuery({
    queryKey: ['provider-detail', providerId],
    queryFn: () => api.getProviderDetail(providerId as string),
    enabled: providerId !== null,
    staleTime: 5_000,
  });
}

/** `GET /api/v1/catalog/providers` — the models.dev catalog (server-cached,
 *  built-in snapshot fallback; 50004 when the upstream is unreachable). */
export function useCatalogProviders() {
  const { api } = useConnection();
  return useQuery({
    queryKey: ['catalog-providers'],
    queryFn: () => api.listCatalogProviders(),
    staleTime: 10 * 60_000,
    retry: false,
  });
}

/** Provider-model mutations share the same cache fallout: the provider list,
 *  the config view (default_model pointers) and the model catalog all move. */
function useInvalidateProviderChanges(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['providers'] });
    void queryClient.invalidateQueries({ queryKey: ['config'] });
    void queryClient.invalidateQueries({ queryKey: ['models'] });
  };
}

/** `POST /api/v1/providers` — create a provider manually. */
export function useCreateProvider() {
  const { api } = useConnection();
  const invalidate = useInvalidateProviderChanges();
  return useMutation({
    mutationFn: (body: CreateProviderRequest) => api.createProvider(body),
    onSuccess: () => invalidate(),
  });
}

/** `PUT /api/v1/providers/{id}` — replace a provider (api_key tri-state). */
export function useReplaceProvider() {
  const { api } = useConnection();
  const invalidate = useInvalidateProviderChanges();
  return useMutation({
    mutationFn: (args: { providerId: string; body: ReplaceProviderRequest }) =>
      api.replaceProvider(args.providerId, args.body),
    onSuccess: () => invalidate(),
  });
}

/** `DELETE /api/v1/providers/{id}` — remove a provider (204). */
export function useDeleteProvider() {
  const { api } = useConnection();
  const invalidate = useInvalidateProviderChanges();
  return useMutation({
    mutationFn: (providerId: string) => api.deleteProvider(providerId),
    onSuccess: () => invalidate(),
  });
}

/** `POST /api/v1/providers/{id}:refresh` — re-fetch the provider's models. */
export function useRefreshProvider() {
  const { api } = useConnection();
  const invalidate = useInvalidateProviderChanges();
  return useMutation({
    mutationFn: (providerId: string) => api.refreshProvider(providerId),
    onSuccess: () => invalidate(),
  });
}

/** `POST /api/v1/providers:import_catalog` — import one models.dev entry. */
export function useImportCatalogProvider() {
  const { api } = useConnection();
  const invalidate = useInvalidateProviderChanges();
  return useMutation({
    mutationFn: (body: ImportCatalogRequest) => api.importCatalogProvider(body),
    onSuccess: () => invalidate(),
  });
}

// ---------------------------------------------------------------- mutations

/** Invalidate every query the sidebar / header reads after a session-list
 *  changing mutation (create / archive / restore). */
function useInvalidateSessionList(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['v2-sessions'] });
    void queryClient.invalidateQueries({ queryKey: ['session'] });
  };
}

export function useCreateSession() {
  const { api } = useConnection();
  const invalidate = useInvalidateSessionList();
  return useMutation({
    mutationFn: (body: SessionCreate) => api.createSession(body),
    onSuccess: () => invalidate(),
  });
}

/** `POST .../profile` — write session-level agent config (model / permission /
 *  plan / swarm / goal). The v2 engine applies these fields ONLY through this
 *  endpoint; the prompt-body plan/swarm/goal fields are v1-compat and ignored. */
export function useUpdateSessionProfile(sessionId: string) {
  const { api } = useConnection();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateSessionProfileRequest) => api.updateSessionProfile(sessionId, body),
    onSuccess: () => {
      // The session record carries agent_config; goal_control writes change
      // the goal snapshot — refresh both.
      void queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
      void queryClient.invalidateQueries({ queryKey: ['goal', sessionId] });
    },
  });
}

export function useArchiveSession() {
  const { api } = useConnection();
  const invalidate = useInvalidateSessionList();
  return useMutation({
    mutationFn: (sessionId: string) => api.archiveSession(sessionId),
    onSuccess: () => invalidate(),
  });
}

export function useRestoreSession() {
  const { api } = useConnection();
  const invalidate = useInvalidateSessionList();
  return useMutation({
    mutationFn: (sessionId: string) => api.restoreSession(sessionId),
    onSuccess: () => invalidate(),
  });
}

export function useAbortSession() {
  const { api } = useConnection();
  return useMutation({
    mutationFn: (sessionId: string) => api.abortSession(sessionId),
  });
}

// -------------------------------------------------------- session actions (M7)

/** `POST ...:undo` — cut the last `count` turns. The caller refreshes its
 *  transcript afterwards via the ChatView handle (`TranscriptSync.refresh`). */
export function useUndoSession(sessionId: string) {
  const { api } = useConnection();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UndoSessionRequest) => api.undoSession(sessionId, body),
    onSuccess: () => {
      // message_count / last_seq / busy changed server-side.
      void queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
      void queryClient.invalidateQueries({ queryKey: ['session-status', sessionId] });
    },
  });
}

/** `POST ...:compact` — manually compact the context. */
export function useCompactSession(sessionId: string) {
  const { api } = useConnection();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CompactSessionRequest) => api.compactSession(sessionId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['session', sessionId] });
    },
  });
}

/** `POST ...:fork` — copy a session; the new session lands in the sidebar. */
export function useForkSession() {
  const { api } = useConnection();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { sessionId: string; body: ForkSessionRequest }) =>
      api.forkSession(args.sessionId, args.body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['v2-sessions'] });
    },
  });
}

/** `POST ...:btw` — start a side-channel agent (returns `agent-<N>`). */
export function useStartBtw(sessionId: string) {
  const { api } = useConnection();
  return useMutation({
    mutationFn: () => api.startBtw(sessionId),
  });
}

/** `GET .../tasks` — background tasks. Polls every 3 s while enabled (the
 *  TaskBrowser is open), mirroring the web client's task clock. */
export function useTasks(sessionId: string | null) {
  const { api } = useConnection();
  return useQuery({
    queryKey: ['tasks', sessionId],
    queryFn: () => api.listTasks(sessionId as string),
    enabled: sessionId !== null,
    staleTime: 1_000,
    refetchInterval: 3_000,
  });
}

/** `GET .../tasks/{id}` — one task with its output tail (never cached). */
export function useGetTask(sessionId: string | null, taskId: string | null) {
  const { api } = useConnection();
  return useQuery({
    queryKey: ['task', sessionId, taskId],
    queryFn: () =>
      api.getTask(sessionId as string, taskId as string, {
        with_output: true,
        output_bytes: 32 * 1024,
      } satisfies GetTaskQuery),
    enabled: sessionId !== null && taskId !== null,
    staleTime: 0,
  });
}

/** `POST .../tasks/{id}:cancel` — cancel a running task. The server answers
 *  40904 `{cancelled:false}` for already-finished tasks; that is treated as
 *  success here (the task list is refreshed either way). */
export function useCancelTask(sessionId: string) {
  const { api } = useConnection();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => api.cancelTask(sessionId, taskId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', sessionId] });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 40904) {
        void queryClient.invalidateQueries({ queryKey: ['tasks', sessionId] });
      }
    },
  });
}

export function useSubmitPrompt(sessionId: string) {
  const { api } = useConnection();
  return useMutation({
    mutationFn: (body: PromptSubmission) => api.submitPrompt(sessionId, body),
  });
}

export function useAbortPrompt(sessionId: string) {
  const { api } = useConnection();
  return useMutation({
    mutationFn: (promptId: string) => api.abortPrompt(sessionId, promptId),
  });
}

export function useResolveApproval(sessionId: string) {
  const { api } = useConnection();
  return useMutation({
    mutationFn: (args: { approvalId: string; body: ApprovalResolveRequest }) =>
      api.resolveApproval(sessionId, args.approvalId, args.body),
  });
}

export function useResolveQuestion(sessionId: string) {
  const { api } = useConnection();
  return useMutation({
    mutationFn: (args: { questionId: string; body: QuestionResolveRequest }) =>
      api.resolveQuestion(sessionId, args.questionId, args.body),
  });
}

export function useDismissQuestion(sessionId: string) {
  const { api } = useConnection();
  return useMutation({
    mutationFn: (questionId: string) => api.dismissQuestion(sessionId, questionId),
  });
}

/** `POST /api/v1/files` — upload one attachment (multipart). */
export function useUploadFile() {
  const { api } = useConnection();
  return useMutation({
    mutationFn: (args: { file: File; name?: string }) =>
      api.uploadFile(args.file, { name: args.name }),
  });
}

/** `POST .../prompts:steer` — inject a follow-up into a running turn. */
export function useSteerPrompt(sessionId: string) {
  const { api } = useConnection();
  return useMutation({
    mutationFn: (promptIds: readonly string[]) => api.steerPrompt(sessionId, { promptIds }),
  });
}

/** `POST .../skills/{name}:activate` — start a skill turn (slash command). */
export function useActivateSkill(sessionId: string) {
  const { api } = useConnection();
  return useMutation({
    mutationFn: (args: { skillName: string; body: ActivateSkillRequest }) =>
      api.activateSkill(sessionId, args.skillName, args.body),
  });
}

/** `POST .../terminals` — create a PTY. */
export function useCreateTerminal(sessionId: string) {
  const { api } = useConnection();
  return useMutation({
    mutationFn: (body: CreateTerminalRequest) => api.createTerminal(sessionId, body),
  });
}

/** `POST .../terminals/{tid}:close` — close a PTY. */
export function useCloseTerminal(sessionId: string) {
  const { api } = useConnection();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (terminalId: string) => api.closeTerminal(sessionId, terminalId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['terminals', sessionId] });
    },
  });
}

/** `POST .../fs:open` / `fs:reveal` — open or reveal a path in the OS. */
export function useFsOpen(sessionId: string) {
  const { api } = useConnection();
  return useMutation({
    mutationFn: (args: { path: string; reveal?: boolean }) =>
      args.reveal === true
        ? api.fsReveal(sessionId, args.path)
        : api.fsOpen(sessionId, args.path),
  });
}

/** `POST .../export` — download a session bundle (zip blob). */
export function useExportSession(sessionId: string) {
  const { api } = useConnection();
  return useMutation({
    mutationFn: (opts: { desktop?: boolean; webLog?: string }) =>
      api.exportSession(sessionId, opts),
  });
}

// ------------------------------------------------------- global activity feed

/**
 * Mount the global-facts socket and answer server pushes with query
 * invalidation: work-fact changes, session create/retitle and every reconnect
 * re-seed the sidebar list; config changes re-seed the config query. The
 * socket also follows the active session at transcript grade `'off'`, which
 * is the one grade that does NOT suppress `agent.status.updated` /
 * `goal.updated` — those frames merge into the `['session', id]` and
 * `['goal', id]` caches so the mode bar tracks engine-side changes live.
 * Mount once per app shell.
 */
export function useGlobalActivitySocket(activeSessionId: string | null): void {
  const { api, baseUrl, token } = useConnection();
  const queryClient = useQueryClient();
  const socketRef = useRef<ActivitySocket | null>(null);

  useEffect(() => {
    const socket = createActivitySocket({
      url: baseUrl,
      token,
      handlers: {
        onWorkChanged: () => {
          void queryClient.invalidateQueries({ queryKey: ['v2-sessions'] });
        },
        onSessionCreated: () => {
          void queryClient.invalidateQueries({ queryKey: ['v2-sessions'] });
        },
        onMetaUpdated: () => {
          void queryClient.invalidateQueries({ queryKey: ['v2-sessions'] });
        },
        onConfigChanged: () => {
          void queryClient.invalidateQueries({ queryKey: ['config'] });
        },
        onStatusUpdated: (sessionId, event) => {
          // Merge the mode-bearing fields into the cached session record;
          // nothing to update when the record was never fetched.
          queryClient.setQueryData<Session>(['session', sessionId], (old) =>
            old === undefined ? old : applyStatusEventToSession(old, event),
          );
          // The status cache (status bar: thinking / context usage) gets the
          // live context fields the same way.
          queryClient.setQueryData<SessionStatusResponse>(['session-status', sessionId], (old) =>
            old === undefined ? old : applyStatusEventToStatus(old, event),
          );
        },
        onGoalUpdated: (sessionId, snapshot) => {
          queryClient.setQueryData<GetSessionGoalResponse>(['goal', sessionId], snapshot);
        },
        onReconnected: () => {
          // Live facts are missed while the socket was down — full re-seed.
          void queryClient.invalidateQueries({ queryKey: ['v2-sessions'] });
          void queryClient.invalidateQueries({ queryKey: ['config'] });
        },
      },
    });
    socketRef.current = socket;
    return () => {
      socketRef.current = null;
      socket.close();
    };
  }, [baseUrl, token, api, queryClient]);

  // Re-point the mode-state follow when the active session changes (the
  // socket itself lives for the app shell's lifetime).
  useEffect(() => {
    socketRef.current?.follow(activeSessionId);
  }, [activeSessionId]);
}
