/**
 * ProviderManager — the M8 provider CRUD surface: list configured providers
 * (`GET /api/v1/providers`, credentials redacted) with per-row edit / refresh /
 * delete (inline y/N confirm), plus two add paths — manual create and
 * models.dev catalog import. Opens from Settings as a nested modal (z-50).
 */

import { useEffect, useState } from 'react';

import type { ProviderCatalogItem, ProviderCatalogStatus } from '@moonshot-ai/protocol';

import { ApiError } from '#/lib/api';
import { useDeleteProvider, useProviders, useRefreshProvider } from '#/lib/queries';
import { PROVIDER_STATUS_LABELS } from '#/lib/providers';

import { CatalogImportDialog } from './CatalogImportDialog';
import { ProviderEditDialog } from './ProviderEditDialog';

export interface ProviderManagerProps {
  readonly onClose: () => void;
}

const STATUS_TONES: Record<ProviderCatalogStatus, string> = {
  connected: 'var(--color-text-success)',
  error: 'var(--color-text-danger)',
  unconfigured: 'var(--color-text-secondary)',
};

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `操作失败（${error.code}）`;
  return '操作失败';
}

export function ProviderManager({ onClose }: ProviderManagerProps) {
  const providers = useProviders();
  const deleteProvider = useDeleteProvider();
  const refreshProvider = useRefreshProvider();
  /** `null` = dialog closed; `{provider: null}` = create form; `{provider}` = edit. */
  const [editing, setEditing] = useState<{ readonly provider: ProviderCatalogItem | null } | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const items = providers.data?.items ?? [];
  const pending = deleteProvider.isPending || refreshProvider.isPending;
  const mutationError = deleteProvider.error ?? refreshProvider.error;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      // Only the backdrop itself closes the manager — the nested dialogs
      // (edit / catalog) render inside this overlay and must not cascade.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Provider 管理"
        onMouseDown={(event) => event.stopPropagation()}
        className="flex w-[640px] max-h-[85vh] flex-col overflow-hidden rounded-xl border border-[var(--color-border-heavy)] bg-[var(--color-background-surface)] shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border-light)] px-4 py-2.5">
          <span className="text-[13px] font-medium text-[var(--color-text-foreground)]">Provider 管理</span>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {providers.isLoading ? (
            <div className="px-3 py-3 text-[12px] text-[var(--gray-500)]">加载中…</div>
          ) : providers.isError ? (
            <div className="px-3 py-3 text-[12px] text-[var(--red-400)]">
              无法读取 Provider 列表
              {providers.error instanceof Error ? `：${providers.error.message}` : ''}
            </div>
          ) : items.length === 0 ? (
            <div className="px-3 py-3 text-[12px] text-[var(--gray-500)]">
              还没有配置任何 Provider —— 从目录导入或手动添加一个。
            </div>
          ) : (
            <ul className="space-y-1">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center gap-3 rounded-lg border border-[var(--color-border-light)] px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-mono text-[12px] text-[var(--color-text-foreground)]">
                        {item.id}
                      </span>
                      <span
                        className="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                        style={{ color: STATUS_TONES[item.status], backgroundColor: 'var(--color-list-hover)' }}
                      >
                        {PROVIDER_STATUS_LABELS[item.status]}
                      </span>
                      <span className="shrink-0 text-[10px] text-[var(--gray-500)]">{item.type}</span>
                    </div>
                    <p className="mt-0.5 truncate text-[10px] text-[var(--gray-500)]">
                      {item.base_url ?? '（默认端点）'}
                      {item.default_model !== undefined ? ` · 默认 ${item.default_model}` : ''}
                      {item.models !== undefined ? ` · ${item.models.length} 模型` : ''}
                      {item.has_api_key ? ' · 已配置 Key' : ' · 无 Key'}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {confirmingDelete === item.id ? (
                      <>
                        <span className="text-[11px] text-[var(--color-text-secondary)]">删除？</span>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => deleteProvider.mutate(item.id)}
                          className="rounded-md px-2 py-1 text-[11px] font-medium text-[var(--color-text-danger)] hover:bg-[var(--color-list-hover)] disabled:opacity-50"
                        >
                          y
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => setConfirmingDelete(null)}
                          className="rounded-md px-2 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] disabled:opacity-50"
                        >
                          N
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => setEditing({ provider: item })}
                          className="rounded-md px-2 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] disabled:opacity-50"
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => refreshProvider.mutate(item.id)}
                          title="重新拉取该 Provider 的模型列表"
                          className="rounded-md px-2 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] disabled:opacity-50"
                        >
                          刷新
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => setConfirmingDelete(item.id)}
                          className="rounded-md px-2 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-danger)] disabled:opacity-50"
                        >
                          删除
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {mutationError !== null ? (
            <p className="px-3 pt-2 text-[11px] text-[var(--red-400)]">{errorMessage(mutationError)}</p>
          ) : null}
        </div>

        <div className="flex items-center gap-2 border-t border-[var(--color-border-light)] px-4 py-2.5">
          <button
            type="button"
            onClick={() => setCatalogOpen(true)}
            className="rounded-md border border-[var(--color-border-heavy)] px-3 py-1 text-[12px] text-[var(--color-text-foreground)] hover:bg-[var(--color-list-hover)]"
          >
            从目录导入…
          </button>
          <button
            type="button"
            onClick={() => setEditing({ provider: null })}
            className="rounded-md border border-[var(--color-border)] px-3 py-1 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
          >
            手动添加…
          </button>
          <div className="ml-auto" />
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
          >
            关闭
          </button>
        </div>
      </div>

      {editing !== null ? (
        <ProviderEditDialog provider={editing.provider} onClose={() => setEditing(null)} />
      ) : null}
      {catalogOpen ? <CatalogImportDialog onClose={() => setCatalogOpen(false)} /> : null}
    </div>
  );
}
