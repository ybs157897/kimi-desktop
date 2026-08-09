/**
 * Tool call rendering, dispatched by `frame.view ?? frame.name` (the view
 * registry contract) with the `display` payload as the structured hint:
 *
 *  - Bash-style tools → exec card (Codex `exec`): rounded border, command +
 *    cwd + streaming/output body, status footer (green check on success,
 *    exit code on failure, "Stopped" on interruption), collapsible.
 *  - Edit / Write / diff displays → per-file diff block: header with the file
 *    name and +/- line-count badges, monospace body with added/removed lines
 *    tinted.
 *  - AgentSwarm / swarm displays → member roster card ({@link SwarmCard}).
 *  - Single Agent calls → compact agent line ({@link AgentCallCard}).
 *  - Web search displays → single-line summary ("Searched the web for …").
 *  - Everything else → generic card: name + summary, expandable to the raw
 *    input/output JSON.
 *
 * `ToolInputDisplaySchema` (`@moonshot-ai/protocol`) is the authoritative
 * parser for `frame.display`; the engine's `ToolInputDisplay` union mirrors
 * it (see `packages/agent-core-v2/src/tool/toolContract.ts`).
 */

import {
  ToolInputDisplaySchema,
  type ToolInputDisplay,
} from '@moonshot-ai/protocol';
import type { AgentRef, ToolCallFrame, TranscriptInteraction, TranscriptTask } from '@moonshot-ai/transcript';
import {
  ArrowSquareOut,
  CaretRight,
  CheckCircle,
  FileCode,
  MagnifyingGlass,
  Robot,
  TerminalWindow,
  Wrench,
} from '@phosphor-icons/react';
import { useState, type ReactNode } from 'react';

import {
  addAllLines,
  countChanges,
  diffBeforeAfter,
  diffLineTone,
  diffPrefix,
  type DiffLine,
} from '#/lib/diffRender';
import { agentTypeTag, tagClasses, tagIconClass, type TagKind } from '#/lib/agentColors';
import { agentCallTypeLabel } from '#/lib/timelinePresentation';
import { Markdown } from '../../markdown/Markdown';
import type { TranscriptPlanInfo } from '#/lib/api';
import type { OpenPlanDoc } from '../PlanDocViewer';
import { PlanCard } from './PlanCard';
import { SwarmCard, type SourcedChildInteraction } from './SwarmCard';

export interface ToolFrameProps {
  readonly frame: ToolCallFrame;
  /** Execution entity behind the call (shell run / subagent), when known. */
  readonly task?: TranscriptTask;
  /** The approval/question interaction gating this call, when known. */
  readonly interaction?: TranscriptInteraction;
  /** Tasks for the session, used by swarm/diff cards to enrich member status. */
  readonly tasks?: ReadonlyMap<string, TranscriptTask>;
  /** Pending interactions owned by child agents (swarm member badges). */
  readonly childInteractions?: readonly SourcedChildInteraction[];
  /** Open a child agent's transcript in the side panel. */
  readonly onOpenAgent?: (agentId: string, prompt?: string) => void;
  /** Open a plan in the plan-document dock tab. */
  readonly onOpenPlanDoc?: OpenPlanDoc;
  /** Durable plan projection from the transcript plan endpoint. */
  readonly plan?: TranscriptPlanInfo;
}

/** Shared tool-card surface; also used by the end-of-turn edited-files card. */
export const TOOL_CARD =
  'ui-card-enter mb-1 max-w-[46rem] overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-background-panel)]';
const TOOL_BODY =
  'max-h-72 overflow-auto border-t border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] px-3 py-2 font-mono text-[11.5px] leading-[1.55] text-[var(--color-text-secondary)]';

export function ToolFrame({
  frame,
  task,
  interaction,
  tasks,
  childInteractions,
  onOpenAgent,
  onOpenPlanDoc,
  plan,
}: ToolFrameProps) {
  const display = parseDisplay(frame.display);
  const key = frame.view ?? frame.name;

  if (isSwarm(frame, display, key)) {
    const members = swarmMembers(frame);
    return (
      <SwarmCard
        frame={frame}
        display={display}
        members={members}
        tasks={tasks}
        interactions={childInteractions}
        onOpenAgent={onOpenAgent}
      />
    );
  }
  if (display?.kind === 'agent_call' || isAgentName(key)) {
    return (
      <AgentCallCard
        frame={frame}
        display={display}
        task={task}
        tasks={tasks}
        interaction={interaction}
        onOpenAgent={onOpenAgent}
      />
    );
  }
  if (key === 'ExitPlanMode' || display?.kind === 'plan_review') {
    return (
      <PlanCard
        frame={frame}
        display={display}
        plan={plan}
        task={task}
        interaction={interaction}
        onOpenPlanDoc={onOpenPlanDoc}
      />
    );
  }
  if (key === 'TodoList' || display?.kind === 'todo_list') {
    return <TodoToolCard frame={frame} display={display} task={task} interaction={interaction} />;
  }
  if (display?.kind === 'command' || isBashName(key)) {
    return <BashCard frame={frame} display={display} task={task} interaction={interaction} />;
  }
  if (isDiff(display, key)) {
    return <DiffCard frame={frame} display={display} task={task} interaction={interaction} />;
  }
  if (display?.kind === 'search' || isSearchName(key)) {
    return <SearchLine frame={frame} display={display} task={task} interaction={interaction} />;
  }
  return <GenericCard frame={frame} display={display} task={task} interaction={interaction} />;
}

// ------------------------------------------------------------------ dispatch

function parseDisplay(value: unknown): ToolInputDisplay | undefined {
  if (value === undefined) return undefined;
  const parsed = ToolInputDisplaySchema.safeParse(value);
  return parsed.success ? (parsed.data as ToolInputDisplay) : undefined;
}

function isBashName(key: string): boolean {
  return key === 'Bash' || key === 'bash';
}

function isAgentName(key: string): boolean {
  return key === 'Agent' || key === 'agent';
}

function isSearchName(key: string): boolean {
  return /search/i.test(key);
}

function todoItems(frame: ToolCallFrame, display: ToolInputDisplay | undefined): readonly TodoItem[] {
  if (display?.kind === 'todo_list') return display.items.map(normalizeTodoItem).filter(isTodoItem);
  const input = isRecord(frame.input) ? frame.input['todos'] : undefined;
  return Array.isArray(input) ? input.map(normalizeTodoItem).filter(isTodoItem) : [];
}

interface TodoItem {
  readonly title: string;
  readonly status: 'pending' | 'in_progress' | 'done';
}

function normalizeTodoItem(value: unknown): TodoItem | undefined {
  if (!isRecord(value) || typeof value['title'] !== 'string') return undefined;
  const status = value['status'];
  if (status !== 'pending' && status !== 'in_progress' && status !== 'done') return undefined;
  return { title: value['title'], status };
}

function isTodoItem(value: TodoItem | undefined): value is TodoItem {
  return value !== undefined;
}

function isSwarm(
  frame: ToolCallFrame,
  display: ToolInputDisplay | undefined,
  key: string,
): boolean {
  if (key === 'AgentSwarm') return true;
  if (display?.kind === 'agent_call' && /swarm/i.test(display.agent_name)) return true;
  // agentRefs with any 'member' role also indicate a swarm spawn.
  return (frame.agentRefs ?? []).some((ref) => ref.role === 'member');
}

function swarmMembers(frame: ToolCallFrame): readonly AgentRef[] {
  const refs = frame.agentRefs ?? [];
  const members = refs.filter((ref) => ref.role === 'member');
  return members.length > 0 ? members : refs;
}

function isDiff(display: ToolInputDisplay | undefined, key: string): boolean {
  if (display?.kind === 'diff') return true;
  if (display?.kind === 'file_io') {
    return display.operation === 'edit' || display.operation === 'write';
  }
  return key === 'Edit' || key === 'Write' || key === 'edit' || key === 'write';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/** Shared expandable header — caret + icon + tag + title row. */
function CardHeader({
  expanded,
  onToggle,
  icon,
  tag,
  tagLabel,
  children,
  trailing,
}: {
  expanded: boolean;
  onToggle: () => void;
  icon: ReactNode;
  /** Optional type tag; renders a colored pill before the title (zcode parity). */
  tag?: TagKind;
  tagLabel?: string;
  children: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="ui-pressable flex min-h-9 w-full cursor-pointer select-none items-center gap-1.5 px-2.5 py-1 text-left hover:bg-[var(--color-list-hover)]"
    >
      <CaretRight
        size={11}
        weight="bold"
        className={`shrink-0 text-[var(--color-text-tertiary)] transition-transform duration-[var(--duration-hover)] ease-[var(--ease-out)] ${
          expanded ? 'rotate-90' : ''
        }`}
        aria-hidden
      />
      <span className={`shrink-0 ${tag !== undefined ? tagIconClass(tag) : 'text-[var(--color-text-tertiary)]'}`} aria-hidden>
        {icon}
      </span>
      {tag !== undefined ? <span className={`ui-tag-pill shrink-0 ${tagClasses(tag)}`}>{tagLabel ?? tag}</span> : null}
      <div className="min-w-0 flex-1">{children}</div>
      {trailing !== undefined ? <div className="flex shrink-0 items-center gap-1.5">{trailing}</div> : null}
    </button>
  );
}

function BadgeRow({
  frame,
  task,
  interaction,
  alwaysShowState = false,
}: {
  frame: ToolCallFrame;
  task: TranscriptTask | undefined;
  interaction: TranscriptInteraction | undefined;
  alwaysShowState?: boolean;
}) {
  return (
    <>
      {interaction !== undefined ? <InteractionBadge interaction={interaction} /> : null}
      {task !== undefined ? <TaskBadge task={task} /> : null}
      {interaction?.state !== 'pending' && (alwaysShowState || frame.state === 'running') ? (
        <StateBadge frame={frame} />
      ) : null}
    </>
  );
}

// ------------------------------------------------------------------ status bits

/** Busy pill: tinted orange with a sweeping highlight while the call is live
 *  (web shimmer). The overlay is pointer-inert so the pill stays readable. */
function BusyPill({ label }: { readonly label: string }) {
  return (
    <span className="relative overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--color-text-warning)_14%,transparent)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-warning)]">
      {label}
      <span className="ui-shimmer absolute inset-0" aria-hidden />
    </span>
  );
}

function StateBadge({ frame }: { frame: ToolCallFrame }) {
  if (frame.state === 'running') {
    return <BusyPill label="运行中" />;
  }
  if (frame.state === 'error') {
    return (
      <span className="rounded-full bg-[color-mix(in_srgb,var(--color-text-danger)_14%,transparent)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-danger)]">
        失败
      </span>
    );
  }
  return (
    <span className="rounded-full bg-[color-mix(in_srgb,var(--color-text-success)_14%,transparent)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-success)]">
      完成
    </span>
  );
}

function TaskBadge({ task }: { task: TranscriptTask }) {
  const tone =
    task.state === 'running'
      ? 'text-[var(--color-text-warning)] bg-[color-mix(in_srgb,var(--color-text-warning)_12%,transparent)]'
      : task.state === 'completed'
        ? 'text-[var(--color-text-success)] bg-[color-mix(in_srgb,var(--color-text-success)_12%,transparent)]'
        : task.state === 'failed' || task.state === 'timed_out' || task.state === 'lost'
          ? 'text-[var(--color-text-danger)] bg-[color-mix(in_srgb,var(--color-text-danger)_12%,transparent)]'
          : 'text-[var(--color-text-tertiary)] bg-[var(--color-background-button-secondary)]';
  return (
    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${tone}`}>
      {task.kind}
      {task.detached ? ' · 后台' : ''} · {task.state}
    </span>
  );
}

function InteractionBadge({ interaction }: { interaction: TranscriptInteraction }) {
  if (interaction.state === 'pending') {
    return <BusyPill label={interaction.interactionKind === 'approval' ? '待审批' : '待回答'} />;
  }
  const label =
    interaction.state === 'approved'
      ? '已批准'
      : interaction.state === 'rejected'
        ? '已拒绝'
        : interaction.state === 'answered'
          ? '已回答'
          : interaction.state === 'dismissed'
            ? '已跳过'
            : interaction.state;
  return (
    <span className="rounded-full bg-[var(--color-background-button-secondary)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-tertiary)]">
      {label}
    </span>
  );
}

/** The tool call's visible output: the streaming tail while running, the
 *  result text once settled. */
function toolOutput(frame: ToolCallFrame, task: TranscriptTask | undefined): string | undefined {
  if (frame.state === 'running') {
    const tail = task?.outputTail ?? '';
    if (tail !== '') return tail;
    if (frame.progress?.text !== undefined && frame.progress.text !== '') {
      return frame.progress.text;
    }
    return undefined;
  }
  if (typeof frame.output === 'string') return frame.output;
  if (Array.isArray(frame.output)) {
    const parts: string[] = [];
    for (const part of frame.output) {
      if (isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string') {
        parts.push(part['text']);
      } else if (isRecord(part) && typeof part['type'] === 'string') {
        parts.push(`[${part['type']}]`);
      }
    }
    return parts.join('\n');
  }
  return undefined;
}

// ------------------------------------------------------------------ exec card

function BashCard({
  frame,
  display,
  task,
  interaction,
}: {
  frame: ToolCallFrame;
  display: ToolInputDisplay | undefined;
  task: TranscriptTask | undefined;
  interaction: TranscriptInteraction | undefined;
}) {
  // Collapsed by default — command execution is background noise the user can
  // opt into. The header's running/status badge still surfaces progress, so a
  // live call is identifiable without the noisy streaming tail.
  const [expanded, setExpanded] = useState(false);
  const input = isRecord(frame.input) ? frame.input : undefined;
  const command =
    (display?.kind === 'command' && display.command) ||
    stringField(input ?? {}, 'command') ||
    frame.inputText ||
    '';
  const cwd = (display?.kind === 'command' && display.cwd) || stringField(input ?? {}, 'cwd');
  const fullOutput = toolOutput(frame, task);
  const outcome = bashFooter(frame, fullOutput);
  const hasOutput = fullOutput !== undefined && fullOutput.trim() !== '';
  const outputLineCount = hasOutput ? countLines(fullOutput) : 0;
  return (
    <div className={TOOL_CARD}>
      <CardHeader
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
        icon={<TerminalWindow size={14} />}
        tag="shell"
        tagLabel="命令"
        trailing={
          <>
            <BadgeRow frame={frame} task={task} interaction={interaction} />
            {outcome !== undefined ? (
              <span className={`flex items-center gap-1 text-[10.5px] font-medium ${outcome.tone}`}>
                {outcome.icon}
                {outcome.label}
              </span>
            ) : null}
          </>
        }
      >
        <code className="block truncate font-mono text-[12px] leading-5 tracking-[var(--tracking-tight)] text-[var(--color-text-foreground)]" title={command}>
          <span className="select-none text-[var(--color-text-tertiary)]">$ </span>
          {command}
        </code>
      </CardHeader>
      {hasOutput && !expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-label={`展开命令输出，共 ${outputLineCount} 行`}
          className="ui-pressable flex w-full items-center gap-1.5 border-t border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] px-3 py-1.5 text-left text-[10.5px] text-[var(--color-text-tertiary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-secondary)]"
        >
          <CaretRight size={10} weight="bold" aria-hidden />
          <span className="truncate">已执行 · {outputLineCount} 行输出</span>
        </button>
      ) : null}
      {hasOutput && expanded ? (
        <>
          {cwd !== undefined && cwd !== '' ? (
            <div className="border-t border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] px-3 pt-2 font-mono text-[10.5px] text-[var(--color-text-tertiary)]">
              {cwd}
            </div>
          ) : null}
          <pre className={`${TOOL_BODY} whitespace-pre-wrap ${cwd !== undefined && cwd !== '' ? 'border-t-0' : ''}`}>{fullOutput}</pre>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            aria-label="收起命令输出"
            className="ui-pressable flex w-full items-center justify-center gap-1 border-t border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] py-1 text-[10px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
          >
            <CaretRight size={10} weight="bold" className="-rotate-90" aria-hidden />
            收起输出
          </button>
        </>
      ) : null}
    </div>
  );
}

function bashFooter(
  frame: ToolCallFrame,
  output: string | undefined,
): { tone: string; label: string; icon: ReactNode } | undefined {
  // While running the header badge carries the state; the footer only
  // reports the settled outcome.
  if (frame.state === 'running') return undefined;
  if (frame.state === 'done') {
    return {
      tone: 'text-[var(--color-text-success)]',
      label: '完成',
      icon: <CheckCircle size={12} aria-hidden />,
    };
  }
  const text = output ?? frame.error ?? '';
  if (/interrupted|aborted/i.test(text)) {
    return {
      tone: 'text-[var(--color-text-tertiary)]',
      label: 'Stopped',
      icon: null,
    };
  }
  const exit = /exit code[:\s]+(\d+)/i.exec(text);
  if (exit !== null) {
    return {
      tone: 'text-[var(--color-text-danger)]',
      label: `Exit code: ${exit[1]}`,
      icon: null,
    };
  }
  return { tone: 'text-[var(--color-text-danger)]', label: 'Failed', icon: null };
}

function countLines(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length;
}

// ------------------------------------------------------------------ diff block

function DiffCard({
  frame,
  display,
  task,
  interaction,
}: {
  frame: ToolCallFrame;
  display: ToolInputDisplay | undefined;
  task: TranscriptTask | undefined;
  tasks?: ReadonlyMap<string, TranscriptTask>;
  interaction: TranscriptInteraction | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const input = isRecord(frame.input) ? frame.input : undefined;
  let path: string | undefined;
  let before: string | undefined;
  let after: string | undefined;
  let writeContent: string | undefined;
  if (display?.kind === 'file_io') {
    path = display.path;
    if (display.operation === 'write') {
      writeContent = display.content;
    } else {
      before = display.before;
      after = display.after;
    }
  } else if (display?.kind === 'diff') {
    path = display.path;
    before = display.before;
    after = display.after;
  }
  path ??= stringField(input ?? {}, 'path');
  before ??= stringField(input ?? {}, 'old_string');
  after ??= stringField(input ?? {}, 'new_string');
  writeContent ??= stringField(input ?? {}, 'content');

  const lines: DiffLine[] =
    writeContent !== undefined ? addAllLines(writeContent) : diffBeforeAfter(before ?? '', after ?? '');
  const { adds, dels } = countChanges(lines);
  return (
    <div className={TOOL_CARD}>
      <CardHeader
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
        icon={<FileCode size={14} />}
        tag="file"
        tagLabel="文件"
        trailing={
          <>
            <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px]">
              <span className="rounded-full bg-[color-mix(in_srgb,var(--color-text-success)_12%,transparent)] px-1.5 py-0.5 text-[var(--color-text-success)]">
                +{adds}
              </span>
              <span className="rounded-full bg-[color-mix(in_srgb,var(--color-text-danger)_12%,transparent)] px-1.5 py-0.5 text-[var(--color-text-danger)]">
                −{dels}
              </span>
            </span>
            <BadgeRow frame={frame} task={task} interaction={interaction} />
          </>
        }
      >
        <span className="block truncate font-mono text-[12px] tracking-[var(--tracking-tight)] text-[var(--color-text-foreground)]">
          {path !== undefined && path !== '' ? path : frame.name}
        </span>
      </CardHeader>
      {expanded && lines.length > 0 ? (
        <pre className="max-h-72 overflow-auto border-t border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] py-1.5 font-mono text-[11.5px] leading-[1.55]">
          {lines.map((line, index) => (
            <div key={index} className={`px-3.5 ${diffLineTone(line.type)}`}>
              <span className="select-none opacity-50">{diffPrefix(line.type)}</span>
              {line.text}
            </div>
          ))}
        </pre>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ agent card

/** Single-Agent tool call. It follows the same lightweight section treatment
 *  as the parent task popover instead of reading as another generic tool card.
 *  The whole row is the "open the child's transcript" affordance; the caret
 *  button owns the inline result preview. */
function AgentCallCard({
  frame,
  display,
  task,
  tasks,
  interaction,
  onOpenAgent,
}: {
  frame: ToolCallFrame;
  display: ToolInputDisplay | undefined;
  task: TranscriptTask | undefined;
  tasks?: ReadonlyMap<string, TranscriptTask>;
  interaction: TranscriptInteraction | undefined;
  onOpenAgent?: (agentId: string, prompt?: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const displayName = display?.kind === 'agent_call' ? display.agent_name : undefined;
  const name = agentCallTypeLabel(frame, displayName);
  const typeTag = agentTypeTag(name);
  const input = isRecord(frame.input) ? frame.input : undefined;
  const description = stringField(input ?? {}, 'description');
  const prompt = display?.kind === 'agent_call' ? display.prompt : frame.inputText;
  const childAgent = (frame.agentRefs ?? [])[0];
  const linkedTask = task ?? resolveAgentTask(frame, tasks);
  const childAgentId = childAgent?.agentId ?? linkedTask?.agentId;
  const running = frame.state === 'running';
  const output = agentOutput(frame, linkedTask);
  const hasOutput = output !== undefined && output.trim() !== '';
  const canOpen = childAgentId !== undefined && onOpenAgent !== undefined;
  return (
    <section className="ui-card-enter mb-3 max-w-[46rem] border-t border-[var(--color-border-light)] pt-2">
      <div className="mb-0.5 flex items-center gap-1.5">
        <span className={`ui-tag-pill ${tagClasses(typeTag.tag)}`}>子智能体</span>
      </div>
      <div className="-mx-1.5 flex min-h-8 w-[calc(100%+0.75rem)] items-center rounded-[var(--radius-sm)] hover:bg-[var(--color-list-hover)]">
        <button
          type="button"
          title={canOpen ? `打开 ${name} 的完整会话` : undefined}
          onClick={() => {
            // The primary row action is opening the child's live transcript;
            // inline expansion is the fallback when the agent id is unknown.
            if (canOpen) onOpenAgent(childAgentId, prompt ?? linkedTask?.description);
            else setExpanded((value) => !value);
          }}
          className="ui-pressable flex min-w-0 flex-1 cursor-pointer select-none items-center gap-2 rounded-[var(--radius-sm)] px-1.5 py-1 text-left"
        >
          <Robot
            size={14}
            weight="regular"
            className={`shrink-0 ${tagIconClass(typeTag.tag)}`}
            aria-hidden
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-medium text-[var(--color-text-foreground)]">
              {description ?? prompt ?? name}
            </span>
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={`ui-tag-pill shrink-0 ${tagClasses(typeTag.tag)}`}>{typeTag.label}</span>
              <span className="block truncate text-[10.5px] text-[var(--color-text-tertiary)]">{name}</span>
            </span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1 pr-1.5">
          <span className="px-1 text-[10.5px] text-[var(--color-text-tertiary)]">
            {agentStatusLabel(running, linkedTask, interaction)}
          </span>
          {canOpen ? (
            <ArrowSquareOut
              size={12}
              weight="regular"
              className="text-[var(--color-text-tertiary)]"
              aria-hidden
            />
          ) : null}
          <button
            type="button"
            aria-label={expanded ? '收起智能体输出' : '展开智能体输出'}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            className="ui-pressable flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-background-button-secondary)] hover:text-[var(--color-text-foreground)]"
          >
            <CaretRight
              size={10}
              weight="bold"
              className={`transition-transform duration-[var(--duration-hover)] ${expanded ? 'rotate-90' : ''}`}
              aria-hidden
            />
          </button>
        </div>
      </div>
      {expanded ? (
        hasOutput && !running ? (
          <div className="ml-2 mt-1 max-h-[24rem] overflow-y-auto border-l border-[var(--color-border-light)] py-1 pl-4 pr-2 text-[12px] leading-[var(--leading-chat)]">
            <Markdown source={output} />
          </div>
        ) : (
          <div className="ml-2 mt-1 max-h-[18rem] overflow-y-auto whitespace-pre-wrap border-l border-[var(--color-border-light)] py-1 pl-4 pr-2 font-mono text-[11.5px] leading-[1.55] text-[var(--color-text-secondary)]">
            {hasOutput
              ? output
              : running
                ? '子智能体正在工作，点击本行可打开它的实时会话…'
                : '暂无可展示的子代理输出。'}
          </div>
        )
      ) : null}
    </section>
  );
}

function agentStatusLabel(
  running: boolean,
  task: TranscriptTask | undefined,
  interaction: TranscriptInteraction | undefined,
): string {
  if (interaction?.state === 'pending') return '等待回应';
  if (running || task?.state === 'running') return '运行中';
  if (task?.state === 'failed' || task?.state === 'timed_out' || task?.state === 'lost') return '失败';
  return '已结束';
}

function agentOutput(
  frame: ToolCallFrame,
  task: TranscriptTask | undefined,
): string | undefined {
  const output = toolOutput(frame, task);
  if (output !== undefined && output !== '') return output;
  if (isRecord(frame.output) && typeof frame.output['result'] === 'string') {
    return frame.output['result'];
  }
  if (task?.outputTail !== undefined && task.outputTail !== '') return task.outputTail;
  return task?.resultSummary ?? task?.error;
}

/** Cold transcript frames may lose `agentRefs`, while the durable subagent
 * task still carries the agent id. Prefer the task whose launch description
 * matches the archived Agent arguments; the single-candidate fallback covers
 * older records that did not persist the description field. */
function resolveAgentTask(
  frame: ToolCallFrame,
  tasks: ReadonlyMap<string, TranscriptTask> | undefined,
): TranscriptTask | undefined {
  if (tasks === undefined) return undefined;
  const candidates = [...tasks.values()].filter(
    (value) => value.kind === 'subagent' && value.agentId !== undefined,
  );
  if (candidates.length === 0) return undefined;
  const input = isRecord(frame.input) ? frame.input : undefined;
  const description = stringField(input ?? {}, 'description');
  if (description !== undefined) {
    const match = candidates.find(
      (value) => value.description === description || value.description?.includes(description),
    );
    if (match !== undefined) return match;
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

// ------------------------------------------------------------------ search line

function SearchLine({
  frame,
  display,
  task,
  interaction,
}: {
  frame: ToolCallFrame;
  display: ToolInputDisplay | undefined;
  task: TranscriptTask | undefined;
  interaction: TranscriptInteraction | undefined;
}) {
  const input = isRecord(frame.input) ? frame.input : undefined;
  const query = (display?.kind === 'search' && display.query) || stringField(input ?? {}, 'query');
  const running = frame.state === 'running';
  return (
    <div className="ui-card-enter mb-2 flex min-h-9 max-w-[46rem] items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-background-panel)] px-3 py-1.5 text-[12px] tracking-[var(--tracking-tight)] text-[var(--color-text-secondary)]">
      <MagnifyingGlass size={14} className="shrink-0 text-[var(--color-tag-search)]" aria-hidden />
      <span className={`ui-tag-pill shrink-0 ${tagClasses('search')}`}>搜索</span>
      <span className="min-w-0 truncate text-[var(--color-text-foreground)]">
        {running ? '正在搜索' : '已搜索'}
        {query !== undefined && query !== '' ? (
          <>
            ：<span className="font-medium">{query}</span>
          </>
        ) : (
          <> · {frame.name}</>
        )}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {running ? <BusyPill label="…" /> : null}
        {interaction !== undefined ? <InteractionBadge interaction={interaction} /> : null}
        {task !== undefined ? <TaskBadge task={task} /> : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ todo card

/** Point-in-time TodoList snapshot. The live TodoPanel is authoritative for
 * the current list; this compact card preserves the list as it looked at the
 * tool call without exposing the raw argument JSON. */
function TodoToolCard({
  frame,
  display,
  task,
  interaction,
}: {
  frame: ToolCallFrame;
  display: ToolInputDisplay | undefined;
  task: TranscriptTask | undefined;
  interaction: TranscriptInteraction | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const items = todoItems(frame, display);
  const done = items.filter((item) => item.status === 'done').length;
  const inProgress = items.filter((item) => item.status === 'in_progress').length;
  const summary = items.length === 0 ? '列表已清空' : `${done}/${items.length} 完成${inProgress > 0 ? ` · ${inProgress} 进行中` : ''}`;
  return (
    <div className={TOOL_CARD}>
      <CardHeader
        expanded={expanded}
        onToggle={() => items.length > 0 && setExpanded((value) => !value)}
        icon={<CheckCircle size={14} />}
        tag="todo"
        tagLabel="待办"
        trailing={<BadgeRow frame={frame} task={task} interaction={interaction} alwaysShowState />}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[10.5px] text-[var(--color-text-tertiary)]">{summary}</span>
        </div>
      </CardHeader>
      {expanded ? (
        <ul className="space-y-0.5 border-t border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] px-3.5 py-2">
          {items.map((item, index) => (
            <li key={`${item.title}-${index}`} className="flex items-center gap-2 text-[11px]">
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${todoStatusDot(item.status)}`}
                aria-hidden
              />
              <span className={item.status === 'done' ? 'text-[var(--color-text-tertiary)] line-through' : 'text-[var(--color-text-foreground)]'}>
                {item.title}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function todoStatusDot(status: TodoItem['status']): string {
  if (status === 'done') return 'bg-[var(--color-text-success)]';
  if (status === 'in_progress') return 'bg-[var(--primary)]';
  return 'bg-[var(--color-text-tertiary)]';
}

// ------------------------------------------------------------------ generic card

function GenericCard({
  frame,
  display,
  task,
  interaction,
}: {
  frame: ToolCallFrame;
  display: ToolInputDisplay | undefined;
  task: TranscriptTask | undefined;
  interaction: TranscriptInteraction | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = (display?.kind === 'generic' && display.summary) || summarize(frame);
  const output = toolOutput(frame, task);
  const inputText =
    typeof frame.inputText === 'string' && frame.inputText !== '' ? frame.inputText : undefined;
  // Subagents (and other generic tools) must stay expandable while running —
  // callers need the streamed input / outputTail, not just the header badge.
  const hasBody =
    frame.input !== undefined ||
    frame.output !== undefined ||
    inputText !== undefined ||
    output !== undefined;
  return (
    <div className={TOOL_CARD}>
      <CardHeader
        expanded={expanded}
        onToggle={() => {
          if (hasBody) setExpanded((value) => !value);
        }}
        icon={<Wrench size={14} />}
        tag="generic"
        tagLabel={frame.name}
        trailing={<BadgeRow frame={frame} task={task} interaction={interaction} alwaysShowState />}
      >
        <div className="flex min-w-0 items-center gap-2">
          {summary !== undefined ? (
            <span className="min-w-0 truncate text-[10.5px] text-[var(--color-text-tertiary)]">
              {summary}
            </span>
          ) : null}
        </div>
      </CardHeader>
      {expanded ? (
        <div className="space-y-2 border-t border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] px-3.5 py-2.5">
          {frame.input !== undefined ? (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[10.5px] leading-[1.5] text-[var(--color-text-secondary)]">
              {safeJson(frame.input)}
            </pre>
          ) : inputText !== undefined ? (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[10.5px] leading-[1.5] text-[var(--color-text-secondary)]">
              {inputText}
            </pre>
          ) : null}
          {output !== undefined ? (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[10.5px] leading-[1.5] text-[var(--color-text-secondary)]">
              {output}
            </pre>
          ) : frame.output !== undefined ? (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[10.5px] leading-[1.5] text-[var(--color-text-secondary)]">
              {safeJson(frame.output)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function summarize(frame: ToolCallFrame): string | undefined {
  if (typeof frame.inputText === 'string' && frame.inputText !== '') return frame.inputText;
  if (frame.input !== undefined) {
    const text = safeJson(frame.input);
    return text !== undefined ? text.slice(0, 500) : undefined;
  }
  return undefined;
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}
