/**
 * Welcome — the no-session empty state (M9): logo, connection facts, the
 * server host's home directory and the global default model, plus a
 * new-session button.
 */

import { useConnection } from '#/lib/connection';
import { useConfig, useFsHome } from '#/lib/queries';

export interface WelcomeProps {
  readonly onNewSession: () => void;
}

export function Welcome({ onNewSession }: WelcomeProps) {
  const { serverVersion, mode } = useConnection();
  const fsHome = useFsHome();
  const config = useConfig();
  const defaultModel = config.data?.default_model;

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6">
      <div className="text-[22px] font-semibold tracking-[-0.02em]">Kimi Code</div>
      <p className="mt-1.5 text-[12px] text-[var(--color-text-secondary)]">
        开始一个新的会话，或从侧栏选择一个历史会话。
      </p>
      <button
        type="button"
        onClick={onNewSession}
        className="mt-4 rounded-lg bg-[var(--gray-1000)] px-4 py-1.5 text-[12px] font-medium text-[var(--color-text-foreground)] hover:bg-[var(--gray-900)]"
      >
        新建会话
      </button>
      <dl className="mt-7 space-y-1.5 text-[11px]">
        <div className="flex items-center gap-3">
          <dt className="w-16 shrink-0 text-right text-[var(--gray-500)]">工作目录</dt>
          <dd className="max-w-[420px] truncate font-mono text-[var(--color-text-foreground)]" title={fsHome.data?.home}>
            {fsHome.data?.home ?? '加载中…'}
          </dd>
        </div>
        <div className="flex items-center gap-3">
          <dt className="w-16 shrink-0 text-right text-[var(--gray-500)]">默认模型</dt>
          <dd className="font-mono text-[var(--color-text-foreground)]">{defaultModel ?? '未设置'}</dd>
        </div>
        <div className="flex items-center gap-3">
          <dt className="w-16 shrink-0 text-right text-[var(--gray-500)]">后端</dt>
          <dd className="font-mono text-[var(--color-text-foreground)]">
            {serverVersion} · {mode === 'embedded' ? '内嵌' : '附着'}
          </dd>
        </div>
      </dl>
    </div>
  );
}
