/**
 * Scenario: user agent-profile REST schemas — validates create/update/state
 * payloads and the builtin/user descriptor distinction.
 * Run: `pnpm --filter @moonshot-ai/protocol exec vitest run
 * src/__tests__/rest-agent-profile.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  agentProfileDescriptorSchema,
  createAgentProfileRequestSchema,
  deleteAgentProfileResponseSchema,
  setAgentProfileEnabledRequestSchema,
} from '../rest/agentProfile';

describe('rest/agentProfile — user profile management', () => {
  it('parses a complete user profile create request', () => {
    const parsed = createAgentProfileRequestSchema.parse({
      name: 'code-reviewer',
      description: 'Reviews risky changes',
      when_to_use: 'Before merging',
      color: 'violet',
      tools: ['Read', 'Grep'],
      disallowed_tools: ['Bash'],
      subagents: ['explore'],
      prompt: 'Review the change carefully.',
    });

    expect(parsed).toEqual({
      name: 'code-reviewer',
      description: 'Reviews risky changes',
      when_to_use: 'Before merging',
      color: 'violet',
      tools: ['Read', 'Grep'],
      disallowed_tools: ['Bash'],
      subagents: ['explore'],
      prompt: 'Review the change carefully.',
      enabled: true,
    });
  });

  it('rejects a user profile name that is not kebab-case', () => {
    expect(
      createAgentProfileRequestSchema.safeParse({
        name: 'Code Reviewer',
        description: 'Reviews code',
        prompt: 'Review code.',
      }).success,
    ).toBe(false);
  });

  it('parses an editable disabled user descriptor', () => {
    const parsed = agentProfileDescriptorSchema.parse({
      name: 'reviewer',
      description: 'Reviews code',
      source: 'user',
      enabled: false,
      editable: true,
      prompt: 'Review code.',
      path: '/tmp/agents/reviewer.md',
      color: 'coral',
    });

    expect(parsed.enabled).toBe(false);
    expect(parsed.source).toBe('user');
    expect(parsed.color).toBe('coral');
  });

  it('requires a boolean when changing profile state', () => {
    expect(setAgentProfileEnabledRequestSchema.safeParse({ enabled: 'yes' }).success).toBe(false);
  });

  it('parses the deleted profile name in a delete response', () => {
    expect(deleteAgentProfileResponseSchema.parse({ deleted: 'code-reviewer' })).toEqual({
      deleted: 'code-reviewer',
    });
  });
});
