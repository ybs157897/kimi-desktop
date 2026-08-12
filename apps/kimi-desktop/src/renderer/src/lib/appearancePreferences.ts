/**
 * Local display preferences for the Desktop renderer.
 *
 * CSS remains the source of truth for the default appearance. Persisted
 * preferences only install overrides on <html>; restoring defaults removes
 * those overrides so future token changes continue to flow through.
 */

export interface AppearancePreferences {
  readonly interfaceFontSize: number;
  readonly markdownFontSize: number;
  readonly codeFontSize: number;
  readonly textColor: string | null;
}

export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferences = {
  interfaceFontSize: 14,
  markdownFontSize: 14,
  codeFontSize: 13,
  textColor: null,
};

export const DEFAULT_TEXT_COLOR_BY_THEME = {
  light: '#14161a',
  dark: '#f5f5f7',
} as const;

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const FONT_SIZE_LIMITS = {
  interfaceFontSize: { min: 12, max: 18 },
  markdownFontSize: { min: 12, max: 20 },
  codeFontSize: { min: 10, max: 18 },
} as const;

export const APPEARANCE_STYLE_PROPERTY_NAMES = [
  '--client-content-font-size',
  '--client-title-font-size',
  '--client-sidebar-primary-font-size',
  '--markdown-font-size',
  '--markdown-code-block-font-size',
  '--color-user-text-foreground',
] as const;

type ManagedStyleProperty = (typeof APPEARANCE_STYLE_PROPERTY_NAMES)[number];
export type AppearanceStyleProperties = Partial<
  Record<ManagedStyleProperty, string>
>;

function defaults(): AppearancePreferences {
  return { ...DEFAULT_APPEARANCE_PREFERENCES };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizedFontSize(
  value: unknown,
  key: keyof typeof FONT_SIZE_LIMITS,
): number {
  const limits = FONT_SIZE_LIMITS[key];
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= limits.min &&
    value <= limits.max
  ) {
    return value;
  }
  return DEFAULT_APPEARANCE_PREFERENCES[key];
}

export function normalizeAppearancePreferences(
  value: unknown,
): AppearancePreferences {
  if (!isRecord(value)) return defaults();

  const textColor =
    typeof value['textColor'] === 'string' && HEX_COLOR.test(value['textColor'])
      ? value['textColor'].toLowerCase()
      : null;

  return {
    interfaceFontSize: normalizedFontSize(
      value['interfaceFontSize'],
      'interfaceFontSize',
    ),
    markdownFontSize: normalizedFontSize(
      value['markdownFontSize'],
      'markdownFontSize',
    ),
    codeFontSize: normalizedFontSize(value['codeFontSize'], 'codeFontSize'),
    textColor,
  };
}

export function parseAppearancePreferences(
  raw: string | null,
): AppearancePreferences {
  if (raw === null) return defaults();
  try {
    return normalizeAppearancePreferences(JSON.parse(raw));
  } catch {
    return defaults();
  }
}

export function isDefaultAppearancePreferences(
  preferences: AppearancePreferences,
): boolean {
  return (
    preferences.interfaceFontSize ===
      DEFAULT_APPEARANCE_PREFERENCES.interfaceFontSize &&
    preferences.markdownFontSize ===
      DEFAULT_APPEARANCE_PREFERENCES.markdownFontSize &&
    preferences.codeFontSize === DEFAULT_APPEARANCE_PREFERENCES.codeFontSize &&
    preferences.textColor === null
  );
}

/** Convert preferences into only the overrides that differ from CSS defaults. */
export function appearanceStyleProperties(
  preferences: AppearancePreferences,
): AppearanceStyleProperties {
  const normalized = normalizeAppearancePreferences(preferences);
  const properties: AppearanceStyleProperties = {};

  if (
    normalized.interfaceFontSize !==
    DEFAULT_APPEARANCE_PREFERENCES.interfaceFontSize
  ) {
    const value = `${normalized.interfaceFontSize}px`;
    properties['--client-content-font-size'] = value;
    properties['--client-title-font-size'] = value;
    properties['--client-sidebar-primary-font-size'] = value;
  }
  if (
    normalized.markdownFontSize !==
    DEFAULT_APPEARANCE_PREFERENCES.markdownFontSize
  ) {
    properties['--markdown-font-size'] = `${normalized.markdownFontSize}px`;
  }
  if (
    normalized.codeFontSize !== DEFAULT_APPEARANCE_PREFERENCES.codeFontSize
  ) {
    properties['--markdown-code-block-font-size'] =
      `${normalized.codeFontSize}px`;
  }
  if (normalized.textColor !== null) {
    properties['--color-user-text-foreground'] = normalized.textColor;
  }

  return properties;
}
