import { describe, expect, it } from 'vitest';

import {
  classifyAgent,
  collaborationMode,
  mapOfficePhase,
} from '../src/renderer/src/office/officeModel';

describe('office protocol projection', () => {
  it('distinguishes expert, swarm, and background agents from protocol facts', () => {
    expect(classifyAgent({ agentId: 'main' })).toBe('main');
    expect(
      classifyAgent({ agentId: 'agent-1', label: 'expert-reviewer' }),
    ).toBe('expert');
    expect(classifyAgent({ agentId: 'agent-2', swarmIndex: 3 })).toBe(
      'swarm',
    );
    expect(
      classifyAgent({ agentId: 'agent-3', runInBackground: true }),
    ).toBe('background');
  });

  it('maps live phases into the office vocabulary', () => {
    expect(
      mapOfficePhase({
        kind: 'streaming',
        turnId: 1,
        step: 0,
        stepId: 'step-1',
        stream: 'thinking',
        since: 1,
      }),
    ).toEqual({ state: 'think', task: '推演方案' });
    expect(
      mapOfficePhase({
        kind: 'awaiting_approval',
        turnId: 1,
        since: 1,
      }),
    ).toEqual({ state: 'review', task: '候旨批复' });
  });

  it('gives swarm mode precedence over other collaboration types', () => {
    expect(collaborationMode([{ kind: 'expert' }], false)).toBe('expert');
    expect(
      collaborationMode([{ kind: 'expert' }, { kind: 'swarm' }], false),
    ).toBe('swarm');
    expect(collaborationMode([{ kind: 'main' }], true)).toBe('swarm');
  });
});
