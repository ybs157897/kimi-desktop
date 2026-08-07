/**
 * Theme management — light/dark/system, persisted to localStorage and applied
 * as `data-theme` on <html> (the semantic token layer in tokens.css switches on
 * that attribute). "system" follows the OS `prefers-color-scheme` and tracks
 * changes while the app is open.
 */

export type ThemeChoice = 'light' | 'dark' | 'system';

const THEME_STORAGE_KEY = 'kimi-desktop.theme';

export function resolveThemeChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  } catch {
    // localStorage unavailable — fall back to system.
  }
  return 'system';
}

/** The effective theme ("light" / "dark") after resolving "system". */
export function effectiveTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return choice;
}

/** Apply a theme choice to <html data-theme>. */
export function applyTheme(choice: ThemeChoice): void {
  document.documentElement.setAttribute('data-theme', effectiveTheme(choice));
}

/** Persist a choice and apply it. */
export function setThemeChoice(choice: ThemeChoice): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // best-effort persistence
  }
  applyTheme(choice);
}

/**
 * Apply the saved theme at startup and keep following the OS when the choice
 * is "system". Returns a cleanup fn that removes the media-query listener.
 */
export function initTheme(): () => void {
  const choice = resolveThemeChoice();
  applyTheme(choice);
  if (choice !== 'system') return () => {};
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => applyTheme('system');
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}
