interface ToggleSwitchProps {
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
  readonly size?: 'regular' | 'compact';
}

const SIZE_CLASSES = {
  regular: {
    track: 'h-6 w-[42px]',
    thumb: 'h-5 w-5',
    checked: 'translate-x-[18px]',
  },
  compact: {
    track: 'h-5 w-9',
    thumb: 'h-4 w-4',
    checked: 'translate-x-4',
  },
} as const;

export function ToggleSwitch({
  checked,
  disabled = false,
  label,
  onChange,
  size = 'regular',
}: ToggleSwitchProps) {
  const classes = SIZE_CLASSES[size];
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        onChange(!checked);
      }}
      className={`relative inline-flex shrink-0 rounded-full border border-transparent transition-colors duration-[var(--duration-popover)] ease-[var(--ease-out)] motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-background-panel)] disabled:cursor-not-allowed disabled:opacity-50 ${classes.track} ${
        checked ? 'bg-[var(--primary)]' : 'bg-[var(--toggle-off)]'
      }`}
    >
      <span
        className={`absolute left-0.5 top-0.5 rounded-full bg-white shadow-sm transition-transform duration-[var(--duration-popover)] ease-[var(--ease-out)] motion-reduce:transition-none ${classes.thumb} ${
          checked ? classes.checked : 'translate-x-0'
        }`}
        aria-hidden
      />
    </button>
  );
}
