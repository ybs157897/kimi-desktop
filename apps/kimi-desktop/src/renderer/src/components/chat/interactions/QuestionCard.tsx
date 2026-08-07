import {
  questionRequestSchema,
  type QuestionAnswer,
  type QuestionItem,
  type QuestionResponse,
} from '@moonshot-ai/protocol';
import type { TranscriptInteraction } from '@moonshot-ai/transcript';
import { useState } from 'react';

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
 *  in flight; renders the settled result once no longer pending. */
export function QuestionCard({ interaction, onAnswer, onDismiss, busy = false }: QuestionCardProps) {
  const request = questionRequestSchema.safeParse(interaction.request);
  const [inFlight, setInFlight] = useState(false);
  const [selected, setSelected] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [others, setOthers] = useState<Readonly<Record<string, string>>>({});
  const pending = interaction.state === 'pending';
  const isBusy = busy || inFlight;

  if (!pending) {
    const answered = interaction.state === 'answered';
    return (
      <div className="mb-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-background-surface-under)] px-4 py-3">
        <div className="flex items-center gap-2 text-[12px] text-[var(--color-text-foreground)]">
          <span className={answered ? 'text-[var(--green-400)]' : 'opacity-50'}>
            {answered ? '已回答' : resolvedLabel(interaction.state)}
          </span>
          <span className="opacity-70">提问已结束</span>
        </div>
      </div>
    );
  }

  const questions = request.success ? request.data.questions : [];
  const toggleOption = (question: QuestionItem, optionId: string): void => {
    setSelected((prev) => {
      const current = prev[question.id] ?? [];
      const next =
        question.multi_select === true
          ? current.includes(optionId)
            ? current.filter((id) => id !== optionId)
            : [...current, optionId]
          : current.includes(optionId)
            ? []
            : [optionId];
      return { ...prev, [question.id]: next };
    });
  };
  const setOther = (questionId: string, text: string): void => {
    setOthers((prev) => ({ ...prev, [questionId]: text }));
  };
  const hasAnswer = questions.some((q) => (selected[q.id] ?? []).length > 0 || (others[q.id] ?? '').trim() !== '');
  const run = (fn: () => void | Promise<void>): void => {
    if (isBusy) return;
    setInFlight(true);
    Promise.resolve()
      .then(fn)
      .finally(() => setInFlight(false));
  };
  const answer = (): void => {
    if (!hasAnswer || isBusy) return;
    run(() => onAnswer({ answers: buildAnswers(questions, selected, others), method: 'click' }));
  };
  const skip = (): void => {
    if (isBusy) return;
    run(() => onAnswer({ answers: skipAnswers(questions) }));
  };

  return (
    <div
      className={`mb-2 rounded-xl border border-[var(--color-border-heavy)] bg-[var(--color-background-surface-under)] px-4 py-3 ${
        isBusy ? 'animate-pulse' : ''
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
        <div key={question.id} className="mb-3 last:mb-0">
          <div className="text-[13px] font-medium text-[var(--color-text-foreground)]">
            {question.header ?? question.question}
          </div>
          {question.body !== undefined && question.body !== '' ? (
            <div className="mt-0.5 text-[11px] leading-relaxed text-[var(--color-text-foreground)] opacity-60">
              {question.body}
            </div>
          ) : null}
          <div className="mt-2 space-y-1">
            {question.options.map((option) => {
              const isSelected = (selected[question.id] ?? []).includes(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={isBusy}
                  title={option.description}
                  onClick={() => toggleOption(question, option.id)}
                  className={`block w-full cursor-pointer rounded-md border px-3 py-1 text-left text-[12px] transition-colors disabled:cursor-default disabled:opacity-50 ${
                    isSelected
                      ? 'border-[var(--color-border-heavy)] bg-[var(--color-list-hover)] text-[var(--color-text-foreground)]'
                      : 'border-[var(--color-border-light)] text-[var(--color-text-foreground)] opacity-80 hover:bg-[var(--color-list-hover)]'
                  }`}
                >
                  {question.multi_select === true && isSelected ? '☑ ' : question.multi_select === true ? '☐ ' : ''}
                  {option.label}
                </button>
              );
            })}
          </div>
          {question.allow_other === true ? (
            <input
              type="text"
              disabled={isBusy}
              value={others[question.id] ?? ''}
              onChange={(event) => setOther(question.id, event.target.value)}
              placeholder={question.other_label ?? '其他…'}
              className="mt-1.5 w-full rounded-md border border-[var(--color-border-light)] bg-[var(--color-background-surface)] px-3 py-1 text-[12px] text-[var(--color-text-foreground)] outline-none placeholder:text-[var(--color-text-foreground)] placeholder:opacity-40 focus:border-[var(--color-border-heavy)] disabled:opacity-50"
            />
          ) : null}
        </div>
      ))}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          autoFocus
          disabled={isBusy || !hasAnswer}
          onClick={answer}
          className="cursor-pointer rounded-md bg-[var(--gray-1000)] px-3 py-1 text-[12px] font-medium text-[var(--color-text-foreground)] hover:bg-[var(--gray-900)] disabled:cursor-default disabled:opacity-40"
        >
          回答
        </button>
        <button
          type="button"
          disabled={isBusy}
          onClick={skip}
          className="cursor-pointer rounded-md border border-[var(--color-border)] px-3 py-1 text-[12px] text-[var(--color-text-foreground)] opacity-70 hover:bg-[var(--color-list-hover)] disabled:cursor-default disabled:opacity-50"
        >
          跳过
        </button>
        <button
          type="button"
          disabled={isBusy}
          onClick={() => void onDismiss()}
          className="cursor-pointer rounded-md px-2 py-1 text-[11px] text-[var(--color-text-foreground)] opacity-50 underline-offset-2 hover:opacity-80 disabled:cursor-default disabled:opacity-40"
        >
          Dismiss
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

function buildAnswers(
  questions: readonly QuestionItem[],
  selected: Readonly<Record<string, readonly string[]>>,
  others: Readonly<Record<string, string>>,
): Record<string, QuestionAnswer> {
  const answers: Record<string, QuestionAnswer> = {};
  for (const question of questions) {
    const optionIds = [...(selected[question.id] ?? [])];
    const other = (others[question.id] ?? '').trim();
    if (question.multi_select === true) {
      if (optionIds.length > 0 && other !== '') {
        answers[question.id] = { kind: 'multi_with_other', option_ids: optionIds, other_text: other };
      } else if (optionIds.length > 0) {
        answers[question.id] = { kind: 'multi', option_ids: optionIds };
      } else if (other !== '') {
        answers[question.id] = { kind: 'other', text: other };
      }
    } else if (optionIds.length > 0) {
      answers[question.id] = { kind: 'single', option_id: optionIds[0]! };
    } else if (other !== '') {
      answers[question.id] = { kind: 'other', text: other };
    }
  }
  return answers;
}

function skipAnswers(questions: readonly QuestionItem[]): Record<string, QuestionAnswer> {
  const answers: Record<string, QuestionAnswer> = {};
  for (const question of questions) {
    answers[question.id] = { kind: 'skipped' };
  }
  return answers;
}
