import type { PromptPermissionMode } from '@moonshot-ai/protocol';

const STORAGE_KEY = 'kimi-desktop.permission-mode';
const MODES: readonly PromptPermissionMode[] = ['manual', 'auto', 'yolo'];

export function loadDefaultPermissionMode(): PromptPermissionMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null && (MODES as readonly string[]).includes(saved)) {
      return saved as PromptPermissionMode;
    }
  } catch {
    // Storage can be unavailable in privacy-restricted renderer contexts.
  }
  return 'manual';
}

export function saveDefaultPermissionMode(mode: PromptPermissionMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Best-effort preference persistence.
  }
}

/**
 * Normalize a server-provided permission mode string (the config's
 * `default_permission_mode` is untyped on the wire). Falls back to `'manual'`
 * — the engine's own default — for anything outside the three modes.
 */
export function normalizePermissionMode(value: string | undefined): PromptPermissionMode {
  if (value !== undefined && (MODES as readonly string[]).includes(value)) {
    return value as PromptPermissionMode;
  }
  return 'manual';
}
