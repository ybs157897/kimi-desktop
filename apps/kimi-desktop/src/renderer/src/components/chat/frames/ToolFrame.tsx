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
import type { ToolCallFrame, TranscriptInteraction, TranscriptTask } from '@moonshot-ai/transcript';
import {
  CaretRight,
  CheckCircle,
  FileCode,
  MagnifyingGlass,
  TerminalWindow,
  Wrench,
} from '@phosphor-icons/react';
import { useState, type ReactNode } from 'react';

import {
  countChanges,
  diffBeforeAfter,
  diffLineTone,
  diffPrefix,
  type DiffLine,
} from '#/lib/diffRender';

export interface ToolFrameProps {
  readonly frame: ToolCallFrame;
  /** Execution entity behind the call (shell run / subagent), when known. */
  readonly task?: TranscriptTask;
  /** The approval/question interaction gating this call, when known. */
  readonly interaction?: TranscriptInteraction;
}

const TOOL_CARD =
  'ui-card-enter mb-1 max-w-[46rem] overflow-hidden rounded-lg border border-[var(--color-border-light)] bg-[var(--color-background-surface-under)]';
const TOOL_BODY =
  'max-h-72 overflow-auto border-t border-[var(--color-border-light)] bg-[var(--color-background-panel)] px-3 py-2 font-mono text-[11.5px] leading-[1.55] text-[var(--color-text-secondary)]';

export function ToolFrame({ frame, task, interaction }: ToolFrameProps) {
  const display = parseDisplay(frame.display);
  const key = frame.view ?? frame.name;

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

function isSearchName(key: string): boolean {
  return /search/i.test(key);
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

/** Shared expandable header — caret + icon + title row. */
function CardHeader({
  expanded,
  onToggle,
  icon,
  children,
  trailing,
}: {
  expanded: boolean;
  onToggle: () => void;
  icon: ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="ui-pressable flex min-h-8 w-full cursor-pointer select-none items-center gap-1.5 px-2.5 py-1 text-left hover:bg-[var(--color-list-hover)]"
    >
      <CaretRight
        size={11}
        weight="bold"
        className={`shrink-0 text-[var(--color-text-tertiary)] transition-transform duration-[var(--duration-hover)] ease-[var(--ease-out)] ${
          expanded ? 'rotate-90' : ''
        }`}
        aria-hidden
      />
      <span className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden>
        {icon}
      </span>
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
    <span className="relative overflow-hidden rounded-md bg-[color-mix(in_srgb,var(--orange-400)_14%,transparent)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--orange-400)]">
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
      <span className="rounded-md bg-[color-mix(in_srgb,var(--red-400)_14%,transparent)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--red-400)]">
        失败
      </span>
    );
  }
  return (
    <span className="rounded-md bg-[color-mix(in_srgb,var(--green-400)_14%,transparent)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--green-400)]">
      完成
    </span>
  );
}

function TaskBadge({ task }: { task: TranscriptTask }) {
  const tone =
    task.state === 'running'
      ? 'text-[var(--orange-400)] bg-[color-mix(in_srgb,var(--orange-400)_12%,transparent)]'
      : task.state === 'completed'
        ? 'text-[var(--green-400)] bg-[color-mix(in_srgb,var(--green-400)_12%,transparent)]'
        : task.state === 'failed' || task.state === 'timed_out' || task.state === 'lost'
          ? 'text-[var(--red-400)] bg-[color-mix(in_srgb,var(--red-400)_12%,transparent)]'
          : 'text-[var(--color-text-tertiary)] bg-[var(--color-background-button-secondary)]';
  return (
    <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${tone}`}>
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
    <span className="rounded-md bg-[var(--color-background-button-secondary)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-tertiary)]">
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
  const output = toolOutput(frame, task);
  const outcome = bashFooter(frame, output);
  return (
    <div className={TOOL_CARD}>
      <CardHeader
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
        icon={<TerminalWindow size={14} weight="duotone" />}
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
          {command}
        </code>
      </CardHeader>
      {expanded && output !== undefined ? (
        <>
          {cwd !== undefined && cwd !== '' ? (
            <div className="border-t border-[var(--color-border-light)] bg-[var(--color-background-panel)] px-3 pt-2 font-mono text-[10.5px] text-[var(--color-text-tertiary)]">
              {cwd}
            </div>
          ) : null}
          <pre className={`${TOOL_BODY} whitespace-pre-wrap ${cwd !== undefined && cwd !== '' ? 'border-t-0' : ''}`}>{output}</pre>
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
      tone: 'text-[var(--green-400)]',
      label: '完成',
      icon: <CheckCircle size={12} weight="fill" aria-hidden />,
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
      tone: 'text-[var(--red-400)]',
      label: `Exit code: ${exit[1]}`,
      icon: null,
    };
  }
  return { tone: 'text-[var(--red-400)]', label: 'Failed', icon: null };
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
        icon={<FileCode size={14} weight="duotone" />}
        trailing={
          <>
            <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px]">
              <span className="rounded-md bg-[color-mix(in_srgb,var(--green-400)_12%,transparent)] px-1.5 py-0.5 text-[var(--green-400)]">
                +{adds}
              </span>
              <span className="rounded-md bg-[color-mix(in_srgb,var(--red-400)_12%,transparent)] px-1.5 py-0.5 text-[var(--red-400)]">
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

/** A Write tool's content renders as all-added lines (new file). */
function addAllLines(content: string): DiffLine[] {
  const body = content.length > 0 && content.endsWith('\n') ? content.slice(0, -1) : content;
  return body.split('\n').map((line) => ({ type: 'add', text: line }));
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
    <div className="ui-card-enter mb-2 flex min-h-9 max-w-[46rem] items-center gap-2 rounded-lg border border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] px-3 py-1.5 text-[12px] tracking-[var(--tracking-tight)] text-[var(--color-text-secondary)]">
      <MagnifyingGlass size={14} weight="duotone" className="shrink-0 text-[var(--color-text-accent)]" aria-hidden />
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
        icon={<Wrench size={14} weight="duotone" />}
        trailing={<BadgeRow frame={frame} task={task} interaction={interaction} alwaysShowState />}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-[12px] tracking-[var(--tracking-tight)] text-[var(--color-text-foreground)]">
            {frame.name}
          </span>
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
