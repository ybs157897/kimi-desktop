import type { QuestionResponse } from '@moonshot-ai/protocol';
import type { TranscriptInteraction } from '@moonshot-ai/transcript';
import { CheckCircle, CheckSquare, Circle, Square } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

import {
  buildQuestionResponse,
  buildSkippedQuestionResponse,
  isRecommendedOption,
  questionInteractionPresentation,
} from '#/lib/questionInteraction';

export interface QuestionCardProps {
  /** The pending question interaction; `request` is the engine QuestionRequest payload. */
  readonly interaction: TranscriptInteraction;
  /** Answer the question (see `QuestionResponse`: single/multi/other/skipped answers). */
  readonly onAnswer: (response: QuestionResponse) => void | Promise<void>;
  /** Dismiss the question (`:dismiss` — the agent continues without an answer). */
  readonly onDismiss: () => void | Promise<void>;
  readonly busy?: boolean;
}

/** AskUserQuestion card: option list (single / multi select), free-text
 *  "other" input, skip-all and dismiss actions. Shimmers while an answer is
 *  in flight; renders the settled result once no longer pending.
 *
 *  The interaction's `request` may arrive in the in-process camelCase shape
 *  (the transcript default) or the wire snake_case shape; both are normalized
 *  via `questionInteractionPresentation`, which also synthesizes the wire
 *  ids (`q_<idx>` / `opt_<q>_<o>`) the answer endpoint reverses server-side. */
export function QuestionCard({ interaction, onAnswer, onDismiss, busy = false }: QuestionCardProps) {
  const presentation = useMemo(
    () => questionInteractionPresentation(interaction),
    [interaction],
  );
  const [inFlight, setInFlight] = useState(false);
  const [selected, setSelected] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [others, setOthers] = useState<Readonly<Record<string, string>>>({});
  const pending = interaction.state === 'pending';
  const isBusy = busy || inFlight;

  if (!pending) {
    const answered = interaction.state === 'answered';
    return (
      <div className="mb-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-background-surface-under)] px-4 py-3">
        <div className="flex items-center gap-2 text-[12px] text-[var(--color-text-foreground)]">
          <span className={answered ? 'text-[var(--color-text-success)]' : 'opacity-50'}>
            {answered ? '已回答' : resolvedLabel(interaction.state)}
          </span>
          <span className="opacity-70">提问已结束</span>
        </div>
      </div>
    );
  }

  const questions = presentation.questions;
  const toggleOption = (questionId: string, optionId: string): void => {
    setSelected((prev) => {
      const current = prev[questionId] ?? [];
      // Single-select questions keep only one; the first hit toggles off.
      const question = questions.find((q) => q.id === questionId);
      const next =
        question?.multiSelect === true
          ? current.includes(optionId)
            ? current.filter((id) => id !== optionId)
            : [...current, optionId]
          : current.includes(optionId)
            ? []
            : [optionId];
      return { ...prev, [questionId]: next };
    });
  };
  const setOther = (questionId: string, text: string): void => {
    setOthers((prev) => ({ ...prev, [questionId]: text }));
  };
  const hasAnswer = questions.some(
    (q) => (selected[q.id] ?? []).length > 0 || (others[q.id] ?? '').trim() !== '',
  );
  const run = (fn: () => void | Promise<void>): void => {
    if (isBusy) return;
    setInFlight(true);
    void Promise.resolve()
      .then(fn)
      .finally(() => setInFlight(false));
  };
  const answer = (): void => {
    if (!hasAnswer || isBusy) return;
    run(() => onAnswer(buildQuestionResponse(questions, selected, others)));
  };
  const skip = (): void => {
    if (isBusy) return;
    run(() => onAnswer(buildSkippedQuestionResponse(questions)));
  };

  return (
    <div
      className={`rounded-[var(--radius-lg)] border border-[var(--color-border-heavy)] bg-[var(--color-background-surface)] px-3.5 py-3 shadow-[var(--shadow-md)] ${
        isBusy ? 'opacity-70' : ''
      }`}
      onKeyDown={(event) => {
        if (isBusy) return;
        const tag = (event.target as HTMLElement).tagName;
        // Buttons handle Enter natively (click); text inputs answer on Enter
        // only via their own semantics — skip both to avoid double submits.
        if (event.key === 'Enter' && tag !== 'BUTTON' && tag !== 'TEXTAREA' && tag !== 'INPUT') {
          event.preventDefault();
          answer();
        }
      }}
    >
      {questions.map((question) => (
        <div key={question.id} className="mb-2.5 last:mb-0">
          <div className="text-[13px] font-medium text-[var(--color-text-foreground)]">
            {question.header ?? question.question}
          </div>
          {question.body !== undefined && question.body !== '' ? (
            <div className="mt-0.5 text-[11px] leading-relaxed text-[var(--color-text-foreground)] opacity-60">
              {question.body}
            </div>
          ) : null}
          <div className="mt-1.5 space-y-1">
            {question.options.map((option) => {
              const isSelected = (selected[question.id] ?? []).includes(option.id);
              const recommended = isRecommendedOption(option);
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={isBusy}
                  title={option.description}
                  onClick={() => toggleOption(question.id, option.id)}
                  className={`ui-pressable block w-full cursor-pointer rounded-[var(--radius-sm)] border px-2.5 py-1 text-left text-[12px] transition-colors disabled:cursor-default disabled:opacity-50 ${
                    isSelected
                      ? 'border-[var(--color-border-focus)] bg-[var(--color-accent-background)] text-[var(--color-text-foreground)]'
                      : 'border-[var(--color-border-light)] text-[var(--color-text-foreground)] opacity-80 hover:bg-[var(--color-list-hover)]'
                  }`}
                >
                  <span className="flex select-none items-center gap-1.5">
                    {question.multiSelect ? (
                      isSelected ? (
                        <CheckSquare size={16} weight="regular" className="shrink-0 text-[var(--primary)]" aria-hidden />
                      ) : (
                        <Square size={16} weight="regular" className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden />
                      )
                    ) : isSelected ? (
                      <CheckCircle size={16} weight="regular" className="shrink-0 text-[var(--primary)]" aria-hidden />
                    ) : (
                      <Circle size={16} weight="regular" className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden />
                    )}
                    <span>{option.label}</span>
                    {recommended ? (
                      <span className="text-[10px] font-medium text-[var(--color-text-accent)]">推荐</span>
                    ) : null}
                  </span>
                  {option.description !== undefined && option.description !== '' ? (
                    <span className="mt-0.5 block opacity-60">{option.description}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
          {question.allowOther ? (
            <input
              type="text"
              disabled={isBusy}
              value={others[question.id] ?? ''}
              onChange={(event) => setOther(question.id, event.target.value)}
              placeholder={question.otherLabel ?? '其他…'}
              className="mt-1.5 w-full rounded-md border border-[var(--color-border-light)] bg-[var(--color-background-surface)] px-3 py-1 text-[12px] text-[var(--color-text-foreground)] outline-none placeholder:text-[var(--color-text-foreground)] placeholder:opacity-40 focus:border-[var(--color-border-heavy)] disabled:opacity-50"
            />
          ) : null}
        </div>
      ))}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          autoFocus
          disabled={isBusy || !hasAnswer}
          onClick={answer}
          className="ui-pressable cursor-pointer rounded-[var(--radius-sm)] bg-[var(--color-button-primary-background)] px-3 py-1 text-[12px] font-medium text-[var(--color-button-primary-foreground)] hover:opacity-90 disabled:cursor-default disabled:opacity-40"
        >
          回答
        </button>
        <button
          type="button"
          disabled={isBusy}
          onClick={skip}
          className="ui-pressable cursor-pointer rounded-[var(--radius-sm)] border border-[var(--color-border-heavy)] px-3 py-1 text-[12px] text-[var(--color-text-foreground)] hover:bg-[var(--color-list-hover)] disabled:cursor-default disabled:opacity-50"
        >
          跳过
        </button>
        <button
          type="button"
          disabled={isBusy}
          onClick={() => void onDismiss()}
          className="ui-pressable cursor-pointer rounded-[var(--radius-sm)] px-2 py-1 text-[11px] text-[var(--color-text-foreground)] opacity-50 underline-offset-2 hover:opacity-80 disabled:cursor-default disabled:opacity-40"
        >
          关闭提问
        </button>
      </div>
    </div>
  );
}

function resolvedLabel(state: string): string {
  switch (state) {
    case 'dismissed':
      return '已关闭';
    case 'cancelled':
      return '已取消';
    default:
      return state;
  }
}
