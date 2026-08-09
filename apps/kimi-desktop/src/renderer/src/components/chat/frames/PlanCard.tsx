/**
 * Historical ExitPlanMode renderer.
 *
 * Plan review is an interaction while it is pending, but a completed review
 * is still a normal tool frame in the transcript. Keep the two concerns
 * separate: the interaction card owns the answer buttons, while this card
 * owns the durable plan preview so replay never falls back to raw JSON.
 */

import type { ToolInputDisplay } from '@moonshot-ai/protocol';
import type { ToolCallFrame, TranscriptInteraction, TranscriptTask } from '@moonshot-ai/transcript';
import { ArrowSquareOut, CaretRight } from '@phosphor-icons/react';
import { useState } from 'react';

import type { TranscriptPlanInfo } from '#/lib/api';
import { tagClasses } from '#/lib/agentColors';
import { Markdown } from '../../markdown/Markdown';
import type { OpenPlanDoc } from '../PlanDocViewer';
import { PlanStateIcon, planStateLabel, planTitle, type PlanReviewState } from '../planShared';

export interface PlanCardProps {
  readonly frame: ToolCallFrame;
  readonly display?: ToolInputDisplay;
  readonly plan?: TranscriptPlanInfo;
  readonly task?: TranscriptTask;
  readonly interaction?: TranscriptInteraction;
  /** Open the plan in the plan-document dock tab. */
  readonly onOpenPlanDoc?: OpenPlanDoc;
}

export function PlanCard({ frame, display, plan, interaction, onOpenPlanDoc }: PlanCardProps) {
  const resolved = resolvePlan(frame, display, plan, interaction);
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<'plan' | 'raw'>('plan');
  const hasPlan = resolved.plan !== undefined && resolved.plan.trim() !== '';
  const stateLabel = planStateLabel(resolved.state);
  const title = planTitle(resolved.plan);
  const openDoc =
    hasPlan && onOpenPlanDoc !== undefined
      ? () =>
          onOpenPlanDoc({
            initialId: frame.toolCallId,
            doc: {
              id: frame.toolCallId,
              plan: resolved.plan!,
              state: resolved.state,
              path: resolved.path,
              selectedOption: resolved.selectedOption,
              feedback: resolved.feedback,
            },
          })
      : undefined;

  return (
    <section className="ui-card-enter mb-3 max-w-[46rem] border-t border-[var(--color-border-light)] pt-2">
      <div className="mb-0.5 flex items-center gap-1.5">
        <span className={`ui-tag-pill ${tagClasses('plan')}`}>计划</span>
      </div>
      <div className="-mx-1.5 flex min-h-8 w-[calc(100%+0.75rem)] items-center rounded-[var(--radius-sm)] hover:bg-[var(--color-list-hover)]">
        <button
          type="button"
          onClick={() => hasPlan && setExpanded((value) => !value)}
          aria-expanded={expanded}
          disabled={!hasPlan}
          title={resolved.path}
          className="ui-pressable flex min-w-0 flex-1 select-none items-center gap-2 rounded-[var(--radius-sm)] px-1.5 py-1 text-left enabled:cursor-pointer"
        >
          <PlanStateIcon state={resolved.state} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] font-medium text-[var(--color-text-foreground)]">
              {title}
            </div>
            {resolved.selectedOption !== undefined ? (
              <div className="truncate text-[10.5px] text-[var(--color-text-tertiary)]">
                {resolved.selectedOption}
              </div>
            ) : null}
          </div>
          <span className="shrink-0 text-[10.5px] text-[var(--color-text-tertiary)]">{stateLabel}</span>
          {hasPlan ? (
            <CaretRight
              size={10}
              weight="bold"
              className={`shrink-0 text-[var(--color-text-tertiary)] transition-transform duration-[var(--duration-hover)] ease-[var(--ease-out)] ${expanded ? 'rotate-90' : ''}`}
              aria-hidden
            />
          ) : null}
        </button>
        {openDoc !== undefined ? (
          <button
            type="button"
            title="在右侧面板查看计划"
            aria-label="在右侧面板查看计划"
            onClick={openDoc}
            className="ui-pressable mr-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-background-button-secondary)] hover:text-[var(--color-text-foreground)]"
          >
            <ArrowSquareOut size={12} weight="regular" aria-hidden />
          </button>
        ) : null}
      </div>
      {expanded && hasPlan ? (
        <div className="mt-1">
          <div role="tablist" aria-label="计划视图" className="mb-1.5 flex items-center gap-1">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'plan'}
              onClick={() => setTab('plan')}
              className={`ui-pressable rounded-[var(--radius-sm)] px-2 py-0.5 text-[11px] font-medium ${
                tab === 'plan'
                  ? tagClasses('plan')
                  : 'text-[var(--color-text-tertiary)] hover:bg-[var(--color-list-hover)]'
              }`}
            >
              计划
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'raw'}
              onClick={() => setTab('raw')}
              className={`ui-pressable rounded-[var(--radius-sm)] px-2 py-0.5 text-[11px] font-medium ${
                tab === 'raw'
                  ? tagClasses('plan')
                  : 'text-[var(--color-text-tertiary)] hover:bg-[var(--color-list-hover)]'
              }`}
            >
              原始
            </button>
          </div>
          {tab === 'plan' ? (
            <div className="ml-2 max-h-[28rem] overflow-auto border-l border-[var(--color-border-light)] py-1 pl-4 pr-2 text-[12px] leading-relaxed">
              <Markdown source={resolved.plan!} />
            </div>
          ) : (
            <pre className="ml-2 max-h-[28rem] overflow-auto whitespace-pre-wrap border-l border-[var(--color-border-light)] py-1 pl-4 pr-2 font-mono text-[11.5px] leading-[1.55] text-[var(--color-text-secondary)]">
              {resolved.plan!}
            </pre>
          )}
        </div>
      ) : null}
      {expanded && resolved.feedback !== undefined ? (
        <div className="ml-2 border-l border-[var(--color-border-light)] px-4 py-2 text-[11px] text-[var(--color-text-secondary)]">
          <span className="font-medium text-[var(--color-text-tertiary)]">反馈：</span>
          {resolved.feedback}
        </div>
      ) : null}
    </section>
  );
}

interface ResolvedPlan {
  readonly plan?: string;
  readonly path?: string;
  readonly state: PlanReviewState;
  readonly selectedOption?: string;
  readonly feedback?: string;
}

function resolvePlan(
  frame: ToolCallFrame,
  display: ToolInputDisplay | undefined,
  plan: TranscriptPlanInfo | undefined,
  interaction: TranscriptInteraction | undefined,
): ResolvedPlan {
  const fromDisplay = display?.kind === 'plan_review' ? display : undefined;
  const fromOutput = parsePlanOutput(frame.output);
  const review = plan?.review;
  const interactionState = interaction?.state;
  const state =
    interactionState === 'pending' || interactionState === 'approved' || interactionState === 'rejected' || interactionState === 'cancelled'
      ? interactionState
      : review?.state ?? (fromOutput.autoApproved ? 'auto_approved' : 'approved');
  return {
    plan: plan?.plan ?? fromDisplay?.plan ?? fromOutput.plan,
    path: plan?.path ?? fromDisplay?.path ?? fromOutput.path,
    state,
    selectedOption: review?.selectedOption,
    feedback: review?.feedback,
  };
}

function parsePlanOutput(output: unknown): { plan?: string; path?: string; autoApproved: boolean } {
  if (typeof output !== 'string') return { autoApproved: false };
  const pathMatch = /^Plan saved to: (.+)$/m.exec(output);
  const path = pathMatch?.[1]?.trim() || undefined;
  const markers = [
    { marker: '## Approved Plan:\n', autoApproved: false },
    { marker: '## Plan (auto-approved, not user-reviewed):\n', autoApproved: true },
  ];
  for (const { marker, autoApproved } of markers) {
    const index = output.indexOf(marker);
    if (index !== -1) {
      const plan = output.slice(index + marker.length).trim();
      if (plan !== '') return { plan, path, autoApproved };
    }
  }
  return { path, autoApproved: false };
}
