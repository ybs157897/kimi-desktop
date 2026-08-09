/**
 * PlanPanel — the right-dock 「计划」tab, modeled on zcode's StatusPanel:
 * collapsible sections (default open, chevron appears on hover, trailing
 * counts) for the session's plans (计划), the execution-progress steps
 * (进程, the model's TodoList), and the child agents (智能体, zcode's
 * 子智能体目录). The agents directory merges two sources: the main agent's
 * transcript tasks AND the session snapshot's subagent roster — the latter is
 * the only surface that sees expert-team / swarm members spawned by child
 * agents. Plans likewise merge the main projection with each child agent's
 * own ExitPlanMode plans.
 */

import type { TodoItem, TranscriptTask, TranscriptTodo } from '@moonshot-ai/transcript';
import {
  ArrowSquareOut,
  CaretRight,
  CheckCircle,
  Circle,
  CircleNotch,
  FileText,
  PlayCircle,
  XCircle,
} from '@phosphor-icons/react';
import { useState, type ReactNode } from 'react';

import type { SessionSubagentSnapshot, TranscriptPlanInfo } from '#/lib/api';
import { agentTypeTag, tagClasses, tagIconClass, type TagKind } from '#/lib/agentColors';
import { useChildAgentPlans, useSessionSubagents } from '#/lib/queries';
import type { OpenPlanDoc } from '../chat/PlanDocViewer';
import { planDocFromInfo } from '../chat/PlanDocViewer';
import { COLLAPSE_AFTER, selectVisibleTodos } from '../chat/TodoPanel';
import { planStateLabel, planTitle, type PlanReviewState } from '../chat/planShared';

export interface PlanPanelProps {
  readonly sessionId: string;
  readonly plans: ReadonlyMap<string, TranscriptPlanInfo>;
  readonly todos: ReadonlyMap<string, TranscriptTodo>;
  readonly tasks: ReadonlyMap<string, TranscriptTask>;
  /** Open a child agent's transcript in the side panel. */
  readonly onOpenAgent?: (agentId: string, prompt?: string) => void;
  /** Open a plan in the plan-document dock tab. */
  readonly onOpenPlanDoc?: OpenPlanDoc;
}

const HISTORY_AFTER = 3;
/** Cap the per-child plan queries (newest agents win). */
const CHILD_PLAN_AGENT_LIMIT = 8;

const AGENT_STATUS_LABEL: Record<TranscriptTask['state'], string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  timed_out: '超时',
  killed: '已终止',
  lost: '丢失',
};

/** One row of the agents directory, normalized from either source. */
interface AgentEntry {
  readonly key: string;
  readonly agentId?: string;
  readonly title: string;
  readonly state: TranscriptTask['state'];
  /** Colored type pill (expert-team member profile etc.), when known. */
  readonly typeLabel?: string;
  readonly typeTag: TagKind;
  readonly snippet?: string;
  readonly timeIso?: string;
}

export function PlanPanel({ sessionId, plans, todos, tasks, onOpenAgent, onOpenPlanDoc }: PlanPanelProps) {
  const todoItems = Array.from(todos.values()).flatMap((doc) => doc.items);
  const mainAgents = Array.from(tasks.values()).filter(
    (task) => task.kind === 'subagent' && task.agentId !== undefined,
  );
  const mainRunning = mainAgents.some((task) => task.state === 'running');

  const roster = useSessionSubagents(sessionId, mainRunning);
  const agents = mergeAgentEntries(mainAgents, roster.data ?? []);

  // Child agents may hold their own ExitPlanMode plans (an expert-team lead
  // planning the delegation); merge them with the main projection.
  const childAgentIds = agents
    .map((entry) => entry.agentId)
    .filter((agentId): agentId is string => agentId !== undefined)
    .slice(-CHILD_PLAN_AGENT_LIMIT);
  const childPlans = useChildAgentPlans(sessionId, childAgentIds);
  const planEntries = orderPlans(plans, childPlans);

  const sections: ReactNode[] = [];
  if (planEntries.length > 0) {
    sections.push(
      <PanelSection key="plans" title="计划" bordered={sections.length > 0}>
        <PlansSection entries={planEntries} onOpenPlanDoc={onOpenPlanDoc} />
      </PanelSection>,
    );
  }
  if (todoItems.length > 0) {
    sections.push(
      <PanelSection
        key="progress"
        title="进程"
        trailing={<ProgressCount items={todoItems} />}
        bordered={sections.length > 0}
      >
        <ProgressSection items={todoItems} />
      </PanelSection>,
    );
  }
  if (agents.length > 0) {
    const runningCount = agents.filter((entry) => entry.state === 'running').length;
    sections.push(
      <PanelSection
        key="agents"
        title="智能体"
        trailing={runningCount > 0 ? `${runningCount} 运行` : undefined}
        bordered={sections.length > 0}
      >
        <AgentsSection agents={agents} onOpenAgent={onOpenAgent} />
      </PanelSection>,
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
      {sections.length > 0 ? (
        <div className="space-y-1">{sections}</div>
      ) : (
        <div className="px-3 py-6 text-center text-[12px] text-[var(--color-text-tertiary)]">
          暂无计划与进展
        </div>
      )}
    </div>
  );
}

/** Merge the main projection with child-agent plans (dedupe by tool call id):
 *  pending review first (expanded by default), then the rest newest-first. */
function orderPlans(
  plans: ReadonlyMap<string, TranscriptPlanInfo>,
  childPlans: readonly TranscriptPlanInfo[],
): TranscriptPlanInfo[] {
  const merged = new Map<string, TranscriptPlanInfo>(plans);
  for (const plan of childPlans) {
    if (!merged.has(plan.toolCallId)) merged.set(plan.toolCallId, plan);
  }
  const entries = Array.from(merged.values());
  const pending = entries.filter((entry) => entry.review?.state === 'pending');
  const rest = entries.filter((entry) => entry.review?.state !== 'pending').toReversed();
  return [...pending, ...rest];
}

/** The agents directory: transcript tasks first (they carry richer result
 *  data), then roster-only rows — the expert-team members whose spawning
 *  tool calls live in a child agent's transcript. */
function mergeAgentEntries(
  mainAgents: readonly TranscriptTask[],
  roster: readonly SessionSubagentSnapshot[],
): readonly AgentEntry[] {
  const entries: AgentEntry[] = mainAgents.map((task) => {
    const typeTag = agentTypeTag(task.description ?? task.agentId);
    return {
      key: `task:${task.taskId}`,
      agentId: task.agentId,
      title: task.description ?? task.agentId ?? task.taskId,
      state: task.state,
      typeTag: typeTag.tag,
      snippet: firstLine(task.error ?? task.resultSummary ?? emptyToUndefined(task.outputTail)),
      timeIso: task.endedAt ?? task.startedAt,
    };
  });
  const known = new Set(entries.map((entry) => entry.agentId).filter((id) => id !== undefined));
  for (const item of roster) {
    if (item.kind !== 'subagent' || known.has(item.id)) continue;
    const typeTag = agentTypeTag(item.subagent_type ?? item.description);
    entries.push({
      key: `roster:${item.id}`,
      agentId: item.id,
      title: item.description,
      state: rosterState(item),
      typeLabel: item.subagent_type,
      typeTag: typeTag.tag,
      snippet: firstLine(item.suspended_reason ?? item.output_preview),
      timeIso: item.completed_at ?? item.started_at ?? item.created_at,
    });
  }
  return entries;
}

function rosterState(item: SessionSubagentSnapshot): TranscriptTask['state'] {
  if (item.status === 'cancelled') return 'killed';
  return item.status;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/** First non-empty line of the result (or the failure message). */
function firstLine(source: string | undefined): string | undefined {
  if (source === undefined) return undefined;
  return source
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
}

// ------------------------------------------------------------------ section

/** zcode StatusSection: h-8 trigger (title + trailing count + hover chevron),
 *  default open, remembered only for the session (component state). */
function PanelSection({
  title,
  trailing,
  bordered = false,
  children,
}: {
  readonly title: string;
  readonly trailing?: ReactNode;
  readonly bordered?: boolean;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className={bordered ? 'border-t border-[var(--color-border-light)] pt-1' : ''}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="ui-pressable group flex h-8 w-full items-center gap-1.5 rounded-[var(--radius-sm)] px-2 text-left hover:bg-[var(--color-list-hover)]"
      >
        <span className="text-[12px] font-medium text-[var(--color-text-secondary)]">{title}</span>
        {trailing !== undefined ? (
          <span className="ml-auto shrink-0 tabular-nums text-[11px] text-[var(--color-text-tertiary)]">
            {trailing}
          </span>
        ) : null}
        <CaretRight
          size={10}
          weight="bold"
          className={`${trailing === undefined ? 'ml-auto' : ''} shrink-0 text-[var(--color-text-tertiary)] opacity-0 transition-[opacity,transform] duration-[var(--duration-hover)] ease-[var(--ease-out)] group-hover:opacity-100 ${open ? 'rotate-90' : ''}`}
          aria-hidden
        />
      </button>
      {open ? <div className="pb-1">{children}</div> : null}
    </section>
  );
}

// --------------------------------------------------------------------- 计划

function PlansSection({
  entries,
  onOpenPlanDoc,
}: {
  readonly entries: readonly TranscriptPlanInfo[];
  readonly onOpenPlanDoc?: OpenPlanDoc;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const visible = showHistory ? entries : entries.slice(0, HISTORY_AFTER);
  const hiddenCount = entries.length - visible.length;
  return (
    <ul className="space-y-0.5">
      {visible.map((entry) => (
        <PlanRow
          key={entry.toolCallId}
          entry={entry}
          onOpen={() =>
            // Carry the doc snapshot: child-agent plans are not in the app
            // shell's main-agent projection, so the tab needs the fallback.
            onOpenPlanDoc?.({ initialId: entry.toolCallId, doc: planDocFromInfo(entry) })
          }
        />
      ))}
      {hiddenCount > 0 || showHistory ? (
        <li>
          <button
            type="button"
            onClick={() => setShowHistory((value) => !value)}
            className="ui-pressable flex h-7 w-full items-center gap-1.5 rounded-[var(--radius-sm)] px-2 text-left text-[11px] text-[var(--color-text-tertiary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
          >
            <CaretRight
              size={10}
              weight="bold"
              className={`shrink-0 transition-transform duration-[var(--duration-hover)] ${showHistory ? 'rotate-90' : ''}`}
              aria-hidden
            />
            {showHistory ? '收起历史计划' : `历史计划 ${entries.length - HISTORY_AFTER} 条`}
          </button>
        </li>
      ) : null}
    </ul>
  );
}

/** One plan row. Clicking opens the plan-document dock tab — the section list
 *  is too narrow for reading, so there is no inline expansion here. */
function PlanRow({ entry, onOpen }: { readonly entry: TranscriptPlanInfo; readonly onOpen: () => void }) {
  const state: PlanReviewState = entry.review?.state ?? 'approved';
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        title={entry.path ?? '打开计划文档'}
        className="ui-pressable group flex min-h-8 w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1 text-left hover:bg-[var(--color-list-hover)]"
      >
        <FileText size={14} className={`shrink-0 ${tagIconClass('plan')}`} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-foreground)]">
          {planTitle(entry.plan)}
        </span>
        {state === 'pending' ? (
          <span className={`ui-tag-pill shrink-0 ${tagClasses('plan')}`}>{planStateLabel(state)}</span>
        ) : (
          <span className="shrink-0 text-[10.5px] text-[var(--color-text-tertiary)]">{planStateLabel(state)}</span>
        )}
        <ArrowSquareOut
          size={12}
          weight="regular"
          className="shrink-0 text-[var(--color-text-tertiary)] opacity-0 transition-opacity duration-[var(--duration-hover)] group-hover:opacity-100"
          aria-hidden
        />
      </button>
    </li>
  );
}

// --------------------------------------------------------------------- 进程

function ProgressCount({ items }: { readonly items: readonly TodoItem[] }) {
  const done = items.filter((item) => item.status === 'done').length;
  return (
    <span className={done === items.length ? 'text-[var(--color-text-success)]' : undefined}>
      {done}/{items.length}
    </span>
  );
}

function ProgressSection({ items }: { readonly items: readonly TodoItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const collapsed = !expanded && items.length > COLLAPSE_AFTER;
  const visible = collapsed ? selectVisibleTodos(items) : items;
  const hiddenCount = items.length - visible.length;
  return (
    <ul className="space-y-0.5">
      {visible.map((item, index) => (
        <li key={index} className="flex min-h-7 items-start gap-2 rounded-[var(--radius-sm)] px-2 py-1 text-[12px]">
          <TodoStatusIcon status={item.status} />
          <span
            className={`min-w-0 flex-1 break-words leading-5 ${
              item.status === 'done'
                ? 'text-[var(--color-text-tertiary)] line-through'
                : 'text-[var(--color-text-foreground)]'
            }`}
          >
            {item.title}
          </span>
        </li>
      ))}
      {hiddenCount > 0 || expanded ? (
        <li>
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="ui-pressable flex h-7 w-full items-center rounded-[var(--radius-sm)] px-2 text-left text-[11px] text-[var(--color-text-tertiary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
          >
            {expanded ? '收起' : `… +${hiddenCount} 条`}
          </button>
        </li>
      ) : null}
    </ul>
  );
}

function TodoStatusIcon({ status }: { readonly status: TodoItem['status'] }) {
  if (status === 'done') {
    return <CheckCircle size={14} className="mt-0.5 shrink-0 text-[var(--color-text-success)]" aria-hidden />;
  }
  if (status === 'in_progress') {
    return <PlayCircle size={14} className="mt-0.5 shrink-0 text-[var(--color-text-foreground)]" aria-hidden />;
  }
  return <Circle size={14} className="mt-0.5 shrink-0 text-[var(--color-text-tertiary)]" aria-hidden />;
}

// -------------------------------------------------------------------- 智能体

/** zcode 子智能体目录: always-visible "正在运行 · N" / "已结束 · N" groups
 *  with rich rows (status icon, title, result snippet, relative time). */
function AgentsSection({
  agents,
  onOpenAgent,
}: {
  readonly agents: readonly AgentEntry[];
  readonly onOpenAgent?: (agentId: string, prompt?: string) => void;
}) {
  const running = agents.filter((entry) => entry.state === 'running');
  const finished = agents.filter((entry) => entry.state !== 'running').toReversed();
  return (
    <div className="space-y-1">
      {running.length > 0 ? (
        <AgentGroup label={`正在运行 · ${running.length}`}>
          {running.map((entry) => (
            <AgentRow key={entry.key} entry={entry} onOpenAgent={onOpenAgent} />
          ))}
        </AgentGroup>
      ) : null}
      {finished.length > 0 ? (
        <AgentGroup label={`已结束 · ${finished.length}`}>
          {finished.map((entry) => (
            <AgentRow key={entry.key} entry={entry} onOpenAgent={onOpenAgent} />
          ))}
        </AgentGroup>
      ) : null}
    </div>
  );
}

function AgentGroup({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div>
      <div className="px-2 py-1 text-[10.5px] font-medium text-[var(--color-text-tertiary)]">
        {label}
      </div>
      <ul className="space-y-0.5">{children}</ul>
    </div>
  );
}

function AgentRow({
  entry,
  onOpenAgent,
}: {
  readonly entry: AgentEntry;
  readonly onOpenAgent?: (agentId: string, prompt?: string) => void;
}) {
  const time = relativeTime(entry.timeIso);
  return (
    <li>
      <button
        type="button"
        disabled={onOpenAgent === undefined || entry.agentId === undefined}
        title={entry.agentId !== undefined ? `打开 ${entry.title} 的对话` : undefined}
        onClick={() => entry.agentId !== undefined && onOpenAgent?.(entry.agentId, entry.title)}
        className="ui-pressable group flex w-full items-start gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left enabled:hover:bg-[var(--color-list-hover)] disabled:cursor-default"
      >
        <AgentStateIcon state={entry.state} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-foreground)]">
              {entry.title}
            </span>
            <span className="shrink-0 text-[10px] tabular-nums text-[var(--color-text-tertiary)]">
              {entry.state === 'running' ? AGENT_STATUS_LABEL[entry.state] : time ?? AGENT_STATUS_LABEL[entry.state]}
            </span>
          </span>
          {entry.typeLabel !== undefined || entry.snippet !== undefined ? (
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
              {entry.typeLabel !== undefined ? (
                <span className={`ui-tag-pill shrink-0 ${tagClasses(entry.typeTag)}`}>{entry.typeLabel}</span>
              ) : null}
              {entry.snippet !== undefined ? (
                <span className="min-w-0 flex-1 truncate text-[10.5px] text-[var(--color-text-tertiary)]">
                  {entry.snippet}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
        {onOpenAgent !== undefined && entry.agentId !== undefined ? (
          <ArrowSquareOut
            size={12}
            weight="regular"
            className="mt-0.5 shrink-0 text-[var(--color-text-tertiary)] opacity-0 transition-opacity duration-[var(--duration-hover)] group-hover:opacity-100"
            aria-hidden
          />
        ) : null}
      </button>
    </li>
  );
}

function AgentStateIcon({ state }: { readonly state: TranscriptTask['state'] }) {
  if (state === 'running') {
    return (
      <CircleNotch
        size={14}
        className="mt-0.5 shrink-0 animate-spin text-[var(--color-text-warning)]"
        aria-hidden
      />
    );
  }
  if (state === 'completed') {
    return <CheckCircle size={14} className="mt-0.5 shrink-0 text-[var(--color-text-success)]" aria-hidden />;
  }
  if (state === 'killed') {
    return <Circle size={14} className="mt-0.5 shrink-0 text-[var(--color-text-tertiary)]" aria-hidden />;
  }
  return <XCircle size={14} className="mt-0.5 shrink-0 text-[var(--color-text-danger)]" aria-hidden />;
}

function relativeTime(iso: string | undefined): string | undefined {
  if (iso === undefined) return undefined;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return undefined;
  const deltaMs = Date.now() - then;
  if (deltaMs < 60_000) return '刚刚';
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}
