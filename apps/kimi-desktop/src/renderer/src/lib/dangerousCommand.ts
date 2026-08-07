/**
 * Dangerous-command detection for approval cards (M7) — a port of the TUI's
 * eight patterns (`apps/kimi-code/src/tui/reverse-rpc/approval/adapter.ts`
 * `DANGER_PATTERNS`). Pure functions, unit-tested in a node environment.
 */

import { ToolInputDisplaySchema } from '@moonshot-ai/protocol';

const DANGER_PATTERNS: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /\brm\s+(-[a-zA-Z]*[rRfF][a-zA-Z]*|--recursive|--force)/i, label: '递归删除' },
  { pattern: /\bsudo\b/i, label: 'sudo' },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/i, label: '管道到 shell' },
  { pattern: /\bdd\b[^|]*\bof=/i, label: 'dd 写盘' },
  { pattern: /\bmkfs\b/i, label: 'mkfs' },
  { pattern: />\s*\/dev\/(sd|nvme|disk|hd)/i, label: '写入原始设备' },
  { pattern: /\bchmod\s+-R?\s*777\b/i, label: 'chmod 777' },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}/i, label: 'fork bomb' },
];

/** The first dangerous pattern label matching the command, or undefined. */
export function detectDangerousCommand(command: string): string | undefined {
  for (const { pattern, label } of DANGER_PATTERNS) {
    if (pattern.test(command)) return label;
  }
  return undefined;
}

/** Extract the shell command from a `ToolInputDisplay` (`kind: 'command'`). */
export function extractCommandDisplay(display: unknown): string | undefined {
  const parsed = ToolInputDisplaySchema.safeParse(display);
  if (!parsed.success || parsed.data.kind !== 'command') return undefined;
  return parsed.data.command;
}
