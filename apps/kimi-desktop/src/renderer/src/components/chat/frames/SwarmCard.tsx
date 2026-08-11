/**
 * SwarmCard — the AgentSwarm tool call rendered as a member roster.
 *
 * The engine's AgentSwarm tool emits a generic `agent_call` display
 * (`{ kind: 'agent_call', agent_name: 'swarm (<N> subagents)', prompt }`) and
 * attaches each spawned child on the frame's `agentRefs` with
 * `role: 'member'`. None of that was surfaced before — it fell through to the
 * generic JSON dump. This card turns it into a compact roster: a header with
 * the swarm prompt and an aggregate progress count, and one row per member
 * carrying its live status (derived from the linked task entity) plus a
 * "open" affordance that opens the child agent's transcript in the side panel.
 *
 * Each child's transcript is independently subscribable (the side-panel
 * ChatView keys its sync channel by `${sessionId}:${agentId}`), so the open
 * affordance reuses the existing side-chat plumbing — no new data path.
 */

import type { ToolInputDisplay } from '@moonshot-ai/protocol';
import type {
  AgentRef,
  ToolCallFrame,
  TranscriptInteraction,
  TranscriptTask,
} from '@moonshot-ai/transcript';
import { ArrowSquareOut, CaretRight, CheckCircle, Circle, WarningCircle } from '@phosphor-icons/react';
import { useContext, useState } from 'react';

import { agentTypeTag, tagClasses, tagIconClass } from '#/lib/agentColors';
import { CollapsibleBody } from '../CollapsibleBody';
import { TurnContext } from '../frameContext';

export interface SwarmCardProps {
  readonly frame: ToolCallFrame;
  readonly display?: ToolInputDisplay;
  /** Member agent refs (role 'member'); falls back to all refs when absent. */
  readonly members?: readonly AgentRef[];
  /** Tasks for the session, to derive each member's live status. */
  readonly tasks?: ReadonlyMap<string, TranscriptTask>;
  /** Pending interactions anchored to child agents (member pending badges). */
  readonly interactions?: readonly SourcedChildInteraction[];
  /** Open a child agent's transcript in the side panel. */
  readonly onOpenAgent?: (agentId: string, prompt?: string) => void;
}

/** A pending interaction owned by a child agent, for per-member badges. */
export interface SourcedChildInteraction {
  readonly sourceAgentId: string;
  readonly interaction: TranscriptInteraction;
}

const TASK_STATUS_DOT: Record<string, string> = {
  running: 'bg-[var(--color-text-warning)]',
  completed: 'bg-[var(--color-text-success)]',
  failed: 'bg-[var(--color-text-danger)]',
  timed_out: 'bg-[var(--color-text-danger)]',
  lost: 'bg-[var(--color-text-danger)]',
  pending: 'bg-[var(--color-text-tertiary)]',
};

const TASK_STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  timed_out: '超时',
  lost: '丢失',
  pending: '等待中',
};

export function SwarmCard({
  frame,
  display,
  members,
  tasks,
  interactions,
  onOpenAgent,
}: SwarmCardProps) {
  const turn = useContext(TurnContext);
  const live = turn?.liveTailFrameId === frame.frameId;
  const liveRoster = members ?? frame.agentRefs ?? [];
  const prompt = display?.kind === 'agent_call' ? display.prompt : undefined;
  const result = parseSwarmResult(frame.output);
  const declaredTotal = declaredSwarmCount(display);
  const roster =
    liveRoster.length > 0
      ? liveRoster
      : result.members.length > 0
        ? result.members.map((member, index) => ({
            agentId: member.agentId ?? `子代理 ${index + 1}`,
            role: 'member' as const,
          }))
        : Array.from({ length: declaredTotal }, (_, index) => ({
            agentId: `子代理 ${index + 1}`,
            role: 'member' as const,
          }));
  const synthetic = liveRoster.length === 0;

  // Finished groups stay compact like the parent task popover; live work opens
  // automatically so member progress remains visible while it matters.
  const [expanded, setExpanded] = useState(live || frame.state === 'running');

  const memberStatuses = roster.map((ref, index) =>
    statusForMember(
      ref,
      tasks,
      interactions,
      result.members.find((member) => member.agentId === ref.agentId) ?? result.members[index],
      synthetic,
    ),
  );
  const counts = aggregate(memberStatuses);
  const total = Math.max(roster.length, result.total, declaredTotal);

  return (
    <section className="ui-card-enter mb-1 max-w-[46rem]">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="ui-pressable group/activity-header -mx-1 flex min-h-8 w-[calc(100%+0.5rem)] cursor-pointer select-none items-center gap-1.5 rounded-[var(--radius-sm)] px-1.5 py-1 text-left text-[length:var(--codex-chat-font-size)] hover:bg-[var(--color-list-hover)]"
      >
        <AggregateIcon counts={counts} live={live} />
        <span className={`ui-tag-pill shrink-0 ${tagClasses('swarm')}`}>蜂群</span>
        <div className="min-w-0 flex-1 text-[var(--color-token-conversation-summary-leading)] group-hover/activity-header:text-[var(--color-text-foreground)]">
          <span className="text-[12.5px] font-medium">
            {aggregateLabel(counts, live)}
          </span>
          {prompt !== undefined && prompt !== '' ? (
            <span className="ml-1 truncate text-[11px] text-[var(--color-token-conversation-summary-trailing)]">{prompt}</span>
          ) : null}
        </div>
        <span className="shrink-0 text-[10.5px] text-[var(--color-token-conversation-summary-trailing)]">{total}</span>
        <CaretRight
          size={10}
          weight="bold"
          className={`shrink-0 text-[var(--color-token-conversation-body)] transition-transform duration-[var(--duration-hover)] ease-[var(--ease-out)] ${
            expanded
              ? 'rotate-90 opacity-100'
              : 'opacity-0 group-hover/activity-header:opacity-100 group-focus-visible/activity-header:opacity-100 group-has-[:focus-visible]/activity-header:opacity-100'
          }`}
          aria-hidden
        />
      </button>

      <CollapsibleBody open={expanded && roster.length > 0} className="ml-3 border-l border-[var(--color-border-light)] pl-2">
        <ul className="py-0.5">
          {roster.map((ref, index) => (
            <MemberRow
              key={ref.agentId ?? index}
              ref_={ref}
              status={memberStatuses[index]!}
              swarmPrompt={prompt}
              onOpen={synthetic && ref.agentId.startsWith('子代理 ') ? undefined : onOpenAgent}
            />
          ))}
        </ul>
      </CollapsibleBody>
    </section>
  );
}

function AggregateIcon({
  counts,
  live,
}: {
  readonly counts: { done: number; running: number; pending: number; failed: number };
  readonly live: boolean;
}) {
  if (counts.failed > 0) {
    return <WarningCircle size={14} className="shrink-0 text-[var(--color-text-danger)]" aria-hidden />;
  }
  if (live || counts.running > 0 || counts.pending > 0) {
    return <Circle size={14} className={`ui-dot-pulse shrink-0 ${tagIconClass('swarm')}`} aria-hidden />;
  }
  return <CheckCircle size={14} className={`shrink-0 ${tagIconClass('swarm')}`} aria-hidden />;
}

function aggregateLabel(
  counts: { readonly running: number; readonly pending: number; readonly failed: number },
  live: boolean,
): string {
  if (counts.failed > 0) return '部分失败';
  if (live || counts.running > 0) return '正在运行';
  if (counts.pending > 0) return '等待回应';
  return '已结束';
}

function MemberRow({
  ref_,
  status,
  swarmPrompt,
  onOpen,
}: {
  readonly ref_: AgentRef;
  readonly status: MemberStatus;
  readonly swarmPrompt?: string;
  readonly onOpen?: (agentId: string, prompt?: string) => void;
}) {
  const dot = TASK_STATUS_DOT[status.taskState ?? 'pending'] ?? 'bg-[var(--color-text-tertiary)]';
  const typeTag = agentTypeTag(status.description ?? ref_.agentId);
  return (
    <li>
      <button
        type="button"
        title={`打开 ${ref_.agentId} 的对话`}
        onClick={() => onOpen?.(ref_.agentId, status.description ?? swarmPrompt)}
        disabled={onOpen === undefined}
        className="ui-pressable group flex min-h-10 w-full items-start gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[12px] enabled:cursor-pointer enabled:hover:bg-[var(--color-list-hover)]"
      >
        <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={`ui-tag-pill shrink-0 ${tagClasses(typeTag.tag)}`}>{typeTag.label}</span>
            <span className="block truncate font-medium text-[var(--color-text-foreground)]">
              {status.description ?? ref_.agentId}
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-[var(--color-text-tertiary)]">
            <span className="shrink-0 font-mono">{ref_.agentId}</span>
            {status.resultSummary !== undefined ? (
              <span className="truncate" title={status.resultSummary}>{status.resultSummary}</span>
            ) : null}
          </span>
        </span>
        {status.pendingInteraction ? (
          <span className="shrink-0 rounded-full bg-[color-mix(in_srgb,var(--color-text-warning)_14%,transparent)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-warning)]">
            {status.pendingInteraction.interaction.interactionKind === 'approval' ? '待审批' : '待回答'}
          </span>
        ) : null}
        {status.taskState !== undefined ? (
          <span className="mt-0.5 shrink-0 text-[10px] text-[var(--color-text-tertiary)]">
            {TASK_STATUS_LABEL[status.taskState] ?? status.taskState}
          </span>
        ) : null}
        {onOpen !== undefined ? (
          <ArrowSquareOut
            size={12}
            weight="regular"
            className="mt-0.5 shrink-0 text-[var(--color-text-tertiary)] group-hover:text-[var(--color-text-foreground)]"
            aria-hidden
          />
        ) : null}
      </button>
    </li>
  );
}

interface MemberStatus {
  readonly taskState?: string;
  readonly description?: string;
  readonly pendingInteraction?: SourcedChildInteraction;
  readonly resultSummary?: string;
}

interface SwarmResultMember {
  readonly agentId?: string;
  readonly item?: string;
  readonly outcome: 'completed' | 'failed' | 'aborted' | 'cancelled';
  readonly summary?: string;
}

interface SwarmResult {
  readonly members: readonly SwarmResultMember[];
  readonly total: number;
}

function statusForMember(
  ref: AgentRef,
  tasks: ReadonlyMap<string, TranscriptTask> | undefined,
  interactions: readonly SourcedChildInteraction[] | undefined,
  result: SwarmResultMember | undefined,
  synthetic: boolean,
): MemberStatus {
  let task: TranscriptTask | undefined;
  if (tasks !== undefined) {
    task = tasks.get(ref.agentId);
    if (task === undefined) {
      for (const value of tasks.values()) {
        if (value.agentId === ref.agentId) {
          task = value;
          break;
        }
      }
    }
  }
  const pendingInteraction = interactions?.find((item) => item.sourceAgentId === ref.agentId);
  const resultState = result === undefined ? undefined : result.outcome === 'completed' ? 'completed' : result.outcome === 'aborted' || result.outcome === 'cancelled' ? 'failed' : 'failed';
  return {
    taskState: task?.state ?? resultState ?? (synthetic ? 'pending' : undefined),
    description: task?.description ?? result?.item,
    pendingInteraction,
    resultSummary: result?.summary,
  };
}

function aggregate(statuses: readonly MemberStatus[]): {
  done: number;
  running: number;
  pending: number;
  failed: number;
} {
  let done = 0;
  let running = 0;
  let pending = 0;
  let failed = 0;
  for (const status of statuses) {
    if (status.taskState === 'completed') done += 1;
    else if (status.taskState === 'running') running += 1;
    else if (status.taskState === 'failed' || status.taskState === 'timed_out' || status.taskState === 'lost') failed += 1;
    else if (status.pendingInteraction !== undefined) pending += 1;
  }
  return { done, running, pending, failed };
}

function frameOutputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (isRecord(output)) {
    if (typeof output['output'] === 'string') return output['output'];
    if (typeof output['text'] === 'string') return output['text'];
  }
  if (!Array.isArray(output)) return '';
  return output
    .flatMap((part) => {
      if (!isRecord(part)) return [];
      return part['type'] === 'text' && typeof part['text'] === 'string' ? [part['text']] : [];
    })
    .join('\n');
}

function parseSwarmResult(output: unknown): SwarmResult {
  const text = frameOutputText(output);
  if (text === '') return { members: [], total: 0 };
  const members: SwarmResultMember[] = [];
  const memberPattern = /<subagent\b([^>]*)>([\s\S]*?)<\/subagent>/gi;
  for (const match of text.matchAll(memberPattern)) {
    const attrs = match[1] ?? '';
    const body = (match[2] ?? '').trim();
    const outcome = readAttribute(attrs, 'outcome');
    if (outcome !== 'completed' && outcome !== 'failed' && outcome !== 'aborted' && outcome !== 'cancelled') continue;
    const agentId = readAttribute(attrs, 'agent_id');
    const item = readAttribute(attrs, 'item');
    members.push({ agentId, item, outcome, summary: oneLine(body) });
  }
  const summary = /<summary>\s*([^<]+)<\/summary>/i.exec(text)?.[1] ?? '';
  const completed = Number(/completed:\s*(\d+)/i.exec(summary)?.[1] ?? 0);
  const failed = Number(/failed:\s*(\d+)/i.exec(summary)?.[1] ?? 0);
  const aborted = Number(/aborted:\s*(\d+)/i.exec(summary)?.[1] ?? 0);
  return { members, total: Math.max(members.length, completed + failed + aborted) };
}

function declaredSwarmCount(display: ToolInputDisplay | undefined): number {
  if (display?.kind !== 'agent_call') return 0;
  return Number(/(?:swarm|蜂群)\s*\(?\s*(\d+)\s*(?:subagents?|个子代理)/i.exec(display.agent_name)?.[1] ?? 0);
}

function readAttribute(attrs: string, name: string): string | undefined {
  const value = new RegExp(`${name}="([^"]*)"`, 'i').exec(attrs)?.[1];
  return value === undefined || value === '' ? undefined : value;
}

function oneLine(value: string): string | undefined {
  const line = value.replaceAll(/\s+/g, ' ').trim();
  return line === '' ? undefined : line.length > 180 ? `${line.slice(0, 177)}…` : line;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
