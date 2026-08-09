/**
 * REST client for the kap-server surface consumed by the desktop app.
 *
 * Every response is the `{ code, msg, data, request_id, details? }` envelope —
 * the business outcome lives in `code` (0 success; 4xxxx/5xxxx/6xxxx/7xxxx/
 * 8xxxx error families, see `@moonshot-ai/protocol/error-codes`) while the
 * HTTP status only reports transport-level outcomes. This module unwraps the
 * envelope, throws a typed `ApiError` on business errors, and validates the
 * `data` payload against the package-owned zod schemas where one exists
 * (`@moonshot-ai/protocol` for REST models, `@moonshot-ai/transcript` for the
 * transcript surface). Two endpoints have no zod schema yet (v2 session list,
 * global search) and are validated by hand, dropping malformed entries rather
 * than failing the whole page.
 */

import {
  archiveSessionResponseSchema,
  approvalResolveResultSchema,
  cancelTaskResultSchema,
  compactSessionRequestSchema,
  compactSessionResponseSchema,
  configResponseSchema,
  agentProfileDescriptorSchema,
  deleteAgentProfileResponseSchema,
  forkSessionRequestSchema,
  getTaskQuerySchema,
  getTaskResponseSchema,
  listModelsResponseSchema,
  listAgentProfilesResponseSchema,
  listPendingApprovalsResponseSchema,
  listPendingQuestionsResponseSchema,
  listTasksQuerySchema,
  listTasksResponseSchema,
  metaResponseSchema,
  promptAbortResponseSchema,
  promptSubmitResultSchema,
  questionDismissResultSchema,
  questionResolveResultSchema,
  sessionAbortResponseSchema,
  sessionSchema,
  sessionSnapshotResponseSchema,
  startBtwSessionResponseSchema,
  undoSessionRequestSchema,
  undoSessionResponseSchema,
  type ApprovalResolveRequest,
  type ApprovalResolveResult,
  type ArchiveSessionResponse,
  type CancelTaskResult,
  type CompactSessionRequest,
  type CompactSessionResponse,
  type ConfigResponse,
  type CreateAgentProfileRequest,
  type DeleteAgentProfileResponse,
  type ForkSessionRequest,
  type GetTaskQuery,
  type GetTaskResponse,
  type ListModelsResponse,
  type ListAgentProfilesResponse,
  type ListPendingApprovalsResponse,
  type ListPendingQuestionsResponse,
  type ListTasksQuery,
  type ListTasksResponse,
  type MetaResponse,
  type PromptAbortResponse,
  type PromptSubmission,
  type PromptSubmitResult,
  type QuestionDismissResult,
  type QuestionResolveRequest,
  type QuestionResolveResult,
  type Session,
  type SessionAbortResponse,
  type SessionCreate,
  type SessionSnapshotResponse,
  type StartBtwSessionResponse,
  type SetAgentProfileEnabledRequest,
  type UndoSessionRequest,
  type UndoSessionResponse,
  type UpdateAgentProfileRequest,
  type AgentProfileDescriptor,
  fsBrowseResponseSchema,
  fsDiffResponseSchema,
  fsGitBranchesResponseSchema,
  fsGitCheckoutResponseSchema,
  fsGitStatusResponseSchema,
  fsHomeResponseSchema,
  fsListResponseSchema,
  fsReadResponseSchema,
  getSessionGoalResponseSchema,
  listProvidersResponseSchema,
  listSkillsResponseSchema,
  listTerminalsResponseSchema,
  patchConfigRequestSchema,
  refreshProviderModelsResponseSchema,
  sessionStatusResponseSchema,
  terminalSchema,
  updateSessionProfileRequestSchema,
  uploadFileResponseSchema,
  type ActivateSkillRequest,
  type ActivateSkillResult,
  type CreateTerminalRequest,
  type CloseTerminalResponse,
  type FsBrowseResponse,
  type FsDiffResponse,
  type FsGitBranchesResponse,
  type FsGitCheckoutResponse,
  type FsGitStatusResponse,
  type FsHomeResponse,
  type FsListResponse,
  type FsListRequest,
  type FsReadResponse,
  type FsReadRequest,
  type GetSessionGoalResponse,
  type ListProvidersResponse,
  type ListSkillsResponse,
  type ListTerminalsResponse,
  type PatchConfigRequest,
  type ProviderCatalogItem,
  type RefreshProviderModelsResponse,
  type SessionStatusResponse,
  type Terminal,
  type UpdateSessionProfileRequest,
  type UploadFileResponse,
} from '@moonshot-ai/protocol';
import {
  transcriptOpsCatchupResponseSchema,
  transcriptPlanResponseSchema,
  transcriptResponseSchema,
  type TranscriptAttachment,
  type TranscriptInteraction,
  type TranscriptItem,
  type TranscriptMeta,
  type TranscriptOperation,
  type TranscriptTask,
  type TranscriptTodo,
} from '@moonshot-ai/transcript';
import { z, type ZodType } from 'zod';

// ------------------------------------------------------------------ errors

/** A business-level failure surfaced in the envelope `code` (non-zero). */
export class ApiError extends Error {
  constructor(
    /** Envelope `code`; zero only when the HTTP status failed without a parseable envelope. */
    readonly code: number,
    message: string,
    /** HTTP status of the transport response. */
    readonly httpStatus: number,
    /** Envelope `details`, when the server sent one. */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface Envelope {
  code: number;
  msg: string;
  data: unknown;
  request_id?: string;
  details?: unknown;
}

function parseEnvelope(body: unknown, httpStatus: number): Envelope {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if (typeof record['code'] === 'number' && typeof record['msg'] === 'string') {
      return {
        code: record['code'],
        msg: record['msg'],
        data: record['data'],
        request_id: typeof record['request_id'] === 'string' ? record['request_id'] : undefined,
        details: record['details'],
      };
    }
  }
  return { code: httpStatus === 200 ? -1 : httpStatus, msg: `http ${httpStatus}`, data: null };
}

// ------------------------------------------------------------ v2 session list

export type V2ActivityStatus = 'running' | 'approval' | 'question' | 'failed' | 'idle';

export type V2SessionSort =
  | 'meta.updated_at_desc'
  | 'meta.updated_at_asc'
  | 'meta.created_at_desc';

export interface V2Session {
  readonly id: string;
  readonly workspace: { readonly id: string; readonly cwd: string | null };
  readonly meta: {
    readonly title: string | null;
    readonly lastPrompt: string | null;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly archived: boolean;
  };
  readonly activity: { readonly status: V2ActivityStatus };
  /** Present only when the request opted in via `include=git`. */
  readonly git?: {
    readonly branch: string | null;
    readonly pullRequest: {
      readonly number: number;
      readonly state: 'open' | 'closed' | 'merged';
      readonly url: string;
    } | null;
  };
}

export interface V2SessionsQuery {
  readonly workspaceIds?: readonly string[];
  readonly statuses?: readonly V2ActivityStatus[];
  readonly updatedAfter?: number;
  readonly archived?: 'true' | 'false' | 'all';
  readonly sort?: V2SessionSort;
  readonly includeGit?: boolean;
  readonly pageSize?: number;
  /** Opaque cursor from the previous page; the query conditions must not change. */
  readonly pageToken?: string;
}

export interface V2SessionPage {
  readonly items: readonly V2Session[];
  readonly hasMore: boolean;
  readonly nextPageToken?: string;
}

// ------------------------------------------------------- providers (M8)
// The create/replace/import/catalog request+response shapes below have NO
// `@moonshot-ai/protocol` schema (that package only carries the list/get/
// refresh responses) — they are typed by hand, matching kap-server's
// `rest-modelCatalog.ts` copies.

/** Provider wire types the engine accepts. */
export type ProviderWireType =
  | 'kimi'
  | 'openai'
  | 'openai_responses'
  | 'anthropic'
  | 'google-genai'
  | 'vertexai';

/** One model entry in a create/replace provider body. */
export interface CreateProviderModel {
  readonly model: string;
  readonly max_context_size: number;
  readonly display_name?: string;
  readonly capabilities?: readonly string[];
  readonly max_output_size?: number;
  readonly support_efforts?: readonly string[];
  readonly adaptive_thinking?: boolean;
}

/** `POST /api/v1/providers` body. */
export interface CreateProviderRequest {
  readonly id: string;
  readonly type: ProviderWireType;
  readonly api_key?: string;
  readonly base_url?: string;
  readonly default_model?: string;
  readonly models: readonly CreateProviderModel[];
}

/** `PUT /api/v1/providers/{id}` body. `api_key` is tri-state: absent = keep
 *  the stored key, `""` = clear it, any other value = replace it. */
export interface ReplaceProviderRequest {
  readonly new_id?: string;
  readonly type: ProviderWireType;
  readonly api_key?: string;
  readonly base_url?: string;
  readonly default_model?: string;
  readonly models: readonly CreateProviderModel[];
}

/** `GET /api/v1/providers/{id}` — the item plus the stored key (loopback
 *  only; the protocol schema omits `api_key`). */
export interface ProviderDetail extends ProviderCatalogItem {
  readonly api_key?: string;
}

/** One models.dev catalog entry (`GET /api/v1/catalog/providers`). */
export interface CatalogProviderItem {
  readonly id: string;
  readonly name: string;
  readonly wire_type: ProviderWireType | null;
  readonly guessed: boolean;
  readonly needs_base_url: boolean;
  readonly rejected: boolean;
  readonly reject_reason: string | null;
  readonly env_key: string | null;
  readonly models: readonly CatalogProviderModel[];
}

export interface CatalogProviderModel {
  readonly id: string;
  readonly name?: string;
  readonly max_context_size: number;
  readonly capabilities?: readonly string[];
  readonly reasoning: boolean;
}

export interface CatalogProvidersResponse {
  readonly items: readonly CatalogProviderItem[];
}

/** `POST /api/v1/providers:import_catalog` body. */
export interface ImportCatalogRequest {
  readonly catalog_id: string;
  readonly id?: string;
  readonly api_key?: string;
  readonly base_url?: string;
}

export interface ImportCatalogResult {
  readonly provider: ProviderCatalogItem;
  readonly models_imported: number;
}

export interface ReplaceProviderResponse {
  readonly provider: ProviderCatalogItem;
}

const V2_STATUSES = new Set<V2ActivityStatus>(['running', 'approval', 'question', 'failed', 'idle']);
const PR_STATES = new Set(['open', 'closed', 'merged']);

function parsePullRequest(value: unknown): NonNullable<V2Session['git']>['pullRequest'] {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const pr = value as Record<string, unknown>;
  if (
    typeof pr['number'] !== 'number' ||
    typeof pr['state'] !== 'string' ||
    !PR_STATES.has(pr['state']) ||
    typeof pr['url'] !== 'string'
  ) {
    return null;
  }
  return { number: pr['number'], state: pr['state'] as 'open' | 'closed' | 'merged', url: pr['url'] };
}

function parseV2Session(value: unknown): V2Session | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const s = value as Record<string, unknown>;
  const workspace = s['workspace'] as Record<string, unknown> | null;
  const meta = s['meta'] as Record<string, unknown> | null;
  const activity = s['activity'] as Record<string, unknown> | null;
  if (
    typeof s['id'] !== 'string' ||
    workspace === null ||
    typeof workspace !== 'object' ||
    typeof workspace['id'] !== 'string' ||
    meta === null ||
    typeof meta !== 'object' ||
    typeof meta['created_at'] !== 'number' ||
    typeof meta['updated_at'] !== 'number' ||
    typeof meta['archived'] !== 'boolean' ||
    activity === null ||
    typeof activity !== 'object' ||
    typeof activity['status'] !== 'string' ||
    !V2_STATUSES.has(activity['status'] as V2ActivityStatus)
  ) {
    return undefined;
  }
  const cwd = workspace['cwd'];
  const title = meta['title'];
  const lastPrompt = meta['last_prompt'];
  let git: V2Session['git'];
  if ('git' in s) {
    const g = s['git'] as Record<string, unknown> | null;
    if (g !== null && typeof g === 'object' && !Array.isArray(g)) {
      git = {
        branch: typeof g['branch'] === 'string' ? g['branch'] : null,
        pullRequest: parsePullRequest(g['pull_request']),
      };
    }
  }
  return {
    id: s['id'],
    workspace: { id: workspace['id'], cwd: typeof cwd === 'string' ? cwd : null },
    meta: {
      title: typeof title === 'string' ? title : null,
      lastPrompt: typeof lastPrompt === 'string' ? lastPrompt : null,
      createdAt: meta['created_at'],
      updatedAt: meta['updated_at'],
      archived: meta['archived'],
    },
    activity: { status: activity['status'] as V2ActivityStatus },
    git,
  };
}

// ------------------------------------------------------------------ search

export interface SearchHit {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly sessionTitle: string;
  /** 'main' or a subagent id; '' for title hits (they belong to the session). */
  readonly agentId: string;
  readonly role: 'user' | 'assistant' | 'title';
  readonly snippet: string;
  /** Epoch ms. */
  readonly time: number;
  /** 0-based turn ordinal (`t<turn>` in the transcript); absent for title hits. */
  readonly turn?: number;
  /** Transcript step id (`t<turn>.<step>`); assistant hits on step-aware servers. */
  readonly stepId?: string;
  readonly score: number;
}

export interface SearchIndexState {
  readonly state: 'building' | 'ready' | 'readonly';
  readonly indexedSessions: number;
  readonly totalSessions: number;
  readonly documents: number;
}

export interface SearchPage {
  readonly items: readonly SearchHit[];
  readonly hasMore: boolean;
  readonly pageToken?: string;
  readonly incomplete?: 'candidate_cap';
  readonly source?: 'live' | 'index';
  readonly indexState: SearchIndexState;
}

export interface SearchQuery {
  readonly query: string;
  readonly role?: 'user' | 'assistant' | 'title';
  readonly sort?: 'score' | 'time_desc' | 'time_asc';
  readonly mode?: 'terms' | 'literal';
  /** Scope the search to one session (and optionally one agent). */
  readonly container?: { readonly sessionId: string; readonly agentId?: string };
  readonly pageSize?: number;
  readonly pageToken?: string;
}

const SEARCH_ROLES = new Set(['user', 'assistant', 'title']);

function parseSearchHit(value: unknown): SearchHit | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const h = value as Record<string, unknown>;
  if (
    typeof h['session_id'] !== 'string' ||
    typeof h['workspace_id'] !== 'string' ||
    typeof h['session_title'] !== 'string' ||
    typeof h['agent_id'] !== 'string' ||
    typeof h['role'] !== 'string' ||
    !SEARCH_ROLES.has(h['role']) ||
    typeof h['snippet'] !== 'string' ||
    typeof h['time'] !== 'number' ||
    typeof h['score'] !== 'number'
  ) {
    return undefined;
  }
  return {
    sessionId: h['session_id'],
    workspaceId: h['workspace_id'],
    sessionTitle: h['session_title'],
    agentId: h['agent_id'],
    role: h['role'] as SearchHit['role'],
    snippet: h['snippet'],
    time: h['time'],
    turn: typeof h['turn'] === 'number' ? h['turn'] : undefined,
    stepId: typeof h['step_id'] === 'string' ? h['step_id'] : undefined,
    score: h['score'],
  };
}

// ------------------------------------------------------------ transcript page

/** One transcript page as merged by the chat store. */
export interface TranscriptPage {
  readonly items: readonly TranscriptItem[];
  /** `has_more` in the query direction — more older turns exist. */
  readonly hasMoreOlder: boolean;
  readonly tasks: readonly TranscriptTask[];
  readonly interactions: readonly TranscriptInteraction[];
  readonly attachments: readonly TranscriptAttachment[];
  readonly todos: readonly TranscriptTodo[];
  readonly meta: TranscriptMeta;
  readonly pendingInteractions: readonly string[];
  /** Op-batch watermark (state includes every batch with seq <= N); absent on legacy servers. */
  readonly seq?: number;
}

/** One turn per page: fine-grained paging — the viewport grows a turn at a time. */
export const TRANSCRIPT_PAGE_SIZE = 1;

/** One sequenced op batch from the catch-up endpoint. */
export interface TranscriptOpBatch {
  readonly seq: number;
  readonly ops: readonly TranscriptOperation[];
}

export interface TranscriptOpsCatchup {
  readonly batches: readonly TranscriptOpBatch[];
  readonly latestSeq: number;
  /** False = the journal cannot cover `sinceSeq`; the caller must full-refresh. */
  readonly complete: boolean;
}

/** One ExitPlanMode call's plan info, from the plan endpoint. */
export interface TranscriptPlanInfo {
  readonly toolCallId: string;
  readonly turnId: string;
  readonly source: 'interaction' | 'display' | 'output';
  readonly plan: string;
  readonly path?: string;
  readonly options?: readonly { label: string; description?: string }[];
  readonly review?:
    | {
        readonly state: 'pending' | 'approved' | 'rejected' | 'cancelled';
        readonly selectedOption?: string;
        readonly feedback?: string;
      }
    | undefined;
}

/** One live foreground subagent from the session snapshot roster (the wire
 *  `snapshotSubagentSchema`): the base task shape plus the swarm identity
 *  metadata that otherwise only rides the non-replayed `subagent.spawned`
 *  event. `id` is the subagent's agent id (side-panel addressable). */
export interface SessionSubagentSnapshot {
  readonly id: string;
  readonly kind: 'subagent' | 'bash' | 'tool';
  readonly description: string;
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
  readonly created_at?: string;
  readonly started_at?: string;
  readonly completed_at?: string;
  readonly output_preview?: string;
  readonly model?: string;
  readonly subagent_phase?: 'queued' | 'working' | 'suspended' | 'completed' | 'failed';
  readonly subagent_type?: string;
  readonly parent_tool_call_id?: string;
  readonly suspended_reason?: string;
  readonly swarm_index?: number;
  readonly run_in_background?: boolean;
}

// ------------------------------------------------------------------- client

export interface ApiRequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Query parameters; array values expand to repeated keys (`?a=1&a=2`). */
  readonly query?: Record<string, unknown>;
  readonly body?: unknown;
  /** zod schema for `envelope.data`; when set the payload is validated before returning. */
  readonly schema?: ZodType;
}

function appendQuery(params: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (entry !== undefined) params.append(key, String(entry));
    }
    return;
  }
  params.append(key, String(value));
}

export class ApiClient {
  constructor(
    /** Server base URL, e.g. `http://127.0.0.1:58627` (no trailing slash). */
    readonly baseUrl: string,
    /** Bearer token from `<KIMI_CODE_HOME>/server.token`; absent → no auth header. */
    readonly token?: string,
  ) {}

  async request<T>(path: string, opts: ApiRequestOptions = {}): Promise<T> {
    const query = opts.query;
    const params = new URLSearchParams();
    if (query !== undefined) {
      for (const [key, value] of Object.entries(query)) appendQuery(params, key, value);
    }
    const queryString = params.size === 0 ? '' : `?${params.toString()}`;
    const headers: Record<string, string> = {};
    if (this.token !== undefined && this.token !== '') {
      headers['authorization'] = `Bearer ${this.token}`;
    }
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}${queryString}`, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (error) {
      throw new ApiError(-1, `network error: ${error instanceof Error ? error.message : String(error)}`, 0);
    }
    // 204 No Content (DELETE /providers/{id}) — no envelope to parse.
    if (res.status === 204) return undefined as T;
    let envelope: Envelope;
    try {
      envelope = parseEnvelope(await res.json(), res.status);
    } catch {
      throw new ApiError(0, `http ${res.status}: unparseable response`, res.status);
    }
    if (envelope.code !== 0) {
      throw new ApiError(envelope.code, `${path} failed (${envelope.code}): ${envelope.msg}`, res.status, envelope.details);
    }
    if (!res.ok) {
      throw new ApiError(envelope.code, `${path} failed (http ${res.status}): ${envelope.msg}`, res.status, envelope.details);
    }
    if (opts.schema !== undefined) {
      const parsed = opts.schema.safeParse(envelope.data);
      if (!parsed.success) {
        throw new ApiError(0, `${path}: unexpected response shape`, res.status);
      }
      return parsed.data as T;
    }
    return envelope.data as T;
  }

  // ---------------------------------------------------------------- endpoints

  /** `GET /api/v1/meta` — server identity + capabilities + engine generation. */
  meta(): Promise<MetaResponse> {
    return this.request<MetaResponse>('/api/v1/meta', { schema: metaResponseSchema });
  }

  /** `GET /api/v2/sessions` — sidebar session list (cursor pagination). */
  async listSessionsV2(query: V2SessionsQuery = {}): Promise<V2SessionPage> {
    const params: Record<string, unknown> = {
      'workspace.id': query.workspaceIds,
      'activity.status': query.statuses,
      'meta.updated_after': query.updatedAfter,
      'meta.archived': query.archived,
      'sort': query.sort,
      'page_size': query.pageSize,
      'page_token': query.pageToken,
    };
    if (query.includeGit === true) params['include'] = 'git';
    const data = await this.request<{ items: unknown[]; has_more?: unknown; next_page_token?: unknown }>(
      '/api/v2/sessions',
      { query: params },
    );
    if (!Array.isArray(data.items)) throw new ApiError(0, 'v2 sessions: unexpected response shape', 200);
    return {
      items: data.items.map(parseV2Session).filter((s): s is V2Session => s !== undefined),
      hasMore: data.has_more === true,
      nextPageToken: typeof data.next_page_token === 'string' ? data.next_page_token : undefined,
    };
  }

  /** `GET /api/v1/sessions/{id}` — full session record. */
  getSession(sessionId: string): Promise<Session> {
    return this.request<Session>(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
      schema: sessionSchema,
    });
  }

  /** `POST /api/v1/sessions` — create; body must give `workspace_id` or `metadata.cwd`. */
  createSession(body: SessionCreate): Promise<Session> {
    return this.request<Session>('/api/v1/sessions', {
      method: 'POST',
      body,
      schema: sessionSchema,
    });
  }

  /** `POST /api/v1/sessions/{id}/profile` — patch the session's agent config
   *  (model / permission_mode / plan_mode / swarm_mode / goal_objective /
   *  goal_control). This is the ONLY write path the v2 engine applies for
   *  plan/goal/swarm; the prompt-body fields are v1-compat and ignored. */
  updateSessionProfile(sessionId: string, body: UpdateSessionProfileRequest): Promise<Session> {
    return this.request<Session>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/profile`,
      { method: 'POST', body, schema: sessionSchema },
    );
  }

  /** `GET /api/v1/sessions/{id}/goal` — the session's active goal snapshot
   *  (`null` when no goal is set). */
  getGoal(sessionId: string): Promise<GetSessionGoalResponse> {
    return this.request<GetSessionGoalResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/goal`,
      { schema: getSessionGoalResponseSchema },
    );
  }

  /** `GET /api/v1/sessions/{id}/status` — live session status (model /
   *  thinking level / permission / modes / context usage). */
  getSessionStatus(sessionId: string): Promise<SessionStatusResponse> {
    return this.request<SessionStatusResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/status`,
      { schema: sessionStatusResponseSchema },
    );
  }

  /** `POST /api/v1/sessions/{id}:archive` — soft-delete. */
  archiveSession(sessionId: string): Promise<ArchiveSessionResponse> {
    return this.request<ArchiveSessionResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}:archive`,
      { method: 'POST', schema: archiveSessionResponseSchema },
    );
  }

  /** `POST /api/v1/sessions/{id}:restore` — un-archive. */
  restoreSession(sessionId: string): Promise<Session> {
    return this.request<Session>(`/api/v1/sessions/${encodeURIComponent(sessionId)}:restore`, {
      method: 'POST',
      schema: sessionSchema,
    });
  }

  /** `POST /api/v1/sessions/{id}:abort` — interrupt the active turn. */
  abortSession(sessionId: string): Promise<SessionAbortResponse> {
    return this.request<SessionAbortResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}:abort`,
      { method: 'POST', schema: sessionAbortResponseSchema },
    );
  }

  // ---------------------------------------------------- session actions (M7)

  /** `POST /api/v1/sessions/{id}:fork` — copy the session (returns the new one). */
  forkSession(sessionId: string, body: ForkSessionRequest = {}): Promise<Session> {
    return this.request<Session>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}:fork`,
      { method: 'POST', body, schema: sessionSchema },
    );
  }

  /** `POST /api/v1/sessions/{id}:undo` — cut the last `count` turns; the
   *  response carries the surviving messages page + session status. The
   *  caller refreshes its transcript afterwards (`TranscriptSync.refresh`). */
  undoSession(sessionId: string, body: UndoSessionRequest = { count: 1 }): Promise<UndoSessionResponse> {
    return this.request<UndoSessionResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}:undo`,
      { method: 'POST', body, schema: undoSessionResponseSchema },
    );
  }

  /** `POST /api/v1/sessions/{id}:compact` — manually compact the context. */
  compactSession(sessionId: string, body: CompactSessionRequest = {}): Promise<CompactSessionResponse> {
    return this.request<CompactSessionResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}:compact`,
      { method: 'POST', body, schema: compactSessionResponseSchema },
    );
  }

  /** `POST /api/v1/sessions/{id}:btw` — start a side-channel agent; the
   *  response's `agent_id` (`agent-<N>`) is a normal session agent, usable in
   *  `subscribe_v2` and prompt `agent_id` directly. */
  startBtw(sessionId: string): Promise<StartBtwSessionResponse> {
    return this.request<StartBtwSessionResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}:btw`,
      { method: 'POST', body: {}, schema: startBtwSessionResponseSchema },
    );
  }

  /** `GET /api/v1/sessions/{id}/tasks` — background tasks (status filter
   *  optional). Output rides `output_preview` / `output_bytes`. */
  listTasks(sessionId: string, query: ListTasksQuery = {}): Promise<ListTasksResponse> {
    return this.request<ListTasksResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/tasks`,
      { query, schema: listTasksResponseSchema },
    );
  }

  /** `GET /api/v1/sessions/{id}/snapshot` — atomic session snapshot. Only the
   *  `subagents` roster is consumed here: it is the sole surface that lists
   *  live FOREGROUND subagents session-wide (expert-team / swarm members
   *  spawned by child agents), which REST `/tasks` — main-agent scope only —
   *  never sees. Typed loosely on purpose; the snapshot's other fields are
   *  the WS reconnect payload and stay untouched. */
  async sessionSubagents(sessionId: string): Promise<readonly SessionSubagentSnapshot[]> {
    const data = await this.request<{ subagents?: SessionSubagentSnapshot[] }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/snapshot`,
    );
    return data.subagents ?? [];
  }

  /** `GET /api/v1/sessions/{id}/tasks/{taskId}` — one task; `with_output`
   *  includes the output tail (bounded by `output_bytes`, default 32 KiB). */
  getTask(sessionId: string, taskId: string, query: GetTaskQuery = {}): Promise<GetTaskResponse> {
    return this.request<GetTaskResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}`,
      { query, schema: getTaskResponseSchema },
    );
  }

  /** `POST /api/v1/sessions/{id}/tasks/{taskId}:cancel` — cancel a running
   *  task; the server answers 40904 `{cancelled:false}` for finished tasks
   *  (callers treat that as success). */
  cancelTask(sessionId: string, taskId: string): Promise<CancelTaskResult> {
    return this.request<CancelTaskResult>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}:cancel`,
      { method: 'POST', body: {}, schema: cancelTaskResultSchema },
    );
  }

  /** `POST /api/v1/sessions/{id}/prompts` — send a user message (may queue). */
  submitPrompt(sessionId: string, body: PromptSubmission): Promise<PromptSubmitResult> {
    return this.request<PromptSubmitResult>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts`,
      { method: 'POST', body, schema: promptSubmitResultSchema },
    );
  }

  /** `POST /api/v1/sessions/{id}/prompts/{pid}:abort` — abort one prompt (idempotent). */
  abortPrompt(sessionId: string, promptId: string): Promise<PromptAbortResponse> {
    return this.request<PromptAbortResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts/${encodeURIComponent(promptId)}:abort`,
      { method: 'POST', schema: promptAbortResponseSchema },
    );
  }

  /** `GET /api/v1/sessions/{id}/approvals?status=pending` */
  listPendingApprovals(sessionId: string): Promise<ListPendingApprovalsResponse> {
    return this.request<ListPendingApprovalsResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/approvals`,
      { query: { status: 'pending' }, schema: listPendingApprovalsResponseSchema },
    );
  }

  /** `POST /api/v1/sessions/{id}/approvals/{approvalId}` — answer an approval. */
  resolveApproval(
    sessionId: string,
    approvalId: string,
    body: ApprovalResolveRequest,
  ): Promise<ApprovalResolveResult> {
    return this.request<ApprovalResolveResult>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`,
      {
        method: 'POST',
        body,
        schema: approvalResolveResultSchema,
      },
    );
  }

  /** `GET /api/v1/sessions/{id}/questions?status=pending` */
  listPendingQuestions(sessionId: string): Promise<ListPendingQuestionsResponse> {
    return this.request<ListPendingQuestionsResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/questions`,
      { query: { status: 'pending' }, schema: listPendingQuestionsResponseSchema },
    );
  }

  /** `POST /api/v1/sessions/{id}/questions/{qid}` — answer a question. */
  resolveQuestion(
    sessionId: string,
    questionId: string,
    body: QuestionResolveRequest,
  ): Promise<QuestionResolveResult> {
    return this.request<QuestionResolveResult>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(questionId)}`,
      {
        method: 'POST',
        body,
        schema: questionResolveResultSchema,
      },
    );
  }

  /** `POST /api/v1/sessions/{id}/questions/{qid}:dismiss` — dismiss (returns 40909 envelope). */
  dismissQuestion(sessionId: string, questionId: string): Promise<QuestionDismissResult> {
    return this.request<QuestionDismissResult>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(questionId)}:dismiss`,
      { method: 'POST', schema: questionDismissResultSchema },
    );
  }

  /** `GET /api/v1/sessions/{id}/snapshot` — IM-style initial sync baseline. */
  getSnapshot(sessionId: string): Promise<SessionSnapshotResponse> {
    return this.request<SessionSnapshotResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/snapshot`,
      { schema: sessionSnapshotResponseSchema },
    );
  }

  /** `GET /api/v1/sessions/{id}/transcript` — turn-granular transcript page. */
  async transcriptPage(
    sessionId: string,
    agentId: string,
    opts: { beforeTurn?: string; afterTurn?: string; pageSize?: number } = {},
  ): Promise<TranscriptPage> {
    const query: Record<string, unknown> = {
      agent_id: agentId,
      page_size: opts.pageSize ?? TRANSCRIPT_PAGE_SIZE,
    };
    if (opts.beforeTurn !== undefined) query['before_turn'] = opts.beforeTurn;
    if (opts.afterTurn !== undefined) query['after_turn'] = opts.afterTurn;
    const data = await this.request<WireTranscriptResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/transcript`,
      { query, schema: transcriptResponseSchema },
    );
    return toTranscriptPage(data);
  }

  /** `GET /api/v1/sessions/{id}/transcript/ops?since_seq=` — point-to-point catch-up. */
  async transcriptOps(
    sessionId: string,
    agentId: string,
    sinceSeq: number,
  ): Promise<TranscriptOpsCatchup> {
    const data = await this.request<WireTranscriptOpsResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/transcript/ops`,
      { query: { agent_id: agentId, since_seq: sinceSeq }, schema: transcriptOpsCatchupResponseSchema },
    );
    return {
      batches: data.batches,
      latestSeq: data.latest_seq,
      complete: data.complete,
    };
  }

  /** `GET /api/v1/sessions/{id}/transcript/plan` — ExitPlanMode plans of one agent. */
  async transcriptPlan(
    sessionId: string,
    agentId: string,
    toolCallId?: string,
  ): Promise<TranscriptPlanInfo[]> {
    const query: Record<string, string | undefined> = { agent_id: agentId };
    if (toolCallId !== undefined) query['tool_call_id'] = toolCallId;
    const data = await this.request<{
      plans: {
        tool_call_id: string;
        turn_id: string;
        source: 'interaction' | 'display' | 'output';
        plan: string;
        path?: string;
        options?: { label: string; description?: string }[];
        review?: {
          state: 'pending' | 'approved' | 'rejected' | 'cancelled';
          selected_option?: string;
          feedback?: string;
        };
      }[];
    }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/transcript/plan`, {
      query,
      schema: transcriptPlanResponseSchema,
    });
    return data.plans.map((entry) => ({
      toolCallId: entry.tool_call_id,
      turnId: entry.turn_id,
      source: entry.source,
      plan: entry.plan,
      path: entry.path,
      options: entry.options,
      review:
        entry.review === undefined
          ? undefined
          : {
              state: entry.review.state,
              selectedOption: entry.review.selected_option,
              feedback: entry.review.feedback,
            },
    }));
  }

  /** `POST /api/v1/search` — cross-session full-text search. */
  async search(query: SearchQuery): Promise<SearchPage> {
    const data = await this.request<{
      items: unknown[];
      has_more?: unknown;
      page_token?: unknown;
      incomplete?: unknown;
      source?: unknown;
      index_state?: Record<string, unknown> | null;
    }>('/api/v1/search', {
      method: 'POST',
      body: {
        query: query.query,
        role: query.role,
        sort: query.sort,
        mode: query.mode,
        container:
          query.container === undefined
            ? undefined
            : { session_id: query.container.sessionId, agent_id: query.container.agentId },
        page_size: query.pageSize,
        page_token: query.pageToken,
      },
    });
    if (!Array.isArray(data.items)) throw new ApiError(0, 'search: unexpected response shape', 200);
    const rawState = (data.index_state ?? {}) as Record<string, unknown>;
    return {
      items: data.items.map(parseSearchHit).filter((hit): hit is SearchHit => hit !== undefined),
      hasMore: data.has_more === true,
      pageToken: typeof data.page_token === 'string' ? data.page_token : undefined,
      incomplete: data.incomplete === 'candidate_cap' ? 'candidate_cap' : undefined,
      source: data.source === 'live' || data.source === 'index' ? data.source : undefined,
      indexState: {
        state:
          rawState['state'] === 'building' || rawState['state'] === 'readonly'
            ? rawState['state']
            : 'ready',
        indexedSessions: Number(rawState['indexed_sessions'] ?? 0),
        totalSessions: Number(rawState['total_sessions'] ?? 0),
        documents: Number(rawState['documents'] ?? 0),
      },
    };
  }

  /** `GET /api/v1/config` — current config view. */
  config(): Promise<ConfigResponse> {
    return this.request<ConfigResponse>('/api/v1/config', { schema: configResponseSchema });
  }

  /** `POST /api/v1/config` — merge-patch the server config (default model /
   *  permission / plan …). Missing keys are left untouched; the server pushes
   *  `event.config.changed` afterwards. */
  patchConfig(body: PatchConfigRequest): Promise<ConfigResponse> {
    return this.request<ConfigResponse>('/api/v1/config', {
      method: 'POST',
      body,
      schema: configResponseSchema,
    });
  }

  /** `GET /api/v1/models` — model catalog. */
  models(): Promise<ListModelsResponse> {
    return this.request<ListModelsResponse>('/api/v1/models', { schema: listModelsResponseSchema });
  }

  /** `GET /api/v1/agent-profiles` — builtin and user profiles that may run as subagents. */
  agentProfiles(): Promise<ListAgentProfilesResponse> {
    return this.request<ListAgentProfilesResponse>('/api/v1/agent-profiles', {
      schema: listAgentProfilesResponseSchema,
    });
  }

  /** `POST /api/v1/agent-profiles` — create a user agent Markdown file. */
  createAgentProfile(body: CreateAgentProfileRequest): Promise<AgentProfileDescriptor> {
    return this.request<AgentProfileDescriptor>('/api/v1/agent-profiles', {
      method: 'POST',
      body,
      schema: agentProfileDescriptorSchema,
    });
  }

  /** `PUT /api/v1/agent-profiles/{name}` — replace editable user agent fields. */
  updateAgentProfile(
    name: string,
    body: UpdateAgentProfileRequest,
  ): Promise<AgentProfileDescriptor> {
    return this.request<AgentProfileDescriptor>(
      `/api/v1/agent-profiles/${encodeURIComponent(name)}`,
      { method: 'PUT', body, schema: agentProfileDescriptorSchema },
    );
  }

  /** `POST /api/v1/agent-profiles/{name}/state` — enable or disable a user agent. */
  setAgentProfileEnabled(
    name: string,
    body: SetAgentProfileEnabledRequest,
  ): Promise<AgentProfileDescriptor> {
    return this.request<AgentProfileDescriptor>(
      `/api/v1/agent-profiles/${encodeURIComponent(name)}/state`,
      { method: 'POST', body, schema: agentProfileDescriptorSchema },
    );
  }

  /** `DELETE /api/v1/agent-profiles/{name}` — delete an editable user agent file. */
  deleteAgentProfile(name: string): Promise<DeleteAgentProfileResponse> {
    return this.request<DeleteAgentProfileResponse>(
      `/api/v1/agent-profiles/${encodeURIComponent(name)}`,
      { method: 'DELETE', schema: deleteAgentProfileResponseSchema },
    );
  }

  // ------------------------------------------------------------- providers

  /** `GET /api/v1/providers` — configured providers (credentials redacted). */
  listProviders(): Promise<ListProvidersResponse> {
    return this.request<ListProvidersResponse>('/api/v1/providers', {
      schema: listProvidersResponseSchema,
    });
  }

  /** `GET /api/v1/providers/{id}` — one provider plus its stored api key
   *  (loopback only; the protocol schema omits `api_key`, so no zod check). */
  getProviderDetail(providerId: string): Promise<ProviderDetail> {
    return this.request<ProviderDetail>(
      `/api/v1/providers/${encodeURIComponent(providerId)}`,
    );
  }

  /** `POST /api/v1/providers` — create a provider manually (201). */
  createProvider(body: CreateProviderRequest): Promise<ProviderCatalogItem> {
    return this.request<ProviderCatalogItem>('/api/v1/providers', { method: 'POST', body });
  }

  /** `PUT /api/v1/providers/{id}` — replace a provider (api_key tri-state:
   *  absent = keep, `""` = clear, value = replace). */
  replaceProvider(providerId: string, body: ReplaceProviderRequest): Promise<ReplaceProviderResponse> {
    return this.request<ReplaceProviderResponse>(
      `/api/v1/providers/${encodeURIComponent(providerId)}`,
      { method: 'PUT', body },
    );
  }

  /** `DELETE /api/v1/providers/{id}` — remove a provider (204). */
  deleteProvider(providerId: string): Promise<void> {
    return this.request<void>(`/api/v1/providers/${encodeURIComponent(providerId)}`, {
      method: 'DELETE',
    });
  }

  /** `POST /api/v1/providers/{id}:refresh` — re-fetch the provider's models. */
  refreshProvider(providerId: string): Promise<RefreshProviderModelsResponse> {
    return this.request<RefreshProviderModelsResponse>(
      `/api/v1/providers/${encodeURIComponent(providerId)}:refresh`,
      { method: 'POST', schema: refreshProviderModelsResponseSchema },
    );
  }

  /** `POST /api/v1/providers:import_catalog` — import one models.dev entry. */
  importCatalogProvider(body: ImportCatalogRequest): Promise<ImportCatalogResult> {
    return this.request<ImportCatalogResult>('/api/v1/providers:import_catalog', {
      method: 'POST',
      body,
    });
  }

  /** `GET /api/v1/catalog/providers` — the models.dev catalog (server-cached,
   *  built-in snapshot fallback). */
  listCatalogProviders(): Promise<CatalogProvidersResponse> {
    return this.request<CatalogProvidersResponse>('/api/v1/catalog/providers');
  }

  /** `GET /api/v1/fs:home` — the server host's home directory (folder picker
   *  bootstrap; also the default `cwd` for sessions created without an
   *  explicit workspace). */
  fsHome(): Promise<FsHomeResponse> {
    return this.request<FsHomeResponse>('/api/v1/fs:home', { schema: fsHomeResponseSchema });
  }

  /** `GET /api/v1/fs:browse` — directory browsing for a folder picker. Returns
   *  one level of subdirectories only (no files, no recursion); `path` omitted
   *  resolves the server host home. `parent` is null at the filesystem root. */
  fsBrowse(path?: string): Promise<FsBrowseResponse> {
    return this.request<FsBrowseResponse>('/api/v1/fs:browse', {
      query: path === undefined ? undefined : { path },
      schema: fsBrowseResponseSchema,
    });
  }

  // -------------------------------------------------------------- attachments
  // The multipart upload bypasses the JSON `request()` helper (no envelope on
  // the wire is wrong — it IS the envelope, but the body is form data). We
  // still validate the response data against the file-meta schema.

  /** `POST /api/v1/files` (multipart) — upload one attachment. Returns the
   *  file meta; reference it in a prompt via `{ type: 'file', file_id }`. */
  async uploadFile(file: File, opts?: { name?: string; expiresInSec?: number }): Promise<UploadFileResponse> {
    const form = new FormData();
    form.append('file', file);
    if (opts?.name !== undefined) form.append('name', opts.name);
    if (opts?.expiresInSec !== undefined) form.append('expires_in_sec', String(opts.expiresInSec));
    const headers: Record<string, string> = {};
    if (this.token !== undefined && this.token !== '') {
      headers['authorization'] = `Bearer ${this.token}`;
    }
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/v1/files`, { method: 'POST', headers, body: form });
    } catch (error) {
      throw new ApiError(-1, `network error: ${error instanceof Error ? error.message : String(error)}`, 0);
    }
    let envelope: Envelope;
    try {
      envelope = parseEnvelope(await res.json(), res.status);
    } catch {
      throw new ApiError(0, `http ${res.status}: unparseable response`, res.status);
    }
    if (envelope.code !== 0) {
      throw new ApiError(envelope.code, `/api/v1/files failed (${envelope.code}): ${envelope.msg}`, res.status, envelope.details);
    }
    const parsed = uploadFileResponseSchema.safeParse(envelope.data);
    if (!parsed.success) {
      throw new ApiError(0, '/api/v1/files: unexpected response shape', res.status);
    }
    return parsed.data;
  }

  // ------------------------------------------------------------------ steer
  // Steer is its own endpoint (NOT a PromptSubmission field): it injects a
  // follow-up message into a running turn rather than queuing a new prompt.

  /** `POST /api/v1/sessions/{id}/prompts:steer` — inject a follow-up into the
   *  active turn(s). Body `{ prompt_ids }` on the collection route; the single
   *  prompt route `{pid}:steer` is the same shape without `prompt_ids`. */
  steerPrompt(sessionId: string, body: { promptIds: readonly string[] }): Promise<{ steered: true; promptIds: readonly string[] }> {
    return this
      .request<{ steered: true; prompt_ids: readonly string[] }>(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts:steer`,
        { method: 'POST', body: { prompt_ids: body.promptIds } },
      )
      .then((data) => ({ steered: true as const, promptIds: data.prompt_ids ?? body.promptIds }));
  }

  // ------------------------------------------------------------------ skills

  /** `GET /api/v1/sessions/{id}/skills` — skills activatable in this session
   *  (drives the composer's `/` and `$` mention menus). */
  listSkills(sessionId: string): Promise<ListSkillsResponse> {
    return this.request<ListSkillsResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/skills`,
      { schema: listSkillsResponseSchema },
    );
  }

  /** `POST /api/v1/sessions/{id}/skills/{name}:activate` — start a skill turn
   *  (the REST analogue of a `/<skill>` slash command). */
  activateSkill(sessionId: string, skillName: string, body: ActivateSkillRequest): Promise<ActivateSkillResult> {
    return this.request<ActivateSkillResult>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/skills/${encodeURIComponent(skillName)}:activate`,
      { method: 'POST', body },
    );
  }

  // ----------------------------------------------- session-scoped file actions

  /** `POST /api/v1/sessions/{id}/fs:list` — workspace tree (depth/limit/sort).
   *  Fields the server defaults (show_hidden/follow_gitignore/sort/…) are
   *  optional on the wire; pass what you need to override. */
  fsList(sessionId: string, body: Partial<FsListRequest>): Promise<FsListResponse> {
    return this.request<FsListResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/fs:list`,
      { method: 'POST', body, schema: fsListResponseSchema },
    );
  }

  /** `POST /api/v1/sessions/{id}/fs:read` — read a file's content (utf-8/base64).
   *  `offset`/`length`/`encoding` default server-side; pass overrides if needed. */
  fsRead(sessionId: string, body: Partial<FsReadRequest> & { path: string }): Promise<FsReadResponse> {
    return this.request<FsReadResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/fs:read`,
      { method: 'POST', body, schema: fsReadResponseSchema },
    );
  }

  /** `POST /api/v1/sessions/{id}/fs:diff` — unified diff of one path's changes. */
  fsDiff(sessionId: string, path: string): Promise<FsDiffResponse> {
    return this.request<FsDiffResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/fs:diff`,
      { method: 'POST', body: { path }, schema: fsDiffResponseSchema },
    );
  }

  /** `POST /api/v1/sessions/{id}/fs:git_status` — branch + per-path status. */
  fsGitStatus(sessionId: string, paths?: readonly string[]): Promise<FsGitStatusResponse> {
    return this.request<FsGitStatusResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/fs:git_status`,
      { method: 'POST', body: paths === undefined ? {} : { paths } },
    );
  }

  fsGitBranches(sessionId: string): Promise<FsGitBranchesResponse> {
    return this.request<FsGitBranchesResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/fs:git_branches`,
      { method: 'POST', body: {}, schema: fsGitBranchesResponseSchema },
    );
  }

  fsGitCheckout(sessionId: string, branch: string): Promise<FsGitCheckoutResponse> {
    return this.request<FsGitCheckoutResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/fs:git_checkout`,
      { method: 'POST', body: { branch }, schema: fsGitCheckoutResponseSchema },
    );
  }

  /** `POST /api/v1/sessions/{id}/fs:open` — open a path with the OS default app. */
  fsOpen(sessionId: string, path: string): Promise<void> {
    return this.request<void>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/fs:open`, {
      method: 'POST',
      body: { path },
    }).then(() => undefined);
  }

  /** `POST /api/v1/sessions/{id}/fs:reveal` — reveal a path in the file manager. */
  fsReveal(sessionId: string, path: string): Promise<void> {
    return this.request<void>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/fs:reveal`, {
      method: 'POST',
      body: { path },
    }).then(() => undefined);
  }

  // ---------------------------------------------------------------- terminals
  // REST handles lifecycle; PTY I/O rides a separate WebSocket (see ws.ts).

  /** `POST /api/v1/sessions/{id}/terminals` — create a PTY (cwd is relative to
   *  the session workspace). */
  createTerminal(sessionId: string, body: CreateTerminalRequest): Promise<Terminal> {
    return this.request<Terminal>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/terminals`,
      { method: 'POST', body, schema: terminalSchema },
    );
  }

  /** `GET /api/v1/sessions/{id}/terminals` — list the session's PTYs. */
  listTerminals(sessionId: string): Promise<ListTerminalsResponse> {
    return this.request<ListTerminalsResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/terminals`,
      { schema: listTerminalsResponseSchema },
    );
  }

  /** `POST /api/v1/sessions/{id}/terminals/{tid}:close` — close a PTY. */
  closeTerminal(sessionId: string, terminalId: string): Promise<CloseTerminalResponse> {
    return this.request<CloseTerminalResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/terminals/${encodeURIComponent(terminalId)}:close`,
      { method: 'POST' },
    );
  }

  // ------------------------------------------------------------------- export
  // Returns a binary zip stream (no envelope); we resolve the blob + filename.

  /** `POST /api/v1/sessions/{id}/export` — bundle a session (optionally with
   *  desktop logs) as a zip download. */
  async exportSession(
    sessionId: string,
    opts: { desktop?: boolean; webLog?: string } = {},
  ): Promise<{ blob: Blob; filename: string }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token !== undefined && this.token !== '') {
      headers['authorization'] = `Bearer ${this.token}`;
    }
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/export`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ desktop: opts.desktop, web_log: opts.webLog }),
      });
    } catch (error) {
      throw new ApiError(-1, `network error: ${error instanceof Error ? error.message : String(error)}`, 0);
    }
    if (!res.ok) {
      // Best-effort: surface the envelope message when the server sent JSON.
      let message = `http ${res.status}`;
      try {
        const body = (await res.json()) as Envelope;
        if (body.msg !== undefined) message = body.msg;
      } catch {
        // not JSON — keep the http status
      }
      throw new ApiError(0, `export failed: ${message}`, res.status);
    }
    const blob = await res.blob();
    return { blob, filename: parseExportFilename(res.headers.get('content-disposition'), sessionId) };
  }
}

/** Parse the `Content-Disposition` filename, falling back to a default.
 *  Exported for unit testing. */
export function parseExportFilename(disposition: string | null, sessionId: string): string {
  if (disposition === null) return `kimi-session-${sessionId}.zip`;
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  return match?.[1] ?? `kimi-session-${sessionId}.zip`;
}

// --------------------------------------------------------------- transcript mappers

/** Wire shape of `GET .../transcript` (snake_case), validated by the schema. */
type WireTranscriptResponse = z.infer<typeof transcriptResponseSchema>;

/** Wire shape of `GET .../transcript/ops`, validated by the schema. */
type WireTranscriptOpsResponse = z.infer<typeof transcriptOpsCatchupResponseSchema>;

function toTranscriptPage(data: WireTranscriptResponse): TranscriptPage {
  return {
    items: data.items,
    hasMoreOlder: data.has_more,
    tasks: data.tasks,
    interactions: data.interactions,
    attachments: data.attachments,
    todos: data.todos,
    meta: data.meta,
    pendingInteractions: data.pending_interactions,
    seq: data.seq,
  };
}
