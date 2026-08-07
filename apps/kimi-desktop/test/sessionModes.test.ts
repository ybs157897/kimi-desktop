import { describe, expect, it } from 'vitest';

import type {
  AgentStatusUpdatedEvent,
  GoalSnapshot,
  Session,
  SessionAgentConfig,
  SessionStatusResponse,
} from '@moonshot-ai/protocol';

import {
  agentConfigPatch,
  applyStatusEventToSession,
  applyStatusEventToStatus,
  formatDuration,
  formatTokens,
  GOAL_STATUS_LABELS,
  goalProgress,
} from '../src/renderer/src/lib/sessionModes';

// ------------------------------------------------------------------ fixtures

function makeSession(agentConfig: SessionAgentConfig = { model: 'kimi-k2' }): Session {
  return {
    id: 's_test',
    workspace_id: 'wd_test_000000000000',
    title: '测试会话',
    created_at: '2026-08-07T00:00:00.000Z',
    updated_at: '2026-08-07T00:00:00.000Z',
    busy: false,
    metadata: { cwd: '/tmp' },
    agent_config: agentConfig,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_cost_usd: 0,
      context_tokens: 0,
      context_limit: 0,
      turn_count: 0,
    },
    permission_rules: [],
    message_count: 0,
    last_seq: 0,
  };
}

function makeGoal(budget: Partial<GoalSnapshot['budget']>): GoalSnapshot {
  return {
    goalId: 'g1',
    objective: '修复所有测试失败',
    status: 'active',
    turnsUsed: 3,
    tokensUsed: 1230,
    wallClockMs: 252_000,
    budget: {
      tokenBudget: null,
      turnBudget: null,
      wallClockBudgetMs: null,
      remainingTokens: null,
      remainingTurns: null,
      remainingWallClockMs: null,
      tokenBudgetReached: false,
      turnBudgetReached: false,
      wallClockBudgetReached: false,
      overBudget: false,
      ...budget,
    },
  };
}

// ------------------------------------------------------------- agentConfigPatch

describe('agentConfigPatch', () => {
  it('wraps a partial agent config in the profile write body', () => {
    expect(agentConfigPatch({ permission_mode: 'yolo' })).toEqual({
      agent_config: { permission_mode: 'yolo' },
    });
  });

  it('accepts a multi-field patch', () => {
    expect(agentConfigPatch({ plan_mode: true, goal_objective: 'x' })).toEqual({
      agent_config: { plan_mode: true, goal_objective: 'x' },
    });
  });
});

// ------------------------------------------------------- applyStatusEventToSession

describe('applyStatusEventToSession', () => {
  it('merges permission / plan / swarm / model into agent_config', () => {
    const event: AgentStatusUpdatedEvent = {
      type: 'agent.status.updated',
      permission: 'yolo',
      planMode: true,
      swarmMode: true,
      model: 'kimi-k3',
    };
    const merged = applyStatusEventToSession(makeSession(), event);
    expect(merged.agent_config).toMatchObject({
      permission_mode: 'yolo',
      plan_mode: true,
      swarm_mode: true,
      model: 'kimi-k3',
    });
  });

  it('leaves unrelated agent_config fields untouched', () => {
    const session = makeSession({ model: 'kimi-k2', goal_objective: '旧目标', thinking: 'high' });
    const merged = applyStatusEventToSession(session, {
      type: 'agent.status.updated',
      planMode: false,
    });
    expect(merged.agent_config.goal_objective).toBe('旧目标');
    expect(merged.agent_config.thinking).toBe('high');
  });

  it('does not overwrite fields absent from the event', () => {
    const session = makeSession({ model: 'kimi-k2', plan_mode: true });
    const merged = applyStatusEventToSession(session, {
      type: 'agent.status.updated',
      permission: 'auto',
    });
    expect(merged.agent_config.plan_mode).toBe(true);
    expect(merged.agent_config.model).toBe('kimi-k2');
  });

  it('ignores an empty model string', () => {
    const merged = applyStatusEventToSession(makeSession(), {
      type: 'agent.status.updated',
      model: '',
    });
    expect(merged.agent_config.model).toBe('kimi-k2');
  });

  it('returns a new session object without mutating the input', () => {
    const session = makeSession();
    const merged = applyStatusEventToSession(session, {
      type: 'agent.status.updated',
      planMode: true,
    });
    expect(merged).not.toBe(session);
    expect(session.agent_config.plan_mode).toBeUndefined();
  });
});

// --------------------------------------------------------------- formatDuration

describe('formatDuration', () => {
  it('formats sub-minute durations in seconds', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45_000)).toBe('45s');
  });

  it('drops the seconds when the duration is whole minutes', () => {
    expect(formatDuration(240_000)).toBe('4m');
  });

  it('keeps seconds for uneven minutes', () => {
    expect(formatDuration(252_000)).toBe('4m 12s');
  });

  it('formats hours', () => {
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(3_900_000)).toBe('1h 5m');
  });

  it('clamps negative input', () => {
    expect(formatDuration(-10)).toBe('0s');
  });
});

// ----------------------------------------------------------------- formatTokens

describe('formatTokens', () => {
  it('leaves small counts verbatim', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(980)).toBe('980');
  });

  it('compacts thousands', () => {
    expect(formatTokens(1_000)).toBe('1k');
    expect(formatTokens(12_000)).toBe('12k');
    expect(formatTokens(12_300)).toBe('12.3k');
  });

  it('compacts millions', () => {
    expect(formatTokens(1_500_000)).toBe('1.5M');
    expect(formatTokens(2_000_000)).toBe('2M');
  });
});

// ------------------------------------------------------------------ goalProgress

describe('goalProgress', () => {
  it('reports turn-budget progress first', () => {
    const progress = goalProgress(makeGoal({ turnBudget: 20 }));
    expect(progress).toEqual({ percent: 15, used: '3 / 20 回合' });
  });

  it('falls back to the token budget when no turn budget is declared', () => {
    const progress = goalProgress(makeGoal({ tokenBudget: 10_000 }));
    expect(progress).toEqual({ percent: 12, used: '1.2k / 10k tokens' });
  });

  it('falls back to the wall-clock budget', () => {
    const progress = goalProgress(makeGoal({ wallClockBudgetMs: 600_000 }));
    expect(progress).toEqual({ percent: 42, used: '4m 12s / 10m' });
  });

  it('is undefined when no budget is declared', () => {
    expect(goalProgress(makeGoal({}))).toBeUndefined();
  });

  it('clamps over-budget ratios to 100', () => {
    const progress = goalProgress(makeGoal({ turnBudget: 2 }));
    expect(progress?.percent).toBe(100);
  });

  it('returns a null percent for a zero budget', () => {
    const progress = goalProgress(makeGoal({ tokenBudget: 0 }));
    expect(progress?.percent).toBeNull();
    expect(progress?.used).toBe('1.2k / 0 tokens');
  });
});

// ------------------------------------------------------- applyStatusEventToStatus

describe('applyStatusEventToStatus', () => {
  const status: SessionStatusResponse = {
    busy: false,
    model: 'kimi-k2',
    thinking_level: 'low',
    permission: 'manual',
    plan_mode: false,
    swarm_mode: false,
    context_tokens: 1000,
    max_context_tokens: 64000,
    context_usage: 0.5,
  };

  it('merges the live context / mode fields into the status record', () => {
    const merged = applyStatusEventToStatus(status, {
      type: 'agent.status.updated',
      model: 'kimi-k3',
      thinkingEffort: 'high',
      permission: 'auto',
      planMode: true,
      swarmMode: true,
      contextTokens: 2000,
      maxContextTokens: 128000,
      contextUsage: 0.25,
    });
    expect(merged).toMatchObject({
      model: 'kimi-k3',
      thinking_level: 'high',
      permission: 'auto',
      plan_mode: true,
      swarm_mode: true,
      context_tokens: 2000,
      max_context_tokens: 128000,
      context_usage: 0.25,
    });
    expect(merged.busy).toBe(false);
  });

  it('never overwrites a known context limit with the 0 = unknown marker', () => {
    const merged = applyStatusEventToStatus(status, {
      type: 'agent.status.updated',
      maxContextTokens: 0,
    });
    expect(merged.max_context_tokens).toBe(64000);
  });

  it('leaves fields absent from the event untouched', () => {
    const merged = applyStatusEventToStatus(status, {
      type: 'agent.status.updated',
      contextUsage: 0.9,
    });
    expect(merged.thinking_level).toBe('low');
    expect(merged.context_tokens).toBe(1000);
  });

  it('returns a new object without mutating the input', () => {
    const merged = applyStatusEventToStatus(status, {
      type: 'agent.status.updated',
      contextUsage: 0.9,
    });
    expect(merged).not.toBe(status);
    expect(status.context_usage).toBe(0.5);
  });
});

// ------------------------------------------------------------- status labels

describe('GOAL_STATUS_LABELS', () => {
  it('covers every goal status', () => {
    expect(Object.keys(GOAL_STATUS_LABELS).sort()).toEqual([
      'active',
      'blocked',
      'complete',
      'paused',
    ]);
  });
});
