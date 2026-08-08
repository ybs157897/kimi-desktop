import type { PromptPermissionMode } from '@moonshot-ai/protocol';
import { CaretDown, ShieldCheck, ShieldWarning, Shield } from '@phosphor-icons/react';

export interface PermissionModeSelectProps {
  readonly value: PromptPermissionMode;
  readonly onChange: (mode: PromptPermissionMode) => void;
  readonly disabled?: boolean;
  /** Extra class on the outer control; composer uses the default ghost look. */
  readonly className?: string;
}

/** The three permission modes the engine accepts, in design-doc order. */
const OPTIONS: readonly {
  value: PromptPermissionMode;
  label: string;
  description: string;
}[] = [
  { value: 'manual', label: '每次询问', description: '每次工具调用前询问' },
  { value: 'auto', label: '自动批准', description: '按会话内规则自动批准' },
  { value: 'yolo', label: '完全访问', description: '不询问，直接执行' },
];

/**
 * Composer permission-mode dropdown. The selection rides every prompt body
 * (`permission_mode`) and is persisted to localStorage by the owner (Composer),
 * so the choice survives restarts.
 */
export function PermissionModeSelect({
  value,
  onChange,
  disabled = false,
  className,
}: PermissionModeSelectProps) {
  const current = OPTIONS.find((option) => option.value === value) ?? OPTIONS[0]!;
  return (
    <label
      className={
        className ??
        `composer-menu ${disabled ? 'opacity-55' : 'hover:bg-[var(--color-list-hover)]'}`
      }
      title={current.description}
    >
      <PermissionIcon mode={value} />
      <select
        value={value}
        disabled={disabled}
        aria-label="权限模式"
        onChange={(event) => onChange(event.target.value as PromptPermissionMode)}
        className="composer-menu-select"
      >
        {OPTIONS.map((option) => (
          <option key={option.value} value={option.value} title={option.description}>
            {option.label}
          </option>
        ))}
      </select>
      <CaretDown size={10} weight="bold" className="shrink-0 opacity-45" aria-hidden />
    </label>
  );
}

function PermissionIcon({ mode }: { mode: PromptPermissionMode }) {
  if (mode === 'yolo') {
    return <ShieldWarning size={15} weight="fill" className="shrink-0 text-[var(--orange-400)]" aria-hidden />;
  }
  if (mode === 'auto') {
    return <ShieldCheck size={15} weight="fill" className="shrink-0 text-[var(--green-400)]" aria-hidden />;
  }
  return <Shield size={15} weight="regular" className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden />;
}
