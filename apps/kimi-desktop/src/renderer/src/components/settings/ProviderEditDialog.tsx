/**
 * ProviderEditDialog — create (`provider` is null) or edit a provider.
 *
 * Create mode posts the manual form (`POST /api/v1/providers`: type / id /
 * base_url / api_key / model rows, at least one model).
 *
 * Edit mode prefills from `GET /api/v1/providers/{id}` (the loopback reveals
 * the stored api key) and rebuilds the PUT-required `models` array from the
 * model catalog (`GET /models` filtered by provider, alias prefix stripped) —
 * the provider item alone only carries alias id strings. The api_key input is
 * tri-state on submit: untouched = keep, cleared = remove, changed = replace.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import type { ProviderCatalogItem } from '@moonshot-ai/protocol';

import type { ProviderWireType } from '#/lib/api';
import {
  useCreateProvider,
  useModels,
  useProviderDetail,
  useReplaceProvider,
} from '#/lib/queries';
import { apiKeyPatchTriState, buildProviderModelsFromCatalog, stripAliasPrefix } from '#/lib/providers';
import { useModalDialog } from '#/lib/useModalDialog';

export interface ProviderEditDialogProps {
  /** Provider being edited; `null` opens the create form. */
  readonly provider: ProviderCatalogItem | null;
  readonly onClose: () => void;
}

const WIRE_TYPES: readonly { value: ProviderWireType; label: string }[] = [
  { value: 'kimi', label: 'Kimi' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'openai_responses', label: 'OpenAI Responses' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'google-genai', label: 'Google GenAI' },
  { value: 'vertexai', label: 'Vertex AI' },
];

interface ModelRow {
  readonly key: number;
  readonly model: string;
  readonly maxContextSize: string;
}

const inputClass =
  'min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-background-surface-under)] px-2 py-1 text-[11px] text-[var(--color-text-foreground)] outline-none focus:border-[var(--color-border-heavy)]';

export function ProviderEditDialog({ provider, onClose }: ProviderEditDialogProps) {
  const isEdit = provider !== null;
  const detail = useProviderDetail(isEdit ? provider.id : null);
  const modelsQuery = useModels();
  const createProvider = useCreateProvider();
  const replaceProvider = useReplaceProvider();

  const rebuiltModels = useMemo(
    () =>
      isEdit && modelsQuery.data !== undefined
        ? buildProviderModelsFromCatalog(modelsQuery.data.items, provider.id)
        : [],
    [isEdit, modelsQuery.data, provider?.id],
  );

  const [type, setType] = useState<ProviderWireType>(
    (isEdit ? provider.type : 'openai') as ProviderWireType,
  );
  const [id, setId] = useState(isEdit ? provider.id : '');
  const [baseUrl, setBaseUrl] = useState(isEdit ? (provider.base_url ?? '') : '');
  const [apiKey, setApiKey] = useState('');
  const [defaultModel, setDefaultModel] = useState(
    isEdit ? stripAliasPrefix(provider.default_model ?? '', provider.id) : '',
  );
  const [rows, setRows] = useState<ModelRow[]>(() => [{ key: 0, model: '', maxContextSize: '' }]);
  const nextRowKey = useRef(1);
  const dialogRef = useRef<HTMLDivElement>(null);
  const typeRef = useRef<HTMLSelectElement>(null);
  useModalDialog(dialogRef, onClose, { initialFocusRef: typeRef });

  // The api key arrives with the detail fetch; the item already carried the
  // base_url, so only the key lags behind.
  useEffect(() => {
    if (detail.data !== undefined) setApiKey(detail.data.api_key ?? '');
  }, [detail.data]);

  const pending = createProvider.isPending || replaceProvider.isPending;
  const mutationError = createProvider.error ?? replaceProvider.error;

  const validRows = rows.filter((row) => row.model.trim() !== '' && Number.parseInt(row.maxContextSize, 10) >= 1);
  const canSubmit = isEdit
    ? rebuiltModels.length > 0 && !pending
    : id.trim() !== '' && validRows.length >= 1 && !pending;

  const submit = (): void => {
    if (!canSubmit) return;
    if (isEdit) {
      replaceProvider.mutate(
        {
          providerId: provider.id,
          body: {
            type,
            api_key: apiKeyPatchTriState(detail.data?.api_key, apiKey),
            base_url: baseUrl.trim() === '' ? undefined : baseUrl.trim(),
            default_model: defaultModel.trim() === '' ? undefined : defaultModel.trim(),
            models: rebuiltModels,
          },
        },
        { onSuccess: () => onClose() },
      );
      return;
    }
    createProvider.mutate(
      {
        id: id.trim(),
        type,
        api_key: apiKey.trim() === '' ? undefined : apiKey.trim(),
        base_url: baseUrl.trim() === '' ? undefined : baseUrl.trim(),
        models: validRows.map((row) => ({
          model: row.model.trim(),
          max_context_size: Number.parseInt(row.maxContextSize, 10),
        })),
      },
      { onSuccess: () => onClose() },
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
        aria-label={isEdit ? `编辑 Provider ${provider.id}` : '添加 Provider'}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        className="flex w-[540px] max-h-[85vh] flex-col overflow-hidden rounded-xl border border-[var(--color-border-heavy)] bg-[var(--color-background-surface)] shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border-light)] px-4 py-2.5">
          <span className="text-[13px] font-medium text-[var(--color-text-foreground)]">
            {isEdit ? `编辑 Provider · ${provider.id}` : '添加 Provider'}
          </span>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          <div className="flex items-center gap-2">
            <label className="w-24 shrink-0 text-[11px] text-[var(--gray-500)]">类型</label>
            <select
              ref={typeRef}
              value={type}
              disabled={pending}
              onChange={(event) => setType(event.target.value as ProviderWireType)}
              className="h-7 rounded-lg border border-[var(--color-border)] bg-transparent px-2 text-[11.5px] text-[var(--color-text-foreground)] outline-none focus:border-[var(--color-border-heavy)] disabled:opacity-60"
            >
              {WIRE_TYPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="w-24 shrink-0 text-[11px] text-[var(--gray-500)]">ID</label>
            <input
              type="text"
              value={id}
              disabled={isEdit || pending}
              onChange={(event) => setId(event.target.value)}
              placeholder="如 openai-custom"
              className={`${inputClass} disabled:opacity-60`}
            />
          </div>

          <div className="flex items-center gap-2">
            <label className="w-24 shrink-0 text-[11px] text-[var(--gray-500)]">Base URL</label>
            <input
              type="text"
              value={baseUrl}
              disabled={pending}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.openai.com/v1"
              className={`${inputClass} disabled:opacity-60`}
            />
          </div>

          <div className="flex items-center gap-2">
            <label className="w-24 shrink-0 text-[11px] text-[var(--gray-500)]">API Key</label>
            <input
              type="password"
              value={apiKey}
              disabled={pending}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={isEdit ? '留空 = 保持当前 key' : 'sk-…'}
              className={`${inputClass} disabled:opacity-60`}
            />
          </div>
          {isEdit ? (
            <p className="pl-24 text-[10px] leading-4 text-[var(--gray-500)]">
              清空输入框 = 移除 key；修改后保存 = 替换 key。
            </p>
          ) : null}

          {isEdit ? (
            <div className="flex items-start gap-2">
              <label className="w-24 shrink-0 pt-1 text-[11px] text-[var(--gray-500)]">模型</label>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] leading-5 text-[var(--color-text-secondary)]">
                  共 {rebuiltModels.length} 个模型（来自模型目录，自动同步）
                </p>
                <ul className="mt-1 flex flex-wrap gap-1">
                  {rebuiltModels.map((entry) => (
                    <li
                      key={entry.model}
                      className="rounded-md border border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)]"
                    >
                      {entry.model} · {entry.max_context_size.toLocaleString()}
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex items-center gap-2">
                  <label className="text-[11px] text-[var(--gray-500)]">默认模型</label>
                  <select
                    value={defaultModel}
                    disabled={pending || rebuiltModels.length === 0}
                    onChange={(event) => setDefaultModel(event.target.value)}
                    className="h-7 max-w-[220px] rounded-lg border border-[var(--color-border)] bg-transparent px-2 text-[11.5px] text-[var(--color-text-foreground)] outline-none focus:border-[var(--color-border-heavy)] disabled:opacity-60"
                  >
                    <option value="">未设置</option>
                    {rebuiltModels.map((entry) => (
                      <option key={entry.model} value={entry.model}>
                        {entry.model}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2">
              <label className="w-24 shrink-0 pt-1 text-[11px] text-[var(--gray-500)]">模型</label>
              <div className="min-w-0 flex-1 space-y-1.5">
                {rows.map((row) => (
                  <div key={row.key} className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={row.model}
                      disabled={pending}
                      onChange={(event) =>
                        setRows((current) =>
                          current.map((entry) =>
                            entry.key === row.key ? { ...entry, model: event.target.value } : entry,
                          ),
                        )
                      }
                      placeholder="模型名，如 gpt-4o"
                      className={`${inputClass} disabled:opacity-60`}
                    />
                    <input
                      type="number"
                      min={1}
                      value={row.maxContextSize}
                      disabled={pending}
                      onChange={(event) =>
                        setRows((current) =>
                          current.map((entry) =>
                            entry.key === row.key
                              ? { ...entry, maxContextSize: event.target.value }
                              : entry,
                          ),
                        )
                      }
                      placeholder="上下文大小"
                      className={`${inputClass} w-28 disabled:opacity-60`}
                    />
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        setRows((current) => current.filter((entry) => entry.key !== row.key))
                      }
                      title="移除该模型"
                      className="rounded-md px-1.5 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-danger)] disabled:opacity-50"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    setRows((current) => [
                      ...current,
                      { key: nextRowKey.current++, model: '', maxContextSize: '' },
                    ])
                  }
                  className="rounded-md px-2 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] disabled:opacity-50"
                >
                  + 添加模型（至少一个）
                </button>
              </div>
            </div>
          )}

          {mutationError !== null ? (
            <p className="text-[11px] text-[var(--red-400)]">
              {mutationError instanceof Error ? mutationError.message : '操作失败'}
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border-light)] px-4 py-2.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="rounded-md bg-[var(--gray-1000)] px-3 py-1 text-[12px] font-medium text-[var(--color-text-foreground)] hover:bg-[var(--gray-900)] disabled:opacity-40"
          >
            {pending ? '保存中…' : isEdit ? '保存' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}
