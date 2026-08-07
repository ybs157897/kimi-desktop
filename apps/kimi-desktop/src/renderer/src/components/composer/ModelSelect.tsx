import type { ModelCatalogItem } from '@moonshot-ai/protocol';

export interface ModelSelectProps {
  /** Currently effective model id (`provider/model`), empty when none is known. */
  readonly value?: string;
  /** Model catalog entries (`GET /api/v1/models`). */
  readonly models?: readonly ModelCatalogItem[];
  readonly onChange: (model: string) => void;
  readonly disabled?: boolean;
  /** Label of the empty ("no override") option. Defaults to 跟随会话默认 —
   *  pass 未设置 when the select edits a global default instead. */
  readonly emptyLabel?: string;
}

function entryId(entry: ModelCatalogItem): string {
  return `${entry.provider}/${entry.model}`;
}

function entryLabel(entry: ModelCatalogItem): string {
  return entry.display_name ?? entry.model;
}

/**
 * Composer model dropdown over the model catalog. The select mirrors the
 * session's effective model — the owner passes `agent_config.model` or the
 * global default — and picking an entry is a per-prompt override only: the
 * owner resets the override after submit, never touching the session or the
 * global default. An effective id absent from the catalog (a provider alias,
 * say) is shown verbatim so the select never falls back to a misleading entry.
 */
export function ModelSelect({
  value,
  models,
  onChange,
  disabled = false,
  emptyLabel = '跟随会话默认',
}: ModelSelectProps) {
  const current = value ?? '';
  const list = models ?? [];
  const currentInCatalog = list.some(
    (entry) => entryId(entry) === current || entry.model === current,
  );
  return (
    <select
      value={current}
      disabled={disabled}
      aria-label="模型"
      title="Select model"
      onChange={(event) => onChange(event.target.value)}
      className="h-7 max-w-[180px] rounded-lg border border-transparent bg-transparent px-2 text-[11.5px] font-medium text-[var(--color-text-secondary)] outline-none hover:bg-[var(--color-list-hover)] focus:border-[var(--color-border-heavy)] disabled:opacity-60"
    >
      <option value="">{emptyLabel}</option>
      {current !== '' && !currentInCatalog ? <option value={current}>{current}</option> : null}
      {list.map((entry) => (
        <option key={entryId(entry)} value={entryId(entry)}>
          {entryLabel(entry)}
        </option>
      ))}
    </select>
  );
}

export interface ThinkingEffortSelectProps {
  /** Selected thinking effort; empty = follow the session (no override). */
  readonly value?: string;
  readonly onChange: (effort: string) => void;
  readonly disabled?: boolean;
}

/** The thinking-effort ladder the engine accepts. */
const EFFORTS: readonly string[] = ['off', 'low', 'medium', 'high'];

/**
 * Thinking-effort dropdown (the Effort zone of the Codex-style model popover).
 * Like the model select, choosing an entry overrides the current prompt only;
 * the empty choice leaves the session's own thinking setting untouched.
 */
export function ThinkingEffortSelect({ value, onChange, disabled = false }: ThinkingEffortSelectProps) {
  return (
    <select
      value={value ?? ''}
      disabled={disabled}
      aria-label="思考强度"
      title="Thinking effort"
      onChange={(event) => onChange(event.target.value)}
      className="h-7 rounded-lg border border-transparent bg-transparent px-2 text-[11.5px] font-medium text-[var(--color-text-secondary)] outline-none hover:bg-[var(--color-list-hover)] focus:border-[var(--color-border-heavy)] disabled:opacity-60"
    >
      <option value="">跟随默认</option>
      {EFFORTS.map((effort) => (
        <option key={effort} value={effort}>
          {effort}
        </option>
      ))}
    </select>
  );
}
