import {
  approvalResponseSchema,
  ToolInputDisplaySchema,
  type ApprovalDecision,
  type ApprovalScope,
  type ToolInputDisplay,
} from '@moonshot-ai/protocol';
import type { TranscriptInteraction } from '@moonshot-ai/transcript';
import { useState, type ReactNode } from 'react';

import { detectDangerousCommand } from '#/lib/dangerousCommand';
import { diffBeforeAfter, type DiffLine } from '#/lib/diffRender';
import { approvalInteractionPresentation } from '#/lib/approvalInteraction';
import { MarkdownCodeBlock } from '../../markdown/MarkdownCodeBlock';
import { DiffLines, FullscreenPreview } from './FullscreenPreview';
import { PlanReviewCard, type PlanReviewDisplay } from './PlanReviewCard';

export interface ApprovalCardProps {
  /** The pending approval interaction; `request` is the engine ApprovalRequest payload. */
  readonly interaction: TranscriptInteraction;
  /** Answer the approval. `scope: 'session'` remembers the rule; the optional
   *  `feedback` / `selectedLabel` carry plan-review answers. */
  readonly onResolve: (
    decision: ApprovalDecision,
    options?: ApprovalResolveOptions,
  ) => void | Promise<void>;
  readonly busy?: boolean;
}

/** Extra resolve fields beyond the decision (plan review's revision note and
 *  the chosen option label; `scope` remembers the rule for the session). */
export interface ApprovalResolveOptions {
  readonly scope?: ApprovalScope;
  readonly feedback?: string;
  readonly selectedLabel?: string;
}

export interface ApprovalResolveHandler {
  (interaction: TranscriptInteraction, decision: ApprovalDecision, options?: ApprovalResolveOptions):
    | void
    | Promise<void>;
}

/** The fullscreen preview state (M7): a before/after diff or a code file. */
type PreviewState =
  | { readonly kind: 'diff'; readonly title: string; readonly lines: readonly DiffLine[] }
  | { readonly kind: 'code'; readonly title: string; readonly content: string; readonly language?: string };

/** Permission request card (Codex `permission-request`): rounded large card
 *  with the action, detail, and Allow once (Enter) / Always allow / Deny (Esc)
 *  buttons. A `plan_review` display hands off to {@link PlanReviewCard}.
 *  Shimmers while an answer is in flight; renders the settled result once the
 *  interaction is no longer pending. Shell commands get dangerous-pattern
 *  highlighting and diff/file displays open a fullscreen preview. */
export function ApprovalCard({ interaction, onResolve, busy = false }: ApprovalCardProps) {
  const [inFlight, setInFlight] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const request = approvalInteractionPresentation(interaction);
  const response = approvalResponseSchema.safeParse(interaction.response);
  const pending = interaction.state === 'pending';
  const isBusy = busy || inFlight;
  const run = (fn: () => void | Promise<void>): void => {
    if (isBusy) return;
    setInFlight(true);
    void Promise.resolve()
      .then(fn)
      .finally(() => setInFlight(false));
  };

  if (!pending) {
    return (
      <div className="mb-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-background-surface-under)] px-4 py-3">
        <div className="flex items-center gap-2 text-[12px] text-[var(--color-text-foreground)]">
          <span className={RESOLVED_TONE[interaction.state]}>
            {resolvedLabel(interaction.state)}
          </span>
          <span className="opacity-70">{request.action}</span>
        </div>
        {response.success && response.data.feedback !== undefined ? (
          <div className="mt-1 text-[11px] opacity-60">{response.data.feedback}</div>
        ) : null}
      </div>
    );
  }

  const planReview = parsePlanReview(request.display);
  if (planReview !== undefined) {
    return (
      <PlanReviewCard
        plan={planReview.plan}
        path={planReview.path}
        options={planReview.options}
        busy={isBusy}
        onResolve={(decision, options) => run(() => onResolve(decision, options))}
      />
    );
  }

  const display = ToolInputDisplaySchema.safeParse(request.display);
  const detail = renderDetail(
    {
      tool_name: request.toolName,
      tool_call_id: request.toolCallId,
      tool_input_display: request.display,
    },
    display.success ? display.data : undefined,
    setPreview,
  );
  return (
    <div
      className={`rounded-2xl border border-[var(--color-border-heavy)] bg-[var(--color-background-surface)] px-3 py-2.5 ${
        isBusy ? 'opacity-70' : ''
      }`}
      onKeyDown={(event) => {
        if (isBusy) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          run(() => onResolve('rejected'));
        }
        // Enter is handled natively by the auto-focused primary button; the
        // card-level listener only catches Escape.
      }}
    >
      <div className="text-[13px] font-medium leading-snug text-[var(--color-text-foreground)]">
        {request.action}
      </div>
      {detail}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          autoFocus
          disabled={isBusy}
          onClick={() => run(() => onResolve('approved'))}
          className="cursor-pointer rounded-md bg-[var(--gray-1000)] px-3 py-1 text-[12px] font-medium text-[var(--color-text-foreground)] hover:bg-[var(--gray-900)] disabled:cursor-default disabled:opacity-50"
        >
          仅允许本次
        </button>
        <button
          type="button"
          disabled={isBusy}
          onClick={() => run(() => onResolve('approved', { scope: 'session' }))}
          className="cursor-pointer rounded-md border border-[var(--color-border-heavy)] px-3 py-1 text-[12px] text-[var(--color-text-foreground)] hover:bg-[var(--color-list-hover)] disabled:cursor-default disabled:opacity-50"
        >
          本会话始终允许
        </button>
        <button
          type="button"
          disabled={isBusy}
          onClick={() => run(() => onResolve('rejected'))}
          className="cursor-pointer rounded-md border border-[var(--color-border)] px-3 py-1 text-[12px] text-[var(--color-text-foreground)] opacity-70 hover:bg-[var(--color-list-hover)] disabled:cursor-default disabled:opacity-50"
        >
          拒绝
        </button>
      </div>
      <div className="mt-2 text-[10px] text-[var(--color-text-foreground)] opacity-40">
        Enter 允许 · Esc 拒绝
      </div>
      {preview !== null ? (
        <FullscreenPreview title={preview.title} onClose={() => setPreview(null)}>
          {preview.kind === 'diff' ? (
            <DiffLines lines={preview.lines} />
          ) : (
            <MarkdownCodeBlock code={preview.content} language={preview.language} />
          )}
        </FullscreenPreview>
      ) : null}
    </div>
  );
}

/** A `plan_review` ToolInputDisplay carries the plan text plus optional path /
 *  Accept-Revise options. Returns undefined when the display is not a plan
 *  review (a normal approval stays a normal card). */
function parsePlanReview(display: unknown): PlanReviewDisplay | undefined {
  if (display === null || typeof display !== 'object' || Array.isArray(display)) return undefined;
  const value = display as Record<string, unknown>;
  if (value['kind'] !== 'plan_review') return undefined;
  if (typeof value['plan'] !== 'string') return undefined;
  const options =
    Array.isArray(value['options']) && value['options'].every(isPlanOptionEntry)
      ? (value['options'] as { label: string; description?: string }[])
      : undefined;
  return {
    plan: value['plan'],
    path: typeof value['path'] === 'string' ? value['path'] : undefined,
    options,
  };
}

function isPlanOptionEntry(value: unknown): value is { label: string; description?: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry['label'] === 'string';
}

const RESOLVED_TONE: Record<string, string> = {
  approved: 'text-[var(--green-400)]',
  rejected: 'text-[var(--red-400)]',
  cancelled: 'opacity-50',
};

function resolvedLabel(state: string): string {
  switch (state) {
    case 'approved':
      return '已允许';
    case 'rejected':
      return '已拒绝';
    case 'cancelled':
      return '已取消';
    default:
      return state;
  }
}

const previewButtonClass =
  'cursor-pointer rounded-md border border-[var(--color-border-heavy)] px-2 py-0.5 text-[11px] text-[var(--color-text-foreground)] hover:bg-[var(--color-list-hover)]';

/** The tool identity line (tool_name + tool_call_id) shared by all details. */
function toolHeader(request: { tool_name: string; tool_call_id: string }): ReactNode {
  return (
    <div className="text-[11px] text-[var(--color-text-foreground)] opacity-60">
      <span className="font-mono">{request.tool_name}</span>
      {request.tool_call_id !== undefined ? (
        <span className="ml-2 font-mono opacity-50">{request.tool_call_id}</span>
      ) : null}
    </div>
  );
}

/** Renders the approval payload. Shell commands (`kind: 'command'`) get the
 *  `$` prefix plus a red banner when a dangerous pattern matches; diff and
 *  file displays offer a fullscreen preview. Anything else falls back to a
 *  truncated JSON summary. */
function renderDetail(
  request: { tool_name: string; tool_call_id: string; tool_input_display: unknown },
  display: ToolInputDisplay | undefined,
  openPreview: (preview: PreviewState) => void,
): ReactNode {
  const header = toolHeader(request);

  if (display !== undefined) {
    switch (display.kind) {
      case 'command': {
        const danger = detectDangerousCommand(display.command);
        return (
          <div className="mt-1 space-y-1">
            {header}
            {danger !== undefined ? (
              <div className="flex items-center gap-1.5 rounded-md border border-[var(--color-border-error)] px-2 py-1 text-[11px] text-[var(--color-text-danger)]">
                <span aria-hidden>⚠</span>
                <span>危险命令：{danger}</span>
              </div>
            ) : null}
            <pre className="overflow-auto whitespace-pre-wrap rounded-md bg-[var(--color-background-surface-under)] px-2 py-1.5 text-[11px] leading-relaxed text-[var(--color-text-foreground)]">
              <span className="select-none text-[var(--color-text-tertiary)]">$ </span>
              {display.command}
            </pre>
            {display.cwd !== undefined ? (
              <div className="text-[10px] text-[var(--color-text-tertiary)]">{display.cwd}</div>
            ) : null}
          </div>
        );
      }
      case 'diff': {
        const lines = diffBeforeAfter(display.before, display.after);
        return (
          <div className="mt-1 space-y-1">
            {header}
            <div className="flex items-center gap-2">
              <span className="truncate font-mono text-[11px] text-[var(--color-text-foreground)] opacity-60">
                {display.path}
              </span>
              <button
                type="button"
                onClick={() => openPreview({ kind: 'diff', title: display.path, lines })}
                className={previewButtonClass}
              >
                查看差异
              </button>
            </div>
          </div>
        );
      }
      case 'file_io': {
        if (
          display.operation === 'edit' &&
          display.before !== undefined &&
          display.after !== undefined
        ) {
          const lines = diffBeforeAfter(display.before, display.after);
          return (
            <div className="mt-1 space-y-1">
              {header}
              <div className="flex items-center gap-2">
                <span className="truncate font-mono text-[11px] text-[var(--color-text-foreground)] opacity-60">
                  {display.path}
                </span>
                <button
                  type="button"
                  onClick={() => openPreview({ kind: 'diff', title: display.path, lines })}
                  className={previewButtonClass}
                >
                  查看差异
                </button>
              </div>
            </div>
          );
        }
        if (display.operation === 'write' && display.content !== undefined) {
          return (
            <div className="mt-1 space-y-1">
              {header}
              <div className="flex items-center gap-2">
                <span className="truncate font-mono text-[11px] text-[var(--color-text-foreground)] opacity-60">
                  {display.path}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    openPreview({
                      kind: 'code',
                      title: display.path,
                      content: display.content ?? '',
                      language: languageFromPath(display.path),
                    })
                  }
                  className={previewButtonClass}
                >
                  查看内容
                </button>
              </div>
            </div>
          );
        }
        break;
      }
      default:
        break;
    }
  }

  // Fallback: the raw display as a truncated summary.
  const input = request.tool_input_display;
  let summary: string | undefined;
  if (typeof input === 'string' && input !== '') {
    summary = input;
  } else if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    summary = safeJson(input);
  }
  return (
    <div className="mt-1 space-y-0.5">
      {header}
      {summary !== undefined ? (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-[var(--color-text-foreground)] opacity-70">
          {summary}
        </pre>
      ) : null}
    </div>
  );
}

/** Highlight.js language id from a file path extension (mirrors the file
 *  tree panel's guess; unknown extensions degrade to plain text). */
function languageFromPath(path: string): string | undefined {
  const ext = path.split('.').at(-1) ?? '';
  return ext === '' ? undefined : ext.toLowerCase();
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}
