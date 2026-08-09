/**
 * PlanDocView — one plan rendered as a full document inside the right dock.
 * Every plan opens as its own closable PanelHost tab (zcode document-tab
 * parity), so this view holds exactly one document: state/path meta on top,
 * the full markdown below, review feedback at the end. Entry points
 * (PlanPanel rows, timeline PlanCard, the pending review card) raise a
 * {@link PlanDocRequest} to the app shell, which owns the tabs.
 */

import type { TranscriptPlanInfo } from '#/lib/api';
import { tagClasses } from '#/lib/agentColors';
import { Markdown } from '../markdown/Markdown';
import { planStateLabel, type PlanReviewState } from './planShared';

export interface PlanDoc {
  readonly id: string;
  readonly plan: string;
  readonly state: PlanReviewState;
  readonly path?: string;
  readonly selectedOption?: string;
  readonly feedback?: string;
}

/** Ask the app shell to open a plan-document tab. `doc` is a frame-local
 *  fallback for plans missing from the transcript projection. */
export interface PlanDocRequest {
  readonly initialId?: string;
  readonly doc?: PlanDoc;
}

export type OpenPlanDoc = (request: PlanDocRequest) => void;

export function planDocFromInfo(info: TranscriptPlanInfo): PlanDoc {
  return {
    id: info.toolCallId,
    plan: info.plan,
    state: info.review?.state ?? 'approved',
    path: info.path,
    selectedOption: info.review?.selectedOption,
    feedback: info.review?.feedback,
  };
}

export function PlanDocView({ doc }: { readonly doc: PlanDoc }) {
  return (
    <div className="selectable min-h-0 flex-1 overflow-y-auto">
      <article className="mx-auto w-full max-w-[46rem] px-5 py-4">
        <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-[var(--color-border-light)] pb-2.5">
          {doc.state === 'pending' ? (
            <span className={`ui-tag-pill ${tagClasses('plan')}`}>{planStateLabel(doc.state)}</span>
          ) : (
            <span className="text-[11px] text-[var(--color-text-tertiary)]">
              {planStateLabel(doc.state)}
            </span>
          )}
          {doc.selectedOption !== undefined ? (
            <span className="text-[11px] text-[var(--color-text-tertiary)]">{doc.selectedOption}</span>
          ) : null}
          {doc.path !== undefined ? (
            <span className="min-w-0 truncate font-mono text-[10.5px] text-[var(--color-text-tertiary)]" title={doc.path}>
              {doc.path}
            </span>
          ) : null}
        </div>
        <div className="text-[13px] leading-[var(--leading-chat)]">
          <Markdown source={doc.plan} />
        </div>
        {doc.feedback !== undefined ? (
          <div className="mt-5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-background-panel)] px-3.5 py-2.5 text-[12px] text-[var(--color-text-secondary)]">
            <span className="font-medium text-[var(--color-text-tertiary)]">反馈：</span>
            {doc.feedback}
          </div>
        ) : null}
      </article>
    </div>
  );
}
