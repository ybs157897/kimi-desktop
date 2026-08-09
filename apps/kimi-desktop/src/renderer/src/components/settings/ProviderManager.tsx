/**
 * ProviderManager — the model-settings master/detail surface. The left rail
 * owns provider selection; the right pane owns the selected provider and its
 * models. Model editing is the only nested modal in this flow.
 */

import { useMemo, useState } from 'react';

import { Cube, Plus } from '@phosphor-icons/react';

import type { ProviderCatalogItem, ProviderCatalogStatus } from '@moonshot-ai/protocol';

import { useProviders } from '#/lib/queries';

import { ProviderEditDialog } from './ProviderEditDialog';

export interface ProviderManagerProps {
  readonly onModalOpenChange: (open: boolean) => void;
}

type View = 'detail' | 'add';

const STATUS_DOT: Record<ProviderCatalogStatus, string> = {
  connected: 'bg-[var(--color-text-success)]',
  error: 'bg-[var(--color-text-danger)]',
  unconfigured: 'bg-[var(--color-text-tertiary)]',
};

function groupProviders(items: readonly ProviderCatalogItem[]): {
  builtin: ProviderCatalogItem[];
  custom: ProviderCatalogItem[];
} {
  const builtin: ProviderCatalogItem[] = [];
  const custom: ProviderCatalogItem[] = [];
  for (const item of items) {
    if (item.type === 'kimi') builtin.push(item);
    else custom.push(item);
  }
  return { builtin, custom };
}

export function ProviderManager({ onModalOpenChange }: ProviderManagerProps) {
  const providers = useProviders();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<View>('detail');

  const items = providers.data?.items ?? [];
  const { builtin, custom } = useMemo(() => groupProviders(items), [items]);
  const selected = items.find((item) => item.id === selectedId) ?? items[0] ?? null;
  const activeId = view === 'detail' ? selected?.id ?? null : null;

  const showProvider = (id: string): void => {
    setSelectedId(id);
    setView('detail');
  };

  const showSavedProvider = (id: string): void => {
    setSelectedId(id);
    setView('detail');
  };

  return (
    <div className="h-[min(576px,calc(100vh-190px))] min-h-[480px] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-background-panel)] shadow-[var(--shadow-card)]">
      <div className="grid h-full min-h-0 grid-cols-[224px_minmax(0,1fr)] divide-x divide-[var(--color-border-light)]">
        <aside className="flex min-h-0 flex-col bg-[var(--color-background-panel)]">
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
            {providers.isLoading ? (
              <p className="px-3 py-2 text-[12px] text-[var(--color-text-tertiary)]">加载供应商…</p>
            ) : providers.isError ? (
              <p className="px-3 py-2 text-[12px] leading-5 text-[var(--color-text-danger)]">
                无法读取供应商列表
              </p>
            ) : (
              <>
                <ProviderGroup
                  label="内置供应商"
                  providers={builtin}
                  selectedId={activeId}
                  onSelect={showProvider}
                />
                <ProviderGroup
                  label="自定义供应商"
                  providers={custom}
                  selectedId={activeId}
                  onSelect={showProvider}
                />
                {items.length === 0 ? (
                  <p className="px-3 py-3 text-[12px] leading-5 text-[var(--color-text-tertiary)]">
                    还没有配置供应商
                  </p>
                ) : null}
              </>
            )}

            <button
              type="button"
              onClick={() => setView('add')}
              className={`ui-pressable mt-1 flex h-9 w-full items-center gap-2 rounded-[var(--radius-sm)] border border-transparent px-3 text-left text-[14px] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] ${
                view === 'add'
                  ? 'border-[var(--color-border)] bg-[var(--color-background-muted)] font-medium text-[var(--color-text-foreground)]'
                  : 'text-[var(--color-text-secondary)]'
              }`}
            >
              <Plus size={15} weight="regular" aria-hidden />
              添加供应商
            </button>
          </div>
        </aside>

        <section className="min-h-0 min-w-0 bg-[var(--color-background-panel)]">
          {view === 'add' ? (
            <ProviderEditDialog
              key="new-provider"
              provider={null}
              onClose={() => setView('detail')}
              onSaved={showSavedProvider}
              onModalOpenChange={onModalOpenChange}
            />
          ) : selected !== null ? (
            <ProviderEditDialog
              key={selected.id}
              provider={selected}
              onClose={() => undefined}
              onSaved={showSavedProvider}
              onDeleted={() => {
                setSelectedId(items.find((item) => item.id !== selected.id)?.id ?? null);
              }}
              onModalOpenChange={onModalOpenChange}
            />
          ) : (
            <EmptyState onAdd={() => setView('add')} />
          )}
        </section>
      </div>
    </div>
  );
}

interface ProviderGroupProps {
  readonly label: string;
  readonly providers: readonly ProviderCatalogItem[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}

function ProviderGroup({ label, providers, selectedId, onSelect }: ProviderGroupProps) {
  if (providers.length === 0) return null;
  return (
    <div className="mb-5">
      <p className="mb-1.5 px-3 text-[12px] text-[var(--color-text-tertiary)]">{label}</p>
      <ul className="space-y-0.5">
        {providers.map((provider) => {
          const active = selectedId === provider.id;
          return (
            <li key={provider.id}>
              <button
                type="button"
                aria-current={active ? 'true' : undefined}
                onClick={() => onSelect(provider.id)}
                className={`ui-pressable flex h-9 w-full items-center gap-2.5 rounded-[var(--radius-sm)] border px-3 text-left text-[14px] ${
                  active
                    ? 'border-[var(--color-border)] bg-[var(--color-background-muted)] font-medium text-[var(--color-text-foreground)]'
                    : 'border-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]'
                }`}
              >
                <Cube size={16} weight="regular" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{provider.id}</span>
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[provider.status]}`}
                  aria-label={provider.status === 'connected' ? '已连接' : provider.status === 'error' ? '异常' : '未配置'}
                />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function EmptyState({ onAdd }: { readonly onAdd: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-background-surface-under)] text-[var(--color-text-tertiary)]">
        <Cube size={20} weight="regular" aria-hidden />
      </div>
      <div>
        <p className="text-[13px] font-medium text-[var(--color-text-foreground)]">添加模型服务商</p>
        <p className="mt-1 text-[12px] text-[var(--color-text-tertiary)]">
          配置 API 接入点后，再添加可用模型。
        </p>
      </div>
      <button
        type="button"
        onClick={onAdd}
        className="ui-pressable rounded-[var(--radius-sm)] bg-[var(--color-button-primary-background)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-button-primary-foreground)] hover:brightness-110"
      >
        添加供应商
      </button>
    </div>
  );
}
