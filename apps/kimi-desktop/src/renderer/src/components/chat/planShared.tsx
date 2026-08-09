/**
 * Shared plan-display helpers — the review-state icon, the state label, and
 * the title derivation (first non-empty markdown line, heading/bullet markers
 * stripped). Used by the timeline `PlanCard`, the pending `PlanReviewCard`,
 * and the right-dock `PlanPanel` so all three stay visually consistent.
 */

import { CheckCircle, Circle, XCircle } from '@phosphor-icons/react';

/** Lifecycle of an ExitPlanMode plan review (`auto_approved` never asked). */
export type PlanReviewState = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'auto_approved';

export function PlanStateIcon({ state }: { readonly state: PlanReviewState }) {
  if (state === 'rejected' || state === 'cancelled') {
    return <XCircle size={14} className="shrink-0 text-[var(--color-text-danger)]" aria-hidden />;
  }
  if (state === 'pending') {
    return <Circle size={14} className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden />;
  }
  return <CheckCircle size={14} className="shrink-0 text-[var(--color-text-success)]" aria-hidden />;
}

export function planTitle(plan: string | undefined): string {
  if (plan === undefined) return '计划详情';
  const firstLine = plan
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  if (firstLine === undefined) return '计划详情';
  return firstLine.replace(/^#{1,6}\s+/, '').replace(/^[-*]\s+/, '');
}

export function planStateLabel(state: PlanReviewState): string {
  switch (state) {
    case 'pending':
      return '待审批';
    case 'approved':
      return '已批准';
    case 'auto_approved':
      return '自动批准';
    case 'rejected':
      return '已拒绝';
    case 'cancelled':
      return '已取消';
  }
}
