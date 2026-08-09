/**
 * PanelHost — the tabbed panel container for the right dock (zcode tab-strip
 * parity). Tabs are id-addressed: the fixed panels (plan, and the currently
 * hidden workspace panels) plus dynamically opened document tabs (plan docs,
 * subagent chats), each closable via its × button. This component owns only
 * the tab strip + the body slot so the dock chrome (drag handle, collapse)
 * stays in the shell.
 */

import { X } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

export type PanelKind = 'plan' | 'plandoc' | 'diff' | 'files' | 'terminal' | 'sidechat';

export interface PanelTab {
  /** Unique tab id ('plan', 'diff', … for fixed panels; 'plan:<id>' /
   *  'agent:<id>' for document tabs). */
  readonly id: string;
  readonly kind: PanelKind;
  readonly label: string;
  /** Document tabs render a × and can be closed. */
  readonly closable?: boolean;
}

export interface PanelHostProps {
  readonly tabs: readonly PanelTab[];
  readonly activeId: string;
  readonly onSelect: (id: string) => void;
  readonly onCloseTab?: (id: string) => void;
  readonly children: ReactNode;
  /** Right-aligned actions. */
  readonly actions?: ReactNode;
}

export function PanelHost({ tabs, activeId, onSelect, onCloseTab, children, actions }: PanelHostProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-[var(--color-border-light)] px-3">
        <div role="tablist" className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
          {tabs.map((tab) => {
            const active = tab.id === activeId;
            return (
              // Tabs hold a nested close button, so the tab itself is a
              // keyboard-activatable div instead of a <button> (no nesting).
              <div
                key={tab.id}
                role="tab"
                tabIndex={0}
                aria-selected={active}
                title={tab.label}
                onClick={() => onSelect(tab.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(tab.id);
                  }
                }}
                className={`ui-pressable flex h-7 min-w-0 max-w-[12rem] shrink-0 cursor-pointer select-none items-center gap-1 rounded-[var(--radius-sm)] border pl-2.5 ${
                  tab.closable === true && onCloseTab !== undefined ? 'pr-1' : 'pr-2.5'
                } text-[11.5px] font-medium ${
                  active
                    ? 'border-[var(--color-border)] bg-[var(--color-background-surface)] text-[var(--color-text-foreground)] shadow-[var(--shadow-sm)]'
                    : 'border-transparent text-[var(--color-text-tertiary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]'
                }`}
              >
                <span className="min-w-0 truncate">{tab.label}</span>
                {tab.closable === true && onCloseTab !== undefined ? (
                  <button
                    type="button"
                    aria-label={`关闭 ${tab.label}`}
                    title="关闭"
                    onClick={(event) => {
                      event.stopPropagation();
                      onCloseTab(tab.id);
                    }}
                    className="ui-pressable flex h-4 w-4 shrink-0 items-center justify-center rounded-[var(--radius-xs)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-background-button-secondary)] hover:text-[var(--color-text-foreground)]"
                  >
                    <X size={9} weight="bold" aria-hidden />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
        {actions !== undefined ? <div className="ml-auto flex shrink-0 items-center">{actions}</div> : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
