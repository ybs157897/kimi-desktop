/**
 * PlanReviewCard — the proposed-plan approval card (Codex `proposed-plan`).
 *
 * A `plan_review` display is an ordinary approval interaction whose
 * `tool_input_display.kind === 'plan_review'`; the user answers it through the
 * standard approval resolve endpoint with `selected_label` (the chosen option)
 * and `feedback` (a revision note). The card stays collapsed to a title row
 * plus the always-visible answer buttons; the plan body (markdown pipeline)
 * expands on demand from the title row.
 */

import type { ApprovalDecision } from '@moonshot-ai/protocol';
import { ArrowSquareOut, CaretRight, ClipboardText } from '@phosphor-icons/react';
import { useState } from 'react';

import { tagClasses } from '#/lib/agentColors';
import { Markdown } from '../../markdown/Markdown';
import { planTitle } from '../planShared';
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
  /** Open this plan in the plan-document dock tab. */
  readonly onOpenDoc?: () => void;
}

const REJECT_LABEL = 'Reject and Exit';
const REVISE_LABEL = 'Revise';

export function PlanReviewCard({ plan, path, options, busy = false, onResolve, onOpenDoc }: PlanReviewCardProps) {
  const [feedback, setFeedback] = useState('');
  const [selected, setSelected] = useState<string | undefined>(undefined);
  // The plan body stays collapsed by default (zcode elicitation pattern): the
  // title row + answer buttons are always visible, the full markdown only
  // expands on demand so the card never fills the viewport.
  const [expanded, setExpanded] = useState(false);
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
      className={`rounded-[var(--radius-lg)] border border-[var(--color-border-heavy)] bg-[var(--color-background-surface)] px-3.5 py-3 shadow-[var(--shadow-md)] ${
        busy ? 'opacity-70' : ''
      }`}
      onKeyDown={(event) => {
        if (busy) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          reject();
        }
      }}
    >
      <div className="-mx-1 flex w-[calc(100%+0.5rem)] items-center rounded-[var(--radius-sm)] hover:bg-[var(--color-list-hover)]">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          title={path}
          className="ui-pressable flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-sm)] px-1 py-1 text-left"
        >
          <CaretRight
            size={10}
            weight="bold"
            className={`shrink-0 text-[var(--color-text-tertiary)] transition-transform duration-[var(--duration-hover)] ease-[var(--ease-out)] ${expanded ? 'rotate-90' : ''}`}
            aria-hidden
          />
          <ClipboardText size={16} weight="regular" className="shrink-0 text-[var(--color-text-secondary)]" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--color-text-foreground)]">
            {planTitle(plan)}
          </span>
          {path !== undefined && path !== '' ? (
            <span className="max-w-[12rem] shrink-0 truncate font-mono text-[10px] text-[var(--color-text-tertiary)] opacity-50">
              {path}
            </span>
          ) : null}
          <span className={`ui-tag-pill shrink-0 ${tagClasses('plan')}`}>待审批</span>
        </button>
        {onOpenDoc !== undefined ? (
          <button
            type="button"
            title="在右侧面板查看计划"
            aria-label="在右侧面板查看计划"
            onClick={onOpenDoc}
            className="ui-pressable mr-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-background-button-secondary)] hover:text-[var(--color-text-foreground)]"
          >
            <ArrowSquareOut size={12} weight="regular" aria-hidden />
          </button>
        ) : null}
      </div>
      {expanded ? (
        <div className="mt-1 max-h-[32vh] overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] px-3 py-2">
          <Markdown source={plan} />
        </div>
      ) : null}

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
              className={`ui-pressable block w-full cursor-pointer rounded-[var(--radius-sm)] border px-3 py-1.5 text-left text-[12px] transition-colors disabled:cursor-default disabled:opacity-50 ${
                selected === option.label
                  ? 'border-[var(--color-border-focus)] bg-[var(--color-accent-background)] text-[var(--color-text-foreground)]'
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
          className="w-full resize-none rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-background-surface)] px-2 py-1 text-[12px] text-[var(--color-text-foreground)] outline-none placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-border-focus)] disabled:opacity-50"
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          autoFocus
          disabled={busy}
          onClick={accept}
          className="ui-pressable cursor-pointer rounded-[var(--radius-sm)] bg-[var(--color-button-primary-background)] px-3 py-1 text-[12px] font-medium text-[var(--color-button-primary-foreground)] hover:opacity-90 disabled:cursor-default disabled:opacity-50"
        >
          Accept
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={revise}
          title="带着上方修订意见继续（rejected + Revise）"
          className="ui-pressable cursor-pointer rounded-[var(--radius-sm)] border border-[var(--color-border-heavy)] px-3 py-1 text-[12px] text-[var(--color-text-foreground)] hover:bg-[var(--color-list-hover)] disabled:cursor-default disabled:opacity-50"
        >
          Revise
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={reject}
          className="ui-pressable cursor-pointer rounded-[var(--radius-sm)] border border-[var(--color-border)] px-3 py-1 text-[12px] text-[var(--color-text-foreground)] opacity-70 hover:bg-[var(--color-list-hover)] disabled:cursor-default disabled:opacity-50"
        >
          Reject
        </button>
      </div>
      <div className="ui-label mt-2 opacity-70">
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
