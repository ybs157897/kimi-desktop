/**
 * PanelHost — the tabbed panel container shared by the right dock and the
 * bottom dock. Each dock holds an independent set of open tabs; the right dock
 * hosts the workspace panels (diff / file tree), the bottom dock hosts the
 * terminal (full-width PTY).
 *
 * The owner places one PanelHost per dock with a fixed tab kind and renders the
 * active panel; this component owns only the tab strip + the body slot so the
 * dock chrome (drag handle, collapse) stays in the shell.
 */

import type { ReactNode } from 'react';

export type PanelKind = 'diff' | 'files' | 'terminal' | 'sidechat';

export interface PanelTab {
  readonly kind: PanelKind;
  readonly label: string;
}

export interface PanelHostProps {
  readonly tabs: readonly PanelTab[];
  readonly active: PanelKind;
  readonly onSelect: (kind: PanelKind) => void;
  readonly children: ReactNode;
  /** Right-aligned actions (e.g. the terminal "+" button). */
  readonly actions?: ReactNode;
}

export function PanelHost({ tabs, active, onSelect, children, actions }: PanelHostProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center border-b border-[var(--color-border-light)] px-3.5">
        <span className="text-[11.5px] font-medium text-[var(--color-text-secondary)]">环境信息</span>
        {actions !== undefined ? <div className="ml-auto flex items-center">{actions}</div> : null}
      </div>
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--color-border-light)] px-3">
        {tabs.map((tab) => (
          <button
            key={tab.kind}
            type="button"
            onClick={() => onSelect(tab.kind)}
            className={`relative h-9 px-2 text-[11.5px] font-medium ${
              tab.kind === active
                ? 'text-[var(--color-text-foreground)] after:absolute after:bottom-0 after:left-2 after:right-2 after:h-0.5 after:rounded-full after:bg-[var(--color-text-foreground)]'
                : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-foreground)]'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
