/**
 * Question interaction presentation — the client-side mirror of kap-server's
 * `toWireQuestion` (`packages/kap-server/src/routes/questions.ts`).
 *
 * Why this exists: the transcript interaction carries the **in-process**
 * `QuestionRequest` payload (camelCase `multiSelect`, options carry no ids),
 * not the wire shape the answer endpoint expects. The REST answer path needs
 * the synthesized ids (`q_<idx>` / `opt_<q>_<o>`) and reverses them back to
 * text server-side via `toInProcessResponse`. We synthesize the same ids here
 * so rendering and answering never depend on which transport produced the
 * request, and so the ids round-trip exactly through the server's lookup
 * table. This mirrors how `approvalInteraction.ts` already tolerates both the
 * wire and in-process approval shapes.
 */

import { questionRequestSchema, type QuestionAnswer, type QuestionResponse } from '@moonshot-ai/protocol';
import type { TranscriptInteraction } from '@moonshot-ai/transcript';

/** A rendered option: the synthesized wire id (`opt_<q>_<o>`) + display text. */
export interface QuestionPresentationOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

/** A rendered question: the synthesized wire id (`q_<idx>`) + options. */
export interface QuestionPresentationItem {
  readonly id: string;
  readonly question: string;
  readonly header?: string;
  readonly body?: string;
  readonly options: readonly QuestionPresentationOption[];
  readonly multiSelect: boolean;
  readonly allowOther: boolean;
  readonly otherLabel?: string;
}

export interface QuestionInteractionPresentation {
  /** The interaction id — the REST `:question_id` path parameter. */
  readonly questionId: string;
  readonly questions: readonly QuestionPresentationItem[];
}

/**
 * Normalize the interaction's `request` (in-process camelCase OR wire
 * snake_case) into the rendered shape. Mirrors the server's id synthesis:
 *   - QuestionItem.id   ← `q_<index>`
 *   - QuestionOption.id ← `opt_<item>_<option>`
 *   - allow_other is always advertised (the SDK model has no field for it).
 */
export function questionInteractionPresentation(
  interaction: Pick<TranscriptInteraction, 'interactionId' | 'request'>,
): QuestionInteractionPresentation {
  const parsed = questionRequestSchema.safeParse(interaction.request);
  if (parsed.success) {
    // Already wire-shaped (snake_case with synthesized ids) — pass through,
    // only projecting into the camelCase presentation the components use.
    return {
      questionId: parsed.data.question_id,
      questions: parsed.data.questions.map((q) => ({
        id: q.id,
        question: q.question,
        header: q.header,
        body: q.body,
        options: q.options.map((o) => ({
          id: o.id,
          label: o.label,
          description: o.description,
        })),
        multiSelect: q.multi_select === true,
        // The wire schema marks allow_other optional but the server always
        // advertises it; treat its absence as available.
        allowOther: q.allow_other !== false,
        otherLabel: q.other_label,
      })),
    };
  }

  // In-process camelCase shape — synthesize the wire ids locally.
  const raw = asRecord(interaction.request);
  const rawQuestions = Array.isArray(raw?.['questions']) ? raw!['questions'] : [];
  const items: QuestionPresentationItem[] = [];
  for (let itemIdx = 0; itemIdx < rawQuestions.length; itemIdx += 1) {
    const q = asRecord(rawQuestions[itemIdx]);
    if (q === undefined) continue;
    const question = typeof q['question'] === 'string' ? q['question'] : '';
    if (question === '') continue;
    const rawOptions = Array.isArray(q['options']) ? q['options'] : [];
    const options: QuestionPresentationOption[] = [];
    for (let optIdx = 0; optIdx < rawOptions.length; optIdx += 1) {
      const o = asRecord(rawOptions[optIdx]);
      if (o === undefined) continue;
      const label = typeof o['label'] === 'string' ? o['label'] : '';
      if (label === '') continue;
      const description =
        typeof o['description'] === 'string' && o['description'] !== '' ? o['description'] : undefined;
      options.push(
        description === undefined
          ? { id: `opt_${itemIdx}_${optIdx}`, label }
          : { id: `opt_${itemIdx}_${optIdx}`, label, description },
      );
    }
    if (options.length === 0) continue;
    const header = typeof q['header'] === 'string' && q['header'] !== '' ? q['header'] : undefined;
    const body = typeof q['body'] === 'string' && q['body'] !== '' ? q['body'] : undefined;
    const otherLabel =
      typeof q['otherLabel'] === 'string' && q['otherLabel'] !== '' ? q['otherLabel'] : undefined;
    const item: QuestionPresentationItem = {
      id: `q_${itemIdx}`,
      question,
      header,
      body,
      options,
      multiSelect: q['multiSelect'] === true,
      // The SDK has no allowOther field; always advertise the free-text Other
      // option (matches the server's wire projection).
      allowOther: true,
      otherLabel,
    };
    items.push(item);
  }

  return { questionId: interaction.interactionId, questions: items };
}

/**
 * Build the protocol `QuestionResponse` from the rendered selection, using the
 * synthesized wire ids so the server's `toInProcessResponse` reverses them to
 * text. Matches `QuestionCard`'s answer construction semantics:
 *   - single-select → at most one option id
 *   - multi-select  → toggle membership; an "other" text combines into
 *                     `multi_with_other` when options are also picked
 *   - "other" only  → `{ kind: 'other', text }`
 */
export function buildQuestionResponse(
  questions: readonly QuestionPresentationItem[],
  selected: Readonly<Record<string, readonly string[]>>,
  others: Readonly<Record<string, string>>,
): QuestionResponse {
  const answers: Record<string, QuestionAnswer> = {};
  for (const question of questions) {
    const optionIds = [...(selected[question.id] ?? [])];
    const other = (others[question.id] ?? '').trim();
    if (question.multiSelect) {
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
  return { answers, method: 'click' };
}

/** Build a response where every question is marked skipped. */
export function buildSkippedQuestionResponse(
  questions: readonly QuestionPresentationItem[],
): QuestionResponse {
  const answers: Record<string, QuestionAnswer> = {};
  for (const question of questions) {
    answers[question.id] = { kind: 'skipped' };
  }
  return { answers };
}

/** Whether an option label/description carries a "recommended" hint. */
export function isRecommendedOption(option: {
  readonly label: string;
  readonly description?: string;
}): boolean {
  if ('recommended' in option && option['recommended'] === true) return true;
  return /\b(?:recommended|recommend)\b|推荐/u.test(
    `${option.label} ${option.description ?? ''}`.toLowerCase(),
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
