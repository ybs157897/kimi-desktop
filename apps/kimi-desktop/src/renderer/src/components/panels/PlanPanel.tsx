/**
 * PlanPanel — the Codex-style floating conversation summary: compact,
 * persistent sections for the environment, plans, execution progress, and
 * child agents. The agents directory merges two sources: the main agent's
 * transcript tasks AND the session snapshot's subagent roster — the latter is
 * the only surface that sees expert-team / swarm members spawned by child
 * agents. Plans likewise merge the main projection with each child agent's
 * own ExitPlanMode plans.
 */

import type { TodoItem, TranscriptTask, TranscriptTodo } from '@moonshot-ai/transcript';
import {
  ArrowClockwise,
  ArrowSquareOut,
  CaretDown,
  CaretRight,
  CheckCircle,
  Circle,
  CircleNotch,
  FileText,
  GitDiff,
  GitPullRequest,
  Laptop,
  PlayCircle,
  Plus,
  XCircle,
} from '@phosphor-icons/react';
import { useEffect, useId, useState, type ReactNode } from 'react';

import type { TranscriptPlanInfo } from '#/lib/api';
import { tagClasses, tagIconClass } from '#/lib/agentColors';
import { gitChangeGroups } from '#/lib/gitPresentation';
import {
  useChildAgentPlans,
  useFsGitStatus,
  useFsOpen,
  useSessionSubagents,
} from '#/lib/queries';
import {
  mergeSessionSubagents,
  selectPanelSubagents,
  summarizeSubagents,
  type SubagentEntry,
  type SubagentSummary,
} from '#/lib/subagentSummary';
import { CollapsibleBody } from '../chat/CollapsibleBody';
import { GitBranchPicker } from '../git/GitBranchPicker';
import { GitCommitPushPopover } from '../git/GitCommitPushPopover';
import type { OpenPlanDoc } from '../chat/PlanDocViewer';
import { planDocFromInfo } from '../chat/PlanDocViewer';
import { COLLAPSE_AFTER, selectVisibleTodos } from '../chat/TodoPanel';
import { planStateLabel, planTitle, type PlanReviewState } from '../chat/planShared';
import { SubagentGlyph } from '../subagents/SubagentGlyph';

export interface PlanPanelProps {
  readonly sessionId: string;
  readonly cwd?: string;
  readonly plans: ReadonlyMap<string, TranscriptPlanInfo>;
  readonly todos: ReadonlyMap<string, TranscriptTodo>;
  readonly tasks: ReadonlyMap<string, TranscriptTask>;
  /** Open a child agent's transcript in the side panel. */
  readonly onOpenAgent?: (agentId: string, prompt?: string) => void;
  /** Open a plan in the plan-document dock tab. */
  readonly onOpenPlanDoc?: OpenPlanDoc;
  /** Open the full changed-files review in the resizable dock. */
  readonly onOpenChanges?: () => void;
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

export function PlanPanel({
  sessionId,
  cwd,
  plans,
  todos,
  tasks,
  onOpenAgent,
  onOpenPlanDoc,
  onOpenChanges,
}: PlanPanelProps) {
  const todoItems = Array.from(todos.values()).flatMap((doc) => doc.items);
  const mainAgents = Array.from(tasks.values()).filter((task) => task.kind === 'subagent');
  const mainRunning = mainAgents.some((task) => task.state === 'running');

  const roster = useSessionSubagents(sessionId, mainRunning);
  const agents = mergeSessionSubagents(mainAgents, roster.data ?? []);
  const inlineAgentSummary = summarizeSubagents(agents, 4);
  const agentSummary = inlineAgentSummary === undefined
    ? undefined
    : { ...inlineAgentSummary, ...selectPanelSubagents(agents, 4) };

  // Child agents may hold their own ExitPlanMode plans (an expert-team lead
  // planning the delegation); merge them with the main projection.
  const childAgentIds = agents
    .map((entry) => entry.agentId)
    .filter((agentId): agentId is string => agentId !== undefined)
    .slice(-CHILD_PLAN_AGENT_LIMIT);
  const childPlans = useChildAgentPlans(sessionId, childAgentIds);
  const planEntries = orderPlans(plans, childPlans);

  const sections: ReactNode[] = [
    <EnvironmentSection
      key="environment"
      sessionId={sessionId}
      cwd={cwd}
      onOpenChanges={onOpenChanges}
    />,
  ];
  if (planEntries.length > 0) {
    sections.push(
      <PanelSection key="plans" sectionKey="plans" title="计划" bordered>
        <PlansSection entries={planEntries} onOpenPlanDoc={onOpenPlanDoc} />
      </PanelSection>,
    );
  }
  if (todoItems.length > 0) {
    sections.push(
      <PanelSection
        key="progress"
        sectionKey="progress"
        title="进程"
        trailing={<ProgressCount items={todoItems} />}
        bordered
      >
        <ProgressSection items={todoItems} />
      </PanelSection>,
    );
  }
  if (agentSummary !== undefined) {
    sections.push(
      <PanelSection
        key="agents"
        sectionKey="subagents"
        title="子智能体"
        bordered
      >
        <AgentsSection summary={agentSummary} onOpenAgent={onOpenAgent} />
      </PanelSection>,
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
      <div className="space-y-1">{sections}</div>
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

// ------------------------------------------------------------------ section

/** zcode StatusSection: h-8 trigger (title + trailing count + hover chevron),
 *  default open, remembered only for the session (component state). */
function PanelSection({
  sectionKey,
  title,
  trailing,
  bordered = false,
  children,
}: {
  readonly sectionKey: string;
  readonly title: string;
  readonly trailing?: ReactNode;
  readonly bordered?: boolean;
  readonly children: ReactNode;
}) {
  const bodyId = useId();
  const storageKey = `kimi-desktop:thread-summary:${sectionKey}:open`;
  const [open, setOpen] = useState(
    () => localStorage.getItem(storageKey) !== 'false',
  );
  useEffect(() => {
    localStorage.setItem(storageKey, String(open));
  }, [open, storageKey]);
  return (
    <section className={bordered ? 'border-t border-[var(--color-border-light)] pt-1' : ''}>
      <div className="group flex h-8 w-full items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={bodyId}
          className="ui-pressable flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-[var(--radius-sm)] px-2 text-left hover:bg-[var(--color-list-hover)]"
        >
          <span className="text-[length:var(--client-content-font-size)] font-medium text-[var(--color-text-secondary)]">{title}</span>
          <CaretRight
            size={10}
            weight="bold"
            className={`ml-auto shrink-0 text-[var(--color-text-tertiary)] opacity-0 transition-[opacity,transform] duration-[var(--duration-hover)] ease-[var(--ease-out)] group-hover:opacity-100 ${open ? 'rotate-90' : ''}`}
            aria-hidden
          />
        </button>
        {trailing !== undefined ? (
          <span className="flex shrink-0 items-center tabular-nums text-[length:var(--client-content-font-size)] text-[var(--color-text-tertiary)]">
            {trailing}
          </span>
        ) : null}
      </div>
      <div id={bodyId}>
        <CollapsibleBody open={open} className="pb-1">
          {children}
        </CollapsibleBody>
      </div>
    </section>
  );
}

// ------------------------------------------------------------- 环境信息

function EnvironmentSection({
  sessionId,
  cwd,
  onOpenChanges,
}: {
  readonly sessionId: string;
  readonly cwd?: string;
  readonly onOpenChanges?: () => void;
}) {
  const git = useFsGitStatus(sessionId);
  const open = useFsOpen(sessionId);
  const branch = git.data?.branch;
  const changeGroups = gitChangeGroups(git.data);
  const changedFileCount = new Set(
    [...changeGroups.staged, ...changeGroups.unstaged].map((change) => change.path),
  ).size;
  const stagedFileCount = new Set(changeGroups.staged.map((change) => change.path)).size;
  const unstagedFileCount = new Set(changeGroups.unstaged.map((change) => change.path)).size;
  const repositoryName = cwd?.split(/[\\/]/).filter((part) => part !== '').at(-1);
  const pullRequest = git.data?.pullRequest;

  return (
    <PanelSection
      sectionKey="environment"
      title="环境信息"
      trailing={
        <button
          type="button"
          aria-label="刷新环境信息"
          title="刷新环境信息"
          onClick={() => {
            void git.refetch();
          }}
          className="ui-pressable flex h-6 w-6 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
        >
          {git.isFetching ? (
            <ArrowClockwise size={13} className="animate-spin" aria-hidden />
          ) : (
            <Plus size={14} aria-hidden />
          )}
        </button>
      }
    >
      <div className="space-y-0.5">
        <EnvironmentRow
          icon={<GitDiff size={14} aria-hidden />}
          label="变更"
          onClick={onOpenChanges}
          meta={
            git.data === undefined ? null : (
              <span className="inline-flex items-center gap-1 tabular-nums tracking-tight">
                <span className="text-[var(--color-text-success)]">+{git.data.additions}</span>
                <span className="text-[var(--color-text-danger)]">-{git.data.deletions}</span>
              </span>
            )
          }
        />
        <EnvironmentRow
          icon={<Laptop size={14} aria-hidden />}
          label="本地"
          title={cwd}
          onClick={cwd === undefined ? undefined : () => open.mutate({ path: '.', reveal: true })}
          meta={<CaretDown size={11} aria-hidden />}
        />
        <GitBranchPicker
          sessionId={sessionId}
          currentBranch={branch}
          changedFileCount={changedFileCount}
          stagedFileCount={stagedFileCount}
          repositoryName={repositoryName}
          appearance="environment"
        />
        <GitCommitPushPopover
          sessionId={sessionId}
          branch={branch}
          additions={git.data?.additions ?? 0}
          deletions={git.data?.deletions ?? 0}
          ahead={git.data?.ahead ?? 0}
          stagedFileCount={stagedFileCount}
          unstagedFileCount={unstagedFileCount}
          changedFileCount={changedFileCount}
          disabled={git.isError}
        />
        {pullRequest !== undefined && pullRequest !== null ? (
          <EnvironmentRow
            icon={<GitPullRequest size={14} aria-hidden />}
            label={`拉取请求 #${pullRequest.number}`}
            onClick={() => void window.kimiDesktop.openExternal(pullRequest.url)}
            meta={<ArrowSquareOut size={12} aria-hidden />}
          />
        ) : (
          <EnvironmentRow
            icon={<GitPullRequest size={14} aria-hidden />}
            label={git.isError ? '无法获取拉取请求状态' : '暂无拉取请求'}
          />
        )}
      </div>
    </PanelSection>
  );
}

function EnvironmentRow({
  icon,
  label,
  meta,
  title,
  onClick,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly meta?: ReactNode;
  readonly title?: string;
  readonly onClick?: () => void;
}) {
  const content = (
    <>
      <span className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--color-text-secondary)]">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-[length:var(--client-content-font-size)] text-[var(--color-text-foreground)]">
        {label}
      </span>
      {meta !== undefined ? (
        <span className="ml-auto flex shrink-0 items-center text-[length:var(--client-content-font-size)] text-[var(--color-text-tertiary)]">
          {meta}
        </span>
      ) : null}
    </>
  );
  const className =
    'ui-pressable flex h-7 w-full items-center gap-1.5 rounded-[var(--radius-sm)] px-2 text-left';
  if (onClick === undefined) {
    return (
      <div className={className} title={title}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={`${className} cursor-pointer hover:bg-[var(--color-list-hover)]`}
      title={title}
      onClick={onClick}
    >
      {content}
    </button>
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
            className="ui-pressable flex h-7 w-full items-center gap-1.5 rounded-[var(--radius-sm)] px-2 text-left text-[length:var(--client-content-font-size)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
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
        <span className="min-w-0 flex-1 truncate text-[length:var(--client-content-font-size)] text-[var(--color-text-foreground)]">
          {planTitle(entry.plan)}
        </span>
        {state === 'pending' ? (
          <span
            className={`ui-tag-pill shrink-0 ${tagClasses('plan')}`}
            style={{ fontSize: 'var(--client-content-font-size)' }}
          >
            {planStateLabel(state)}
          </span>
        ) : (
          <span className="shrink-0 text-[length:var(--client-content-font-size)] text-[var(--color-text-tertiary)]">{planStateLabel(state)}</span>
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
        <li key={index} className="flex min-h-7 items-start gap-2 rounded-[var(--radius-sm)] px-2 py-1 text-[length:var(--client-content-font-size)]">
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
            className="ui-pressable flex h-7 w-full items-center rounded-[var(--radius-sm)] px-2 text-left text-[length:var(--client-content-font-size)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
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
  summary,
  onOpenAgent,
}: {
  readonly summary: SubagentSummary;
  readonly onOpenAgent?: (agentId: string, prompt?: string) => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const agents = summary.entries;
  const running = agents.filter((entry) => entry.state === 'running');
  const finished = agents.filter((entry) => entry.state !== 'running').toReversed();
  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => setShowDetails((value) => !value)}
        aria-expanded={showDetails}
        aria-label={`${summary.ariaLabel}，${showDetails ? '收起详情' : '展开详情'}`}
        className="ui-pressable group flex h-8 w-full cursor-pointer items-center rounded-[var(--radius-sm)] px-2 hover:bg-[var(--color-list-hover)]"
      >
        <span className="flex min-w-0 flex-1 items-center">
          {summary.visibleEntries.map((entry, index) => (
            <span
              key={entry.key}
              className={index === 0 ? '' : '-ml-1'}
              title={entry.label}
            >
              <SubagentGlyph
                seed={entry.agentId ?? entry.key}
                tag={entry.tag}
                size="md"
              />
            </span>
          ))}
          {summary.overflowCount > 0 ? (
            <span className="-ml-1 flex h-6 min-w-6 items-center justify-center rounded-full border border-[var(--color-background-panel)] bg-[var(--color-background-button-secondary)] px-1 text-[length:var(--client-content-font-size)] tabular-nums text-[var(--color-text-secondary)]">
              +{summary.overflowCount}
            </span>
          ) : null}
          <span
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="ml-2 truncate text-[length:var(--client-content-font-size)] text-[var(--color-text-secondary)]"
          >
            {summary.panelLabel}
          </span>
        </span>
        <CaretRight
          size={10}
          weight="bold"
          className={`ml-2 shrink-0 text-[var(--color-text-tertiary)] transition-transform duration-[var(--duration-hover)] ${showDetails ? 'rotate-90' : ''}`}
          aria-hidden
        />
      </button>
      <CollapsibleBody open={showDetails}>
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
      </CollapsibleBody>
    </div>
  );
}

function AgentGroup({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div>
      <div className="px-2 py-1 text-[length:var(--client-content-font-size)] font-medium text-[var(--color-text-tertiary)]">
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
  readonly entry: SubagentEntry;
  readonly onOpenAgent?: (agentId: string, prompt?: string) => void;
}) {
  const time = relativeTime(entry.timeIso);
  return (
    <li>
      <button
        type="button"
        disabled={onOpenAgent === undefined || entry.agentId === undefined}
        title={entry.agentId !== undefined ? `打开 ${entry.label} 的对话` : undefined}
        onClick={() => entry.agentId !== undefined && onOpenAgent?.(entry.agentId, entry.prompt)}
        className="ui-pressable group flex w-full items-start gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left enabled:hover:bg-[var(--color-list-hover)] disabled:cursor-default"
      >
        <AgentStateIcon state={entry.state} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[length:var(--client-content-font-size)] text-[var(--color-text-foreground)]">
              {entry.label}
            </span>
            <span className="shrink-0 text-[length:var(--client-content-font-size)] tabular-nums text-[var(--color-text-tertiary)]">
              {entry.state === 'running' ? AGENT_STATUS_LABEL[entry.state] : time ?? AGENT_STATUS_LABEL[entry.state]}
            </span>
          </span>
          {entry.typeLabel !== undefined || entry.snippet !== undefined ? (
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
              {entry.typeLabel !== undefined ? (
                <span
                  className={`ui-tag-pill shrink-0 ${tagClasses(entry.tag)}`}
                  style={{ fontSize: 'var(--client-content-font-size)' }}
                >
                  {entry.typeLabel}
                </span>
              ) : null}
              {entry.snippet !== undefined ? (
                <span className="min-w-0 flex-1 truncate text-[length:var(--client-content-font-size)] text-[var(--color-text-tertiary)]">
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
