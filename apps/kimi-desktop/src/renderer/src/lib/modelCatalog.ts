import type { ModelCatalogItem } from '@moonshot-ai/protocol';

/** The server already returns a fully-qualified model id in `model`. */
export function modelCatalogItemId(entry: ModelCatalogItem): string {
  return entry.model;
}

export interface ModelCatalogGroup {
  readonly provider: string;
  readonly entries: readonly ModelCatalogItem[];
}

/** Preserve catalog order while grouping models for the two-level picker. */
export function groupModelCatalog(items: readonly ModelCatalogItem[]): readonly ModelCatalogGroup[] {
  const groups = new Map<string, ModelCatalogItem[]>();
  for (const item of items) {
    const entries = groups.get(item.provider);
    if (entries === undefined) groups.set(item.provider, [item]);
    else entries.push(item);
  }
  return [...groups].map(([provider, entries]) => ({ provider, entries }));
}

/** Resolve the model used by a prompt. Session creation persists an empty
 * model string when no session override was chosen, so empty values must fall
 * through to the configured global default instead of shadowing it. */
export function resolvePromptModel(
  promptOverride: string | undefined,
  sessionModel: string | undefined,
  defaultModel: string | undefined,
): string | undefined {
  return [promptOverride, sessionModel, defaultModel].find(
    (candidate): candidate is string => candidate !== undefined && candidate.trim() !== '',
  );
}
