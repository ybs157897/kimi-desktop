/**
 * Global keyboard shortcuts — mounted once by the app shell. Aligns with the
 * Codex desktop shortcuts: Cmd/Ctrl+B toggles the sidebar, Cmd/Ctrl+J the
 * bottom panel, Ctrl+` the terminal, Cmd/Ctrl+K focuses search, Cmd/Ctrl+Shift+E
 * the file tree. Approval Enter/Esc stays local to the card.
 *
 * The handler map is plain booleans / callbacks so the shell wires its own
 * state setters; this hook only owns the key dispatch.
 */

import { useEffect } from 'react';

export interface ShortcutHandlers {
  readonly toggleSidebar?: () => void;
  readonly toggleBottomPanel?: () => void;
  readonly openTerminal?: () => void;
  readonly openFileTree?: () => void;
  readonly focusSearch?: () => void;
}

function isShortcut(event: KeyboardEvent, key: string, shift = false): boolean {
  const meta = event.metaKey || event.ctrlKey;
  return meta && event.key.toLowerCase() === key.toLowerCase() && event.shiftKey === shift;
}

/** Mount the global shortcut listener; pass `null`-ish handlers to skip a key. */
export function useShortcuts(handlers: ShortcutHandlers): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Ctrl+` toggles the terminal (no meta — matches editor conventions).
      if (event.ctrlKey && !event.metaKey && event.key === '`') {
        event.preventDefault();
        handlers.openTerminal?.();
        return;
      }
      if (isShortcut(event, 'b')) {
        event.preventDefault();
        handlers.toggleSidebar?.();
      } else if (isShortcut(event, 'j')) {
        event.preventDefault();
        handlers.toggleBottomPanel?.();
      } else if (isShortcut(event, 'k')) {
        event.preventDefault();
        handlers.focusSearch?.();
      } else if (isShortcut(event, 'e', true)) {
        event.preventDefault();
        handlers.openFileTree?.();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handlers]);
}
