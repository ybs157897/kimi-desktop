import type { ModelCatalogItem } from '@moonshot-ai/protocol';

/** Read the user-facing effort from the global `[thinking]` config section. */
export function configuredThinkingEffort(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const config = value as Record<string, unknown>;
  if (config['enabled'] === false) return 'off';
  const effort = config['effort'];
  return typeof effort === 'string' && effort.trim() !== ''
    ? effort.trim()
    : undefined;
}

/** Resolve a preference against the selected model exactly enough for the UI:
 * unsupported saved efforts fall back to the model's declared/default rung. */
export function resolveThinkingEffort(
  requested: string | undefined,
  model: ModelCatalogItem | undefined,
): string | undefined {
  const supported = model?.support_efforts?.filter(
    (effort) => effort.trim() !== '',
  );
  const hasThinkingCapability = model?.capabilities?.some(
    (capability) =>
      capability === 'thinking' || capability === 'always_thinking',
  );
  const declaredDefault = model?.default_effort?.trim();
  const fallback =
    declaredDefault !== undefined &&
    declaredDefault !== '' &&
    (supported === undefined ||
      supported.length === 0 ||
      supported.includes(declaredDefault))
      ? declaredDefault
      : supported !== undefined && supported.length > 0
        ? supported[Math.floor(supported.length / 2)]
        : hasThinkingCapability
          ? 'on'
          : undefined;
  const normalized = requested?.trim();
  if (normalized === undefined || normalized === '') return fallback;
  if (model?.capabilities !== undefined && !hasThinkingCapability) return 'off';
  if (
    normalized !== 'off' &&
    supported !== undefined &&
    supported.length > 0 &&
    !supported.includes(normalized)
  ) {
    return fallback;
  }
  if (
    normalized === 'off' &&
    model?.capabilities?.includes('always_thinking')
  ) {
    return fallback;
  }
  return normalized;
}

/** Patch persisted by the Desktop whenever the user chooses an effort. */
export function thinkingConfigPatch(effort: string): {
  readonly enabled: boolean;
  readonly effort: string;
} {
  return { enabled: effort !== 'off', effort };
}
