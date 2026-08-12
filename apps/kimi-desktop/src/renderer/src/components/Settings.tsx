/**
 * Settings — a full-window settings surface with category navigation and a
 * focused content pane. Existing settings behavior stays on the same data
 * paths; this component only owns the desktop settings shell and grouping.
 */

import { useRef, useState, type ReactNode } from 'react';

import {
  ArrowCounterClockwise,
  ArrowLeft,
  CaretDown,
  Cube,
  Database,
  GearSix,
  Info,
  Palette,
  Robot,
  UsersThree,
} from '@phosphor-icons/react';

import {
  DEFAULT_TEXT_COLOR_BY_THEME,
  isDefaultAppearancePreferences,
  type AppearancePreferences,
} from '#/lib/appearancePreferences';
import {
  persistAppearancePreferences,
  resetAppearancePreferences,
  resolveAppearancePreferences,
} from '#/lib/appearancePreferencesBrowser';
import { useConnection } from '#/lib/connection';
import { normalizePermissionMode } from '#/lib/permissionMode';
import {
  useConfig,
  useAgentProfiles,
  useExportSession,
  useModels,
  usePatchConfig,
} from '#/lib/queries';
import {
  effectiveTheme,
  resolveThemeChoice,
  setThemeChoice,
  type ThemeChoice,
} from '#/lib/theme';
import { useModalDialog } from '#/lib/useModalDialog';
import { PermissionModeSelect } from './composer/PermissionModeSelect';
import { ModelSelect } from './composer/ModelSelect';
import { ToggleSwitch } from './ToggleSwitch';
import { ProviderManager } from './settings/ProviderManager';
import { SubagentSettings } from './settings/SubagentSettings';
import { ExpertTeamSettings } from './settings/ExpertTeamSettings';

export interface SettingsProps {
  /** The active session id (enables the export button); null when none. */
  readonly activeSessionId: string | null;
  readonly onClose: () => void;
  readonly onStartExpertManager: () => void;
}

type SettingsSection =
  | 'general'
  | 'appearance'
  | 'models'
  | 'agents'
  | 'expert-teams'
  | 'data'
  | 'about';

const THEME_LABELS: Record<ThemeChoice, string> = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
};

const INTERFACE_FONT_SIZES = [12, 13, 14, 15, 16, 17, 18] as const;
const MARKDOWN_FONT_SIZES = [12, 13, 14, 15, 16, 17, 18, 19, 20] as const;
const CODE_FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 17, 18] as const;

interface SettingsNavItemProps {
  readonly active: boolean;
  readonly icon: ReactNode;
  readonly label: string;
  readonly onClick: () => void;
}

function SettingsNavItem({
  active,
  icon,
  label,
  onClick,
}: SettingsNavItemProps) {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={`ui-pressable flex h-9 w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 text-left text-[length:var(--client-content-font-size)] ${
        active
          ? 'bg-[var(--color-list-hover)] font-medium text-[var(--color-text-foreground)]'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]'
      }`}
    >
      <span
        className="flex h-5 w-5 shrink-0 items-center justify-center"
        aria-hidden
      >
        {icon}
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}

interface SettingsPageHeaderProps {
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}

function SettingsPageHeader({
  title,
  description,
  action,
}: SettingsPageHeaderProps) {
  return (
    <header className="mb-7">
      <div className="flex items-start justify-between gap-8">
        <h1 className="text-[28px] font-semibold leading-9 tracking-[-0.025em] text-[var(--color-text-foreground)]">
          {title}
        </h1>
        {action}
      </div>
      <p className="mt-7 text-[length:var(--client-content-font-size)] leading-5 text-[var(--color-text-secondary)]">
        {description}
      </p>
    </header>
  );
}

function SettingsPanel({ children }: { readonly children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-background-panel)] shadow-[var(--shadow-card)]">
      {children}
    </div>
  );
}

interface SettingsRowProps {
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
  readonly last?: boolean;
}

function SettingsRow({
  title,
  description,
  children,
  last = false,
}: SettingsRowProps) {
  return (
    <div
      className={`flex min-h-[78px] items-center justify-between gap-8 px-5 py-4 ${
        last ? '' : 'border-b border-[var(--color-border-light)]'
      }`}
    >
      <div className="min-w-0 flex-1">
        <h2 className="text-[length:var(--client-content-font-size)] font-medium leading-5 text-[var(--color-text-foreground)]">
          {title}
        </h2>
        <p className="mt-1 text-[12px] leading-5 text-[var(--color-text-tertiary)]">
          {description}
        </p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

interface FontSizeSelectProps {
  readonly label: string;
  readonly options: readonly number[];
  readonly value: number;
  readonly onChange: (value: number) => void;
}

function FontSizeSelect({
  label,
  options,
  value,
  onChange,
}: FontSizeSelectProps) {
  return (
    <div className="relative">
      <select
        value={value}
        aria-label={label}
        onChange={(event) => {
          onChange(Number(event.currentTarget.value));
        }}
        className="h-8 w-[92px] appearance-none rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-background-panel)] pl-3 pr-8 text-[13px] text-[var(--color-text-foreground)] outline-none transition-colors hover:border-[var(--color-border-heavy)] focus:border-[var(--color-border-focus)] focus:ring-2 focus:ring-[var(--color-border-focus)]"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option} px
          </option>
        ))}
      </select>
      <CaretDown
        size={13}
        weight="regular"
        aria-hidden
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)]"
      />
    </div>
  );
}

interface TextColorControlProps {
  readonly defaultColor: string;
  readonly value: string | null;
  readonly onChange: (value: string | null) => void;
}

function TextColorControl({
  defaultColor,
  value,
  onChange,
}: TextColorControlProps) {
  const resolvedColor = value ?? defaultColor;
  return (
    <div className="flex items-center gap-2">
      <label className="relative flex h-8 min-w-[132px] cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-background-panel)] px-2.5 text-[12px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-heavy)] focus-within:border-[var(--color-border-focus)] focus-within:ring-2 focus-within:ring-[var(--color-border-focus)]">
        <span
          className="h-4 w-4 shrink-0 rounded-full border border-[var(--color-border-heavy)] shadow-sm"
          style={{ backgroundColor: resolvedColor }}
          aria-hidden
        />
        <span>{value === null ? '跟随主题' : value.toUpperCase()}</span>
        <input
          type="color"
          aria-label="Markdown 文字颜色"
          value={resolvedColor}
          onChange={(event) => {
            onChange(event.currentTarget.value);
          }}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </label>
      {value !== null ? (
        <button
          type="button"
          onClick={() => {
            onChange(null);
          }}
          className="ui-pressable h-8 rounded-[var(--radius-sm)] px-2 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
        >
          跟随主题
        </button>
      ) : null}
    </div>
  );
}

function GeneralAppearanceSettings({
  preferences,
  defaultTextColor,
  onChange,
  onReset,
}: {
  readonly preferences: AppearancePreferences;
  readonly defaultTextColor: string;
  readonly onChange: <K extends keyof AppearancePreferences>(
    key: K,
    value: AppearancePreferences[K],
  ) => void;
  readonly onReset: () => void;
}) {
  return (
    <>
      <div className="mb-2 mt-7 flex min-h-7 items-center justify-between gap-4">
        <p className="text-[12px] font-medium text-[var(--color-text-secondary)]">
          字体与阅读
        </p>
        <button
          type="button"
          disabled={isDefaultAppearancePreferences(preferences)}
          onClick={onReset}
          className="ui-pressable inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-sm)] px-2 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] disabled:cursor-default disabled:opacity-35"
        >
          <ArrowCounterClockwise size={13} weight="regular" aria-hidden />
          恢复默认样式
        </button>
      </div>
      <SettingsPanel>
        <SettingsRow
          title="界面字号"
          description="调整导航、会话列表和主要界面文字。"
        >
          <FontSizeSelect
            label="界面字号"
            options={INTERFACE_FONT_SIZES}
            value={preferences.interfaceFontSize}
            onChange={(value) => {
              onChange('interfaceFontSize', value);
            }}
          />
        </SettingsRow>
        <SettingsRow
          title="Markdown 字号"
          description="调整对话回复中 Markdown 正文的字号。"
        >
          <FontSizeSelect
            label="Markdown 字号"
            options={MARKDOWN_FONT_SIZES}
            value={preferences.markdownFontSize}
            onChange={(value) => {
              onChange('markdownFontSize', value);
            }}
          />
        </SettingsRow>
        <SettingsRow
          title="代码块字号"
          description="调整 Markdown 代码块的等宽字体字号。"
        >
          <FontSizeSelect
            label="代码块字号"
            options={CODE_FONT_SIZES}
            value={preferences.codeFontSize}
            onChange={(value) => {
              onChange('codeFontSize', value);
            }}
          />
        </SettingsRow>
        <SettingsRow
          title="Markdown 文字颜色"
          description="调整对话回复中 Markdown 正文的文字颜色；默认跟随主题。"
          last
        >
          <TextColorControl
            defaultColor={defaultTextColor}
            value={preferences.textColor}
            onChange={(value) => {
              onChange('textColor', value);
            }}
          />
        </SettingsRow>
      </SettingsPanel>
    </>
  );
}

export function Settings({
  activeSessionId,
  onClose,
  onStartExpertManager,
}: SettingsProps) {
  const { serverVersion, mode, serverId } = useConnection();
  const [activeSection, setActiveSection] = useState<SettingsSection>('models');
  const [theme, setTheme] = useState<ThemeChoice>(resolveThemeChoice);
  const [appearancePreferences, setAppearancePreferences] =
    useState<AppearancePreferences>(resolveAppearancePreferences);
  const [childModalOpen, setChildModalOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  useModalDialog(dialogRef, onClose, {
    active: !childModalOpen,
    initialFocusRef: backButtonRef,
  });
  const configQuery = useConfig();
  const agentProfilesQuery = useAgentProfiles();
  const modelsQuery = useModels();
  const patchConfig = usePatchConfig();
  const exportSession = useExportSession(activeSessionId ?? '');

  const config = configQuery.data;
  const patchPending = patchConfig.isPending;
  const defaultPermission = normalizePermissionMode(
    config?.default_permission_mode,
  );
  const defaultPlan = config?.default_plan_mode === true;
  const defaultModel = config?.default_model ?? '';
  const agentModels = config?.agent_models ?? {};

  const patch = (body: Parameters<typeof patchConfig.mutate>[0]): void => {
    if (patchPending) return;
    patchConfig.mutate(body);
  };

  const changeAppearance = <K extends keyof AppearancePreferences>(
    key: K,
    value: AppearancePreferences[K],
  ): void => {
    const next = persistAppearancePreferences({
      ...appearancePreferences,
      [key]: value,
    });
    setAppearancePreferences(next);
  };

  const download = (desktop: boolean): void => {
    if (activeSessionId === null) return;
    exportSession.mutate(
      { desktop },
      {
        onSuccess: ({ blob, filename }) => {
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = filename;
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          URL.revokeObjectURL(url);
        },
      },
    );
  };

  const changeAgentModel = (profile: string, model: string): void => {
    const next = { ...agentModels };
    if (model === '') {
      delete next[profile];
    } else {
      next[profile] = model;
    }
    patch({ agent_models: next });
  };

  const saveStatus = patchConfig.isError ? (
    <p
      role="alert"
      className="mt-3 text-[12px] text-[var(--color-text-danger)]"
    >
      {patchConfig.error instanceof Error
        ? patchConfig.error.message
        : '配置写入失败'}
    </p>
  ) : patchConfig.isSuccess ? (
    <p
      role="status"
      className="mt-3 text-[12px] text-[var(--color-text-success)]"
    >
      设置已保存
    </p>
  ) : null;

  const renderContent = (): ReactNode => {
    switch (activeSection) {
      case 'general':
        return (
          <>
            <SettingsPageHeader
              title="常规"
              description="配置新会话的默认行为。"
            />
            <p className="mb-2 text-[12px] font-medium text-[var(--color-text-secondary)]">
              新会话
            </p>
            <SettingsPanel>
              <SettingsRow
                title="默认权限模式"
                description="设置新会话开始时使用的权限模式。"
              >
                <PermissionModeSelect
                  value={defaultPermission}
                  onChange={(nextMode) =>
                    patch({ default_permission_mode: nextMode })
                  }
                  disabled={patchPending}
                  className="composer-menu w-56 max-w-none justify-between rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-background-panel)] px-2.5"
                />
              </SettingsRow>
              <SettingsRow
                title="默认计划模式"
                description="创建新会话时自动进入计划模式。"
                last
              >
                <ToggleSwitch
                  checked={defaultPlan}
                  disabled={patchPending}
                  label="默认计划模式"
                  onChange={(checked) => patch({ default_plan_mode: checked })}
                />
              </SettingsRow>
            </SettingsPanel>
            {saveStatus}
            <GeneralAppearanceSettings
              preferences={appearancePreferences}
              defaultTextColor={
                DEFAULT_TEXT_COLOR_BY_THEME[effectiveTheme(theme)]
              }
              onChange={changeAppearance}
              onReset={() =>
                setAppearancePreferences(resetAppearancePreferences())
              }
            />
          </>
        );

      case 'appearance':
        return (
          <>
            <SettingsPageHeader
              title="外观"
              description="选择 Kimi Code 的显示主题。"
            />
            <p className="mb-2 text-[12px] font-medium text-[var(--color-text-secondary)]">
              主题
            </p>
            <SettingsPanel>
              <SettingsRow
                title="界面主题"
                description="可使用浅色、深色，或跟随系统外观。"
                last
              >
                <div className="flex rounded-[var(--radius-sm)] bg-[var(--color-background-muted)] p-0.5">
                  {(Object.keys(THEME_LABELS) as ThemeChoice[]).map(
                    (choice) => (
                      <button
                        key={choice}
                        type="button"
                        aria-pressed={theme === choice}
                        onClick={() => {
                          setThemeChoice(choice);
                          setTheme(choice);
                        }}
                        className={`ui-pressable rounded-[6px] px-3 py-1.5 text-[12px] ${
                          theme === choice
                            ? 'bg-[var(--color-background-panel)] font-medium text-[var(--color-text-foreground)] shadow-sm'
                            : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-foreground)]'
                        }`}
                      >
                        {THEME_LABELS[choice]}
                      </button>
                    ),
                  )}
                </div>
              </SettingsRow>
            </SettingsPanel>
          </>
        );

      case 'models':
        return (
          <>
            <SettingsPageHeader
              title="模型设置"
              description="管理默认模型和自定义模型服务商，配置后可在聊天时选择使用。"
              action={
                // Deliberately NOT a <label>: wrapping the ModelSelect in a
                // label re-dispatches a click to the trigger button whenever a
                // menu item is picked (label activation behavior), reopening
                // the popover right after every selection.
                <div className="flex items-center gap-2 pt-0.5">
                  <span className="shrink-0 text-[12px] text-[var(--color-text-tertiary)]">
                    新会话默认模型
                  </span>
                  <ModelSelect
                    value={defaultModel}
                    models={modelsQuery.data?.items}
                    onChange={(nextModel) =>
                      patch({
                        default_model: nextModel === '' ? undefined : nextModel,
                      })
                    }
                    disabled={patchPending}
                    emptyLabel="未设置"
                    placement="below"
                    submenuSide="left"
                    className="composer-menu w-52 max-w-none justify-between rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-background-panel)] px-2.5"
                  />
                </div>
              }
            />
            <ProviderManager onModalOpenChange={setChildModalOpen} />
            {saveStatus}
          </>
        );

      case 'agents':
        return (
          <>
            <SettingsPageHeader
              title="子智能体"
              description="创建和管理用户子智能体，并为每个子智能体分别指定运行模型。"
            />
            <SubagentSettings
              profiles={agentProfilesQuery.data?.items}
              models={modelsQuery.data?.items}
              bindings={agentModels}
              pending={patchPending}
              loading={agentProfilesQuery.isLoading}
              error={
                agentProfilesQuery.isError
                  ? agentProfilesQuery.error instanceof Error
                    ? agentProfilesQuery.error.message
                    : '子智能体读取失败'
                  : undefined
              }
              onBindingChange={changeAgentModel}
              onModelMenuOpenChange={setChildModalOpen}
            />
            {saveStatus}
          </>
        );

      case 'expert-teams':
        return (
          <>
            <SettingsPageHeader
              title="专家团"
              description="将多个专业子 Agent 组织成层级团队，由团长拆解任务、分派成员并统一汇总。"
            />
            <ExpertTeamSettings onStartConversation={onStartExpertManager} />
          </>
        );

      case 'data':
        return (
          <>
            <SettingsPageHeader
              title="会话数据"
              description="导出当前会话的归档与桌面诊断信息。"
            />
            <p className="mb-2 text-[12px] font-medium text-[var(--color-text-secondary)]">
              导出
            </p>
            <SettingsPanel>
              <SettingsRow
                title="导出当前会话"
                description={
                  activeSessionId === null
                    ? '选择一个会话后即可导出。'
                    : '生成当前会话的可携带归档。'
                }
                last
              >
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => download(false)}
                    disabled={
                      activeSessionId === null || exportSession.isPending
                    }
                    className="ui-pressable rounded-[var(--radius-sm)] bg-[var(--color-button-primary-background)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-button-primary-foreground)] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {exportSession.isPending ? '导出中…' : '导出会话'}
                  </button>
                  <button
                    type="button"
                    onClick={() => download(true)}
                    disabled={
                      activeSessionId === null || exportSession.isPending
                    }
                    className="ui-pressable rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-background-panel)] px-3 py-1.5 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    含桌面日志
                  </button>
                </div>
              </SettingsRow>
            </SettingsPanel>
            {exportSession.isError ? (
              <p
                role="alert"
                className="mt-3 text-[12px] text-[var(--color-text-danger)]"
              >
                导出失败
              </p>
            ) : null}
          </>
        );

      case 'about':
        return (
          <>
            <SettingsPageHeader
              title="关于 Kimi Code"
              description="查看桌面端与所连接服务的信息。"
            />
            <p className="mb-2 text-[12px] font-medium text-[var(--color-text-secondary)]">
              运行信息
            </p>
            <SettingsPanel>
              <dl className="px-5 py-3 text-[13px]">
                <div className="flex min-h-11 items-center justify-between gap-6 border-b border-[var(--color-border-light)]">
                  <dt className="text-[var(--color-text-secondary)]">
                    后端版本
                  </dt>
                  <dd className="font-mono text-[var(--color-text-foreground)]">
                    {serverVersion}
                  </dd>
                </div>
                <div className="flex min-h-11 items-center justify-between gap-6 border-b border-[var(--color-border-light)]">
                  <dt className="text-[var(--color-text-secondary)]">
                    运行模式
                  </dt>
                  <dd className="text-[var(--color-text-foreground)]">
                    {mode === 'embedded' ? '内嵌' : '附着'}
                  </dd>
                </div>
                <div className="flex min-h-11 items-center justify-between gap-6">
                  <dt className="text-[var(--color-text-secondary)]">
                    服务器 ID
                  </dt>
                  <dd
                    className="max-w-[70%] truncate font-mono text-[var(--color-text-foreground)]"
                    title={serverId}
                  >
                    {serverId}
                  </dd>
                </div>
              </dl>
            </SettingsPanel>
          </>
        );
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="设置"
      tabIndex={-1}
      className="fixed inset-0 z-40 flex min-h-0 overflow-hidden bg-[var(--color-background-surface-under)] text-[var(--color-text-foreground)] outline-none"
    >
      <aside className="relative flex w-[220px] shrink-0 flex-col border-r border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] px-3 pb-4 pt-12">
        <div
          className="app-drag-region absolute inset-x-0 top-0 h-11"
          aria-hidden
        />
        <nav
          className="app-no-drag flex min-h-0 flex-1 flex-col"
          aria-label="设置分类"
        >
          <button
            ref={backButtonRef}
            type="button"
            onClick={onClose}
            className="ui-pressable mb-5 flex h-9 items-center gap-2 rounded-[var(--radius-sm)] px-2.5 text-[length:var(--client-content-font-size)] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
          >
            <ArrowLeft size={16} weight="regular" aria-hidden />
            返回工作区
          </button>

          <p className="mb-1.5 px-2.5 text-[12px] text-[var(--color-text-tertiary)]">
            基础设置
          </p>
          <div className="space-y-0.5">
            <SettingsNavItem
              active={activeSection === 'general'}
              icon={<GearSix size={17} weight="regular" />}
              label="常规"
              onClick={() => setActiveSection('general')}
            />
            <SettingsNavItem
              active={activeSection === 'appearance'}
              icon={<Palette size={17} weight="regular" />}
              label="外观"
              onClick={() => setActiveSection('appearance')}
            />
            <SettingsNavItem
              active={activeSection === 'models'}
              icon={<Cube size={17} weight="regular" />}
              label="模型设置"
              onClick={() => setActiveSection('models')}
            />
          </div>

          <p className="mb-1.5 mt-6 px-2.5 text-[12px] text-[var(--color-text-tertiary)]">
            Agent 能力
          </p>
          <div className="space-y-0.5">
            <SettingsNavItem
              active={activeSection === 'agents'}
              icon={<Robot size={17} weight="regular" />}
              label="子智能体"
              onClick={() => setActiveSection('agents')}
            />
            <SettingsNavItem
              active={activeSection === 'expert-teams'}
              icon={<UsersThree size={17} weight="regular" />}
              label="专家团"
              onClick={() => setActiveSection('expert-teams')}
            />
          </div>

          <p className="mb-1.5 mt-6 px-2.5 text-[12px] text-[var(--color-text-tertiary)]">
            数据与信息
          </p>
          <div className="space-y-0.5">
            <SettingsNavItem
              active={activeSection === 'data'}
              icon={<Database size={17} weight="regular" />}
              label="会话数据"
              onClick={() => setActiveSection('data')}
            />
            <SettingsNavItem
              active={activeSection === 'about'}
              icon={<Info size={17} weight="regular" />}
              label="关于"
              onClick={() => setActiveSection('about')}
            />
          </div>
        </nav>
      </aside>

      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-tl-[var(--radius-lg)] border-l border-t border-[var(--color-border-light)] bg-[var(--color-background-panel)]">
        <div className="app-drag-region h-10 shrink-0" aria-hidden />
        <div className="min-h-0 flex-1 overflow-y-auto px-10 pb-8">
          <div className="mx-auto w-full max-w-[832px]">{renderContent()}</div>
        </div>
      </main>
    </div>
  );
}
