/**
 * Settings — a modal surface for theme, server-side global defaults (default
 * model / permission / plan mode, written via `POST /api/v1/config`), the
 * provider manager, session export, and an "about" panel. Opened from the
 * sidebar's bottom nav.
 */

import { useRef, useState } from 'react';

import { useConnection } from '#/lib/connection';
import { normalizePermissionMode } from '#/lib/permissionMode';
import {
  useConfig,
  useExportSession,
  useModels,
  usePatchConfig,
} from '#/lib/queries';
import { resolveThemeChoice, setThemeChoice, type ThemeChoice } from '#/lib/theme';
import { useModalDialog } from '#/lib/useModalDialog';
import { PermissionModeSelect } from './composer/PermissionModeSelect';
import { ModelSelect } from './composer/ModelSelect';
import { ProviderManager } from './settings/ProviderManager';

export interface SettingsProps {
  /** The active session id (enables the export button); null when none. */
  readonly activeSessionId: string | null;
  readonly onClose: () => void;
}

const THEME_LABELS: Record<ThemeChoice, string> = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
};

export function Settings({ activeSessionId, onClose }: SettingsProps) {
  const { serverVersion, mode, serverId } = useConnection();
  const [theme, setTheme] = useState<ThemeChoice>(resolveThemeChoice);
  const [providerManagerOpen, setProviderManagerOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalDialog(dialogRef, onClose, { active: !providerManagerOpen });
  const configQuery = useConfig();
  const modelsQuery = useModels();
  const patchConfig = usePatchConfig();
  const exportSession = useExportSession(activeSessionId ?? '');

  const config = configQuery.data;
  const patchPending = patchConfig.isPending;
  const defaultPermission = normalizePermissionMode(config?.default_permission_mode);
  const defaultPlan = config?.default_plan_mode === true;
  const defaultModel = config?.default_model ?? '';

  const patch = (body: Parameters<typeof patchConfig.mutate>[0]): void => {
    if (patchPending) return;
    patchConfig.mutate(body);
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

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      // Only the backdrop itself closes Settings — the nested ProviderManager
      // renders inside this overlay and must not cascade.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        className="flex w-[520px] max-h-[80vh] flex-col overflow-hidden rounded-xl border border-[var(--color-border-heavy)] bg-[var(--color-background-surface)] shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border-light)] px-4 py-2.5">
          <span className="text-[13px] font-medium text-[var(--color-text-foreground)]">设置</span>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {/* Theme */}
          <section className="mb-5">
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--gray-500)]">
              外观
            </h2>
            <div className="flex gap-1.5">
              {(Object.keys(THEME_LABELS) as ThemeChoice[]).map((choice) => (
                <button
                  key={choice}
                  type="button"
                  onClick={() => {
                    setThemeChoice(choice);
                    setTheme(choice);
                  }}
                  className={`rounded-md border px-3 py-1 text-[12px] ${
                    theme === choice
                      ? 'border-[var(--color-border-heavy)] bg-[var(--color-list-hover)] text-[var(--color-text-foreground)]'
                      : 'border-[var(--color-border-light)] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)]'
                  }`}
                >
                  {THEME_LABELS[choice]}
                </button>
              ))}
            </div>
          </section>

          {/* Server-side global defaults (M8) */}
          <section className="mb-5">
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--gray-500)]">
              默认模型
            </h2>
            <ModelSelect
              value={defaultModel}
              models={modelsQuery.data?.items}
              onChange={(nextModel) => patch({ default_model: nextModel === '' ? undefined : nextModel })}
              disabled={patchPending}
              emptyLabel="未设置"
              className="composer-menu w-full max-w-none justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-background-panel)] px-2.5"
            />
            <p className="mt-1 text-[10px] leading-4 text-[var(--gray-500)]">
              新会话与未指定模型的请求使用的默认模型（写入服务端配置）。
            </p>
          </section>

          <section className="mb-5">
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--gray-500)]">
              默认权限模式
            </h2>
            <PermissionModeSelect
              value={defaultPermission}
              onChange={(nextMode) => patch({ default_permission_mode: nextMode })}
              disabled={patchPending}
              className="composer-menu w-full max-w-none justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-background-panel)] px-2.5"
            />
            <p className="mt-1 text-[10px] leading-4 text-[var(--gray-500)]">
              新会话的权限模式（写入服务端配置）。
            </p>
          </section>

          <section className="mb-5">
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--gray-500)]">
              默认计划模式
            </h2>
            <div className="flex gap-1.5">
              {[
                { value: false, label: '关' },
                { value: true, label: '开' },
              ].map((option) => (
                <button
                  key={String(option.value)}
                  type="button"
                  disabled={patchPending}
                  onClick={() => patch({ default_plan_mode: option.value })}
                  className={`rounded-md border px-3 py-1 text-[12px] disabled:opacity-50 ${
                    defaultPlan === option.value
                      ? 'border-[var(--color-border-heavy)] bg-[var(--color-list-hover)] text-[var(--color-text-foreground)]'
                      : 'border-[var(--color-border-light)] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)]'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[10px] leading-4 text-[var(--gray-500)]">
              新会话是否默认进入计划模式（写入服务端配置）。
            </p>
          </section>

          {patchConfig.isError ? (
            <p role="alert" className="mb-5 text-[11px] text-[var(--red-400)]">
              {patchConfig.error instanceof Error ? patchConfig.error.message : '配置写入失败'}
            </p>
          ) : patchConfig.isSuccess ? (
            <p role="status" className="mb-5 text-[11px] text-[var(--green-500)]">
              设置已保存
            </p>
          ) : null}

          {/* Providers */}
          <section className="mb-5">
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--gray-500)]">
              模型服务商
            </h2>
            <button
              type="button"
              onClick={() => setProviderManagerOpen(true)}
              className="rounded-md border border-[var(--color-border-heavy)] px-3 py-1 text-[12px] text-[var(--color-text-foreground)] hover:bg-[var(--color-list-hover)]"
            >
              管理模型服务商…
            </button>
            <p className="mt-1 text-[10px] leading-4 text-[var(--gray-500)]">
              添加、编辑或删除模型服务商，配置 API Key 与默认模型。
            </p>
          </section>

          {/* Export */}
          <section className="mb-5">
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--gray-500)]">
              导出会话
            </h2>
            {activeSessionId === null ? (
              <p className="text-[11px] text-[var(--gray-500)]">选择一个会话后可导出其归档。</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => download(false)}
                  disabled={exportSession.isPending}
                  className="rounded-md border border-[var(--color-border-heavy)] px-3 py-1 text-[12px] text-[var(--color-text-foreground)] hover:bg-[var(--color-list-hover)] disabled:opacity-50"
                >
                  {exportSession.isPending ? '导出中…' : '导出会话'}
                </button>
                <button
                  type="button"
                  onClick={() => download(true)}
                  disabled={exportSession.isPending}
                  className="rounded-md border border-[var(--color-border)] px-3 py-1 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] disabled:opacity-50"
                >
                  导出（含桌面日志）
                </button>
                {exportSession.isError ? (
                  <span className="self-center text-[11px] text-[var(--red-400)]">导出失败</span>
                ) : null}
              </div>
            )}
          </section>

          {/* About */}
          <section>
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--gray-500)]">
              关于
            </h2>
            <dl className="space-y-1 text-[11px]">
              <div className="flex justify-between gap-4">
                <dt className="text-[var(--gray-500)]">后端版本</dt>
                <dd className="font-mono text-[var(--color-text-foreground)]">{serverVersion}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-[var(--gray-500)]">运行模式</dt>
                <dd className="text-[var(--color-text-foreground)]">
                  {mode === 'embedded' ? '内嵌' : '附着'}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-[var(--gray-500)]">服务器 ID</dt>
                <dd className="truncate font-mono text-[var(--color-text-foreground)]">{serverId}</dd>
              </div>
            </dl>
          </section>
        </div>
      </div>
      {providerManagerOpen ? (
        <ProviderManager onClose={() => setProviderManagerOpen(false)} />
      ) : null}
    </div>
  );
}
