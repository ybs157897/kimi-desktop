/**
 * CatalogImportDialog — browse the models.dev catalog (server-cached via
 * `GET /api/v1/catalog/providers`) and import one entry through
 * `POST /api/v1/providers:import_catalog`. Entries marked `rejected` are
 * disabled with their reason; entries with `needs_base_url` require one.
 */

import { useRef, useState } from 'react';

import { X } from '@phosphor-icons/react';

import type { CatalogProviderItem } from '#/lib/api';
import { useCatalogProviders, useImportCatalogProvider } from '#/lib/queries';
import { catalogProviderFilter } from '#/lib/providers';
import { useModalDialog } from '#/lib/useModalDialog';

export interface CatalogImportDialogProps {
  readonly onClose: () => void;
  readonly onImported?: (providerId: string) => void;
}

const inputClass =
  'min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-background-surface-under)] px-2 py-1 text-[11px] text-[var(--color-text-foreground)] outline-none focus:border-[var(--color-border-heavy)]';

export function CatalogImportDialog({ onClose, onImported }: CatalogImportDialogProps) {
  const catalog = useCatalogProviders();
  const importCatalog = useImportCatalogProvider();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<CatalogProviderItem | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');

  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useModalDialog(dialogRef, onClose, { initialFocusRef: searchRef });

  const items = catalogProviderFilter(query, catalog.data?.items ?? []);
  const pending = importCatalog.isPending;
  const canImport =
    selected !== null && !selected.rejected && (!selected.needs_base_url || baseUrl.trim() !== '') && !pending;

  const doImport = (): void => {
    if (selected === null || !canImport) return;
    importCatalog.mutate(
      {
        catalog_id: selected.id,
        api_key: apiKey.trim() === '' ? undefined : apiKey.trim(),
        base_url: baseUrl.trim() === '' ? undefined : baseUrl.trim(),
      },
      {
        onSuccess: ({ provider }) => {
          onImported?.(provider.id);
          onClose();
        },
      },
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="从 models.dev 目录导入"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        className="flex w-[560px] max-h-[85vh] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border-heavy)] bg-[var(--color-background-surface)] shadow-[var(--shadow-floating-panel)]"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border-light)] px-4 py-2">
          <span className="text-[13px] font-medium text-[var(--color-text-foreground)]">
            从 models.dev 目录导入
          </span>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="rounded-[var(--radius-sm)] p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
          >
            <X size={14} weight="bold" aria-hidden />
          </button>
        </div>

        <div className="px-4 pt-3">
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索 Provider…"
            className={inputClass}
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
          {catalog.isLoading ? (
            <div className="px-3 py-3 text-[12px] text-[var(--color-text-tertiary)]">加载目录…</div>
          ) : catalog.isError ? (
            <div className="px-3 py-3 text-[12px] text-[var(--color-text-danger)]">
              目录不可用{catalog.error instanceof Error ? `：${catalog.error.message}` : ''}
            </div>
          ) : items.length === 0 ? (
            <div className="px-3 py-3 text-[12px] text-[var(--color-text-tertiary)]">没有匹配的 Provider</div>
          ) : (
            <ul>
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    disabled={item.rejected || pending}
                    onClick={() => {
                      setSelected(item);
                      setApiKey('');
                      setBaseUrl('');
                    }}
                    title={item.rejected ? item.reject_reason ?? '该条目当前不可导入' : undefined}
                    className={`flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-2 text-left hover:bg-[var(--color-list-hover)] disabled:cursor-not-allowed disabled:opacity-45 ${
                      selected?.id === item.id ? 'bg-[var(--color-list-active)]' : ''
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-foreground)]">
                      {item.name}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-tertiary)]">{item.id}</span>
                    {item.wire_type !== null ? (
                      <span className="shrink-0 rounded-[var(--radius-xs)] px-1 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
                        {item.wire_type}
                      </span>
                    ) : null}
                    {item.rejected ? (
                      <span className="shrink-0 rounded-[var(--radius-xs)] px-1 py-0.5 text-[10px] text-[var(--color-text-danger)]">
                        不可用
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {selected !== null ? (
          <div className="space-y-3 border-t border-[var(--color-border-light)] px-4 py-3">
            <div className="flex items-center gap-2">
              <label className="w-20 shrink-0 text-[11px] text-[var(--color-text-tertiary)]">API Key</label>
              <input
                type="password"
                value={apiKey}
                disabled={pending}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-…（可选，留空则稍后配置）"
                className={`${inputClass} disabled:opacity-60`}
              />
            </div>
            {selected.needs_base_url ? (
              <div className="flex items-center gap-2">
                <label className="w-20 shrink-0 text-[11px] text-[var(--color-text-tertiary)]">Base URL</label>
                <input
                  type="text"
                  value={baseUrl}
                  disabled={pending}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="该条目需要 base_url（必填）"
                  className={`${inputClass} disabled:opacity-60`}
                />
              </div>
            ) : null}
            <p className="text-[10px] leading-4 text-[var(--color-text-tertiary)]">
              导入 {selected.name} 的全部 {selected.models.length} 个目录模型，并注册为本地
              Provider。
            </p>
            {importCatalog.isError ? (
              <p className="text-[11px] text-[var(--color-text-danger)]">
                {importCatalog.error instanceof Error ? importCatalog.error.message : '导入失败'}
              </p>
            ) : null}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-[var(--radius-sm)] px-3 py-1 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={doImport}
                disabled={!canImport}
                className="rounded-[var(--radius-sm)] bg-[var(--color-button-primary-background)] px-3 py-1 text-[12px] font-medium text-[var(--color-button-primary-foreground)] hover:brightness-110 disabled:opacity-40"
              >
                {pending ? '导入中…' : '导入'}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
