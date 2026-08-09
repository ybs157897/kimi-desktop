import type {
  ExpertTeamColor,
  ExpertTeamDraft,
  ExpertTeamRecord,
  ExpertTeamRole,
  ExpertToolPreset,
} from '../../../../shared/expertTeams';
import { EXPERT_TEAM_COLORS } from '../../../../shared/expertTeams';
import {
  ArrowLeft,
  ChatCircleDots,
  PencilSimple,
  Plus,
  Robot,
  Trash,
  UsersThree,
} from '@phosphor-icons/react';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

interface ExpertTeamSettingsProps {
  readonly onStartConversation: () => void;
}

const COLOR_HEX: Readonly<Record<ExpertTeamColor, string>> = {
  amber: '#fbbf24',
  coral: '#fb7185',
  orange: '#fb923c',
  mint: '#5eead4',
  cyan: '#22d3ee',
  blue: '#60a5fa',
  violet: '#a78bfa',
  pink: '#f472b6',
};

function emptyRole(id: string, displayName: string): ExpertTeamRole {
  return {
    id,
    displayName,
    description: '',
    prompt: '',
    toolPreset: 'read-only',
  };
}

function emptyDraft(): ExpertTeamDraft {
  return {
    id: '',
    displayName: '',
    description: '',
    color: 'cyan',
    lead: { ...emptyRole('lead', '团长'), toolPreset: 'full' },
    members: [emptyRole('specialist', '领域专家')],
    quickPrompts: [],
  };
}

export function ExpertTeamSettings({
  onStartConversation,
}: ExpertTeamSettingsProps) {
  const [teams, setTeams] = useState<readonly ExpertTeamRecord[]>([]);
  const [runtimeAvailable, setRuntimeAvailable] = useState<boolean>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [editor, setEditor] = useState<ExpertTeamDraft>();
  const [editingId, setEditingId] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(undefined);
      const [nextTeams, status] = await Promise.all([
        window.kimiDesktop.expertTeams.list(),
        window.kimiDesktop.expertTeams.status(),
      ]);
      setTeams(nextTeams);
      setRuntimeAvailable(status.runtimeAvailable);
    } catch (error) {
      setError(error instanceof Error ? error.message : '专家团读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => teams.find((team) => team.id === editingId),
    [editingId, teams],
  );

  const openEditor = (team?: ExpertTeamRecord): void => {
    setEditingId(team?.id);
    setEditor(team === undefined ? emptyDraft() : toDraft(team));
    setDeleteConfirm(false);
    setError(undefined);
  };

  const save = async (): Promise<void> => {
    if (editor === undefined || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      const saved = await window.kimiDesktop.expertTeams.save(editor);
      await load();
      setEditingId(saved.id);
      setEditor(toDraft(saved));
    } catch (error) {
      setError(error instanceof Error ? error.message : '专家团保存失败');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (selected === undefined || saving) return;
    setSaving(true);
    try {
      await window.kimiDesktop.expertTeams.remove(selected.id);
      setEditor(undefined);
      setEditingId(undefined);
      await load();
    } catch (error) {
      setError(error instanceof Error ? error.message : '专家团删除失败');
    } finally {
      setSaving(false);
      setDeleteConfirm(false);
    }
  };

  if (editor !== undefined) {
    return (
      <ExpertTeamEditor
        draft={editor}
        creating={selected === undefined}
        saving={saving}
        error={error}
        deleteConfirm={deleteConfirm}
        onChange={setEditor}
        onBack={() => {
          setEditor(undefined);
          setEditingId(undefined);
        }}
        onSave={() => void save()}
        onDelete={() => {
          if (deleteConfirm) void remove();
          else setDeleteConfirm(true);
        }}
        onCancelDelete={() => {
          setDeleteConfirm(false);
        }}
      />
    );
  }

  return (
    <section className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-background-panel)] shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between gap-4 border-b border-[var(--color-border-light)] px-4 py-3">
        <div>
          <h2 className="text-[14px] font-semibold text-[var(--color-text-foreground)]">
            专家团列表
          </h2>
          <p className="mt-1 text-[12px] text-[var(--color-text-tertiary)]">
            团长负责拆解任务，成员 Agent 分工执行并返回结果。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={runtimeAvailable === false}
            title={
              runtimeAvailable === false
                ? '附着模式下需由外部宿主安装 expert-manager'
                : undefined
            }
            onClick={onStartConversation}
            className="ui-pressable flex h-8 items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-border)] px-3 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] disabled:cursor-not-allowed disabled:opacity-45"
          >
            <ChatCircleDots size={15} aria-hidden />
            对话创建
          </button>
          <button
            type="button"
            onClick={() => {
              openEditor();
            }}
            className="ui-pressable flex h-8 items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--color-button-primary-background)] px-3 text-[12px] font-medium text-[var(--color-button-primary-foreground)]"
          >
            <Plus size={14} weight="bold" aria-hidden />
            手动创建
          </button>
        </div>
      </div>

      {error !== undefined ? (
        <p
          role="alert"
          className="border-b border-[var(--color-border-light)] px-4 py-2 text-[12px] text-[var(--color-text-danger)]"
        >
          {error}
        </p>
      ) : null}

      {runtimeAvailable === false ? (
        <p className="border-b border-[var(--color-border-light)] bg-[var(--color-background-warning)] px-4 py-2 text-[12px] text-[var(--color-text-warning)]">
          当前为附着模式：可以编辑并保存专家包，但需由外部宿主安装后才能使用。
        </p>
      ) : null}

      <div className="max-h-[500px] overflow-y-auto">
        {loading ? (
          <p className="px-4 py-10 text-center text-[13px] text-[var(--color-text-tertiary)]">
            正在读取专家团…
          </p>
        ) : teams.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <UsersThree
              size={32}
              className="mx-auto text-[var(--color-text-tertiary)]"
              aria-hidden
            />
            <p className="mt-3 text-[14px] font-medium text-[var(--color-text-foreground)]">
              还没有专家团
            </p>
            <p className="mt-1 text-[12px] text-[var(--color-text-tertiary)]">
              通过对话描述团队目标，或手动配置团长和成员。
            </p>
          </div>
        ) : (
          teams.map((team, index) => (
            <div
              key={team.id}
              className={`flex min-h-[68px] items-center gap-3 px-4 py-3 ${index === teams.length - 1 ? '' : 'border-b border-[var(--color-border-light)]'}`}
            >
              <span
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ backgroundColor: COLOR_HEX[team.color] }}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[14px] font-medium text-[var(--color-text-foreground)]">
                    {team.displayName}
                  </span>
                  <span className="rounded-full bg-[var(--color-background-muted)] px-2 py-0.5 text-[11px] text-[var(--color-text-tertiary)]">
                    {team.members.length + 1} 个角色
                  </span>
                </div>
                <p className="mt-1 truncate text-[12px] text-[var(--color-text-tertiary)]">
                  {team.description}
                </p>
              </div>
              {!team.runtimeAvailable ? (
                <span className="text-[11px] text-[var(--color-text-warning)]">
                  仅保存，尚未安装
                </span>
              ) : null}
              <TeamToggle
                checked={team.enabled}
                disabled={!team.runtimeAvailable}
                label={`${team.enabled ? '停用' : '启用'} ${team.displayName}`}
                onChange={(enabled) => {
                  void window.kimiDesktop.expertTeams
                    .setEnabled({ id: team.id, enabled })
                    .then(load)
                    .catch((error: unknown) => {
                      setError(
                        error instanceof Error ? error.message : '状态更新失败',
                      );
                    });
                }}
              />
              <button
                type="button"
                aria-label={`编辑 ${team.displayName}`}
                onClick={() => {
                  openEditor(team);
                }}
                className="ui-pressable flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
              >
                <PencilSimple size={15} aria-hidden />
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function ExpertTeamEditor({
  draft,
  creating,
  saving,
  error,
  deleteConfirm,
  onChange,
  onBack,
  onSave,
  onDelete,
  onCancelDelete,
}: {
  readonly draft: ExpertTeamDraft;
  readonly creating: boolean;
  readonly saving: boolean;
  readonly error?: string;
  readonly deleteConfirm: boolean;
  readonly onChange: (draft: ExpertTeamDraft) => void;
  readonly onBack: () => void;
  readonly onSave: () => void;
  readonly onDelete: () => void;
  readonly onCancelDelete: () => void;
}) {
  const canSave =
    draft.id !== '' &&
    draft.displayName !== '' &&
    draft.description !== '' &&
    draft.lead.prompt !== '' &&
    draft.members.length > 0 &&
    draft.members.every(
      (role) =>
        role.id !== '' &&
        role.displayName !== '' &&
        role.description !== '' &&
        role.prompt !== '',
    );

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={onBack}
        className="ui-pressable mb-4 flex h-8 items-center gap-1.5 rounded-[var(--radius-sm)] px-2 text-[13px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)]"
      >
        <ArrowLeft size={14} weight="bold" aria-hidden />
        返回专家团列表
      </button>
      <section className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-background-panel)] shadow-[var(--shadow-card)]">
        <header className="border-b border-[var(--color-border-light)] px-5 py-4">
          <h2 className="text-[15px] font-semibold text-[var(--color-text-foreground)]">
            {creating ? '创建专家团' : '编辑专家团'}
          </h2>
          <p className="mt-1 text-[12px] text-[var(--color-text-tertiary)]">
            配置团长、成员和协作提示词，保存后生成本地专家包。
          </p>
        </header>
        <div className="space-y-5 px-5 py-4">
          <div className="grid grid-cols-[1fr_1.2fr_auto] gap-4">
            <Field
              label="标识"
              hint={creating ? '小写字母、数字和连字符' : '创建后不可修改'}
            >
              <input
                value={draft.id}
                disabled={!creating}
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                onChange={(event) => {
                  onChange({ ...draft, id: event.target.value });
                }}
                className={inputClass}
                placeholder="code-review"
              />
            </Field>
            <Field label="名称">
              <input
                value={draft.displayName}
                onChange={(event) => {
                  onChange({ ...draft, displayName: event.target.value });
                }}
                className={inputClass}
                placeholder="代码审查专家团"
              />
            </Field>
            <ColorPicker
              value={draft.color}
              onChange={(color) => {
                onChange({ ...draft, color });
              }}
            />
          </div>
          <Field label="描述">
            <input
              value={draft.description}
              onChange={(event) => {
                onChange({ ...draft, description: event.target.value });
              }}
              className={inputClass}
              placeholder="说明专家团解决什么问题"
            />
          </Field>

          <RoleEditor
            title="团长"
            role={draft.lead}
            onChange={(lead) => {
              onChange({ ...draft, lead });
            }}
          />

          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[13px] font-medium text-[var(--color-text-secondary)]">
                成员 Agent
              </p>
              <button
                type="button"
                onClick={() => {
                  onChange({
                    ...draft,
                    members: [
                      ...draft.members,
                      emptyRole(
                        `member-${draft.members.length + 1}`,
                        `成员 ${draft.members.length + 1}`,
                      ),
                    ],
                  });
                }}
                className="ui-pressable flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-[var(--color-accent-text)] hover:bg-[var(--color-list-hover)]"
              >
                <Plus size={13} aria-hidden />
                添加成员
              </button>
            </div>
            <div className="space-y-3">
              {draft.members.map((role, index) => (
                <RoleEditor
                  key={`${role.id}:${index}`}
                  title={`成员 ${index + 1}`}
                  role={role}
                  onChange={(nextRole) => {
                    onChange({
                      ...draft,
                      members: draft.members.map((item, itemIndex) =>
                        itemIndex === index ? nextRole : item,
                      ),
                    });
                  }}
                  onRemove={
                    draft.members.length > 1
                      ? () => {
                          onChange({
                            ...draft,
                            members: draft.members.filter(
                              (_item, itemIndex) => itemIndex !== index,
                            ),
                          });
                        }
                      : undefined
                  }
                />
              ))}
            </div>
          </div>

          <Field label="快捷提示词" hint="每行一条，可选">
            <textarea
              value={draft.quickPrompts.join('\n')}
              onChange={(event) => {
                onChange({
                  ...draft,
                  quickPrompts: event.target.value
                    .split('\n')
                    .map((item) => item.trim())
                    .filter(Boolean),
                });
              }}
              rows={3}
              className={`${inputClass} resize-none py-2`}
              placeholder="审查当前未提交变更"
            />
          </Field>
          {error !== undefined ? (
            <p
              role="alert"
              className="text-[12px] text-[var(--color-text-danger)]"
            >
              {error}
            </p>
          ) : null}
        </div>
        <footer className="flex items-center justify-between border-t border-[var(--color-border-light)] px-5 py-3">
          <div>
            {!creating ? (
              deleteConfirm ? (
                <div className="flex items-center gap-2">
                  <span className="text-[12px] text-[var(--color-text-danger)]">
                    移到废纸篓？
                  </span>
                  <button
                    type="button"
                    onClick={onDelete}
                    className="text-[12px] font-medium text-[var(--color-text-danger)]"
                  >
                    确认删除
                  </button>
                  <button
                    type="button"
                    onClick={onCancelDelete}
                    className="text-[12px] text-[var(--color-text-secondary)]"
                  >
                    取消
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={onDelete}
                  className="ui-pressable flex h-8 items-center gap-1.5 rounded-md px-2 text-[12px] text-[var(--color-text-danger)] hover:bg-[var(--color-list-hover)]"
                >
                  <Trash size={14} aria-hidden />
                  删除
                </button>
              )
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onBack}
              className="ui-pressable h-8 rounded-[var(--radius-sm)] px-3 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)]"
            >
              取消
            </button>
            <button
              type="button"
              disabled={!canSave || saving}
              onClick={onSave}
              className="ui-pressable h-8 rounded-[var(--radius-sm)] bg-[var(--color-button-primary-background)] px-4 text-[12px] font-medium text-[var(--color-button-primary-foreground)] disabled:opacity-45"
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function RoleEditor({
  title,
  role,
  onChange,
  onRemove,
}: {
  readonly title: string;
  readonly role: ExpertTeamRole;
  readonly onChange: (role: ExpertTeamRole) => void;
  readonly onRemove?: () => void;
}) {
  return (
    <section className="rounded-[var(--radius-sm)] border border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] p-3">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Robot
            size={15}
            className="text-[var(--color-text-tertiary)]"
            aria-hidden
          />
          <h3 className="text-[13px] font-medium text-[var(--color-text-foreground)]">
            {title}
          </h3>
        </div>
        {onRemove !== undefined ? (
          <button
            type="button"
            aria-label={`删除${title}`}
            onClick={onRemove}
            className="ui-pressable rounded-md p-1 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-danger)]"
          >
            <Trash size={13} aria-hidden />
          </button>
        ) : null}
      </div>
      <div className="grid grid-cols-[0.8fr_1fr_1.5fr_auto] gap-3">
        <Field label="标识">
          <input
            value={role.id}
            onChange={(event) => {
              onChange(updateRoleValue(role, 'id', event.target.value));
            }}
            className={inputClass}
          />
        </Field>
        <Field label="名称">
          <input
            value={role.displayName}
            onChange={(event) => {
              onChange(
                updateRoleValue(role, 'displayName', event.target.value),
              );
            }}
            className={inputClass}
          />
        </Field>
        <Field label="职责">
          <input
            value={role.description}
            onChange={(event) => {
              onChange(
                updateRoleValue(role, 'description', event.target.value),
              );
            }}
            className={inputClass}
            placeholder="一句话说明职责"
          />
        </Field>
        <Field label="工具">
          <select
            value={role.toolPreset}
            onChange={(event) => {
              onChange({
                ...role,
                toolPreset: event.target.value as ExpertToolPreset,
              });
            }}
            className={`${inputClass} w-28`}
          >
            <option value="read-only">只读</option>
            <option value="full">完整</option>
          </select>
        </Field>
      </div>
      <div className="mt-3">
        <Field label="系统提示词">
          <textarea
            value={role.prompt}
            onChange={(event) => {
              onChange(updateRoleValue(role, 'prompt', event.target.value));
            }}
            rows={4}
            className={`${inputClass} resize-y py-2 leading-5`}
            placeholder="描述角色、工作步骤、输出要求和边界…"
          />
        </Field>
      </div>
    </section>
  );
}

function updateRoleValue<
  K extends 'id' | 'displayName' | 'description' | 'prompt',
>(role: ExpertTeamRole, key: K, value: string): ExpertTeamRole {
  return { ...role, [key]: value };
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
    <label className="block min-w-0">
      <span className="mb-1 flex items-center gap-2 text-[12px] font-medium text-[var(--color-text-secondary)]">
        {label}
        {hint !== undefined ? (
          <span className="font-normal text-[var(--color-text-tertiary)]">
            {hint}
          </span>
        ) : null}
      </span>
      {children}
    </label>
  );
}

function ColorPicker({
  value,
  onChange,
}: {
  readonly value: ExpertTeamColor;
  readonly onChange: (color: ExpertTeamColor) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-1 text-[12px] font-medium text-[var(--color-text-secondary)]">
        颜色
      </legend>
      <div className="flex h-9 items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-border)] px-2">
        {EXPERT_TEAM_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={color}
            aria-pressed={value === color}
            onClick={() => {
              onChange(color);
            }}
            className={`h-4 w-4 rounded-full ${value === color ? 'ring-2 ring-[var(--color-text-foreground)] ring-offset-2 ring-offset-[var(--color-background-panel)]' : ''}`}
            style={{ backgroundColor: COLOR_HEX[color] }}
          />
        ))}
      </div>
    </fieldset>
  );
}

function TeamToggle({
  checked,
  disabled = false,
  label,
  onChange,
}: {
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      aria-label={label}
      onClick={() => {
        onChange(!checked);
      }}
      className={`relative h-5 w-9 rounded-full disabled:cursor-not-allowed disabled:opacity-45 ${checked ? 'bg-[var(--primary)]' : 'bg-[var(--color-background-muted)]'}`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`}
      />
    </button>
  );
}

function toDraft(team: ExpertTeamRecord): ExpertTeamDraft {
  return {
    id: team.id,
    displayName: team.displayName,
    description: team.description,
    color: team.color,
    lead: team.lead,
    members: team.members,
    quickPrompts: team.quickPrompts,
  };
}

const inputClass =
  'h-9 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-background-panel)] px-3 text-[13px] text-[var(--color-text-foreground)] outline-none focus:border-[var(--color-border-focus)] disabled:bg-[var(--color-background-muted)] disabled:text-[var(--color-text-tertiary)]';
