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

/** Expandable card header (a button toggling the body). */
function CardHeader({
  expanded,
  onToggle,
  children,
}: {
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full cursor-pointer select-none items-start gap-2 px-3 py-2 text-left"
    >
      <span
        className={`mt-0.5 text-[10px] leading-4 text-[var(--color-text-foreground)] opacity-40 transition-transform ${
          expanded ? 'rotate-90' : ''
        }`}
      >
        ▸
      </span>
      {children}
    </button>
  );
}

// ------------------------------------------------------------------ status bits

function StateBadge({ frame }: { frame: ToolCallFrame }) {
  if (frame.state === 'running') {
    return <span className="animate-pulse text-[10px] text-[var(--orange-400)]">运行中</span>;
  }
  if (frame.state === 'error') {
    return <span className="text-[10px] text-[var(--red-400)]">失败</span>;
  }
  return <span className="text-[10px] text-[var(--green-400)]">完成</span>;
}

function TaskBadge({ task }: { task: TranscriptTask }) {
  const tone =
    task.state === 'running'
      ? 'text-[var(--orange-400)]'
      : task.state === 'completed'
        ? 'text-[var(--green-400)]'
        : task.state === 'failed' || task.state === 'timed_out' || task.state === 'lost'
          ? 'text-[var(--red-400)]'
          : 'text-[var(--color-text-foreground)] opacity-60';
  return (
    <span className={`text-[10px] ${tone}`}>
      {task.kind}
      {task.detached ? ' (后台)' : ''} · {task.state}
    </span>
  );
}

function InteractionBadge({ interaction }: { interaction: TranscriptInteraction }) {
  if (interaction.state === 'pending') {
    return (
      <span className="animate-pulse text-[10px] text-[var(--orange-400)]">
        {interaction.interactionKind === 'approval' ? '待审批' : '待回答'}
      </span>
    );
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
    <span className="text-[10px] text-[var(--color-text-foreground)] opacity-50">{label}</span>
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
  const [expanded, setExpanded] = useState(frame.state === 'running');
  const input = isRecord(frame.input) ? frame.input : undefined;
  const command =
    (display?.kind === 'command' && display.command) ||
    stringField(input ?? {}, 'command') ||
    frame.inputText ||
    '';
  const cwd = (display?.kind === 'command' && display.cwd) || stringField(input ?? {}, 'cwd');
  const output = toolOutput(frame, task);
  const footer = bashFooter(frame, output);
  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-background-surface-under)]">
      <CardHeader expanded={expanded} onToggle={() => setExpanded((value) => !value)}>
        <div className="min-w-0 flex-1">
          <code className="block truncate font-mono text-[12px] leading-5 text-[var(--color-text-foreground)]">
            {command}
          </code>
          {cwd !== undefined && cwd !== '' ? (
            <div className="truncate font-mono text-[10px] text-[var(--color-text-foreground)] opacity-45">
              {cwd}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {interaction !== undefined ? <InteractionBadge interaction={interaction} /> : null}
          {task !== undefined ? <TaskBadge task={task} /> : null}
          {frame.state === 'running' ? <StateBadge frame={frame} /> : null}
        </div>
      </CardHeader>
      {expanded && output !== undefined ? (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-[var(--color-border-light)] px-3 py-2 font-mono text-[11px] leading-5 text-[var(--color-text-foreground)] opacity-80">
          {output}
        </pre>
      ) : null}
      {footer !== undefined ? (
        <div
          className={`flex items-center gap-1.5 border-t border-[var(--color-border-light)] px-3 py-1.5 text-[10px] ${footer.tone}`}
        >
          {footer.label}
        </div>
      ) : null}
    </div>
  );
}

function bashFooter(
  frame: ToolCallFrame,
  output: string | undefined,
): { tone: string; label: string } | undefined {
  // While running the header badge carries the state; the footer only
  // reports the settled outcome.
  if (frame.state === 'running') return undefined;
  if (frame.state === 'done') {
    return { tone: 'text-[var(--green-400)]', label: '✓ 完成' };
  }
  const text = output ?? frame.error ?? '';
  if (/interrupted|aborted/i.test(text)) {
    return { tone: 'text-[var(--color-text-foreground)] opacity-70', label: 'Stopped' };
  }
  const exit = /exit code[:\s]+(\d+)/i.exec(text);
  if (exit !== null) {
    return { tone: 'text-[var(--red-400)]', label: `Exit code: ${exit[1]}` };
  }
  return { tone: 'text-[var(--red-400)]', label: 'Failed' };
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
  const [expanded, setExpanded] = useState(true);
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
    <div className="mb-2 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-background-surface-under)]">
      <CardHeader expanded={expanded} onToggle={() => setExpanded((value) => !value)}>
        <span className="truncate font-mono text-[11px] text-[var(--color-text-foreground)]">
          {path !== undefined && path !== '' ? path : frame.name}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[10px]">
          <span className="text-[var(--green-400)]">+{adds}</span>
          <span className="text-[var(--red-400)]">−{dels}</span>
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {interaction !== undefined ? <InteractionBadge interaction={interaction} /> : null}
          {task !== undefined ? <TaskBadge task={task} /> : null}
          {frame.state === 'running' ? <StateBadge frame={frame} /> : null}
        </div>
      </CardHeader>
      {expanded && lines.length > 0 ? (
        <pre className="max-h-72 overflow-auto border-t border-[var(--color-border-light)] py-1 font-mono text-[11px] leading-5">
          {lines.map((line, index) => (
            <div key={index} className={`px-3 ${diffLineTone(line.type)}`}>
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
    <div className="mb-2 flex items-center gap-2 px-0.5 py-1 text-[12px] text-[var(--color-text-foreground)] opacity-80">
      <span className="text-[var(--blue-300)]">🔍</span>
      <span className="truncate">
        {running ? '正在搜索' : '已搜索'}：{query ?? frame.name}
      </span>
      {running ? (
        <span className="animate-pulse text-[10px] text-[var(--orange-400)]">…</span>
      ) : null}
      {interaction !== undefined ? <InteractionBadge interaction={interaction} /> : null}
      {task !== undefined ? <TaskBadge task={task} /> : null}
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
  const hasBody = frame.input !== undefined || frame.output !== undefined;
  return (
    <div className="mb-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-background-surface-under)] px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[12px] text-[var(--color-text-foreground)]">
          {frame.name}
        </span>
        <StateBadge frame={frame} />
        {interaction !== undefined ? <InteractionBadge interaction={interaction} /> : null}
        {task !== undefined ? <TaskBadge task={task} /> : null}
      </div>
      {summary !== undefined ? (
        <div className="mt-1 text-[11px] leading-relaxed text-[var(--color-text-foreground)] opacity-70">
          {summary}
        </div>
      ) : null}
      {hasBody && frame.state !== 'running' ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 cursor-pointer text-[10px] text-[var(--color-text-foreground)] opacity-50 hover:opacity-80"
        >
          {expanded ? '收起详情' : '查看详情'}
        </button>
      ) : null}
      {expanded ? (
        <div className="mt-1 border-t border-[var(--color-border-light)] pt-1">
          {frame.input !== undefined ? (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-4 text-[var(--color-text-foreground)] opacity-70">
              {safeJson(frame.input)}
            </pre>
          ) : null}
          {frame.output !== undefined ? (
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-4 text-[var(--color-text-foreground)] opacity-70">
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
