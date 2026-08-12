/**
 * ProviderEditDialog — the detail pane for one provider. Provider connection
 * fields and model rows share one explicit save boundary because the server's
 * PUT contract replaces the provider and its model list together.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  ArrowsClockwise,
  CaretDown,
  CaretRight,
  Eye,
  EyeSlash,
  Pencil,
  Plus,
  Trash,
  X,
} from '@phosphor-icons/react';

import type { ProviderCatalogItem, ProviderCatalogStatus } from '@moonshot-ai/protocol';

import type { CreateProviderModel, ProviderWireType } from '#/lib/api';
import {
  useCreateProvider,
  useDeleteProvider,
  useModels,
  useProviderDetail,
  useRefreshProvider,
  useReplaceProvider,
} from '#/lib/queries';
import {
  apiKeyPatchTriState,
  buildProviderModelsFromCatalog,
  stripAliasPrefix,
} from '#/lib/providers';
import { useModalDialog } from '#/lib/useModalDialog';

export interface ProviderEditDialogProps {
  readonly provider: ProviderCatalogItem | null;
  readonly onClose: () => void;
  readonly onSaved: (providerId: string) => void;
  readonly onDeleted?: () => void;
  readonly onModalOpenChange: (open: boolean) => void;
}

const WIRE_TYPES: readonly { value: ProviderWireType; label: string }[] = [
  { value: 'kimi', label: 'Kimi' },
  { value: 'openai', label: 'OpenAI Chat Completions' },
  { value: 'openai_responses', label: 'OpenAI Responses' },
  { value: 'anthropic', label: 'Anthropic Messages' },
  { value: 'google-genai', label: 'Google GenAI' },
  { value: 'vertexai', label: 'Vertex AI' },
];

const STATUS_LABEL: Record<ProviderCatalogStatus, string> = {
  connected: '已启用',
  error: '连接异常',
  unconfigured: '未配置',
};

type ModelMetadata = Omit<CreateProviderModel, 'model' | 'max_context_size'>;

interface ModelRow {
  readonly key: number;
  readonly model: string;
  readonly maxContextSize: string;
  readonly metadata: ModelMetadata;
}

interface ModelDraft {
  readonly key: number | null;
  readonly model: string;
  readonly maxContextSize: string;
  readonly displayName: string;
  readonly maxOutputSize: string;
  readonly metadata: ModelMetadata;
}

const inputClass =
  'h-9 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-background-panel)] px-3 text-[length:var(--client-content-font-size)] text-[var(--color-text-foreground)] outline-none transition-colors placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-border-focus)] disabled:cursor-not-allowed disabled:opacity-55';

function rowsFromModels(models: readonly CreateProviderModel[]): ModelRow[] {
  return models.map(({ model, max_context_size, ...metadata }, index) => ({
    key: index,
    model,
    maxContextSize: String(max_context_size),
    metadata,
  }));
}

function modelBody(rows: readonly ModelRow[]): CreateProviderModel[] {
  return rows.map((row) => ({
    ...row.metadata,
    model: row.model.trim(),
    max_context_size: Number.parseInt(row.maxContextSize, 10),
  }));
}

function draftFromRow(row: ModelRow): ModelDraft {
  return {
    key: row.key,
    model: row.model,
    maxContextSize: row.maxContextSize,
    displayName: row.metadata.display_name ?? '',
    maxOutputSize:
      row.metadata.max_output_size === undefined ? '' : String(row.metadata.max_output_size),
    metadata: row.metadata,
  };
}

export function ProviderEditDialog({
  provider,
  onClose,
  onSaved,
  onDeleted,
  onModalOpenChange,
}: ProviderEditDialogProps) {
  const isEdit = provider !== null;
  const detail = useProviderDetail(isEdit ? provider.id : null);
  const modelsQuery = useModels();
  const createProvider = useCreateProvider();
  const replaceProvider = useReplaceProvider();
  const deleteProvider = useDeleteProvider();
  const refreshProvider = useRefreshProvider();

  const providerModels = useMemo(
    () =>
      isEdit && modelsQuery.data !== undefined
        ? buildProviderModelsFromCatalog(modelsQuery.data.items, provider.id)
        : [],
    [isEdit, modelsQuery.data, provider],
  );

  const [type, setType] = useState<ProviderWireType>(
    (isEdit ? provider.type : 'openai') as ProviderWireType,
  );
  const [id, setId] = useState(isEdit ? provider.id : '');
  const [baseUrl, setBaseUrl] = useState(isEdit ? (provider.base_url ?? '') : '');
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [defaultModel, setDefaultModel] = useState(
    isEdit ? stripAliasPrefix(provider.default_model ?? '', provider.id) : '',
  );
  const [rows, setRows] = useState<ModelRow[]>([]);
  const [modelDraft, setModelDraft] = useState<ModelDraft | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const nextRowKey = useRef(0);
  const modelsInitialized = useRef(!isEdit);
  const apiKeyInitialized = useRef(!isEdit);

  useEffect(() => {
    if (!isEdit || modelsQuery.data === undefined || modelsInitialized.current) return;
    const nextRows = rowsFromModels(providerModels);
    setRows(nextRows);
    nextRowKey.current = nextRows.length;
    modelsInitialized.current = true;
  }, [isEdit, modelsQuery.data, providerModels]);

  useEffect(() => {
    if (detail.data === undefined || apiKeyInitialized.current) return;
    setApiKey(detail.data.api_key ?? '');
    apiKeyInitialized.current = true;
  }, [detail.data]);

  const modelModalOpen = modelDraft !== null;
  useEffect(() => {
    onModalOpenChange(modelModalOpen);
    return () => onModalOpenChange(false);
  }, [modelModalOpen, onModalOpenChange]);

  const pending =
    createProvider.isPending ||
    replaceProvider.isPending ||
    deleteProvider.isPending ||
    refreshProvider.isPending;
  const mutationError =
    createProvider.error ?? replaceProvider.error ?? deleteProvider.error ?? refreshProvider.error;
  const modelsReady = !isEdit || modelsQuery.data !== undefined;
  const trimmedModels = rows.map((row) => row.model.trim());
  const rowsValid = rows.every(
    (row) => row.model.trim() !== '' && Number.parseInt(row.maxContextSize, 10) >= 1,
  );
  const modelsUnique = new Set(trimmedModels).size === trimmedModels.length;
  const canSubmit =
    id.trim() !== '' && modelsReady && rows.length > 0 && rowsValid && modelsUnique && !pending;

  const reset = (): void => {
    setModelDraft(null);
    if (!isEdit) {
      onClose();
      return;
    }
    setType(provider.type as ProviderWireType);
    setId(provider.id);
    setBaseUrl(provider.base_url ?? '');
    setApiKey(detail.data?.api_key ?? '');
    setDefaultModel(stripAliasPrefix(provider.default_model ?? '', provider.id));
    setRows(rowsFromModels(providerModels));
    setConfirmingDelete(false);
  };

  const submit = (): void => {
    if (!canSubmit) return;
    const models = modelBody(rows);
    if (!isEdit) {
      createProvider.mutate(
        {
          id: id.trim(),
          type,
          api_key: apiKey.trim() === '' ? undefined : apiKey.trim(),
          base_url: baseUrl.trim() === '' ? undefined : baseUrl.trim(),
          default_model: defaultModel === '' ? undefined : defaultModel,
          models,
        },
        { onSuccess: (created) => onSaved(created.id) },
      );
      return;
    }

    replaceProvider.mutate(
      {
        providerId: provider.id,
        body: {
          type,
          api_key: apiKeyPatchTriState(detail.data?.api_key, apiKey),
          base_url: baseUrl.trim() === '' ? undefined : baseUrl.trim(),
          default_model: defaultModel === '' ? undefined : defaultModel,
          models,
        },
      },
      { onSuccess: ({ provider: saved }) => onSaved(saved.id) },
    );
  };

  const saveModelDraft = (draft: ModelDraft): void => {
    const displayName = draft.displayName.trim();
    const maxOutputSize = Number.parseInt(draft.maxOutputSize, 10);
    const metadata: ModelMetadata = {
      ...draft.metadata,
      display_name: displayName === '' ? undefined : displayName,
      max_output_size: Number.isFinite(maxOutputSize) && maxOutputSize >= 1 ? maxOutputSize : undefined,
    };

    if (draft.key === null) {
      const key = nextRowKey.current++;
      setRows((current) => [
        ...current,
        {
          key,
          model: draft.model.trim(),
          maxContextSize: draft.maxContextSize,
          metadata,
        },
      ]);
    } else {
      const currentRow = rows.find((row) => row.key === draft.key);
      if (currentRow !== undefined && defaultModel === currentRow.model) {
        setDefaultModel(draft.model.trim());
      }
      setRows((current) =>
        current.map((row) =>
          row.key === draft.key
            ? {
                ...row,
                model: draft.model.trim(),
                maxContextSize: draft.maxContextSize,
                metadata,
              }
            : row,
        ),
      );
    }
    setModelDraft(null);
  };

  const removeModel = (key: number): void => {
    const removed = rows.find((row) => row.key === key);
    if (removed?.model === defaultModel) setDefaultModel('');
    setRows((current) => current.filter((row) => row.key !== key));
  };

  const addModel = (): void => {
    setModelDraft({
      key: null,
      model: '',
      maxContextSize: '',
      displayName: '',
      maxOutputSize: '',
      metadata: {},
    });
  };

  const refreshModels = (): void => {
    if (!isEdit) return;
    refreshProvider.mutate(provider.id, {
      onSuccess: () => {
        void modelsQuery.refetch().then(({ data }) => {
          if (data === undefined) return;
          const refreshed = buildProviderModelsFromCatalog(data.items, provider.id);
          const nextRows = rowsFromModels(refreshed);
          setRows(nextRows);
          nextRowKey.current = nextRows.length;
          setModelDraft(null);
        });
      },
    });
  };

  const deleteCurrentProvider = (): void => {
    if (!isEdit) return;
    deleteProvider.mutate(provider.id, { onSuccess: () => onDeleted?.() });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-background-panel)]">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-[var(--color-border-light)] px-5 py-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[17px] font-semibold text-[var(--color-text-foreground)]">
              {isEdit ? provider.id : '添加供应商'}
            </h2>
            {isEdit ? <StatusBadge status={provider.status} /> : null}
          </div>
          <p className="mt-0.5 text-[12px] text-[var(--color-text-tertiary)]">
            {isEdit ? `${rows.length} 个模型` : '配置接入信息后，手动添加可用模型。'}
          </p>
        </div>

        {isEdit ? (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={refreshModels}
              disabled={pending}
              title="刷新模型列表"
              aria-label="刷新模型列表"
              className="ui-pressable rounded-[var(--radius-sm)] p-2 text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] disabled:opacity-50"
            >
              <ArrowsClockwise size={16} weight="regular" aria-hidden />
            </button>
            {confirmingDelete ? (
              <div className="flex items-center gap-1 pl-1">
                <span className="text-[12px] text-[var(--color-text-secondary)]">删除供应商？</span>
                <button
                  type="button"
                  onClick={deleteCurrentProvider}
                  disabled={pending}
                  className="rounded-[var(--radius-sm)] px-2 py-1 text-[12px] font-medium text-[var(--color-text-danger)] hover:bg-[var(--color-list-hover)] disabled:opacity-50"
                >
                  删除
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={pending}
                  className="rounded-[var(--radius-sm)] px-2 py-1 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] disabled:opacity-50"
                >
                  取消
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                disabled={pending}
                title="删除供应商"
                aria-label="删除供应商"
                className="ui-pressable rounded-[var(--radius-sm)] p-2 text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-danger)] disabled:opacity-50"
              >
                <Trash size={16} weight="regular" aria-hidden />
              </button>
            )}
          </div>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border-light)] bg-[var(--color-background-muted)] p-4">
          <div className="space-y-3.5">
            {!isEdit ? (
              <StackedField label="供应商名称">
                <input
                  type="text"
                  value={id}
                  disabled={pending}
                  onChange={(event) => setId(event.target.value)}
                  placeholder="例如：qwen"
                  className={`${inputClass} w-full`}
                />
              </StackedField>
            ) : null}

            <StackedField label="Base URL">
              <input
                type="url"
                value={baseUrl}
                disabled={pending}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://api.example.com/v1"
                className={`${inputClass} w-full`}
              />
            </StackedField>

            <StackedField label="API 格式">
              <select
                value={type}
                disabled={pending}
                onChange={(event) => setType(event.target.value as ProviderWireType)}
                className={`${inputClass} w-full`}
              >
                {WIRE_TYPES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </StackedField>

            <StackedField label="API Key">
              <div className="relative">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  disabled={pending}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={isEdit ? '未配置' : '输入 API Key'}
                  className={`${inputClass} w-full pr-10`}
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey((visible) => !visible)}
                  disabled={pending}
                  aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
                  className="absolute inset-y-0 right-1 flex w-8 items-center justify-center rounded-[var(--radius-xs)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-secondary)] disabled:opacity-50"
                >
                  {showApiKey ? (
                    <EyeSlash size={15} weight="regular" aria-hidden />
                  ) : (
                    <Eye size={15} weight="regular" aria-hidden />
                  )}
                </button>
              </div>
            </StackedField>
          </div>
        </div>

        <section className="mt-5">
          <div className="mb-2.5 flex items-center justify-between gap-4">
            <h3 className="text-[length:var(--client-content-font-size)] font-medium text-[var(--color-text-secondary)]">模型列表</h3>
            <label className="flex items-center gap-2 text-[13px] text-[var(--color-text-tertiary)]">
              默认模型
              <select
                value={defaultModel}
                disabled={pending || rows.length === 0}
                onChange={(event) => setDefaultModel(event.target.value)}
                className="h-8 max-w-48 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-background-panel)] px-2.5 text-[13px] text-[var(--color-text-foreground)] outline-none focus:border-[var(--color-border-focus)] disabled:opacity-55"
              >
                <option value="">未设置</option>
                {rows.map((row) => (
                  <option key={row.key} value={row.model}>
                    {row.model}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {!modelsReady ? (
            <p className="rounded-[var(--radius-sm)] border border-[var(--color-border-light)] px-3 py-4 text-center text-[13px] text-[var(--color-text-tertiary)]">
              加载模型列表…
            </p>
          ) : (
            <ul className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-background-panel)]">
              {rows.map((row, index) => (
                <ModelListRow
                  key={row.key}
                  row={row}
                  last={index === rows.length - 1}
                  pending={pending}
                  isDefault={defaultModel === row.model}
                  onEdit={() => setModelDraft(draftFromRow(row))}
                  onRemove={() => removeModel(row.key)}
                />
              ))}
              {rows.length === 0 ? (
                <li className="px-3 py-5 text-center text-[13px] text-[var(--color-text-tertiary)]">
                  暂未配置模型，请手动添加
                </li>
              ) : null}
            </ul>
          )}

          <button
            type="button"
            onClick={addModel}
            disabled={pending || !modelsReady}
            className="ui-pressable mt-2 inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--color-background-button-secondary)] px-3 text-[13px] text-[var(--color-text-secondary)] hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)] disabled:opacity-50"
          >
            <Plus size={15} weight="regular" aria-hidden />
            添加模型
          </button>
        </section>

        {!modelsUnique ? (
          <p role="alert" className="mt-3 text-[12px] text-[var(--color-text-danger)]">
            模型名称不能重复。
          </p>
        ) : null}
        {mutationError !== null ? (
          <p role="alert" className="mt-3 text-[12px] text-[var(--color-text-danger)]">
            {mutationError instanceof Error ? mutationError.message : '操作失败'}
          </p>
        ) : null}
      </div>

      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--color-border-light)] px-5 py-3">
        <button
          type="button"
          onClick={reset}
          disabled={pending}
          className="ui-pressable rounded-[var(--radius-sm)] px-3 py-1.5 text-[length:var(--client-content-font-size)] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] disabled:opacity-50"
        >
          {isEdit ? '撤销修改' : '取消'}
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="ui-pressable rounded-[var(--radius-sm)] bg-[var(--color-button-primary-background)] px-3.5 py-1.5 text-[length:var(--client-content-font-size)] font-medium text-[var(--color-button-primary-foreground)] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {createProvider.isPending || replaceProvider.isPending
            ? '保存中…'
            : isEdit
              ? '保存更改'
              : '添加供应商'}
        </button>
      </footer>

      {modelDraft !== null ? (
        <ModelEditDialog
          draft={modelDraft}
          duplicate={rows.some(
            (row) => row.key !== modelDraft.key && row.model.trim() === modelDraft.model.trim(),
          )}
          onChange={setModelDraft}
          onClose={() => setModelDraft(null)}
          onSave={saveModelDraft}
        />
      ) : null}
    </div>
  );
}

function StatusBadge({ status }: { readonly status: ProviderCatalogStatus }) {
  const connected = status === 'connected';
  const error = status === 'error';
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[12px] font-medium ${
        connected
          ? 'bg-[color-mix(in_srgb,var(--color-text-success)_12%,transparent)] text-[var(--color-text-success)]'
          : error
            ? 'bg-[color-mix(in_srgb,var(--color-text-danger)_12%,transparent)] text-[var(--color-text-danger)]'
            : 'bg-[var(--color-background-muted)] text-[var(--color-text-secondary)]'
      }`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

interface StackedFieldProps {
  readonly label: string;
  readonly children: ReactNode;
}

function StackedField({ label, children }: StackedFieldProps) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] text-[var(--color-text-secondary)]">{label}</span>
      {children}
    </label>
  );
}

interface ModelListRowProps {
  readonly row: ModelRow;
  readonly last: boolean;
  readonly pending: boolean;
  readonly isDefault: boolean;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}

function ModelListRow({ row, last, pending, isDefault, onEdit, onRemove }: ModelListRowProps) {
  return (
    <li
      className={`flex min-h-11 items-center gap-2 px-3 ${
        last ? '' : 'border-b border-[var(--color-border-light)]'
      }`}
    >
      <span className="min-w-0 flex-1 truncate text-[length:var(--client-content-font-size)] text-[var(--color-text-foreground)]">
        {row.model}
      </span>
      {isDefault ? (
        <span className="rounded-full bg-[var(--color-list-active)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-list-active-foreground)]">
          默认
        </span>
      ) : null}
      <span className="shrink-0 rounded-[var(--radius-xs)] bg-[var(--color-background-muted)] px-2 py-0.5 font-mono text-[11px] text-[var(--color-text-secondary)]">
        {formatContextSize(Number.parseInt(row.maxContextSize, 10))}
      </span>
      <button
        type="button"
        onClick={onEdit}
        disabled={pending}
        aria-label={`编辑模型 ${row.model}`}
        title="编辑模型"
        className="ui-pressable rounded-[var(--radius-sm)] p-2 text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] disabled:opacity-50"
      >
        <Pencil size={14} weight="regular" aria-hidden />
      </button>
      <button
        type="button"
        onClick={onRemove}
        disabled={pending}
        aria-label={`移除模型 ${row.model}`}
        title="保存后移除该模型"
        className="ui-pressable rounded-[var(--radius-sm)] p-2 text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-danger)] disabled:opacity-50"
      >
        <Trash size={14} weight="regular" aria-hidden />
      </button>
    </li>
  );
}

interface ModelEditDialogProps {
  readonly draft: ModelDraft;
  readonly duplicate: boolean;
  readonly onChange: (draft: ModelDraft) => void;
  readonly onClose: () => void;
  readonly onSave: (draft: ModelDraft) => void;
}

function ModelEditDialog({ draft, duplicate, onChange, onClose, onSave }: ModelEditDialogProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const modelInputRef = useRef<HTMLInputElement>(null);
  useModalDialog(dialogRef, onClose, { initialFocusRef: modelInputRef });

  const contextSize = Number.parseInt(draft.maxContextSize, 10);
  const maxOutputSize = Number.parseInt(draft.maxOutputSize, 10);
  const valid =
    draft.model.trim() !== '' &&
    Number.isFinite(contextSize) &&
    contextSize >= 1 &&
    (draft.maxOutputSize === '' || (Number.isFinite(maxOutputSize) && maxOutputSize >= 1)) &&
    !duplicate;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 px-6 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={draft.key === null ? '添加模型配置' : '编辑模型配置'}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        className="w-[576px] max-w-full overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border-heavy)] bg-[var(--color-background-panel)] shadow-[var(--shadow-floating-panel)] outline-none"
      >
        <header className="flex items-center justify-between px-5 pb-2.5 pt-4">
          <h3 className="text-[15px] font-semibold text-[var(--color-text-foreground)]">
            {draft.key === null ? '添加模型配置' : '编辑模型配置'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭模型配置"
            className="ui-pressable rounded-[var(--radius-sm)] p-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
          >
            <X size={15} weight="regular" aria-hidden />
          </button>
        </header>

        <div className="space-y-3 px-5 pb-1">
          <StackedField label="模型 ID">
            <input
              ref={modelInputRef}
              type="text"
              value={draft.model}
              onChange={(event) => onChange({ ...draft, model: event.target.value })}
              placeholder="例如：GLM-5-Turbo"
              className={`${inputClass} h-8 w-full`}
            />
          </StackedField>

          <StackedField label="上下文窗口">
            <input
              type="number"
              min={1}
              value={draft.maxContextSize}
              onChange={(event) => onChange({ ...draft, maxContextSize: event.target.value })}
              placeholder="例如：204800"
              className={`${inputClass} h-8 w-full`}
            />
          </StackedField>

          <button
            type="button"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((open) => !open)}
            className="ui-pressable flex h-8 items-center gap-2 rounded-[var(--radius-sm)] px-1 text-[13px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-foreground)]"
          >
            {advancedOpen ? (
              <CaretDown size={14} weight="regular" aria-hidden />
            ) : (
              <CaretRight size={14} weight="regular" aria-hidden />
            )}
            高级
          </button>

          {advancedOpen ? (
            <div className="grid grid-cols-2 gap-3 rounded-[var(--radius-md)] bg-[var(--color-background-muted)] p-3">
              <StackedField label="显示名称（可选）">
                <input
                  type="text"
                  value={draft.displayName}
                  onChange={(event) => onChange({ ...draft, displayName: event.target.value })}
                  placeholder="用于界面显示"
                  className={`${inputClass} w-full`}
                />
              </StackedField>
              <StackedField label="最大输出长度（可选）">
                <input
                  type="number"
                  min={1}
                  value={draft.maxOutputSize}
                  onChange={(event) => onChange({ ...draft, maxOutputSize: event.target.value })}
                  placeholder="例如：8192"
                  className={`${inputClass} w-full`}
                />
              </StackedField>
            </div>
          ) : null}

          {duplicate ? (
            <p role="alert" className="text-[12px] text-[var(--color-text-danger)]">
              已存在同名模型。
            </p>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 px-5 pb-4 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="ui-pressable rounded-[var(--radius-sm)] border border-[var(--color-border)] px-3 py-1 text-[length:var(--client-content-font-size)] text-[var(--color-text-foreground)] hover:bg-[var(--color-list-hover)]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onSave(draft)}
            disabled={!valid}
            className="ui-pressable rounded-[var(--radius-sm)] bg-[var(--color-text-foreground)] px-3.5 py-1 text-[length:var(--client-content-font-size)] font-medium text-[var(--color-background-panel)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35"
          >
            保存
          </button>
        </footer>
      </div>
    </div>
  );
}

function formatContextSize(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}K`;
  return String(value);
}
