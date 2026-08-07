import type { PromptPermissionMode } from '@moonshot-ai/protocol';

export interface PermissionModeSelectProps {
  readonly value: PromptPermissionMode;
  readonly onChange: (mode: PromptPermissionMode) => void;
  readonly disabled?: boolean;
}

/** The three permission modes the engine accepts, in design-doc order. */
const OPTIONS: readonly { value: PromptPermissionMode; label: string; description: string }[] = [
  { value: 'manual', label: 'Ask for approval', description: '每次工具调用前询问' },
  { value: 'auto', label: 'Auto', description: '按会话内规则自动批准' },
  { value: 'yolo', label: 'Full access', description: '不询问，直接执行' },
];

/**
 * Composer permission-mode dropdown. The selection rides every prompt body
 * (`permission_mode`) and is persisted to localStorage by the owner (Composer),
 * so the choice survives restarts.
 */
export function PermissionModeSelect({ value, onChange, disabled = false }: PermissionModeSelectProps) {
  return (
    <select
      value={value}
      disabled={disabled}
      aria-label="权限模式"
      title="Permission mode"
      onChange={(event) => onChange(event.target.value as PromptPermissionMode)}
      className="h-7 rounded-lg border border-transparent bg-transparent px-2 text-[11.5px] font-medium text-[var(--color-text-secondary)] outline-none hover:bg-[var(--color-list-hover)] focus:border-[var(--color-border-heavy)] disabled:opacity-60"
    >
      {OPTIONS.map((option) => (
        <option key={option.value} value={option.value} title={option.description}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
