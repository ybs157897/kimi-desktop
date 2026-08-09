import type {
  AgentProfileColor,
  AgentProfileDescriptor,
  CreateAgentProfileRequest,
  ModelCatalogItem,
  UpdateAgentProfileRequest,
} from '@moonshot-ai/protocol';
import {
  ArrowLeft,
  CaretDown,
  CaretRight,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Robot,
  Trash,
} from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  useCreateAgentProfile,
  useDeleteAgentProfile,
  useSetAgentProfileEnabled,
  useUpdateAgentProfile,
} from '#/lib/queries';
import { ModelSelect } from '../composer/ModelSelect';

type BindingFilter = 'all' | 'custom' | 'automatic';

export interface SubagentSettingsProps {
  readonly profiles?: readonly AgentProfileDescriptor[];
  readonly models?: readonly ModelCatalogItem[];
  readonly bindings: Readonly<Record<string, string>>;
  readonly pending: boolean;
  readonly loading: boolean;
  readonly error?: string;
  readonly onBindingChange: (profile: string, model: string) => void;
  readonly onModelMenuOpenChange?: (open: boolean) => void;
}

const DESCRIPTION_BY_PROFILE: Readonly<Record<string, string>> = {
  coder: '执行软件工程任务，可读取和修改文件、运行命令并完成验证。',
  explore: '只读探索代码库，适合搜索文件、定位实现和梳理调用关系。',
  plan: '只读制定实现计划，识别关键文件并分析架构取舍。',
};

const PROFILE_COLORS = [
  { id: 'amber', value: '#fbbf24', label: '琥珀' },
  { id: 'coral', value: '#fb7185', label: '珊瑚' },
  { id: 'orange', value: '#fb923c', label: '橙色' },
  { id: 'mint', value: '#5eead4', label: '薄荷' },
  { id: 'cyan', value: '#22d3ee', label: '青色' },
  { id: 'blue', value: '#60a5fa', label: '蓝色' },
  { id: 'violet', value: '#a78bfa', label: '紫色' },
  { id: 'pink', value: '#f472b6', label: '粉色' },
] as const satisfies readonly {
  readonly id: AgentProfileColor;
  readonly value: string;
  readonly label: string;
}[];

const DEFAULT_PROFILE_COLOR: AgentProfileColor = 'mint';

interface AgentEditorProps {
  readonly profile?: AgentProfileDescriptor;
  readonly models?: readonly ModelCatalogItem[];
  readonly model: string;
  readonly onBindingChange: (profile: string, model: string) => void;
  readonly onClose: () => void;
  readonly onModelMenuOpenChange: (open: boolean) => void;
}

function AgentEditor({
  profile,
  models,
  model,
  onBindingChange,
  onClose,
  onModelMenuOpenChange,
}: AgentEditorProps) {
  const creating = profile === undefined;
  const createProfile = useCreateAgentProfile();
  const updateProfile = useUpdateAgentProfile();
  const deleteProfile = useDeleteAgentProfile();
  const [name, setName] = useState(profile?.name ?? '');
  const [description, setDescription] = useState(profile?.description ?? '');
  const [whenToUse, setWhenToUse] = useState(profile?.when_to_use ?? '');
  const [color, setColor] = useState<AgentProfileColor>(normalizeProfileColor(profile?.color));
  const [prompt, setPrompt] = useState(profile?.prompt ?? '');
  const [tools, setTools] = useState(profile?.tools?.join(', ') ?? '');
  const [disallowedTools, setDisallowedTools] = useState(
    profile?.disallowed_tools?.join(', ') ?? '',
  );
  const [subagents, setSubagents] = useState(profile?.subagents?.join(', ') ?? '');
  const [selectedModel, setSelectedModel] = useState(model);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const pending = createProfile.isPending || updateProfile.isPending || deleteProfile.isPending;
  const mutationError = createProfile.error ?? updateProfile.error ?? deleteProfile.error;

  useEffect(() => {
    onModelMenuOpenChange(modelMenuOpen);
    return () => onModelMenuOpenChange(false);
  }, [modelMenuOpen, onModelMenuOpenChange]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || modelMenuOpen) return;
      event.preventDefault();
      event.stopPropagation();
      if (deleteConfirm) {
        setDeleteConfirm(false);
        return;
      }
      onClose();
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [deleteConfirm, modelMenuOpen, onClose]);

  const submit = async (): Promise<void> => {
    const fields = {
      description: description.trim(),
      when_to_use: optionalText(whenToUse),
      color,
      tools: csv(tools),
      disallowed_tools: csv(disallowedTools),
      subagents: csv(subagents),
      prompt: prompt.trim(),
    } satisfies UpdateAgentProfileRequest;

    if (creating) {
      const body = {
        ...fields,
        name: name.trim(),
        enabled: true,
      } satisfies CreateAgentProfileRequest;
      const created = await createProfile.mutateAsync(body);
      if (selectedModel !== '') onBindingChange(created.name, selectedModel);
    } else {
      await updateProfile.mutateAsync({ name: profile.name, body: fields });
      if (selectedModel !== model) onBindingChange(profile.name, selectedModel);
    }
    onClose();
  };

  const remove = async (): Promise<void> => {
    if (profile === undefined) return;
    await deleteProfile.mutateAsync(profile.name);
    onClose();
  };

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={onClose}
        className="ui-pressable mb-4 flex h-8 items-center gap-1.5 rounded-[var(--radius-sm)] px-2 text-[13px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
      >
        <ArrowLeft size={14} weight="bold" aria-hidden />
        返回子智能体列表
      </button>

      <section
        aria-labelledby="agent-editor-title"
        className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-background-panel)] shadow-[var(--shadow-card)]"
      >
        <header className="border-b border-[var(--color-border-light)] px-5 py-4">
          <h2
            id="agent-editor-title"
            className="text-[15px] font-semibold text-[var(--color-text-foreground)]"
          >
            {creating ? '创建子智能体' : '编辑子智能体'}
          </h2>
          <p className="mt-1 text-[12px] leading-5 text-[var(--color-text-tertiary)]">
            {creating ? '配置新的用户级子智能体，创建后返回列表。' : '修改子智能体配置，保存后返回列表。'}
          </p>
        </header>

        <form
          className="px-5 py-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-4">
            <Field label="名称" hint={creating ? '小写字母、数字和连字符' : '创建后不可修改'}>
              <input
                ref={nameRef}
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={!creating}
                required
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                placeholder="例如 code-reviewer"
                className={inputClassName}
              />
            </Field>
            <ColorPicker value={color} onChange={setColor} />
            <Field label="独立模型" hint="留空时遵循自动选择规则">
              <ModelSelect
                value={selectedModel}
                models={models}
                onChange={setSelectedModel}
                emptyLabel="自动选择"
                ariaLabel="子智能体使用的模型"
                placement="below"
                submenuSide="left"
                onOpenChange={setModelMenuOpen}
                className="relative w-full"
              />
            </Field>
          </div>

          <div className="mt-4">
            <Field label="描述">
              <input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                required
                placeholder="一句话说明这个子智能体负责什么"
                className={inputClassName}
              />
            </Field>
          </div>

          <div className="mt-4">
            <Field label="适用场景" hint="可选，会帮助主智能体判断何时委派">
              <input
                value={whenToUse}
                onChange={(event) => setWhenToUse(event.target.value)}
                placeholder="例如：合并前进行代码审查"
                className={inputClassName}
              />
            </Field>
          </div>

          <div className="mt-4">
            <Field label="系统提示词">
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                required
                rows={7}
                placeholder="描述角色、工作方式、输出要求和边界…"
                className={`${inputClassName} min-h-36 resize-y py-2.5 leading-5`}
              />
            </Field>
          </div>

          <button
            type="button"
            onClick={() => setAdvancedOpen(!advancedOpen)}
            aria-expanded={advancedOpen}
            className="ui-pressable mt-4 flex h-9 w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 text-left text-[13px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
          >
            <CaretRight
              size={13}
              weight="bold"
              className={`transition-transform ${advancedOpen ? 'rotate-90' : ''}`}
              aria-hidden
            />
            高级能力范围
          </button>

          {advancedOpen ? (
            <div className="mt-2 grid gap-4 rounded-[var(--radius-md)] bg-[var(--color-background-surface-under)] p-4">
              <Field label="允许工具" hint="逗号分隔；留空表示全部工具">
                <input
                  value={tools}
                  onChange={(event) => setTools(event.target.value)}
                  placeholder="Read, Grep, Bash"
                  className={inputClassName}
                />
              </Field>
              <Field label="禁用工具" hint="逗号分隔，会从允许工具中排除">
                <input
                  value={disallowedTools}
                  onChange={(event) => setDisallowedTools(event.target.value)}
                  placeholder="例如 Write, Bash"
                  className={inputClassName}
                />
              </Field>
              <Field label="可委派子智能体" hint="逗号分隔；留空表示不限制">
                <input
                  value={subagents}
                  onChange={(event) => setSubagents(event.target.value)}
                  placeholder="explore, plan"
                  className={inputClassName}
                />
              </Field>
            </div>
          ) : null}

          {mutationError !== null && mutationError !== undefined ? (
            <p role="alert" className="mt-4 text-[12px] text-[var(--color-text-danger)]">
              {mutationError instanceof Error ? mutationError.message : '保存失败'}
            </p>
          ) : null}

          <footer className="mt-5 flex min-h-9 items-center justify-between gap-3 border-t border-[var(--color-border-light)] pt-4">
            {deleteConfirm && profile !== undefined ? (
              <div role="alert" className="flex w-full items-center gap-3">
                <p className="min-w-0 flex-1 text-[12px] text-[var(--color-text-secondary)]">
                  确定删除“{profile.name}”？对应的用户 Agent 文件和独立模型绑定都会移除。
                </p>
                <button
                  type="button"
                  onClick={() => setDeleteConfirm(false)}
                  disabled={pending}
                  className="ui-pressable rounded-[var(--radius-sm)] border border-[var(--color-border)] px-3 py-2 text-[13px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] disabled:opacity-50"
                >
                  保留
                </button>
                <button
                  type="button"
                  onClick={() => void remove()}
                  disabled={pending}
                  className="ui-pressable rounded-[var(--radius-sm)] bg-[var(--color-text-danger)] px-3 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50"
                >
                  {deleteProfile.isPending ? '删除中…' : '确认删除'}
                </button>
              </div>
            ) : (
              <>
                <div>
                  {!creating && profile?.editable === true ? (
                    <button
                      type="button"
                      onClick={() => setDeleteConfirm(true)}
                      disabled={pending}
                      className="ui-pressable flex items-center gap-1.5 rounded-[var(--radius-sm)] px-2 py-2 text-[13px] text-[var(--color-text-danger)] hover:bg-[color-mix(in_srgb,var(--color-text-danger)_10%,transparent)] disabled:opacity-50"
                    >
                      <Trash size={14} weight="regular" aria-hidden />
                      删除
                    </button>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={onClose}
                    disabled={pending}
                    className="ui-pressable rounded-[var(--radius-sm)] border border-[var(--color-border)] px-4 py-2 text-[13px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] disabled:opacity-50"
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={pending}
                    className="ui-pressable rounded-[var(--radius-sm)] bg-[var(--color-button-primary-background)] px-4 py-2 text-[13px] font-medium text-[var(--color-button-primary-foreground)] hover:brightness-110 disabled:opacity-50"
                  >
                    {pending ? '保存中…' : creating ? '创建' : '保存更改'}
                  </button>
                </div>
              </>
            )}
          </footer>
        </form>
      </section>
    </div>
  );
}

function ColorPicker({
  value,
  onChange,
}: {
  readonly value: AgentProfileColor;
  readonly onChange: (color: AgentProfileColor) => void;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1.5 text-[13px] font-medium text-[var(--color-text-secondary)]">
        颜色标记
      </legend>
      <div className="flex h-[38px] items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-background-panel)] px-2">
        {PROFILE_COLORS.map((color) => (
          <button
            key={color.id}
            type="button"
            onClick={() => onChange(color.id)}
            aria-label={color.label}
            aria-pressed={value === color.id}
            title={color.label}
            className={`ui-pressable flex h-6 w-6 items-center justify-center rounded-full ${
              value === color.id
                ? 'ring-1 ring-[var(--color-text-foreground)] ring-offset-2 ring-offset-[var(--color-background-panel)]'
                : 'hover:scale-110'
            }`}
          >
            <span
              className="h-3.5 w-3.5 rounded-full"
              style={{ backgroundColor: color.value }}
              aria-hidden
            />
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center justify-between gap-3 text-[13px] font-medium text-[var(--color-text-secondary)]">
        {label}
        {hint !== undefined ? (
          <span className="font-normal text-[11px] text-[var(--color-text-tertiary)]">{hint}</span>
        ) : null}
      </span>
      {children}
    </label>
  );
}

const inputClassName =
  'w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-background-panel)] px-3 py-2 text-[14px] text-[var(--color-text-foreground)] outline-none placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-border-focus)] disabled:bg-[var(--color-background-muted)] disabled:text-[var(--color-text-tertiary)]';

function normalizeProfileColor(color: string | undefined): AgentProfileColor {
  return PROFILE_COLORS.some((item) => item.id === color)
    ? (color as AgentProfileColor)
    : DEFAULT_PROFILE_COLOR;
}

function profileColorValue(color: string | undefined): string {
  const normalized = normalizeProfileColor(color);
  return PROFILE_COLORS.find((item) => item.id === normalized)?.value ?? '#5eead4';
}

function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function csv(value: string): string[] | undefined {
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return items.length === 0 ? undefined : [...new Set(items)];
}

function profileDescription(profile: AgentProfileDescriptor): string {
  return DESCRIPTION_BY_PROFILE[profile.name] ?? profile.description ?? '子智能体。';
}

function toolLabel(profile: AgentProfileDescriptor): string {
  if (profile.tools === undefined) return '全部工具';
  return `${profile.tools.length} 个工具`;
}

function AgentToggle({
  checked,
  disabled,
  name,
  onChange,
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly name: string;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={`${checked ? '停用' : '启用'} ${name}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
        checked ? 'bg-[var(--primary)]' : 'bg-[var(--color-background-muted)]'
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-0.5'
        }`}
        aria-hidden
      />
    </button>
  );
}

export function SubagentSettings({
  profiles,
  models,
  bindings,
  pending,
  loading,
  error,
  onBindingChange,
  onModelMenuOpenChange,
}: SubagentSettingsProps) {
  const setEnabled = useSetAgentProfileEnabled();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<BindingFilter>('all');
  const [editing, setEditing] = useState<AgentProfileDescriptor | 'create' | undefined>();
  const [rowMenuOpen, setRowMenuOpen] = useState(false);
  const [editorMenuOpen, setEditorMenuOpen] = useState(false);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleProfiles = useMemo(
    () =>
      (profiles ?? []).filter((profile) => {
        const matchesQuery =
          normalizedQuery === '' ||
          profile.name.toLocaleLowerCase().includes(normalizedQuery) ||
          profileDescription(profile).toLocaleLowerCase().includes(normalizedQuery);
        const hasBinding = bindings[profile.name] !== undefined;
        const matchesFilter = filter === 'all' || (filter === 'custom' ? hasBinding : !hasBinding);
        return matchesQuery && matchesFilter;
      }),
    [bindings, filter, normalizedQuery, profiles],
  );
  const userProfiles = visibleProfiles.filter((profile) => profile.source === 'user');
  const builtinProfiles = visibleProfiles.filter((profile) => profile.source === 'builtin');

  useEffect(() => {
    onModelMenuOpenChange?.(editing !== undefined || rowMenuOpen || editorMenuOpen);
    return () => onModelMenuOpenChange?.(false);
  }, [editing, editorMenuOpen, onModelMenuOpenChange, rowMenuOpen]);

  const renderRows = (items: readonly AgentProfileDescriptor[]): ReactNode =>
    items.map((profile, index) => {
      const model = bindings[profile.name] ?? '';
      const isUser = profile.source === 'user';
      const accent = isUser ? profileColorValue(profile.color) : undefined;
      return (
        <article
          key={`${profile.source}:${profile.name}`}
          className={`flex min-h-[108px] items-center gap-4 px-5 py-4 ${
            index === items.length - 1 ? '' : 'border-b border-[var(--color-border-light)]'
          } ${profile.enabled ? '' : 'opacity-60'}`}
        >
          <span
            className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-background-surface-under)] text-[var(--color-text-secondary)]"
            style={
              accent === undefined
                ? undefined
                : {
                    color: accent,
                    borderColor: `${accent}66`,
                    backgroundColor: `${accent}18`,
                  }
            }
          >
            <Robot size={18} weight="regular" aria-hidden />
            <span
              className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--color-background-panel)] ${
                profile.enabled ? 'bg-[var(--color-text-success)]' : 'bg-[var(--color-text-tertiary)]'
              }`}
              aria-hidden
            />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[14px] font-semibold text-[var(--color-text-foreground)]">
                {profile.name}
              </h3>
              <span className="rounded-[var(--radius-sm)] bg-[var(--color-background-muted)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-text-secondary)]">
                {isUser ? '用户' : '内置'}
              </span>
              <span className="rounded-[var(--radius-sm)] bg-[var(--color-background-muted)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-text-secondary)]">
                {toolLabel(profile)}
              </span>
              {model !== '' ? (
                <span className="rounded-[var(--radius-sm)] bg-[var(--color-list-active)] px-2 py-0.5 text-[11px] font-medium text-[var(--primary)]">
                  独立模型
                </span>
              ) : null}
            </div>
            <p className="mt-1.5 line-clamp-2 text-[13px] leading-5 text-[var(--color-text-secondary)]">
              {profileDescription(profile)}
            </p>
            <p className="mt-1 truncate font-mono text-[12px] text-[var(--color-text-tertiary)]">
              {profile.path ?? `built-in:${profile.name}`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ModelSelect
              value={model}
              models={models}
              onChange={(nextModel) => onBindingChange(profile.name, nextModel)}
              disabled={pending}
              emptyLabel="自动选择"
              ariaLabel={`${profile.name} 使用的模型`}
              placement="below"
              submenuSide="left"
              onOpenChange={setRowMenuOpen}
              className="relative w-44 shrink-0"
            />
            {isUser ? (
              <>
                <AgentToggle
                  checked={profile.enabled}
                  disabled={!profile.editable || setEnabled.isPending}
                  name={profile.name}
                  onChange={(enabled) => setEnabled.mutate({ name: profile.name, enabled })}
                />
                <button
                  type="button"
                  onClick={() => setEditing(profile)}
                  disabled={!profile.editable}
                  aria-label={`编辑 ${profile.name}`}
                  title={profile.editable ? '编辑子智能体' : '此文件不在可编辑的用户目录中'}
                  className="ui-pressable flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] disabled:cursor-not-allowed disabled:opacity-35"
                >
                  <PencilSimple size={15} weight="regular" aria-hidden />
                </button>
              </>
            ) : null}
          </div>
        </article>
      );
    });

  if (editing !== undefined) {
    return (
      <section aria-label="子智能体设置">
        <AgentEditor
          profile={editing === 'create' ? undefined : editing}
          models={models}
          model={editing === 'create' ? '' : bindings[editing.name] ?? ''}
          onBindingChange={onBindingChange}
          onClose={() => setEditing(undefined)}
          onModelMenuOpenChange={setEditorMenuOpen}
        />
      </section>
    );
  }

  return (
    <section aria-label="子智能体设置">
      <div className="mb-4 flex gap-3">
        <label className="relative min-w-0 flex-1">
          <MagnifyingGlass
            size={16}
            weight="regular"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)]"
            aria-hidden
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索子智能体…"
            className="h-9 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-background-panel)] pl-9 pr-3 text-[14px] text-[var(--color-text-foreground)] outline-none placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-border-focus)]"
          />
        </label>
        <label className="relative w-36 shrink-0">
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value as BindingFilter)}
            aria-label="筛选子智能体"
            className="h-9 w-full appearance-none rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-background-panel)] px-3 pr-8 text-[14px] text-[var(--color-text-foreground)] outline-none focus:border-[var(--color-border-focus)]"
          >
            <option value="all">全部</option>
            <option value="custom">已指定模型</option>
            <option value="automatic">自动选择</option>
          </select>
          <CaretDown
            size={12}
            weight="bold"
            className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)]"
            aria-hidden
          />
        </label>
        <button
          type="button"
          onClick={() => setEditing('create')}
          className="ui-pressable flex h-9 shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--color-button-primary-background)] px-3 text-[13px] font-medium text-[var(--color-button-primary-foreground)] hover:brightness-110"
        >
          <Plus size={14} weight="bold" aria-hidden />
          新建
        </button>
      </div>

      {loading ? (
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-5 py-8 text-center text-[13px] text-[var(--color-text-tertiary)]">
          正在读取子智能体…
        </div>
      ) : error !== undefined ? (
        <div role="alert" className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-5 py-8 text-center text-[13px] text-[var(--color-text-danger)]">
          {error}
        </div>
      ) : (
        <div className="space-y-5">
          <AgentGroup
            title="用户子智能体"
            count={(profiles ?? []).filter((profile) => profile.source === 'user').length}
            note="可创建、编辑、启停和删除"
          >
            {userProfiles.length === 0 ? (
              <button
                type="button"
                onClick={() => setEditing('create')}
                className="ui-pressable flex min-h-20 w-full items-center justify-center gap-2 text-[13px] text-[var(--color-text-tertiary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-secondary)]"
              >
                <Plus size={14} weight="bold" aria-hidden />
                创建第一个用户子智能体
              </button>
            ) : (
              renderRows(userProfiles)
            )}
          </AgentGroup>

          <AgentGroup
            title="内置子智能体"
            count={(profiles ?? []).filter((profile) => profile.source === 'builtin').length}
            note="内置能力不可编辑，可分别指定模型"
          >
            {builtinProfiles.length === 0 ? (
              <div className="px-5 py-8 text-center text-[13px] text-[var(--color-text-tertiary)]">
                没有符合条件的内置子智能体
              </div>
            ) : (
              renderRows(builtinProfiles)
            )}
          </AgentGroup>
        </div>
      )}

      {setEnabled.isError ? (
        <p role="alert" className="mt-3 text-[12px] text-[var(--color-text-danger)]">
          {setEnabled.error instanceof Error ? setEnabled.error.message : '状态更新失败'}
        </p>
      ) : null}

    </section>
  );
}

function AgentGroup({
  title,
  count,
  note,
  children,
}: {
  readonly title: string;
  readonly count: number;
  readonly note: string;
  readonly children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-6 px-0.5">
        <h2 className="text-[14px] font-semibold text-[var(--color-text-foreground)]">
          {title}
          <span className="ml-2 font-normal text-[var(--color-text-tertiary)]">{count} 项</span>
        </h2>
        <p className="text-[12px] text-[var(--color-text-tertiary)]">{note}</p>
      </div>
      <div className="overflow-visible rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-background-panel)] shadow-[var(--shadow-card)]">
        {children}
      </div>
    </section>
  );
}
