import type { PromptPermissionMode } from '@moonshot-ai/protocol';
import {
  ArrowUp,
  CaretDown,
  Folder,
  GitBranch,
  Plus,
  Strategy,
  Target,
  UsersThree,
  X,
} from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import { useConfig, useFsHome, useModels } from '#/lib/queries';
import { normalizePermissionMode } from '#/lib/permissionMode';

import { FolderPicker } from './sidebar/FolderPicker';
import { ModelSelect, ThinkingEffortSelect } from './composer/ModelSelect';
import { PermissionModeSelect } from './composer/PermissionModeSelect';

export interface WelcomeStartPayload {
  readonly cwd: string;
  readonly prompt: string;
  readonly permissionMode: PromptPermissionMode;
  readonly model?: string;
  readonly effort?: string;
  readonly planMode: boolean;
  readonly goalMode: boolean;
  readonly swarmMode: boolean;
}

export interface WelcomeProps {
  readonly defaultCwd?: string;
  readonly defaultBranch?: string;
  readonly onStart: (payload: WelcomeStartPayload) => void;
  readonly newSessionPending?: boolean;
  readonly newSessionError?: string | null;
  readonly initialPrompt?: string;
  readonly onOpenModelSettings?: () => void;
}

/** Empty-session landing page: one greeting and one fully functional composer. */
export function Welcome({
  defaultCwd,
  defaultBranch,
  onStart,
  newSessionPending = false,
  newSessionError = null,
  initialPrompt = '',
  onOpenModelSettings,
}: WelcomeProps) {
  const fsHome = useFsHome();
  const config = useConfig();
  const models = useModels();
  const recentRoots = fsHome.data?.recent_roots ?? [];
  const fallbackCwd = defaultCwd ?? recentRoots[0] ?? fsHome.data?.home ?? '';
  const [cwd, setCwd] = useState(defaultCwd ?? '');
  const [prompt, setPrompt] = useState(initialPrompt);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [permissionMode, setPermissionMode] =
    useState<PromptPermissionMode>('manual');
  const [model, setModel] = useState<string | undefined>();
  const [effort, setEffort] = useState<string | undefined>();
  const [planMode, setPlanMode] = useState(false);
  const [goalMode, setGoalMode] = useState(false);
  const [swarmMode, setSwarmMode] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (cwd === '' && fallbackCwd !== '') setCwd(fallbackCwd);
  }, [cwd, fallbackCwd]);

  useEffect(() => {
    if (defaultCwd !== undefined) setCwd(defaultCwd);
  }, [defaultCwd]);

  useEffect(() => {
    setPermissionMode(
      normalizePermissionMode(config.data?.default_permission_mode),
    );
  }, [config.data?.default_permission_mode]);

  useEffect(() => {
    setPlanMode(config.data?.default_plan_mode === true);
  }, [config.data?.default_plan_mode]);

  const defaultModel = config.data?.default_model;
  const effectiveModel = model ?? defaultModel;
  const selectedModel = models.data?.items.find(
    (entry) => entry.model === effectiveModel,
  );
  const supportedEfforts = selectedModel?.support_efforts;
  const submitDisabled =
    newSessionPending || cwd === '' || prompt.trim() === '';
  const roots = useMemo(
    () => [
      ...new Set(
        [defaultCwd, ...recentRoots, fsHome.data?.home].filter(isPresent),
      ),
    ],
    [defaultCwd, recentRoots, fsHome.data?.home],
  );

  useEffect(() => {
    if (
      effort !== undefined &&
      supportedEfforts !== undefined &&
      !supportedEfforts.includes(effort)
    ) {
      setEffort(undefined);
    }
  }, [effort, supportedEfforts]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitDisabled) return;
    onStart({
      cwd,
      prompt: prompt.trim(),
      permissionMode,
      // Send the model the composer is actually showing (override OR the
      // configured default). Sending nothing made the first prompt fail with
      // "model not configured" whenever the server engine had no default
      // bound, even though the UI displayed one.
      model: effectiveModel === undefined || effectiveModel === '' ? undefined : effectiveModel,
      effort: effort === undefined || effort === '' ? undefined : effort,
      planMode,
      goalMode,
      swarmMode,
    });
  };

  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-8 pb-[12vh] pt-10">
      <div className="w-full max-w-[var(--layout-thread-max-width)]">
        <h1 className="mb-2 text-center text-[length:var(--client-display-font-size)] font-normal leading-[1.08] tracking-[var(--tracking-display-tight)] text-[var(--color-text-foreground)]">
          {greeting()}
        </h1>
        <p className="mb-10 text-center text-[length:var(--client-content-font-size)] text-[var(--color-text-secondary)]">
          选择项目并描述任务，剩下的交给 Kimi Code。
        </p>

        <form
          onSubmit={submit}
          className="relative overflow-visible rounded-[18px] border border-[var(--color-border)] bg-[var(--color-background-panel)] shadow-[var(--shadow-lg)]"
        >
          <div className="relative flex h-10 items-center rounded-t-[17px] bg-[var(--color-background-surface-under)] px-3">
            <button
              type="button"
              aria-label="选择项目目录"
              aria-expanded={workspaceMenuOpen}
              title={cwd}
              onClick={() => setWorkspaceMenuOpen((value) => !value)}
              className="ui-pressable flex min-w-0 items-center gap-1.5 rounded-lg px-1.5 py-1 text-[length:var(--client-control-font-size)] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
            >
              <Folder
                size={15}
                weight="regular"
                className="shrink-0"
                aria-hidden
              />
              <span className="max-w-[18rem] truncate">
                {cwd === '' ? '加载项目…' : workspaceLabel(cwd)}
              </span>
              <CaretDown
                size={10}
                weight="bold"
                className="shrink-0 opacity-50"
                aria-hidden
              />
            </button>

            {defaultBranch !== undefined && cwd === defaultCwd ? (
              <div className="ml-2 flex min-w-0 items-center gap-1.5 text-[length:var(--client-meta-font-size)] text-[var(--color-text-secondary)]">
                <GitBranch
                  size={14}
                  weight="regular"
                  className="shrink-0"
                  aria-hidden
                />
                <span className="max-w-32 truncate">{defaultBranch}</span>
              </div>
            ) : null}

            {workspaceMenuOpen ? (
              <>
                <button
                  type="button"
                  aria-label="关闭项目目录菜单"
                  className="fixed inset-0 z-10 cursor-default"
                  onClick={() => setWorkspaceMenuOpen(false)}
                />
                <div className="ui-popover absolute left-3 top-full z-20 mt-1.5 w-80 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-background-panel)] py-1.5 shadow-[var(--shadow-xl)]">
                  <div className="px-3 py-1 text-[10px] font-semibold tracking-[var(--tracking-label)] text-[var(--color-text-tertiary)] uppercase">
                    最近项目
                  </div>
                  {roots.map((root) => (
                    <button
                      key={root}
                      type="button"
                      onClick={() => {
                        setCwd(root);
                        setWorkspaceMenuOpen(false);
                      }}
                      className={`block w-full px-3 py-1.5 text-left hover:bg-[var(--color-list-hover)] ${root === cwd ? 'bg-[var(--color-list-active)]' : ''}`}
                    >
                      <div className="truncate text-[12.5px] font-medium text-[var(--color-text-foreground)]">
                        {workspaceLabel(root)}
                      </div>
                      <div className="truncate font-mono text-[10.5px] text-[var(--color-text-tertiary)]">
                        {root}
                      </div>
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      setWorkspaceMenuOpen(false);
                      setFolderPickerOpen(true);
                    }}
                    className="mt-1 block w-full border-t border-[var(--color-border-light)] px-3 py-2 text-left text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
                  >
                    浏览其它目录…
                  </button>
                </div>
              </>
            ) : null}
          </div>

          {addMenuOpen ? (
            <>
              <button
                type="button"
                aria-label="关闭添加菜单"
                className="fixed inset-0 z-10 cursor-default"
                onClick={() => setAddMenuOpen(false)}
              />
              <div className="absolute bottom-12 left-3 z-20 w-36">
                <WelcomeAddMenu
                  planMode={planMode}
                  goalMode={goalMode}
                  swarmMode={swarmMode}
                  onPlanModeChange={(value) => {
                    setPlanMode(value);
                    setAddMenuOpen(false);
                  }}
                  onGoalModeChange={(value) => {
                    setGoalMode(value);
                    setAddMenuOpen(false);
                  }}
                  onSwarmModeChange={(value) => {
                    setSwarmMode(value);
                    setAddMenuOpen(false);
                  }}
                />
              </div>
            </>
          ) : null}

          <textarea
            ref={textareaRef}
            autoFocus
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={
              goalMode
                ? '描述你的目标，定义可衡量的成果，以获得最佳效果'
                : planMode
                  ? '描述你的任务以生成计划…'
                  : '向 Kimi Code 提问，使用 @ 添加上下文，使用 / 选择命令或能力'
            }
            rows={3}
            className="block min-h-24 w-full resize-none bg-transparent px-4 pb-2 pt-4 text-[length:var(--client-content-font-size)] leading-[var(--leading-chat)] text-[var(--color-text-foreground)] outline-none placeholder:text-[var(--color-text-tertiary)]"
          />

          <div className="flex h-11 items-center gap-0.5 px-3 pb-1">
            <button
              type="button"
              aria-label="添加"
              title="添加"
              aria-expanded={addMenuOpen}
              onClick={() => setAddMenuOpen((value) => !value)}
              className="ui-pressable flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
            >
              <Plus size={16} weight="regular" aria-hidden />
            </button>
            <PermissionModeSelect
              value={permissionMode}
              onChange={setPermissionMode}
              disabled={newSessionPending}
            />
            {planMode ? (
              <ModeChip
                icon={<Strategy size={14} weight="regular" />}
                label="计划"
                onClick={() => setPlanMode(false)}
              />
            ) : null}
            {goalMode ? (
              <ModeChip
                icon={<Target size={14} weight="regular" />}
                label="目标"
                onClick={() => setGoalMode(false)}
              />
            ) : null}
            {swarmMode ? (
              <ModeChip
                icon={<UsersThree size={14} weight="regular" />}
                label="蜂群"
                onClick={() => setSwarmMode(false)}
              />
            ) : null}
            <div className="ml-auto flex min-w-0 items-center gap-0.5">
              <ModelSelect
                value={effectiveModel}
                models={models.data?.items}
                onChange={(next) => setModel(next === '' ? undefined : next)}
                disabled={newSessionPending}
                onOpenModelSettings={onOpenModelSettings}
              />
              {supportedEfforts?.length === 0 ? null : (
                <ThinkingEffortSelect
                  value={effort}
                  efforts={supportedEfforts}
                  defaultEffort={selectedModel?.default_effort}
                  onChange={(next) => setEffort(next === '' ? undefined : next)}
                  disabled={newSessionPending}
                />
              )}
              <button
                type="submit"
                disabled={submitDisabled}
                aria-label={newSessionPending ? '正在创建会话' : '发送'}
                className={`ui-pressable flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${submitDisabled ? 'bg-[var(--color-background-button-secondary)] text-[var(--color-text-tertiary)]' : 'bg-[var(--color-button-primary-background)] text-[var(--color-button-primary-foreground)]'}`}
              >
                <ArrowUp size={14} weight="bold" aria-hidden />
              </button>
            </div>
          </div>
        </form>

        {newSessionError !== null ? (
          <p
            role="alert"
            className="mt-3 text-center text-[12px] text-[var(--color-text-danger)]"
          >
            {newSessionError}
          </p>
        ) : null}
      </div>

      {folderPickerOpen ? (
        <FolderPicker
          onPick={(nextCwd) => {
            setCwd(nextCwd);
            setFolderPickerOpen(false);
          }}
          onClose={() => setFolderPickerOpen(false)}
        />
      ) : null}
    </div>
  );
}

function workspaceLabel(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return parts.at(-1) ?? cwd;
}

function WelcomeAddMenu({
  planMode,
  goalMode,
  swarmMode,
  onPlanModeChange,
  onGoalModeChange,
  onSwarmModeChange,
}: {
  readonly planMode: boolean;
  readonly goalMode: boolean;
  readonly swarmMode: boolean;
  readonly onPlanModeChange: (value: boolean) => void;
  readonly onGoalModeChange: (value: boolean) => void;
  readonly onSwarmModeChange: (value: boolean) => void;
}) {
  return (
    <div className="ui-popover w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-background-panel)] p-1.5 shadow-[var(--shadow-xl)]">
      <WelcomeModeToggle
        icon={<Strategy size={16} weight="regular" />}
        label="计划"
        active={planMode}
        onClick={() => onPlanModeChange(!planMode)}
      />
      <WelcomeModeToggle
        icon={<Target size={16} weight="regular" />}
        label="目标"
        active={goalMode}
        onClick={() => onGoalModeChange(!goalMode)}
      />
      <WelcomeModeToggle
        icon={<UsersThree size={16} weight="regular" />}
        label="蜂群"
        active={swarmMode}
        onClick={() => onSwarmModeChange(!swarmMode)}
      />
    </div>
  );
}

function WelcomeModeToggle({
  icon,
  label,
  active,
  onClick,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly active: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--color-list-hover)] ${active ? 'bg-[var(--color-list-active)]' : ''}`}
    >
      <span className="shrink-0 text-[var(--color-text-secondary)]">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-foreground)]">
        {label}
      </span>
      <span
        className={`relative h-5 w-8 shrink-0 rounded-full transition-colors ${active ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-background-button-secondary)]'}`}
        aria-hidden
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${active ? 'translate-x-3.5' : 'translate-x-0.5'}`}
        />
      </span>
    </button>
  );
}

function ModeChip({
  icon,
  label,
  onClick,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly onClick: () => void;
}) {
  const closeLabel = `关闭${label}模式`;
  return (
    <button
      type="button"
      aria-label={closeLabel}
      title={closeLabel}
      onClick={onClick}
      className="ui-pressable flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
    >
      {icon}
      {label}
      <X size={11} weight="bold" className="opacity-55" aria-hidden />
    </button>
  );
}

function isPresent(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 6) return '夜深了，想做点什么？';
  if (hour < 12) return '早上好，今天想做什么？';
  if (hour < 18) return '下午好，今天想做什么？';
  return '晚上好呀，今天辛苦啦';
}
