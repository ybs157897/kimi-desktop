import type {
  AgentRef,
  ToolCallFrame,
  TranscriptTask,
} from '@moonshot-ai/transcript';

import type { SessionSubagentSnapshot } from '#/lib/api';
import {
  agentTypeTag,
  type TagKind,
} from '#/lib/agentColors';

export interface SubagentEntry {
  readonly key: string;
  readonly agentId?: string;
  readonly label: string;
  readonly prompt?: string;
  readonly state: TranscriptTask['state'];
  readonly tag: TagKind;
  readonly typeLabel?: string;
  readonly snippet?: string;
  readonly timeIso?: string;
}

export interface SubagentSummary {
  readonly entries: readonly SubagentEntry[];
  readonly visibleEntries: readonly SubagentEntry[];
  readonly overflowCount: number;
  readonly runningCount: number;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly stoppedCount: number;
  readonly inlineLabel: string;
  readonly panelLabel: string;
  readonly ariaLabel: string;
}

export interface VisibleSubagents {
  readonly visibleEntries: readonly SubagentEntry[];
  readonly overflowCount: number;
}

/** Agent tool frames that Codex projects into one inline activity summary. */
export function isSubagentFrame(frame: ToolCallFrame): boolean {
  const key = (frame.view ?? frame.name).replace(/[\s_-]+/g, '').toLowerCase();
  if (
    key === 'agent' ||
    key === 'agentswarm' ||
    key === 'spawnagent' ||
    key === 'subagent'
  ) {
    return true;
  }
  if ((frame.agentRefs?.length ?? 0) > 0) return true;
  const display = record(frame.display);
  return display?.['kind'] === 'agent_call';
}

/**
 * Project an ordered run of Agent / AgentSwarm frames. A swarm frame expands
 * to one entry per agent ref; the ref-less streaming shell remains a single
 * stable placeholder until the server attaches its children.
 */
export function projectSubagentActivity(
  frames: readonly ToolCallFrame[],
  tasks: ReadonlyMap<string, TranscriptTask> | undefined,
): readonly SubagentEntry[] {
  const entries: SubagentEntry[] = [];
  const entryIndexByIdentity = new Map<string, number>();

  for (const frame of frames) {
    const swarm = isSwarm(frame);
    const result = swarm ? swarmResultProjection(frame) : EMPTY_SWARM_RESULT;
    const refs = frame.agentRefs ?? [];
    const candidates = activityCandidates(refs, result.members, result.remainingOutcomes);
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]!;
      const ref = candidate.ref;
      const result = candidate.result;
      const candidateAgentId = ref?.agentId ?? result?.agentId;
      const task = resolveFrameTask(frame, candidateAgentId, tasks);
      const agentId = candidateAgentId ?? task?.agentId;
      const key = agentId === undefined
        ? result === undefined
          ? `tool:${frame.toolCallId}:pending`
          : `tool:${frame.toolCallId}:result:${String(candidate.resultIndex)}`
        : `agent:${agentId}`;
      const identity = agentId ?? key;

      const input = record(frame.input);
      const display = record(frame.display);
      // Spawn events append refs in completion order, not the declared item
      // order. The settled tool output is the only payload that binds an
      // item to a concrete agent id, so never align refs to input.items by
      // array index. While live, the linked task description is the stable
      // per-agent label.
      const resumedAgentIds = record(input?.['resume_agent_ids']);
      const resumed = agentId !== undefined && resumedAgentIds?.[agentId] !== undefined;
      const typeLabel = resumed
        ? undefined
        : firstString(
            input?.['subagent_type'],
            input?.['subagent_name'],
            display?.['agent_name'],
          );
      const label = firstString(
        input?.['task_name'],
        result?.item,
        swarm ? undefined : input?.['description'],
        task?.description,
        input?.['description'],
        display?.['agent_name'],
        typeLabel,
        agentId,
      ) ?? '子智能体';
      const tag = agentTypeTag(typeLabel ?? label).tag;
      const entry: SubagentEntry = {
        key,
        agentId,
        label,
        prompt: firstString(input?.['prompt'], display?.['prompt'], frame.inputText, task?.description),
        state: resolveActivityState(frame, task, result),
        tag,
        typeLabel,
        snippet: firstLine(result?.summary ?? task?.error ?? task?.resultSummary ?? emptyToUndefined(task?.outputTail)),
        timeIso: task?.endedAt ?? task?.startedAt,
      };
      const previousIndex = entryIndexByIdentity.get(identity);
      if (previousIndex === undefined) {
        entryIndexByIdentity.set(identity, entries.length);
        entries.push(entry);
      } else {
        // A resumed agent may appear in another adjacent Agent frame. Keep its
        // original chip position/key, but let the newest invocation own the
        // displayed lifecycle.
        entries[previousIndex] = { ...entry, key: entries[previousIndex]!.key };
      }
    }
  }
  return entries;
}

/**
 * Merge durable main-transcript tasks with the session snapshot roster. The
 * transcript task wins on duplicate agent ids because it carries final output
 * and a durable terminal state; the roster only fills nested-agent gaps.
 */
export function mergeSessionSubagents(
  tasks: readonly TranscriptTask[],
  roster: readonly SessionSubagentSnapshot[],
): readonly SubagentEntry[] {
  const entries: SubagentEntry[] = [];
  const known = new Set<string>();

  for (const task of tasks) {
    if (task.kind !== 'subagent') continue;
    const identity = task.agentId ?? `task:${task.taskId}`;
    if (known.has(identity)) continue;
    known.add(identity);
    const tag = agentTypeTag(task.description ?? task.agentId);
    entries.push({
      key: `task:${task.taskId}`,
      agentId: task.agentId,
      label: task.description ?? task.agentId ?? task.taskId,
      prompt: task.description,
      state: task.state,
      tag: tag.tag,
      snippet: firstLine(task.error ?? task.resultSummary ?? emptyToUndefined(task.outputTail)),
      timeIso: task.endedAt ?? task.startedAt,
    });
  }

  for (const item of roster) {
    if (item.kind !== 'subagent' || known.has(item.id)) continue;
    known.add(item.id);
    const tag = agentTypeTag(item.subagent_type ?? item.description);
    entries.push({
      key: `roster:${item.id}`,
      agentId: item.id,
      label: item.description,
      prompt: item.description,
      state: item.status === 'cancelled' ? 'killed' : item.status,
      tag: tag.tag,
      typeLabel: item.subagent_type,
      snippet: firstLine(item.suspended_reason ?? item.output_preview),
      timeIso: item.completed_at ?? item.started_at ?? item.created_at,
    });
  }
  return entries;
}

/** Shared status/count projection for the inline chips and right summary. */
export function summarizeSubagents(
  entries: readonly SubagentEntry[],
  visibleLimit = 3,
): SubagentSummary | undefined {
  if (entries.length === 0) return undefined;
  const runningCount = entries.filter((entry) => entry.state === 'running').length;
  const completedCount = entries.filter((entry) => entry.state === 'completed').length;
  const failedCount = entries.filter((entry) => isFailed(entry.state)).length;
  const stoppedCount = entries.filter((entry) => entry.state === 'killed').length;
  const visibleEntries = entries.slice(0, visibleLimit);

  let inlineLabel: string;
  if (stoppedCount > 0 && runningCount === 0) inlineLabel = '被中断';
  else if (runningCount > 0) inlineLabel = '已开始工作';
  else if (failedCount > 0) inlineLabel = '完成但有错误';
  else inlineLabel = '已完成';

  let panelLabel: string;
  if (runningCount > 0) panelLabel = `${runningCount} 运行中`;
  else if (failedCount > 0) {
    panelLabel = completedCount > 0
      ? `${completedCount} 完成 · ${failedCount} 失败`
      : `${failedCount} 失败`;
  } else if (stoppedCount > 0) panelLabel = `${entries.length} 已结束`;
  else panelLabel = `${completedCount} 完成`;

  const ariaParts = [`子智能体，共 ${entries.length} 个`];
  if (runningCount > 0) ariaParts.push(`${runningCount} 个运行中`);
  if (completedCount > 0) ariaParts.push(`${completedCount} 个已完成`);
  if (failedCount > 0) ariaParts.push(`${failedCount} 个失败`);
  if (stoppedCount > 0) ariaParts.push(`${stoppedCount} 个已终止`);

  return {
    entries,
    visibleEntries,
    overflowCount: entries.length - visibleEntries.length,
    runningCount,
    completedCount,
    failedCount,
    stoppedCount,
    inlineLabel,
    panelLabel,
    ariaLabel: ariaParts.join('，'),
  };
}

/** The compact panel shows the active cohort while work is live; completed
 * avatars do not displace or visually reorder running agents. Once nothing is
 * active it returns to the stable session order. */
export function selectPanelSubagents(
  entries: readonly SubagentEntry[],
  visibleLimit = 4,
): VisibleSubagents {
  const running = entries.filter((entry) => entry.state === 'running');
  const candidates = running.length > 0 ? running : entries;
  const visibleEntries = candidates.slice(0, visibleLimit);
  return {
    visibleEntries,
    overflowCount: candidates.length - visibleEntries.length,
  };
}

function resolveFrameTask(
  frame: ToolCallFrame,
  agentId: string | undefined,
  tasks: ReadonlyMap<string, TranscriptTask> | undefined,
): TranscriptTask | undefined {
  if (tasks === undefined) return undefined;
  if (frame.taskId !== undefined) {
    const direct = tasks.get(frame.taskId);
    if (direct !== undefined && (agentId === undefined || direct.agentId === agentId)) return direct;
  }
  if (agentId !== undefined) {
    const direct = tasks.get(agentId);
    if (direct !== undefined) return direct;
    for (const task of tasks.values()) {
      if (task.agentId === agentId) return task;
    }
  }
  const input = record(frame.input);
  const description = firstString(input?.['description']);
  if (description !== undefined) {
    const matches = Array.from(tasks.values()).filter(
      (task) => task.kind === 'subagent' && task.description === description,
    );
    if (matches.length === 1) return matches[0];
  }
  return undefined;
}

function resolveActivityState(
  frame: ToolCallFrame,
  task: TranscriptTask | undefined,
  result: SwarmResultMember | undefined,
): TranscriptTask['state'] {
  if (frame.state === 'error') return 'failed';
  if (frame.state === 'done') {
    if (result?.outcome === 'failed') return 'failed';
    if (result?.outcome === 'aborted' || result?.outcome === 'cancelled') return 'killed';
    const outputState = agentOutputState(frame.output);
    if (outputState === 'running') {
      // A detached Agent call settles immediately while its task continues.
      // A later resume reuses the same task entity; its preserved endedAt is
      // the only durable sign that this archived invocation already settled.
      if (task?.state === 'running' && task.endedAt !== undefined) return 'completed';
      return task?.state ?? 'running';
    }
    if (outputState !== undefined) return outputState;
    return 'completed';
  }
  return task?.state ?? 'running';
}

interface SwarmResultMember {
  readonly agentId?: string;
  readonly item?: string;
  readonly outcome: 'completed' | 'failed' | 'aborted' | 'cancelled';
  readonly summary?: string;
}

interface ActivityCandidate {
  readonly ref?: AgentRef;
  readonly result?: SwarmResultMember;
  readonly resultIndex?: number;
}

interface SwarmResultProjection {
  readonly members: readonly SwarmResultMember[];
  readonly remainingOutcomes: readonly SwarmResultMember['outcome'][];
}

const EMPTY_SWARM_RESULT: SwarmResultProjection = {
  members: [],
  remainingOutcomes: [],
};

function activityCandidates(
  refs: readonly AgentRef[],
  results: readonly SwarmResultMember[],
  remainingOutcomes: readonly SwarmResultMember['outcome'][],
): readonly ActivityCandidate[] {
  const matchedResultIndexes = new Set<number>();
  let inferredResultIndex = results.length;
  const candidates: ActivityCandidate[] = [];
  for (const ref of refs) {
    const resultIndex = results.findIndex(
      (result, index) =>
        !matchedResultIndexes.has(index) &&
        result.agentId !== undefined &&
        result.agentId === ref.agentId,
    );
    if (resultIndex === -1) {
      // Aggregate summary counts do not identify which ref failed or was
      // aborted. Keep live refs while there is no aggregate gap, but never
      // attach an inferred terminal outcome to a named agent.
      if (remainingOutcomes.length === 0) candidates.push({ ref });
      continue;
    }
    matchedResultIndexes.add(resultIndex);
    candidates.push({ ref, result: results[resultIndex], resultIndex });
  }
  results.forEach((result, resultIndex) => {
    if (!matchedResultIndexes.has(resultIndex)) {
      candidates.push({ result, resultIndex });
    }
  });
  for (const outcome of remainingOutcomes) {
    candidates.push({ result: { outcome }, resultIndex: inferredResultIndex });
    inferredResultIndex += 1;
  }
  return candidates.length > 0 ? candidates : [{}];
}

function isSwarm(frame: ToolCallFrame): boolean {
  const key = (frame.view ?? frame.name).replace(/[\s_-]+/g, '').toLowerCase();
  return key === 'agentswarm' || key === 'swarm' || (frame.agentRefs ?? []).some((ref) => ref.role === 'member');
}

function swarmResultProjection(frame: ToolCallFrame): SwarmResultProjection {
  const text = frameOutputText(frame.output);
  if (text === '' || !/<agent_swarm_result\b/i.test(text)) return EMPTY_SWARM_RESULT;
  const summary = /<summary>\s*([^<]+)<\/summary>/i.exec(text)?.[1] ?? '';
  const completed = Number(/completed:\s*(\d+)/i.exec(summary)?.[1] ?? 0);
  const failed = Number(/failed:\s*(\d+)/i.exec(summary)?.[1] ?? 0);
  const aborted = Number(/aborted:\s*(\d+)/i.exec(summary)?.[1] ?? 0);
  const declaredCounts = new Map<SwarmResultMember['outcome'], number>([
    ['completed', completed],
    ['failed', failed],
    ['aborted', aborted],
    ['cancelled', 0],
  ]);
  const hasDeclaredCounts = completed + failed + aborted > 0;
  const expectedAgentIds = new Set((frame.agentRefs ?? []).map((ref) => ref.agentId));
  const input = record(frame.input);
  const expectedItems = new Set(
    Array.isArray(input?.['items'])
      ? input['items'].filter((item): item is string => typeof item === 'string')
      : [],
  );
  const parsedMembers: SwarmResultMember[] = [];
  const pattern = /<subagent\b([^>]*)>([\s\S]*?)<\/subagent>/gi;
  for (const match of text.matchAll(pattern)) {
    const attrs = match[1] ?? '';
    const outcome = readAttribute(attrs, 'outcome');
    if (outcome !== 'completed' && outcome !== 'failed' && outcome !== 'aborted' && outcome !== 'cancelled') continue;
    const agentId = readAttribute(attrs, 'agent_id');
    const item = readAttribute(attrs, 'item');
    // The result body is produced by another model and was historically not
    // XML-escaped. Only accept structural members that correspond to an
    // attached ref or a declared swarm item; nested XML examples are data.
    if (agentId !== undefined && expectedAgentIds.size > 0 && !expectedAgentIds.has(agentId)) continue;
    if (agentId === undefined && expectedItems.size > 0 && (item === undefined || !expectedItems.has(item))) continue;
    parsedMembers.push({
      agentId,
      item,
      outcome,
      summary: firstLine((match[2] ?? '').trim()),
    });
  }
  const members: SwarmResultMember[] = [];
  const seenAgentIds = new Set<string>();
  const seenItems = new Set<string>();
  // Prefer server-issued agent ids over identifier-less candidates. This
  // prevents an XML-looking result snippet from claiming a real input item
  // before the actual member appears later in the envelope.
  const orderedMembers = parsedMembers.toSorted((left, right) =>
    Number(right.agentId !== undefined) - Number(left.agentId !== undefined),
  );
  for (const member of orderedMembers) {
    if (member.agentId !== undefined && seenAgentIds.has(member.agentId)) continue;
    if (member.item !== undefined && seenItems.has(member.item)) continue;
    const normalizedOutcome = member.outcome === 'cancelled' ? 'aborted' : member.outcome;
    if (hasDeclaredCounts) {
      const remaining = declaredCounts.get(normalizedOutcome) ?? 0;
      if (remaining <= 0) continue;
      declaredCounts.set(normalizedOutcome, remaining - 1);
    }
    if (member.agentId !== undefined) seenAgentIds.add(member.agentId);
    if (member.item !== undefined) seenItems.add(member.item);
    members.push(member);
  }
  const parsedCompleted = members.filter((member) => member.outcome === 'completed').length;
  const parsedFailed = members.filter((member) => member.outcome === 'failed').length;
  const parsedAborted = members.filter(
    (member) => member.outcome === 'aborted' || member.outcome === 'cancelled',
  ).length;
  return {
    members,
    remainingOutcomes: [
      ...Array.from({ length: Math.max(0, failed - parsedFailed) }, () => 'failed' as const),
      ...Array.from({ length: Math.max(0, aborted - parsedAborted) }, () => 'aborted' as const),
      ...Array.from({ length: Math.max(0, completed - parsedCompleted) }, () => 'completed' as const),
    ],
  };
}

function frameOutputText(output: unknown): string {
  if (typeof output === 'string') return output;
  const outputRecord = record(output);
  if (typeof outputRecord?.['output'] === 'string') return outputRecord['output'];
  if (typeof outputRecord?.['text'] === 'string') return outputRecord['text'];
  if (!Array.isArray(output)) return '';
  return output
    .flatMap((part) => {
      const value = record(part);
      return value?.['type'] === 'text' && typeof value['text'] === 'string'
        ? [value['text']]
        : [];
    })
    .join('\n');
}

function agentOutputState(output: unknown): TranscriptTask['state'] | undefined {
  const status = /^status:\s*(running|completed|failed)\s*$/im.exec(frameOutputText(output))?.[1];
  if (status === 'running' || status === 'completed' || status === 'failed') return status;
  return undefined;
}

function readAttribute(attributes: string, name: string): string | undefined {
  const value = new RegExp(`${name}="([^"]*)"`, 'i').exec(attributes)?.[1];
  return value === undefined ? undefined : emptyToUndefined(decodeXmlAttribute(value));
}

function decodeXmlAttribute(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function isFailed(state: TranscriptTask['state']): boolean {
  return state === 'failed' || state === 'timed_out' || state === 'lost';
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

function firstLine(source: string | undefined): string | undefined {
  if (source === undefined) return undefined;
  return source
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
}
