import {
  APPEARANCE_STYLE_PROPERTY_NAMES,
  appearanceStyleProperties,
  type AppearancePreferences,
} from './appearancePreferences';
import {
  clearAppearancePreferences,
  loadAppearancePreferences,
  saveAppearancePreferences,
} from './appearancePreferenceStore';

export function applyAppearancePreferences(
  preferences: AppearancePreferences,
): void {
  const style = document.documentElement.style;
  for (const property of APPEARANCE_STYLE_PROPERTY_NAMES) {
    style.removeProperty(property);
  }
  for (const [property, value] of Object.entries(
    appearanceStyleProperties(preferences),
  )) {
    style.setProperty(property, value);
  }
}

export function resolveAppearancePreferences(): AppearancePreferences {
  return loadAppearancePreferences(localStorage);
}

export function persistAppearancePreferences(
  preferences: AppearancePreferences,
): AppearancePreferences {
  const normalized = saveAppearancePreferences(localStorage, preferences);
  applyAppearancePreferences(normalized);
  return normalized;
}

export function resetAppearancePreferences(): AppearancePreferences {
  const next = clearAppearancePreferences(localStorage);
  applyAppearancePreferences(next);
  return next;
}

/** Apply saved preferences before React mounts to avoid a typography flash. */
export function initAppearancePreferences(): void {
  applyAppearancePreferences(resolveAppearancePreferences());
}
