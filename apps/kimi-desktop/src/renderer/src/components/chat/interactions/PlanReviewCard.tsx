/**
 * PlanReviewCard — the proposed-plan approval card (Codex `proposed-plan`).
 *
 * A `plan_review` display is an ordinary approval interaction whose
 * `tool_input_display.kind === 'plan_review'`; the user answers it through the
 * standard approval resolve endpoint with `selected_label` (the chosen option)
 * and `feedback` (a revision note). The card renders the plan body through the
 * markdown pipeline, lists the advertised options, and offers a free-text
 * "Revise" path.
 */

import type { ApprovalDecision } from '@moonshot-ai/protocol';
import { useState } from 'react';

import { Markdown } from '../../markdown/Markdown';
import type { ApprovalResolveOptions } from './ApprovalCard';

export interface PlanReviewDisplay {
  readonly plan: string;
  readonly path?: string;
  readonly options?: readonly { readonly label: string; readonly description?: string }[];
}

export interface PlanReviewCardProps {
  readonly plan: string;
  readonly path?: string;
  readonly options?: readonly { readonly label: string; readonly description?: string }[];
  readonly busy?: boolean;
  readonly onResolve: (decision: ApprovalDecision, options?: ApprovalResolveOptions) => void | Promise<void>;
}

const REJECT_LABEL = 'Reject and Exit';
const REVISE_LABEL = 'Revise';

export function PlanReviewCard({ plan, path, options, busy = false, onResolve }: PlanReviewCardProps) {
  const [feedback, setFeedback] = useState('');
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const advertised = options ?? [];

  // The Accept option is always the primary action (approved); a custom
  // option list may carry "Revise" / "Reject and Exit" labels that map onto
  // rejected decisions with the label echoed back as `selected_label`.
  const accept = (): void => {
    if (busy) return;
    onResolve('approved', { selectedLabel: firstAcceptLabel(advertised) });
  };
  const revise = (): void => {
    if (busy) return;
    onResolve('rejected', { selectedLabel: REVISE_LABEL, feedback: feedback.trim() || undefined });
  };
  const reject = (): void => {
    if (busy) return;
    onResolve('rejected', { selectedLabel: REJECT_LABEL });
  };
  const pickOption = (label: string): void => {
    if (busy) return;
    const normalized = label.toLowerCase();
    if (normalized === REJECT_LABEL.toLowerCase()) {
      reject();
      return;
    }
    if (normalized === REVISE_LABEL.toLowerCase()) {
      revise();
      return;
    }
    // Accept-style labels resolve approved and echo the choice.
    onResolve('approved', { selectedLabel: label });
  };

  return (
    <div
      className={`mb-2 rounded-xl border border-[var(--color-border-heavy)] bg-[var(--color-background-surface-under)] px-4 py-3 ${
        busy ? 'animate-pulse' : ''
      }`}
      onKeyDown={(event) => {
        if (busy) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          reject();
        }
      }}
    >
      <div className="mb-1 flex items-center gap-2 text-[12px] font-medium text-[var(--color-text-foreground)]">
        <span>📋 计划评审</span>
        {path !== undefined && path !== '' ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] opacity-50" title={path}>
            {path}
          </span>
        ) : null}
      </div>
      <div className="max-h-[40vh] overflow-y-auto rounded-lg border border-[var(--color-border-light)] bg-[var(--color-background-surface)] px-3 py-2">
        <Markdown source={plan} />
      </div>

      {advertised.length > 0 ? (
        <div className="mt-3 space-y-1">
          {advertised.map((option) => (
            <button
              key={option.label}
              type="button"
              disabled={busy}
              title={option.description}
              onClick={() => pickOption(option.label)}
              onMouseEnter={() => setSelected(option.label)}
              className={`block w-full cursor-pointer rounded-md border px-3 py-1.5 text-left text-[12px] transition-colors disabled:cursor-default disabled:opacity-50 ${
                selected === option.label
                  ? 'border-[var(--color-border-heavy)] bg-[var(--color-list-hover)] text-[var(--color-text-foreground)]'
                  : 'border-[var(--color-border-light)] text-[var(--color-text-foreground)] opacity-80 hover:bg-[var(--color-list-hover)]'
              }`}
            >
              <span className="font-medium">{option.label}</span>
              {option.description !== undefined && option.description !== '' ? (
                <span className="ml-2 text-[11px] opacity-60">{option.description}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      <div className="mt-3">
        <textarea
          value={feedback}
          disabled={busy}
          onChange={(event) => setFeedback(event.target.value)}
          placeholder="修订意见（可选，Revise 时一并发回）"
          rows={2}
          spellCheck={false}
          className="w-full resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-background-surface)] px-2 py-1 text-[12px] text-[var(--color-text-foreground)] outline-none placeholder:text-[var(--gray-600)] focus:border-[var(--color-border-heavy)] disabled:opacity-50"
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          autoFocus
          disabled={busy}
          onClick={accept}
          className="cursor-pointer rounded-md bg-[var(--gray-1000)] px-3 py-1 text-[12px] font-medium text-[var(--color-text-foreground)] hover:bg-[var(--gray-900)] disabled:cursor-default disabled:opacity-50"
        >
          Accept
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={revise}
          title="带着上方修订意见继续（rejected + Revise）"
          className="cursor-pointer rounded-md border border-[var(--color-border-heavy)] px-3 py-1 text-[12px] text-[var(--color-text-foreground)] hover:bg-[var(--color-list-hover)] disabled:cursor-default disabled:opacity-50"
        >
          Revise
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={reject}
          className="cursor-pointer rounded-md border border-[var(--color-border)] px-3 py-1 text-[12px] text-[var(--color-text-foreground)] opacity-70 hover:bg-[var(--color-list-hover)] disabled:cursor-default disabled:opacity-50"
        >
          Reject
        </button>
      </div>
      <div className="mt-2 text-[10px] text-[var(--color-text-foreground)] opacity-40">
        Enter 接受 · Esc 拒绝并退出计划模式
      </div>
    </div>
  );
}

/** The advertised "accept" label, if any; undefined lets the server pick its
 *  default for an approval without a selected label. */
function firstAcceptLabel(
  options: readonly { readonly label: string }[],
): string | undefined {
  const accept = options.find(
    (option) =>
      option.label.toLowerCase() !== REVISE_LABEL.toLowerCase() &&
      option.label.toLowerCase() !== REJECT_LABEL.toLowerCase(),
  );
  return accept?.label;
}
