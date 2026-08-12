/**
 * Scenario: Git commit-message assistance uses bounded workspace changes in a
 * tool-free model request without mutating Git or conversation state.
 * Wiring: the service is resolved by interface with workspace-fs and LLM
 * requester boundaries stubbed. Run: pnpm test -- test/agent/gitCommitMessage/agentGitCommitMessage.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import {
  IAgentGitCommitMessageService,
} from '#/agent/gitCommitMessage/agentGitCommitMessage';
import { AgentGitCommitMessageService } from '#/agent/gitCommitMessage/agentGitCommitMessageService';
import {
  IAgentLLMRequesterService,
  type AgentLLMRequestOverrides,
} from '#/agent/llmRequester/llmRequester';
import { emptyUsage } from '#/kosong/contract/usage';
import { ISessionActivityView } from '#/session/sessionActivity/sessionActivity';
import { IWorkspaceFsService } from '#/workspace/workspaceFs/fs';

describe('IAgentGitCommitMessageService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let requests: AgentLLMRequestOverrides[];
  let diffModes: string[];

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    requests = [];
    diffModes = [];
    ix.stub(ISessionActivityView, {
      state: () => ({
        busy: false,
        mainTurnActive: false,
        pendingInteraction: 'none',
      }),
      onDidChange: () => ({ dispose() {} }),
    });
    ix.stub(IWorkspaceFsService, {
      gitStatus: async () => ({
        branch: 'main',
        ahead: 0,
        behind: 0,
        entries: { 'src/app.ts': 'modified' },
        stagedEntries: { 'src/app.ts': 'modified' },
        unstagedEntries: {},
        additions: 1,
        deletions: 0,
        pullRequest: null,
      }),
      diff: async ({ path, mode }) => {
        diffModes.push(mode);
        return { path, diff: '+const answer = 42;', truncated: false };
      },
    });
    ix.stub(IAgentLLMRequesterService, {
      request: async (overrides) => {
        requests.push(overrides ?? {});
        return {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '```text\nfeat: add the answer\n```' }],
            toolCalls: [],
          },
          usage: emptyUsage(),
        };
      },
    });
    ix.set(
      IAgentGitCommitMessageService,
      new SyncDescriptor(AgentGitCommitMessageService),
    );
  });

  afterEach(() => disposables.dispose());

  it('returns a normalized commit message from staged changes', async () => {
    const result = await ix.get(IAgentGitCommitMessageService).generate({
      include_unstaged: false,
    });

    expect(result).toEqual({ message: 'feat: add the answer' });
  });

  it('requests the model without tools or conversation history', async () => {
    await ix.get(IAgentGitCommitMessageService).generate({ include_unstaged: false });

    expect(requests[0]).toMatchObject({
      tools: [],
      source: { type: 'operation', requestKind: 'git_commit_message' },
      maxOutputSize: 2_048,
    });
    expect(requests[0]?.messages).toHaveLength(1);
  });

  it('uses staged diff mode when unstaged changes are excluded', async () => {
    await ix.get(IAgentGitCommitMessageService).generate({ include_unstaged: false });

    expect(diffModes).toEqual(['staged']);
  });

  it('excludes unstaged-only paths from staged commit-message context', async () => {
    ix.stub(IWorkspaceFsService, 'gitStatus', async () => ({
      branch: 'main',
      ahead: 0,
      behind: 0,
      entries: { 'src/app.ts': 'modified', 'src/draft.ts': 'modified' },
      stagedEntries: { 'src/app.ts': 'modified' },
      unstagedEntries: { 'src/draft.ts': 'modified' },
      additions: 2,
      deletions: 0,
      pullRequest: null,
    }));

    await ix.get(IAgentGitCommitMessageService).generate({ include_unstaged: false });

    const userText = requests[0]?.messages?.[0]?.content[0];
    expect(userText !== undefined && userText.type === 'text' ? userText.text : '').not.toContain(
      'src/draft.ts',
    );
  });

  it('includes the supplied draft only in the isolated user request', async () => {
    await ix.get(IAgentGitCommitMessageService).generate({
      draft: 'fix answer',
      include_unstaged: false,
    });

    const request = requests[0];
    const userText = request?.messages?.[0]?.content[0];
    expect(userText).toMatchObject({ type: 'text' });
    expect(userText !== undefined && userText.type === 'text' ? userText.text : '').toContain(
      'fix answer',
    );
    expect(request?.systemPrompt).not.toContain('fix answer');
  });

  it('does not call the model when there are no eligible changes', async () => {
    ix.stub(IWorkspaceFsService, 'gitStatus', async () => ({
      branch: 'main',
      ahead: 0,
      behind: 0,
      entries: {},
      stagedEntries: {},
      unstagedEntries: {},
      additions: 0,
      deletions: 0,
      pullRequest: null,
    }));

    await expect(
      ix.get(IAgentGitCommitMessageService).generate({ include_unstaged: false }),
    ).rejects.toThrow('Git operation failed');
    expect(requests).toEqual([]);
  });

  it('rejects commit-message generation while the session is busy', async () => {
    ix.stub(ISessionActivityView, 'state', () => ({
      busy: true,
      mainTurnActive: true,
      pendingInteraction: 'none',
    }));

    await expect(
      ix.get(IAgentGitCommitMessageService).generate({ include_unstaged: false }),
    ).rejects.toThrow('Session is busy');
    expect(requests).toEqual([]);
  });
});
