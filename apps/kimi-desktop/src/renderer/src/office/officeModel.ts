import type { AgentPhase } from '@moonshot-ai/protocol';

import type {
  OfficeAgentKind,
  OfficeAgentState,
  OfficeAgentView,
  OfficeCollaborationMode,
} from '#/office/types';

const OFFICES = [
  { title: '中书令', department: '中书省 · 总领筹谋', color: '#c8352a' },
  { title: '户部郎', department: '户部 · 搜集考据', color: '#2e9e5b' },
  { title: '尚书仆射', department: '尚书省 · 统筹执行', color: '#2f7fd0' },
  { title: '礼部郎', department: '礼部 · 文辞交付', color: '#c2507a' },
  { title: '工部郎', department: '工部 · 构建点验', color: '#cf7a24' },
  { title: '门下侍中', department: '门下省 · 审议复核', color: '#8b5fc0' },
] as const;

function stableIndex(value: string): number {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % OFFICES.length;
}

export function classifyAgent(options: {
  agentId: string;
  label?: string;
  parentAgentId?: string;
  swarmIndex?: number;
  runInBackground?: boolean;
}): OfficeAgentKind {
  if (options.agentId === 'main') return 'main';
  if (options.runInBackground === true) return 'background';
  if (options.swarmIndex !== undefined) return 'swarm';
  const label = options.label?.toLowerCase() ?? '';
  if (
    label.includes('expert') ||
    (options.parentAgentId !== undefined && options.parentAgentId !== 'main')
  ) {
    return 'expert';
  }
  return 'subagent';
}

export function officialIdentity(
  agentId: string,
  kind: OfficeAgentKind,
  swarmIndex?: number,
): (typeof OFFICES)[number] {
  if (kind === 'main') return OFFICES[0];
  if (kind === 'swarm') return OFFICES[(swarmIndex ?? 0) % OFFICES.length]!;
  if (kind === 'expert') return OFFICES[5];
  if (kind === 'background') return OFFICES[1];
  return OFFICES[1 + (stableIndex(agentId) % (OFFICES.length - 1))]!;
}

export function mapOfficePhase(phase: AgentPhase | undefined): {
  state: OfficeAgentState;
  task: string;
} {
  if (phase === undefined) return { state: 'idle', task: '候令' };
  switch (phase.kind) {
    case 'idle':
      return { state: 'idle', task: '候令' };
    case 'running':
      return { state: 'work', task: '正在办事' };
    case 'tool_call':
      return {
        state: 'work',
        task: phase.name ? `调用 ${phase.name}` : '调用工具',
      };
    case 'streaming':
      if (phase.stream === 'thinking') {
        return { state: 'think', task: '推演方案' };
      }
      if (phase.stream === 'tool_call' && phase.toolName !== undefined) {
        return { state: 'work', task: `调用 ${phase.toolName}` };
      }
      return { state: 'work', task: '撰写答复' };
    case 'retrying':
      return {
        state: 'review',
        task: `复核重试 ${phase.nextAttempt}/${phase.maxAttempts}`,
      };
    case 'awaiting_approval':
      return { state: 'review', task: '候旨批复' };
    case 'interrupted':
      return { state: 'failed', task: '办事中断' };
    case 'ended':
      return phase.reason === 'completed'
        ? { state: 'done', task: '交旨完毕' }
        : { state: 'failed', task: '未能交旨' };
  }
}

export function collaborationMode(
  agents: readonly Pick<OfficeAgentView, 'kind'>[],
  swarmMode: boolean,
): OfficeCollaborationMode {
  if (swarmMode || agents.some((agent) => agent.kind === 'swarm')) return 'swarm';
  if (agents.some((agent) => agent.kind === 'expert')) return 'expert';
  if (agents.some((agent) => agent.kind !== 'main')) return 'subagents';
  return 'single';
}

export const STATUS_LABEL: Record<OfficeAgentState, string> = {
  idle: '候令',
  think: '筹谋',
  work: '办事',
  review: '封驳',
  done: '交旨',
  failed: '驳回',
};

export const MODE_LABEL: Record<OfficeCollaborationMode, string> = {
  single: '独任办差',
  subagents: '诸司协办',
  expert: '专家会审',
  swarm: '蜂群并行',
};
