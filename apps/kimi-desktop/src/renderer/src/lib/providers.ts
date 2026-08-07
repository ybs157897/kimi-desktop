/**
 * Pure helpers for the M8 provider manager — status labels, alias handling,
 * the api_key tri-state, and catalog filtering. Side-effect free so vitest
 * covers them in a node environment.
 */

import type { ModelCatalogItem, ProviderCatalogStatus } from '@moonshot-ai/protocol';

import type { CatalogProviderItem, CreateProviderModel } from './api';

export const PROVIDER_STATUS_LABELS: Record<ProviderCatalogStatus, string> = {
  connected: '已连接',
  error: '异常',
  unconfigured: '未配置',
};

/**
 * Strip the `<providerId>/` prefix from a catalog alias id when present
 * (created providers alias their models as `${id}/${model}`; builtin aliases
 * are bare). Anything else passes through unchanged.
 */
export function stripAliasPrefix(alias: string, providerId: string): string {
  const prefix = `${providerId}/`;
  return alias.startsWith(prefix) ? alias.slice(prefix.length) : alias;
}

/**
 * Rebuild a provider's create/replace `models` body from the global model
 * catalog (entries whose `provider` matches), stripping the alias prefix back
 * to the bare model name. Used to reconstruct the PUT body on edit — the
 * provider item alone only carries alias id strings.
 */
export function buildProviderModelsFromCatalog(
  items: readonly ModelCatalogItem[],
  providerId: string,
): readonly CreateProviderModel[] {
  return items
    .filter((entry) => entry.provider === providerId)
    .map((entry) => ({
      model: stripAliasPrefix(entry.model, providerId),
      max_context_size: entry.max_context_size,
      display_name: entry.display_name,
      capabilities: entry.capabilities,
      support_efforts: entry.support_efforts,
    }));
}

/**
 * The api_key tri-state for a replace body: `undefined` = keep the stored
 * key, `""` = clear it, any other value = replace it. An empty input with no
 * stored key counts as "keep nothing" (undefined), not "clear".
 */
export function apiKeyPatchTriState(
  original: string | undefined,
  current: string,
): string | undefined {
  if (current === (original ?? '')) return undefined;
  return current;
}

/** Case-insensitive name/id filter over the models.dev catalog. */
export function catalogProviderFilter(
  query: string,
  items: readonly CatalogProviderItem[],
): readonly CatalogProviderItem[] {
  const q = query.trim().toLowerCase();
  if (q === '') return items;
  return items.filter(
    (item) => item.name.toLowerCase().includes(q) || item.id.toLowerCase().includes(q),
  );
}
