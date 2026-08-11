import type { ModelCatalogItem } from '@moonshot-ai/protocol';
import { CaretDown, CaretRight, Check, CircleHalf, GearSix, Globe } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { groupModelCatalog, modelCatalogItemId } from '#/lib/modelCatalog';

export interface ModelSelectProps {
  /** Currently effective model id (`provider/model`), empty when none is known. */
  readonly value?: string;
  /** Model catalog entries (`GET /api/v1/models`). */
  readonly models?: readonly ModelCatalogItem[];
  readonly onChange: (model: string) => void;
  readonly disabled?: boolean;
  /** Label of the empty ("no override") option. Defaults to 选择模型 —
   *  pass 未设置 when the select edits a global default instead. */
  readonly emptyLabel?: string;
  readonly className?: string;
  readonly ariaLabel?: string;
  /** Composer menus open upward; settings rows can opt into opening below. */
  readonly placement?: 'above' | 'below';
  /** Keep nested provider menus inside narrow settings panes. */
  readonly submenuSide?: 'left' | 'right';
  readonly onOpenChange?: (open: boolean) => void;
  /** Open the app's model-provider settings. Omit inside Settings itself. */
  readonly onOpenModelSettings?: () => void;
}

function entryLabel(entry: ModelCatalogItem): string {
  return entry.display_name ?? entry.model.split('/').at(-1) ?? entry.model;
}

/**
 * Composer model dropdown over the model catalog. The select mirrors the
 * session's effective model — the owner passes the session status model or
 * the global default — and delegates persistence of a changed selection to
 * its owner. An effective id absent from the catalog (a provider alias, say)
 * is shown verbatim so the select never falls back to a misleading entry.
 */
export function ModelSelect({
  value,
  models,
  onChange,
  disabled = false,
  emptyLabel = '选择模型',
  className,
  ariaLabel = '模型',
  placement = 'above',
  submenuSide = 'right',
  onOpenChange,
  onOpenModelSettings,
}: ModelSelectProps) {
  const current = value ?? '';
  const list = models ?? [];
  const groups = useMemo(() => groupModelCatalog(list), [list]);
  const currentEntry = useMemo(
    () => list.find((entry) => modelCatalogItemId(entry) === current),
    [current, list],
  );
  const [open, setOpen] = useState(false);
  const [activeProvider, setActiveProvider] = useState<string | undefined>();
  const rootRef = useRef<HTMLDivElement>(null);
  const primaryGroup = groups.find((group) => group.provider === 'managed:kimi-code') ?? groups[0];
  const providerGroups = groups.filter((group) => group.provider !== primaryGroup?.provider);
  const activeGroup = providerGroups.find((group) => group.provider === activeProvider);
  const changeOpen = useCallback(
    (nextOpen: boolean): void => {
      setOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [onOpenChange],
  );

  useEffect(() => {
    if (!open) return;
    const preferred =
      currentEntry?.provider !== primaryGroup?.provider ? currentEntry?.provider : undefined;
    setActiveProvider(preferred);
    const close = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) changeOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [changeOpen, open, currentEntry?.provider, groups, primaryGroup?.provider]);

  useEffect(() => () => onOpenChange?.(false), [onOpenChange]);

  const choose = (next: string): void => {
    onChange(next);
    changeOpen(false);
  };

  return (
    <div
      ref={rootRef}
      className={
        className ??
        'relative max-w-[11rem]'
      }
      title="选择模型"
    >
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => changeOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation();
            changeOpen(false);
          }
        }}
        className={`composer-menu w-full ${disabled ? 'opacity-55' : 'hover:bg-[var(--color-list-hover)]'}`}
      >
        <CircleHalf size={14} weight="regular" className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-left text-[12px] font-medium">
          {currentEntry === undefined ? current || emptyLabel : entryLabel(currentEntry)}
        </span>
        <CaretDown size={10} weight="bold" className="shrink-0 opacity-45" aria-hidden />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="模型供应商"
          className={`ui-popover absolute right-0 z-50 w-48 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-background-panel)] p-2 shadow-[var(--shadow-xl)] ${
            placement === 'above' ? 'bottom-[calc(100%+6px)]' : 'top-[calc(100%+6px)]'
          }`}
        >
          {primaryGroup !== undefined ? (
            <>
              <div className="flex items-center gap-2 px-2 py-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
                <span className="min-w-0 flex-1 truncate">{primaryGroup.provider}</span>
                <span className="rounded-[var(--radius-full)] bg-[var(--color-background-button-secondary)] px-1.5 py-1 text-[9px] font-medium">
                  默认
                </span>
              </div>
              {primaryGroup.entries.map((entry) => {
                const id = modelCatalogItemId(entry);
                return (
                  <button
                    key={id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={id === current}
                    title={id}
                    onClick={() => choose(id)}
                    className={`flex min-h-8 w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 text-left text-[12.5px] hover:bg-[var(--color-list-hover)] ${
                      id === current ? 'bg-[var(--color-list-active)]' : ''
                    }`}
                  >
                    <span className="w-3 shrink-0">{id === current ? <Check size={12} weight="bold" /> : null}</span>
                    <span className="min-w-0 flex-1 truncate">{entryLabel(entry)}</span>
                  </button>
                );
              })}
            </>
          ) : null}
          <div className="my-1 h-px bg-[var(--color-border-light)]" />
          {providerGroups.map((group) => {
            const selected = group.provider === currentEntry?.provider;
            return (
              <button
                key={group.provider}
                type="button"
                role="menuitem"
                onPointerEnter={() => setActiveProvider(group.provider)}
                onFocus={() => setActiveProvider(group.provider)}
                onClick={() => setActiveProvider(group.provider)}
                className={`flex min-h-8 w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 text-left text-[12.5px] ${
                  activeProvider === group.provider ? 'bg-[var(--color-list-hover)]' : ''
                }`}
              >
                <span className="w-3 shrink-0">{selected ? <Check size={12} weight="bold" /> : null}</span>
                <span className="min-w-0 flex-1 truncate">{group.provider}</span>
                <CaretRight size={11} weight="bold" className="shrink-0 text-[var(--color-text-tertiary)]" />
              </button>
            );
          })}
          <div className="my-1 h-px bg-[var(--color-border-light)]" />
          <button
            type="button"
            role="menuitemradio"
            aria-checked={current === ''}
            onClick={() => choose('')}
            className="flex min-h-8 w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 text-left text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)]"
          >
            <span className="w-3 shrink-0">{current === '' ? <Check size={12} weight="bold" /> : null}</span>
            <span className="min-w-0 flex-1 truncate">{emptyLabel}</span>
          </button>
          {onOpenModelSettings !== undefined ? (
            <>
              <div className="my-1 h-px bg-[var(--color-border-light)]" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  changeOpen(false);
                  onOpenModelSettings();
                }}
                className="flex min-h-8 w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 text-left text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
              >
                <GearSix size={13} weight="regular" className="w-3 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate">模型设置</span>
              </button>
            </>
          ) : null}

          {activeGroup !== undefined ? (
            <div
              role="menu"
              aria-label={`${activeGroup.provider} 模型`}
              className={`absolute max-h-72 w-56 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-background-panel)] p-2 shadow-[var(--shadow-xl)] ${
                placement === 'above' ? 'bottom-0' : 'top-0'
              } ${submenuSide === 'right' ? 'left-[calc(100%+5px)]' : 'right-[calc(100%+5px)]'}`}
            >
              <div className="px-2 py-1 text-[10.5px] font-semibold text-[var(--color-text-tertiary)]">
                {activeGroup.provider}
              </div>
              {activeGroup.entries.map((entry) => {
                const id = modelCatalogItemId(entry);
                return (
                  <button
                    key={id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={id === current}
                    title={id}
                    onClick={() => choose(id)}
                    className={`flex min-h-8 w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 text-left text-[12.5px] hover:bg-[var(--color-list-hover)] ${
                      id === current ? 'bg-[var(--color-list-active)]' : ''
                    }`}
                  >
                    <span className="w-3 shrink-0">{id === current ? <Check size={12} weight="bold" /> : null}</span>
                    <span className="min-w-0 flex-1 truncate">{entryLabel(entry)}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export interface ThinkingEffortSelectProps {
  /** Selected thinking effort; empty = follow the session (no override). */
  readonly value?: string;
  readonly onChange: (effort: string) => void;
  readonly disabled?: boolean;
  readonly className?: string;
  /** Model-advertised effort values. Undefined falls back to the full ladder. */
  readonly efforts?: readonly string[];
  readonly defaultEffort?: string;
}

/** The thinking-effort ladder the engine accepts. */
const EFFORTS: readonly { value: string; label: string }[] = [
  { value: 'off', label: '关' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
];

function effortLabel(value: string): string {
  return EFFORTS.find((effort) => effort.value === value)?.label ?? value;
}

/**
 * Thinking-effort dropdown (the Effort zone of the Codex-style model popover).
 * Like the model select, the surrounding composer owns persistence. Choosing
 * the empty entry asks it to persist the selected model's default effort.
 *
 * A custom button + popover (not a native `<select>`): the native control's
 * clickable area was only the text itself — the icon/padding of the wrapping
 * label were dead zones inside the composer, so clicks often did nothing.
 * The button makes the whole chip a hit target and the popover stacks above
 * the composer like every other menu.
 */
export function ThinkingEffortSelect({
  value,
  onChange,
  disabled = false,
  className,
  efforts,
  defaultEffort,
}: ThinkingEffortSelectProps) {
  const options = efforts ?? EFFORTS.map((effort) => effort.value);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = value ?? '';
  const defaultLabel = defaultEffort === undefined ? '默认' : `默认 · ${effortLabel(defaultEffort)}`;

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  const choose = (next: string): void => {
    onChange(next);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative shrink-0" title="思考强度">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="思考强度"
        onClick={() => setOpen((next) => !next)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }
        }}
        className={
          className ??
          `composer-menu ${disabled ? 'opacity-55' : 'hover:bg-[var(--color-list-hover)]'}`
        }
      >
        <Globe size={14} weight="regular" className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-left text-[12px] font-medium">
          {current === '' ? defaultLabel : effortLabel(current)}
        </span>
        <CaretDown size={10} weight="bold" className="shrink-0 opacity-45" aria-hidden />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="思考强度"
          className="ui-popover absolute bottom-[calc(100%+6px)] right-0 z-50 w-36 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-background-panel)] p-1.5 shadow-[var(--shadow-xl)]"
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked={current === ''}
            onClick={() => choose('')}
            className={`flex min-h-8 w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 text-left text-[12.5px] hover:bg-[var(--color-list-hover)] ${
              current === '' ? 'bg-[var(--color-list-active)]' : ''
            }`}
          >
            <span className="w-3 shrink-0">{current === '' ? <Check size={12} weight="bold" /> : null}</span>
            <span className="min-w-0 flex-1 truncate">{defaultLabel}</span>
          </button>
          {options.map((effort) => (
            <button
              key={effort}
              type="button"
              role="menuitemradio"
              aria-checked={effort === current}
              onClick={() => choose(effort)}
              className={`flex min-h-8 w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 text-left text-[12.5px] hover:bg-[var(--color-list-hover)] ${
                effort === current ? 'bg-[var(--color-list-active)]' : ''
              }`}
            >
              <span className="w-3 shrink-0">{effort === current ? <Check size={12} weight="bold" /> : null}</span>
              <span className="min-w-0 flex-1 truncate">{effortLabel(effort)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
