import {
  DEFAULT_APPEARANCE_PREFERENCES,
  isDefaultAppearancePreferences,
  normalizeAppearancePreferences,
  parseAppearancePreferences,
  type AppearancePreferences,
} from './appearancePreferences';

export const APPEARANCE_STORAGE_KEY = 'kimi-desktop.appearance';

export interface AppearancePreferenceStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
}

export function loadAppearancePreferences(
  storage: AppearancePreferenceStorage,
): AppearancePreferences {
  try {
    return parseAppearancePreferences(storage.getItem(APPEARANCE_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_APPEARANCE_PREFERENCES };
  }
}

export function saveAppearancePreferences(
  storage: AppearancePreferenceStorage,
  preferences: AppearancePreferences,
): AppearancePreferences {
  const normalized = normalizeAppearancePreferences(preferences);
  try {
    if (isDefaultAppearancePreferences(normalized)) {
      storage.removeItem(APPEARANCE_STORAGE_KEY);
    } else {
      storage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(normalized));
    }
  } catch {
    // Local display preferences are best-effort in restricted renderers.
  }
  return normalized;
}

export function clearAppearancePreferences(
  storage: AppearancePreferenceStorage,
): AppearancePreferences {
  try {
    storage.removeItem(APPEARANCE_STORAGE_KEY);
  } catch {
    // Local display preferences are best-effort in restricted renderers.
  }
  return { ...DEFAULT_APPEARANCE_PREFERENCES };
}
