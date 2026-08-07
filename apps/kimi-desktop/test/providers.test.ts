import { describe, expect, it } from 'vitest';

import type { ModelCatalogItem, ProviderCatalogStatus } from '@moonshot-ai/protocol';

import type { CatalogProviderItem } from '../src/renderer/src/lib/api';
import { normalizePermissionMode } from '../src/renderer/src/lib/permissionMode';
import {
  apiKeyPatchTriState,
  buildProviderModelsFromCatalog,
  catalogProviderFilter,
  PROVIDER_STATUS_LABELS,
  stripAliasPrefix,
} from '../src/renderer/src/lib/providers';

// ------------------------------------------------------------ stripAliasPrefix

describe('stripAliasPrefix', () => {
  it('strips the provider-id prefix from created-provider aliases', () => {
    expect(stripAliasPrefix('openai-custom/gpt-4o', 'openai-custom')).toBe('gpt-4o');
  });

  it('leaves bare aliases (builtin providers) untouched', () => {
    expect(stripAliasPrefix('kimi-k2', 'kimi')).toBe('kimi-k2');
  });

  it('leaves aliases with a different prefix untouched', () => {
    expect(stripAliasPrefix('other-provider/gpt-4o', 'openai-custom')).toBe('other-provider/gpt-4o');
  });
});

// ------------------------------------------------- buildProviderModelsFromCatalog

describe('buildProviderModelsFromCatalog', () => {
  const items: readonly ModelCatalogItem[] = [
    {
      provider: 'openai-custom',
      model: 'openai-custom/gpt-4o',
      max_context_size: 128000,
      display_name: 'GPT-4o',
      capabilities: ['tool_use'],
      support_efforts: ['low', 'high'],
    },
    { provider: 'openai-custom', model: 'openai-custom/gpt-4o-mini', max_context_size: 128000 },
    { provider: 'kimi', model: 'kimi-k2', max_context_size: 131072 },
  ];

  it('filters to the provider and strips the alias prefix', () => {
    expect(buildProviderModelsFromCatalog(items, 'openai-custom')).toEqual([
      {
        model: 'gpt-4o',
        max_context_size: 128000,
        display_name: 'GPT-4o',
        capabilities: ['tool_use'],
        support_efforts: ['low', 'high'],
      },
      {
        model: 'gpt-4o-mini',
        max_context_size: 128000,
        display_name: undefined,
        capabilities: undefined,
        support_efforts: undefined,
      },
    ]);
  });

  it('returns an empty list for an unknown provider', () => {
    expect(buildProviderModelsFromCatalog(items, 'nope')).toEqual([]);
  });
});

// ---------------------------------------------------------- apiKeyPatchTriState

describe('apiKeyPatchTriState', () => {
  it('omits the key when the input matches the stored one (keep)', () => {
    expect(apiKeyPatchTriState('sk-original', 'sk-original')).toBeUndefined();
  });

  it('sends an empty string to clear the stored key', () => {
    expect(apiKeyPatchTriState('sk-original', '')).toBe('');
  });

  it('sends the new value to replace the stored key', () => {
    expect(apiKeyPatchTriState('sk-original', 'sk-new')).toBe('sk-new');
  });

  it('omits the key when there was none and the input stays empty', () => {
    expect(apiKeyPatchTriState(undefined, '')).toBeUndefined();
  });

  it('sends a newly typed key', () => {
    expect(apiKeyPatchTriState(undefined, 'sk-new')).toBe('sk-new');
  });
});

// -------------------------------------------------------- catalogProviderFilter

describe('catalogProviderFilter', () => {
  const items: readonly CatalogProviderItem[] = [
    { id: 'openai', name: 'OpenAI', wire_type: 'openai', guessed: false, needs_base_url: false, rejected: false, reject_reason: null, env_key: null, models: [] },
    { id: 'anthropic', name: 'Anthropic', wire_type: 'anthropic', guessed: false, needs_base_url: false, rejected: false, reject_reason: null, env_key: null, models: [] },
  ];

  it('returns everything for a blank query', () => {
    expect(catalogProviderFilter('', items)).toHaveLength(2);
    expect(catalogProviderFilter('   ', items)).toHaveLength(2);
  });

  it('matches the name case-insensitively', () => {
    expect(catalogProviderFilter('ANTHRO', items).map((item) => item.id)).toEqual(['anthropic']);
  });

  it('matches the id', () => {
    expect(catalogProviderFilter('openai', items).map((item) => item.id)).toEqual(['openai']);
  });

  it('returns nothing when nothing matches', () => {
    expect(catalogProviderFilter('x', items)).toEqual([]);
  });
});

// --------------------------------------------------------------- status labels

describe('PROVIDER_STATUS_LABELS', () => {
  it('covers every provider status', () => {
    expect(Object.keys(PROVIDER_STATUS_LABELS).sort()).toEqual(['connected', 'error', 'unconfigured']);
    const statuses: ProviderCatalogStatus[] = ['connected', 'error', 'unconfigured'];
    for (const status of statuses) expect(PROVIDER_STATUS_LABELS[status]).toBeTruthy();
  });
});

// ------------------------------------------------------ normalizePermissionMode

describe('normalizePermissionMode', () => {
  it('passes the three valid modes through', () => {
    expect(normalizePermissionMode('manual')).toBe('manual');
    expect(normalizePermissionMode('auto')).toBe('auto');
    expect(normalizePermissionMode('yolo')).toBe('yolo');
  });

  it('falls back to manual for unknown or missing values', () => {
    expect(normalizePermissionMode('plan')).toBe('manual');
    expect(normalizePermissionMode(undefined)).toBe('manual');
  });
});
