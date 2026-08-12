/**
 * Scenarios: Desktop presentation, rendering, and local preference contracts.
 * Wiring: pure renderer modules and React SSR; no external boundary is stubbed.
 * Run: pnpm --filter @moonshot-ai/kimi-desktop exec vitest run test/experience.test.ts
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { Marked } from 'marked';
import type { Token, Tokens } from 'marked';
import {
  isValidElement,
  createElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  attachmentImageSrc,
  isImageAttachment,
  isImageMediaType,
} from '../src/renderer/src/lib/attachmentImage';
import {
  advanceStreamState,
  buildStreamedSource,
  createInitialStreamState,
  splitStreamingDelta,
} from '../src/renderer/src/components/markdown/streaming';
import { pairStreamHtml } from '../src/renderer/src/components/markdown/streamHtml';
import { codeBlockLanguage } from '../src/renderer/src/components/markdown/codeBlockLanguage';
import { MarkdownMath } from '../src/renderer/src/components/markdown/MarkdownMath';
import { ToggleSwitch } from '../src/renderer/src/components/ToggleSwitch';
import {
  createMarkdownExtensions,
  type MathToken,
} from '../src/renderer/src/components/markdown/extensions';
import {
  configuredThinkingEffort,
  resolveThinkingEffort,
  thinkingConfigPatch,
} from '../src/renderer/src/lib/conversationDefaults';
import {
  DEFAULT_APPEARANCE_PREFERENCES,
  appearanceStyleProperties,
  parseAppearancePreferences,
} from '../src/renderer/src/lib/appearancePreferences';
import {
  APPEARANCE_STORAGE_KEY,
  clearAppearancePreferences,
  loadAppearancePreferences,
  saveAppearancePreferences,
} from '../src/renderer/src/lib/appearancePreferenceStore';
import { computeScaledSize } from '../src/renderer/src/lib/imageScale';
import {
  newSessionErrorMessage,
  resolveNewSessionCwd,
} from '../src/renderer/src/lib/newSession';
import { ApiError } from '../src/renderer/src/lib/api';
import {
  groupModelCatalog,
  modelCatalogItemId,
  resolvePromptModel,
} from '../src/renderer/src/lib/modelCatalog';
import { webAppUrl } from '../src/renderer/src/lib/webUrl';
import { buildChangeTree } from '../src/renderer/src/lib/changeTree';
import {
  canDiscardGitChange,
  friendlyGitOperationError,
  gitBranchCreationName,
  gitBranchPickerItems,
  gitChangeGroups,
  gitChangeKey,
  gitDiscardCopy,
} from '../src/renderer/src/lib/gitPresentation';
import { approvalInteractionPresentation } from '../src/renderer/src/lib/approvalInteraction';
import { goalObjectiveForSubmission } from '../src/renderer/src/lib/sessionModes';
import { isLiveAgentPhase } from '../src/renderer/src/office/phaseMap';
import {
  projectAgentPendingInteractions,
  projectPendingSessionInteractions,
} from '../src/renderer/src/lib/sessionInteractions';
import {
  agentCallTypeLabel,
  hasUserTurnAfter,
  hasUserTurnSince,
  hasThinkingContent,
  latestTurnOrdinal,
  liveTailFrameId,
  pendingInteractionForToolFrame,
  pendingComposerInteractions,
  resultTextFrameId,
  shouldAbortAfterApproval,
  taskForToolFrame,
  visibleTimelineItems,
} from '../src/renderer/src/lib/timelinePresentation';
import {
  resolveToolRunPresentation,
  toolRunsFromTurn,
} from '../src/renderer/src/lib/toolRunsFromTurn';
import {
  mergeSessionSubagents,
  projectSubagentActivity,
  selectPanelSubagents,
  summarizeSubagents,
} from '../src/renderer/src/lib/subagentSummary';
import type {
  ToolCallFrame,
  TranscriptFrame,
  TranscriptInteraction,
  TranscriptStep,
  TranscriptTask,
  TranscriptTurn,
} from '@moonshot-ai/transcript';
import { ErrorCode, fsGitStatusResponseSchema } from '@moonshot-ai/protocol';
import type { SessionSubagentSnapshot } from '../src/renderer/src/lib/api';
import {
  DESKTOP_TITLEBAR_HEIGHT,
  resolveDesktopWindowChrome,
} from '../src/shared/windowChrome';

describe('desktop design tokens', () => {
  it('defines every custom property referenced by the token layer', () => {
    const css = readFileSync(
      new URL('../src/renderer/src/styles/tokens.css', import.meta.url),
      'utf8',
    );
    const definitions = new Set(
      [...css.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((match) => match[1]!),
    );
    const references = new Set(
      [...css.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1]!),
    );

    expect([...references].filter((reference) => !definitions.has(reference))).toEqual([]);
  });
});

describe('desktop Git change presentation', () => {
  it('puts the current branch first without reordering the remaining service results', () => {
    expect(
      gitBranchPickerItems(['feature/newest', 'main', 'feature/older'], 'main', ''),
    ).toEqual([
      { name: 'main', current: true },
      { name: 'feature/newest', current: false },
      { name: 'feature/older', current: false },
    ]);
  });

  it('filters local branches case-insensitively', () => {
    expect(
      gitBranchPickerItems(['main', 'Feature/Desktop', 'release'], 'main', 'desktop'),
    ).toEqual([{ name: 'Feature/Desktop', current: false }]);
  });

  it('returns no branch rows when the search has no match', () => {
    expect(gitBranchPickerItems(['main', 'release'], 'main', 'missing')).toEqual([]);
  });

  it('normalizes a non-empty new branch name before creation', () => {
    expect(gitBranchCreationName('  feature/picker  ', ['main'])).toBe('feature/picker');
  });

  it('does not offer branch creation when that exact branch exists', () => {
    expect(gitBranchCreationName('main', ['main', 'release'])).toBeNull();
  });

  it('does not offer branch creation for a blank name', () => {
    expect(gitBranchCreationName('   ', ['main'])).toBeNull();
  });

  it('keeps the staged and unstaged versions of one path as separate selectable changes', () => {
    const groups = gitChangeGroups({
      entries: { 'src/app.ts': 'modified' },
      stagedEntries: { 'src/app.ts': 'modified' },
      unstagedEntries: { 'src/app.ts': 'modified' },
    } as never);

    expect(groups.staged).toEqual([
      { cohort: 'staged', path: 'src/app.ts', status: 'modified' },
    ]);
    expect(groups.unstaged).toEqual([
      { cohort: 'unstaged', path: 'src/app.ts', status: 'modified' },
    ]);
    expect(gitChangeKey(groups.staged[0]!)).toBe('staged:src/app.ts');
    expect(gitChangeKey(groups.unstaged[0]!)).toBe('unstaged:src/app.ts');
  });

  it('projects legacy combined status into the unstaged group when cohort fields are absent', () => {
    const groups = gitChangeGroups({
      entries: { 'README.md': 'modified' },
    } as never);

    expect(groups).toEqual({
      staged: [],
      unstaged: [{ cohort: 'unstaged', path: 'README.md', status: 'modified' }],
    });
  });

  it('projects legacy combined status after protocol defaults add empty cohort maps', () => {
    const legacyResponse = fsGitStatusResponseSchema.parse({
      branch: 'main',
      ahead: 0,
      behind: 0,
      entries: { 'README.md': 'modified' },
      additions: 1,
      deletions: 0,
      pullRequest: null,
    });
    const groups = gitChangeGroups(legacyResponse);

    expect(groups).toEqual({
      staged: [],
      unstaged: [{ cohort: 'unstaged', path: 'README.md', status: 'modified' }],
    });
  });

  it('marks discarding an untracked file as irreversible', () => {
    const untracked = { cohort: 'unstaged', path: 'scratch.txt', status: 'untracked' } as const;

    expect(gitDiscardCopy([untracked])).toEqual({
      title: '删除未跟踪文件？',
      description: '未跟踪文件会被永久删除，其余文件会恢复到暂存区中的内容。此操作无法撤销。',
      irreversible: true,
    });
  });

  it('leaves a conflicted file without the ordinary discard action', () => {
    const conflicted = { cohort: 'unstaged', path: 'src/app.ts', status: 'conflicted' } as const;

    expect(canDiscardGitChange(conflicted)).toBe(false);
  });

  it('surfaces the server Git diagnostic when a mutation fails', () => {
    const error = new ApiError(40908, 'git operation failed', 200, {
      cwd: '/private/example',
      detail: 'remote rejected: protected branch',
    });

    expect(friendlyGitOperationError(error, '推送')).toBe(
      '推送失败。remote rejected: protected branch',
    );
  });

  it('redacts credentials from a remote Git diagnostic', () => {
    const error = new ApiError(40908, 'git operation failed', 200, {
      detail: 'fatal: unable to access https://user:secret@example.test/repo.git?token=secret-token',
    });

    expect(friendlyGitOperationError(error, '拉取')).toBe(
      '拉取失败。fatal: unable to access https://example.test/repo.git?token=[REDACTED]',
    );
  });

  it('explains why repository-wide operations are blocked from a nested project', () => {
    const error = new ApiError(40908, 'git operation failed', 200, {
      detail: 'pull must be run from the repository root workspace',
    });

    expect(friendlyGitOperationError(error, '拉取')).toBe(
      '拉取失败：请将 Git 仓库根目录作为项目打开后重试。',
    );
  });

  it('asks the user to wait before generating a commit message during active work', () => {
    const error = new ApiError(40901, 'Session is busy', 200, {
      detail: '当前任务仍在运行，请等待任务结束后再生成提交信息。',
    });

    expect(friendlyGitOperationError(error, '生成提交消息')).toBe(
      '当前任务仍在运行，请等待任务结束后再生成提交信息。',
    );
  });
});

describe('desktop appearance preferences', () => {
  it('uses the current Desktop typography when no preference has been saved', () => {
    const css = readFileSync(
      new URL('../src/renderer/src/styles/tokens.css', import.meta.url),
      'utf8',
    );
    expect(css).toContain('--client-content-font-size: 14px;');
    expect(css).toContain('--markdown-font-size: 14px;');
    expect(css).toContain('--markdown-code-block-font-size: 13px;');
    expect(parseAppearancePreferences(null)).toEqual({
      interfaceFontSize: 14,
      markdownFontSize: 14,
      codeFontSize: 13,
      textColor: null,
    });
  });

  it('restores valid saved typography and normalizes the color value', () => {
    expect(
      parseAppearancePreferences(
        JSON.stringify({
          interfaceFontSize: 16,
          markdownFontSize: 18,
          codeFontSize: 15,
          textColor: '#A1B2C3',
        }),
      ),
    ).toEqual({
      interfaceFontSize: 16,
      markdownFontSize: 18,
      codeFontSize: 15,
      textColor: '#a1b2c3',
    });
  });

  it('keeps valid partial settings and fills missing fields from the defaults', () => {
    expect(
      parseAppearancePreferences(JSON.stringify({ markdownFontSize: 17 })),
    ).toEqual({
      interfaceFontSize: 14,
      markdownFontSize: 17,
      codeFontSize: 13,
      textColor: null,
    });
  });

  it('falls back to the current defaults when saved fields are out of range', () => {
    expect(
      parseAppearancePreferences(
        JSON.stringify({
          interfaceFontSize: 30,
          markdownFontSize: 11,
          codeFontSize: '15',
          textColor: 'red',
        }),
      ),
    ).toEqual({
      interfaceFontSize: 14,
      markdownFontSize: 14,
      codeFontSize: 13,
      textColor: null,
    });
  });

  it('falls back to the current defaults when saved JSON is malformed', () => {
    expect(parseAppearancePreferences('{not-json')).toEqual({
      interfaceFontSize: 14,
      markdownFontSize: 14,
      codeFontSize: 13,
      textColor: null,
    });
  });

  it('projects custom typography into the renderer CSS variables', () => {
    expect(
      appearanceStyleProperties({
        interfaceFontSize: 16,
        markdownFontSize: 18,
        codeFontSize: 15,
        textColor: '#345678',
      }),
    ).toEqual({
      '--client-content-font-size': '16px',
      '--client-title-font-size': '16px',
      '--client-sidebar-primary-font-size': '16px',
      '--markdown-font-size': '18px',
      '--markdown-code-block-font-size': '15px',
      '--color-user-text-foreground': '#345678',
    });
  });

  it('leaves no inline overrides after restoring the default appearance', () => {
    expect(
      appearanceStyleProperties(DEFAULT_APPEARANCE_PREFERENCES),
    ).toEqual({});
  });

  it('persists a custom appearance through the local preference boundary', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };

    saveAppearancePreferences(storage, {
      interfaceFontSize: 16,
      markdownFontSize: 18,
      codeFontSize: 15,
      textColor: '#345678',
    });

    expect(loadAppearancePreferences(storage)).toEqual({
      interfaceFontSize: 16,
      markdownFontSize: 18,
      codeFontSize: 15,
      textColor: '#345678',
    });
  });

  it('removes the saved override when restoring the current defaults', () => {
    const values = new Map<string, string>([
      [
        APPEARANCE_STORAGE_KEY,
        JSON.stringify({
          interfaceFontSize: 16,
          markdownFontSize: 18,
          codeFontSize: 15,
          textColor: '#345678',
        }),
      ],
    ]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };

    const restored = clearAppearancePreferences(storage);

    expect(restored).toEqual({
      interfaceFontSize: 14,
      markdownFontSize: 14,
      codeFontSize: 13,
      textColor: null,
    });
    expect(values.has(APPEARANCE_STORAGE_KEY)).toBe(false);
  });
});

describe('desktop toggle switch', () => {
  it('keeps the regular checked thumb inside the 42px track', () => {
    const markup = renderToStaticMarkup(
      createElement(ToggleSwitch, {
        checked: true,
        label: '默认计划模式',
        onChange: () => undefined,
      }),
    );

    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain('h-6 w-[42px]');
    expect(markup).toContain('left-0.5 top-0.5');
    expect(markup).toContain('h-5 w-5');
    expect(markup).toContain('translate-x-[18px]');
  });

  it('anchors the compact unchecked thumb on the left and exposes disabled state', () => {
    const markup = renderToStaticMarkup(
      createElement(ToggleSwitch, {
        checked: false,
        disabled: true,
        label: '启用专家团',
        onChange: () => undefined,
        size: 'compact',
      }),
    );

    expect(markup).toContain('aria-checked="false"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('h-5 w-9');
    expect(markup).toContain('h-4 w-4');
    expect(markup).toContain('translate-x-0');
  });
});

describe('markdown code block', () => {
  it('labels an untyped fenced block as plain text', () => {
    expect(codeBlockLanguage(undefined)).toEqual({ id: null, label: '纯文本' });
  });
});

describe('desktop window chrome', () => {
  it('replaces both visible Windows chrome rows with the renderer title bar', () => {
    expect(resolveDesktopWindowChrome('win32')).toEqual({
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: '#7c7c7c',
        height: DESKTOP_TITLEBAR_HEIGHT,
      },
      autoHideMenuBar: true,
      hideMenuBar: true,
    });
  });

  it('keeps the existing macOS inset traffic-light title bar', () => {
    expect(resolveDesktopWindowChrome('darwin')).toEqual({
      titleBarStyle: 'hiddenInset',
      titleBarOverlay: undefined,
      autoHideMenuBar: false,
      hideMenuBar: false,
    });
  });
});

describe('new session workspace', () => {
  it('does not resurrect a missing historical workspace after host roots load', () => {
    expect(
      resolveNewSessionCwd(
        { home: '/Users/example', recent_roots: [] },
        ['/Users/example/deleted-project'],
      ),
    ).toBe('/Users/example');
  });

  it('explains when the selected workspace directory no longer exists', () => {
    const error = new ApiError(ErrorCode.FS_PATH_NOT_FOUND, 'missing workspace', 404);
    expect(newSessionErrorMessage(error)).toBe(
      '工作区目录不存在或已移动，请重新选择。',
    );
  });

  it('reserves the connection warning for transport failures', () => {
    const error = new ApiError(-1, 'network error', 0);
    expect(newSessionErrorMessage(error)).toBe(
      '无法连接后端，请检查服务状态后重试。',
    );
  });
});

describe('Codex-style streaming timeline presentation', () => {
  it('removes internal undo and plan revision markers from the visible conversation', () => {
    const items = [
      { kind: 'marker' as const, markerId: 'm1', marker: 'undo' },
      { kind: 'marker' as const, markerId: 'm2', marker: 'plan.revision' },
      { kind: 'marker' as const, markerId: 'm3', marker: 'plan.enter' },
      { kind: 'marker' as const, markerId: 'm4', marker: 'interruption' },
      { kind: 'marker' as const, markerId: 'm5', marker: 'compact' },
      { kind: 'marker' as const, markerId: 'm6', marker: 'swarm.enter' },
    ];
    expect(
      visibleTimelineItems(items).map((item) =>
        item.kind === 'marker' ? item.marker : item.kind,
      ),
    ).toEqual(['compact']);
  });

  it('docks a subagent approval from the session-level pending collection', () => {
    const projected = projectPendingSessionInteractions(
      [
        {
          approval_id: 'approval-child',
          session_id: 'session-1',
          agent_id: 'agent-0',
          tool_call_id: 'tool-child',
          tool_name: 'Bash',
          action: '运行命令',
          tool_input_display: { kind: 'command', command: 'ls' },
          created_at: '2026-01-01T00:00:01.000Z',
          expires_at: '2026-01-02T00:00:01.000Z',
        },
      ],
      [],
    );

    expect(
      pendingComposerInteractions(projected).map((pending) => ({
        agentId: pending.sourceAgentId,
        interactionId: pending.interaction.interactionId,
      })),
    ).toEqual([{ agentId: 'agent-0', interactionId: 'approval-child' }]);
  });

  it('keeps main transcript approvals visible while the session query is loading', () => {
    const interaction: TranscriptInteraction = {
      interactionId: 'approval-main',
      interactionKind: 'approval',
      state: 'pending',
      request: {},
    };
    const fallback = projectAgentPendingInteractions(
      new Map([[interaction.interactionId, interaction]]),
      'main',
    );

    expect(pendingComposerInteractions(fallback)[0]?.sourceAgentId).toBe(
      'main',
    );
  });

  it('docks the newest session interaction across approvals and questions', () => {
    const projected = projectPendingSessionInteractions(
      [
        {
          approval_id: 'approval-older',
          session_id: 'session-1',
          agent_id: 'agent-0',
          tool_call_id: 'tool-approval',
          tool_name: 'Bash',
          action: '运行命令',
          tool_input_display: { kind: 'command', command: 'pwd' },
          created_at: '2026-01-01T00:00:01.000Z',
          expires_at: '2026-01-02T00:00:01.000Z',
        },
      ],
      [
        {
          question_id: 'question-newer',
          session_id: 'session-1',
          agent_id: 'agent-1',
          questions: [
            {
              id: 'q_0',
              question: '继续吗？',
              options: [
                { id: 'opt_0_0', label: '继续' },
                { id: 'opt_0_1', label: '停止' },
              ],
            },
          ],
          created_at: '2026-01-01T00:00:02.000Z',
        },
      ],
    );

    expect(
      pendingComposerInteractions(projected)[0]?.interaction.interactionId,
    ).toBe('question-newer');
  });

  it('stops the active prompt after rejection, except an explicit plan revision', () => {
    expect(shouldAbortAfterApproval('rejected')).toBe(true);
    expect(shouldAbortAfterApproval('rejected', 'Reject and Exit')).toBe(true);
    expect(shouldAbortAfterApproval('rejected', 'Revise')).toBe(false);
    expect(shouldAbortAfterApproval('approved')).toBe(false);
  });

  it('does not abort the main prompt after rejecting a child agent approval', () => {
    expect(shouldAbortAfterApproval('rejected', undefined, 'agent-0')).toBe(
      false,
    );
  });

  it('links an Agent frame to its subagent task when frame.taskId is absent', () => {
    const task: TranscriptTask = {
      taskId: 'agent-0',
      kind: 'subagent',
      state: 'running',
      detached: false,
      agentId: 'agent-0',
      outputTail: '',
    };

    expect(
      taskForToolFrame(
        { taskId: undefined, agentRefs: [{ agentId: 'agent-0' }] },
        new Map([[task.taskId, task]]),
      )?.taskId,
    ).toBe('agent-0');
  });

  it('links an Agent frame to its child pending approval', () => {
    const projected = projectPendingSessionInteractions(
      [
        {
          approval_id: 'approval-child',
          session_id: 'session-1',
          agent_id: 'agent-0',
          tool_call_id: 'tool-child',
          tool_name: 'Bash',
          action: '运行命令',
          tool_input_display: { kind: 'command', command: 'ls' },
          created_at: '2026-01-01T00:00:01.000Z',
          expires_at: '2026-01-02T00:00:01.000Z',
        },
      ],
      [],
    );

    expect(
      pendingInteractionForToolFrame(
        { agentRefs: [{ agentId: 'agent-0' }] },
        projected,
      )?.interaction.interactionId,
    ).toBe('approval-child');
  });

  it('distinguishes Tidal and Coder Agent calls from their explicit subagent type', () => {
    expect(
      agentCallTypeLabel(
        { name: 'Agent', input: { subagent_type: 'tidal' } },
        'Agent',
      ),
    ).toBe('Tidal');
    expect(
      agentCallTypeLabel(
        { name: 'Agent', input: { subagent_type: 'coder' } },
        'Agent',
      ),
    ).toBe('Coder Agent');
  });

  it('does not reserve a blank streaming reasoning body', () => {
    expect(hasThinkingContent('   ')).toBe(false);
    expect(hasThinkingContent('正在检查项目')).toBe(true);
  });

  it('keeps optimistic thinking visible until a newer user turn is observed', () => {
    const turn = (ordinal: number, origin: 'user' | 'cron' = 'user'): TranscriptTurn => ({
      kind: 'turn',
      turnId: `turn-${ordinal}-${origin}`,
      ordinal,
      state: 'completed',
      origin: { kind: origin },
      steps: [],
    });
    const baseline = [turn(3)];

    expect(latestTurnOrdinal(baseline)).toBe(3);
    expect(hasUserTurnAfter([turn(1), ...baseline], 3)).toBe(false);
    expect(hasUserTurnAfter([...baseline, turn(4, 'cron')], 3)).toBe(false);
    expect(hasUserTurnAfter([...baseline, turn(4)], 3)).toBe(true);
    expect(hasUserTurnAfter([turn(1)], undefined)).toBe(true);

    const historical = { ...turn(3), startedAt: '2026-08-11T12:00:00.000Z' };
    const submitted = { ...turn(4), startedAt: '2026-08-11T12:00:01.000Z' };
    expect(hasUserTurnSince([historical], '2026-08-11T12:00:01.000Z')).toBe(false);
    expect(hasUserTurnSince([historical, submitted], '2026-08-11T12:00:01.000Z')).toBe(true);
  });

  it('pins live-tail affordances to the newest frame, not the whole running turn', () => {
    const turn = {
      state: 'running' as const,
      steps: [
        {
          frames: [
            { frameId: 'thinking-1' },
            { frameId: 'text-1' },
            { frameId: 'tool-agent-1' },
          ],
        },
      ],
    };
    expect(liveTailFrameId(turn)).toBe('tool-agent-1');
    expect(liveTailFrameId({ ...turn, state: 'completed' })).toBeUndefined();
    expect(
      liveTailFrameId({
        state: 'running',
        steps: [{ frames: [{ frameId: 'text-only' }] }],
      }),
    ).toBe('text-only');
  });

  it('keeps only the final assistant text outside the folded process', () => {
    const turn = {
      kind: 'turn',
      turnId: 'turn-1',
      ordinal: 1,
      state: 'completed',
      origin: { kind: 'user' },
      steps: [
        {
          kind: 'step',
          stepId: 'step-1',
          turnId: 'turn-1',
          ordinal: 1,
          state: 'completed',
          frames: [
            { kind: 'text', frameId: 'commentary', role: 'assistant', text: '我先检查一下。' },
            { kind: 'tool', frameId: 'tool', toolCallId: 'tool-1', name: 'Read', state: 'done' },
            { kind: 'text', frameId: 'result', role: 'assistant', text: '检查完成。' },
          ],
        },
      ],
    } satisfies TranscriptTurn;

    expect(resultTextFrameId(turn)).toBe('result');
    expect(resultTextFrameId({ ...turn, state: 'running' })).toBe('result');
    expect(
      resultTextFrameId({
        ...turn,
        state: 'running',
        steps: [
          {
            ...turn.steps[0]!,
            state: 'running',
            frames: [
              ...turn.steps[0]!.frames,
              { kind: 'thinking', frameId: 'thinking', text: '继续' },
            ],
          },
        ],
      }),
    ).toBeUndefined();
  });
});

describe('AI office live roster', () => {
  it('shows only agents participating in the current live turn', () => {
    expect(
      isLiveAgentPhase({
        kind: 'running',
        turnId: 1,
        step: 0,
        stepId: 'step-1',
        since: 1,
      }),
    ).toBe(true);
    expect(
      isLiveAgentPhase({ kind: 'awaiting_approval', turnId: 1, since: 2 }),
    ).toBe(true);
    expect(isLiveAgentPhase({ kind: 'idle' })).toBe(false);
    expect(
      isLiveAgentPhase({
        kind: 'interrupted',
        turnId: 1,
        reason: 'aborted',
        at: 3,
      }),
    ).toBe(false);
    expect(
      isLiveAgentPhase({
        kind: 'ended',
        turnId: 1,
        reason: 'completed',
        at: 4,
      }),
    ).toBe(false);
  });
});

describe('approval interaction compatibility', () => {
  it('normalizes the engine transcript payload and uses the interaction id for resolution', () => {
    expect(
      approvalInteractionPresentation({
        interactionId: 'approval-1',
        toolCallId: 'tool-1',
        request: {
          toolName: 'Shell',
          toolCallId: 'tool-1',
          action: '运行命令',
          display: { kind: 'command', command: 'pwd' },
        },
      }),
    ).toEqual({
      approvalId: 'approval-1',
      toolCallId: 'tool-1',
      toolName: 'Shell',
      action: '运行命令',
      display: { kind: 'command', command: 'pwd' },
    });
  });
});

describe('change directory tree', () => {
  it('groups changed files by directory and compacts single-child directory chains', () => {
    expect(
      buildChangeTree([
        ['.agents/skills/animate/SKILL.md', 'modified'],
        ['.agents/skills/animate/RECIPES.md', 'modified'],
        ['.agents/skills/apple-design/SKILL.md', 'untracked'],
        ['.changeset/desktop.md', 'added'],
        ['README.md', 'modified'],
      ]),
    ).toEqual([
      {
        kind: 'directory',
        name: '.agents/skills',
        path: '.agents/skills',
        children: [
          {
            kind: 'directory',
            name: 'animate',
            path: '.agents/skills/animate',
            children: [
              {
                kind: 'file',
                name: 'RECIPES.md',
                path: '.agents/skills/animate/RECIPES.md',
                status: 'modified',
              },
              {
                kind: 'file',
                name: 'SKILL.md',
                path: '.agents/skills/animate/SKILL.md',
                status: 'modified',
              },
            ],
          },
          {
            kind: 'directory',
            name: 'apple-design',
            path: '.agents/skills/apple-design',
            children: [
              {
                kind: 'file',
                name: 'SKILL.md',
                path: '.agents/skills/apple-design/SKILL.md',
                status: 'untracked',
              },
            ],
          },
        ],
      },
      {
        kind: 'directory',
        name: '.changeset',
        path: '.changeset',
        children: [
          {
            kind: 'file',
            name: 'desktop.md',
            path: '.changeset/desktop.md',
            status: 'added',
          },
        ],
      },
      {
        kind: 'file',
        name: 'README.md',
        path: 'README.md',
        status: 'modified',
      },
    ]);
  });
});

describe('model catalog selection', () => {
  it('groups models into provider submenus without flattening the catalog', () => {
    expect(
      groupModelCatalog([
        {
          provider: 'qwen',
          model: 'qwen/qwen3.8-max',
          max_context_size: 128_000,
        },
        { provider: 'kimi', model: 'kimi/k2.5', max_context_size: 128_000 },
        {
          provider: 'qwen',
          model: 'qwen/qwen3.7-max',
          max_context_size: 128_000,
        },
      ]).map((group) => [
        group.provider,
        group.entries.map((entry) => entry.model),
      ]),
    ).toEqual([
      ['qwen', ['qwen/qwen3.8-max', 'qwen/qwen3.7-max']],
      ['kimi', ['kimi/k2.5']],
    ]);
  });

  it('uses the server model id without adding the provider prefix again', () => {
    expect(
      modelCatalogItemId({
        provider: 'example-provider',
        model: 'example-provider/example-model',
        max_context_size: 128_000,
      }),
    ).toBe('example-provider/example-model');
  });

  it('falls back to the global default when a new session stores an empty model', () => {
    expect(
      resolvePromptModel(undefined, '', 'example-provider/example-model'),
    ).toBe('example-provider/example-model');
  });

  it('prefers a per-prompt override over session and global defaults', () => {
    expect(
      resolvePromptModel(
        'override-provider/override-model',
        'session-provider/session-model',
        'default-provider/default-model',
      ),
    ).toBe('override-provider/override-model');
  });
});

describe('conversation defaults', () => {
  it('returns the persisted effort when global thinking is enabled', () => {
    expect(configuredThinkingEffort({ enabled: true, effort: 'high' })).toBe(
      'high',
    );
  });

  it('returns off when global thinking is disabled', () => {
    expect(configuredThinkingEffort({ enabled: false, effort: 'high' })).toBe(
      'off',
    );
  });

  it('uses the selected model default when a saved effort is unsupported', () => {
    expect(
      resolveThinkingEffort('high', {
        provider: 'example-provider',
        model: 'example-provider/example-model',
        max_context_size: 128_000,
        support_efforts: ['low', 'max'],
        default_effort: 'max',
      }),
    ).toBe('max');
  });

  it('turns thinking off when the selected model has no thinking capability', () => {
    expect(
      resolveThinkingEffort('high', {
        provider: 'example-provider',
        model: 'example-provider/example-model',
        max_context_size: 128_000,
        capabilities: ['tool_use'],
      }),
    ).toBe('off');
  });

  it('persists off as both the effort and disabled global thinking', () => {
    expect(thinkingConfigPatch('off')).toEqual({
      enabled: false,
      effort: 'off',
    });
  });
});

describe('goal composer mode', () => {
  it('creates a goal from the next submitted message only when goal mode is armed', () => {
    expect(goalObjectiveForSubmission(true, false, '  完成桌面端修复  ')).toBe(
      '完成桌面端修复',
    );
    expect(
      goalObjectiveForSubmission(false, false, '普通消息'),
    ).toBeUndefined();
    expect(
      goalObjectiveForSubmission(true, true, '继续已有目标'),
    ).toBeUndefined();
  });
});

// ------------------------------------------------------------------- webAppUrl

describe('webAppUrl', () => {
  it('deep-links a session with the token in the hash fragment', () => {
    expect(webAppUrl('http://127.0.0.1:58627', 's_abc', 'tok-1')).toBe(
      'http://127.0.0.1:58627/sessions/s_abc#token=tok-1',
    );
  });

  it('drops the token fragment when none is available', () => {
    expect(webAppUrl('http://127.0.0.1:58627', 's_abc', undefined)).toBe(
      'http://127.0.0.1:58627/sessions/s_abc',
    );
  });

  it('opens the bare origin for no session', () => {
    expect(webAppUrl('http://127.0.0.1:58627', null, 'tok-1')).toBe(
      'http://127.0.0.1:58627/#token=tok-1',
    );
    expect(webAppUrl('http://127.0.0.1:58627', null, undefined)).toBe(
      'http://127.0.0.1:58627',
    );
  });

  it('normalizes a trailing slash on the base url', () => {
    expect(webAppUrl('http://127.0.0.1:58627/', 's_abc', 't')).toBe(
      'http://127.0.0.1:58627/sessions/s_abc#token=t',
    );
  });

  it('encodes the session id', () => {
    expect(webAppUrl('http://x:1', 's/1', undefined)).toBe(
      'http://x:1/sessions/s%2F1',
    );
  });

  it('encodes the token', () => {
    expect(webAppUrl('http://x:1', 's1', 'a b')).toBe(
      'http://x:1/sessions/s1#token=a%20b',
    );
  });
});

// ------------------------------------------------------------ computeScaledSize

describe('computeScaledSize', () => {
  it('keeps sizes already within the bound (no upscaling)', () => {
    expect(computeScaledSize(800, 600, 2048)).toEqual({
      width: 800,
      height: 600,
    });
  });

  it('scales a wide image down to the long edge', () => {
    expect(computeScaledSize(4096, 2048, 2048)).toEqual({
      width: 2048,
      height: 1024,
    });
  });

  it('scales a tall image down to the long edge', () => {
    expect(computeScaledSize(1024, 4096, 2048)).toEqual({
      width: 512,
      height: 2048,
    });
  });

  it('rounds fractional results', () => {
    expect(computeScaledSize(3000, 2000, 1000)).toEqual({
      width: 1000,
      height: 667,
    });
  });

  it('never produces a zero dimension', () => {
    const size = computeScaledSize(1, 10000, 1000);
    expect(size.width).toBeGreaterThanOrEqual(1);
    expect(size.height).toBe(1000);
  });

  it('passes degenerate input through', () => {
    expect(computeScaledSize(0, 100, 1000)).toEqual({ width: 0, height: 100 });
    expect(computeScaledSize(100, 100, 0)).toEqual({ width: 100, height: 100 });
  });
});

// ------------------------------------------------------- attachment image src

describe('attachmentImageSrc', () => {
  it('accepts image media types case-insensitively', () => {
    expect(isImageMediaType('image/png')).toBe(true);
    expect(isImageMediaType('IMAGE/PNG')).toBe(true);
    expect(isImageMediaType('application/pdf')).toBe(false);
    expect(isImageMediaType(undefined)).toBe(false);
    expect(
      isImageAttachment({ attachmentId: 'a1', mediaType: 'image/jpeg' }),
    ).toBe(true);
    expect(isImageAttachment(undefined)).toBe(false);
  });

  it('uses the url source directly for image attachments', () => {
    expect(
      attachmentImageSrc(
        {
          attachmentId: 'a1',
          mediaType: 'image/png',
          source: { kind: 'url', url: 'https://example.test/x.png' },
        },
        'http://127.0.0.1:58627',
      ),
    ).toBe('https://example.test/x.png');
  });

  it('resolves file-sourced images to the server download route', () => {
    expect(
      attachmentImageSrc(
        {
          attachmentId: 'a1',
          mediaType: 'image/png',
          source: { kind: 'file', fileId: 'f_1' },
        },
        'http://127.0.0.1:58627/',
      ),
    ).toBe('http://127.0.0.1:58627/api/v1/files/f_1');
  });

  it('encodes the file id in the download route', () => {
    expect(
      attachmentImageSrc(
        {
          attachmentId: 'a1',
          mediaType: 'image/png',
          source: { kind: 'file', fileId: 'a b/1' },
        },
        'http://127.0.0.1:58627',
      ),
    ).toBe('http://127.0.0.1:58627/api/v1/files/a%20b%2F1');
  });

  it('rejects non-http image urls', () => {
    expect(
      attachmentImageSrc(
        {
          attachmentId: 'a1',
          mediaType: 'image/png',
          source: { kind: 'url', url: 'file:///tmp/x.png' },
        },
        'http://127.0.0.1:58627',
      ),
    ).toBeNull();
    expect(
      attachmentImageSrc(
        {
          attachmentId: 'a1',
          mediaType: 'image/png',
          source: { kind: 'url', url: 'not-a-url' },
        },
        'http://127.0.0.1:58627',
      ),
    ).toBeNull();
  });

  it('returns null for non-image attachments or missing sources', () => {
    expect(
      attachmentImageSrc(
        {
          attachmentId: 'a1',
          mediaType: 'application/pdf',
          source: { kind: 'url', url: 'https://example.test/x.pdf' },
        },
        'http://127.0.0.1:58627',
      ),
    ).toBeNull();
    expect(
      attachmentImageSrc(
        { attachmentId: 'a1', mediaType: 'image/png' },
        'http://127.0.0.1:58627',
      ),
    ).toBeNull();
    expect(attachmentImageSrc(undefined, 'http://127.0.0.1:58627')).toBeNull();
  });
});

// ---------------------------------------------------- streaming markdown delta

describe('splitStreamingDelta', () => {
  it('returns none when the source did not grow', () => {
    expect(splitStreamingDelta('hello', 'hello')).toEqual({
      kind: 'none',
      text: '',
    });
  });

  it('keeps an appended suffix as an inline continuation', () => {
    expect(splitStreamingDelta('hello', 'hello world')).toEqual({
      kind: 'inline',
      text: ' world',
    });
  });

  it('keeps a soft-line continuation inline', () => {
    expect(splitStreamingDelta('hello\n', 'hello\nworld')).toEqual({
      kind: 'inline',
      text: 'world',
    });
  });

  it('opens a block wrapper after a blank line', () => {
    expect(splitStreamingDelta('hello', 'hello\n\n# Title')).toEqual({
      kind: 'block',
      text: '\n\n# Title',
    });
  });

  it('flushes when the boundary sits inside an open code fence', () => {
    expect(
      splitStreamingDelta('```ts\nconst a', '```ts\nconst a = 1').kind,
    ).toBe('flush');
  });

  it('flushes when the delta opens a fence it does not close', () => {
    expect(splitStreamingDelta('hello', 'hello\n```ts\nconst a').kind).toBe(
      'flush',
    );
  });

  it('wraps a complete fence inside a block delta', () => {
    expect(
      splitStreamingDelta('hello', 'hello\n\n```ts\nconst a = 1\n```').kind,
    ).toBe('block');
  });

  it('flushes when the boundary sits inside an open code span', () => {
    expect(splitStreamingDelta('use `foo', 'use `foo` here').kind).toBe(
      'flush',
    );
  });

  it('flushes inside unclosed math delimiters', () => {
    expect(splitStreamingDelta('x \\(a', 'x \\(a+b\\)').kind).toBe('flush');
    expect(splitStreamingDelta('$$', '$$\nx^2').kind).toBe('flush');
    expect(splitStreamingDelta('x \\[a', 'x \\[a+b\\]').kind).toBe('flush');
    expect(splitStreamingDelta('x $a', 'x $a+b$').kind).toBe('flush');
  });

  it('flushes inside an open citation bracket', () => {
    expect(splitStreamingDelta('【src', '【src†L12】').kind).toBe('flush');
  });

  it('flushes on a trailing half-typed directive line', () => {
    expect(splitStreamingDelta('hello', 'hello\n\n:::note').kind).toBe('flush');
  });

  it('flushes oversized deltas (session refresh dumps)', () => {
    expect(splitStreamingDelta('x', `x${'y'.repeat(9000)}`).kind).toBe('flush');
  });

  it('keeps bold markers inline (pairing degrades without artifacts)', () => {
    expect(splitStreamingDelta('**bold', '**bold**').kind).toBe('inline');
  });
});

describe('markdown math delimiters', () => {
  const markdown = new Marked({ gfm: true, breaks: true, silent: true });
  markdown.use(createMarkdownExtensions());

  it('parses model-authored single-dollar inline formulas', () => {
    const paragraph = markdown.lexer(
      '取 $x \\neq 0$，得到 $\\frac{1}{3}$。',
    )[0] as Tokens.Paragraph;
    const math = paragraph.tokens.filter(
      (token): token is MathToken => token.type === 'math',
    );

    expect(math.map((token) => token.tex)).toEqual([
      'x \\neq 0',
      '\\frac{1}{3}',
    ]);
    expect(math.every((token) => token.displayMode === false)).toBe(true);
  });

  it('parses display math placed directly after prose without leaking a delimiter', () => {
    const paragraph = markdown.lexer(
      '**答案**：$$\\boxed{\\lim_{x\\to0^+}x\\lfloor 1/x\\rfloor=1,\\quad \\frac13}$$',
    )[0] as Tokens.Paragraph;
    const math = paragraph.tokens.filter(
      (token): token is MathToken => token.type === 'math',
    );

    expect(math).toEqual([
      expect.objectContaining({
        tex: '\\boxed{\\lim_{x\\to0^+}x\\lfloor 1/x\\rfloor=1,\\quad \\frac13}',
        displayMode: true,
      }),
    ]);
    expect(math[0]?.tex).not.toContain('$');
  });

  it('keeps embedded display math valid inside paragraph markup', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownMath, { tex: '\\boxed{x=1}', block: true }),
    );

    expect(html).toMatch(/^<span class="markdown-math markdown-math-block">/);
    expect(html).not.toContain('<div');
  });

  it('renders a standalone spaced single-dollar formula as display math', () => {
    const math = markdown
      .lexer('答案：\n\n$ \\boxed{x\\lfloor 1/x\\rfloor=1} $\n\n验证如下。')
      .find((token): token is MathToken => token.type === 'math');

    expect(math).toMatchObject({
      tex: '\\boxed{x\\lfloor 1/x\\rfloor=1}',
      displayMode: true,
    });
  });

  it('normalizes a redundant single-dollar pair inside display math', () => {
    const math = markdown
      .lexer('$$\n$\\boxed{y\u2032(0)=\\frac12}$\n$$')
      .find((token): token is MathToken => token.type === 'math');

    expect(math).toMatchObject({
      tex: '\\boxed{y\u2032(0)=\\frac12}',
      displayMode: true,
    });
  });

  it('accepts a standalone dollar opener on the line before the formula', () => {
    const math = markdown
      .lexer('$\n\\boxed{y\u2032\u2032(0)=-\\frac14}$\n')
      .find((token): token is MathToken => token.type === 'math');

    expect(math).toMatchObject({
      tex: '\\boxed{y\u2032\u2032(0)=-\\frac14}',
      displayMode: true,
    });
  });

  it('does not merge separate single-dollar formulas into one display token', () => {
    const tokens = markdown.lexer('$x$ and prose\n$y$');
    const math: MathToken[] = tokens.flatMap((token) => {
      if (token.type === 'paragraph') {
        return (token.tokens ?? []).filter(
          (child): child is MathToken => child.type === 'math',
        );
      }
      return token.type === 'math' ? [token as MathToken] : [];
    });

    expect(math.map((token) => [token.tex, token.displayMode])).toEqual([
      ['x', false],
      ['y', true],
    ]);
  });

  it('keeps an escaped TeX atom at the end of inline math', () => {
    const paragraph = markdown.lexer('完成率是 $100\\%$。')[0] as Tokens.Paragraph;
    const math = paragraph.tokens.find(
      (token): token is MathToken => token.type === 'math',
    );

    expect(math).toMatchObject({ tex: '100\\%', displayMode: false });
  });

  it('leaves dollar-prefixed prose alone when no closing delimiter exists', () => {
    const paragraph = markdown.lexer('价格是 $5。')[0] as Tokens.Paragraph;
    expect(paragraph.tokens.some((token) => token.type === 'math')).toBe(false);
  });
});

describe('streaming markdown chunk accumulation', () => {
  it('accumulates inline chunks in order', () => {
    let state = createInitialStreamState('');
    state = advanceStreamState(state, 'Hel', true);
    state = advanceStreamState(state, 'Hello', true);
    expect(state.chunks.map((chunk) => chunk.text)).toEqual(['Hel', 'lo']);
    expect(state.chunks.map((chunk) => chunk.variant)).toEqual([0, 1]);
  });

  it('resets on a flush and renders the plain source', () => {
    let state = createInitialStreamState('hello');
    state = advanceStreamState(state, 'hello\n```ts\nconst a', true);
    expect(state.chunks).toHaveLength(0);
    expect(state.baseSource).toBe('hello\n```ts\nconst a');
  });

  it('merges inline continuations into a block-wrapped chunk', () => {
    let state = createInitialStreamState('para');
    state = advanceStreamState(state, 'para\n\nNext', true);
    state = advanceStreamState(state, 'para\n\nNext more', true);
    expect(state.chunks).toHaveLength(1);
    expect(state.chunks[0]!.text).toBe('\n\nNext more');
    expect(state.chunks[0]!.block).toBe(true);
  });

  it('clears the chunk structure once streaming settles', () => {
    const state = createInitialStreamState('');
    const streamed = advanceStreamState(state, 'Hel', true);
    const settled = advanceStreamState(streamed, 'Hello', false);
    expect(settled.chunks).toHaveLength(0);
    expect(settled.baseSource).toBe('Hello');
  });

  it('is idempotent for an unchanged source', () => {
    const state = createInitialStreamState('hi');
    const state2 = advanceStreamState(state, 'hi more', true);
    expect(advanceStreamState(state2, 'hi more', true)).toBe(state2);
  });
});

describe('buildStreamedSource', () => {
  it('returns the plain source without chunks', () => {
    expect(buildStreamedSource(createInitialStreamState('hello'))).toBe(
      'hello',
    );
  });

  it('wraps inline chunks in spans and moves trailing newlines out', () => {
    let state = createInitialStreamState('hi');
    state = advanceStreamState(state, 'hi\nmore\n', true);
    expect(buildStreamedSource(state)).toBe(
      'hi<span class="markdown-stream-delta markdown-stream-delta--a">\nmore</span>\n',
    );
  });

  it('wraps block chunks in line-anchored divs', () => {
    let state = createInitialStreamState('para');
    state = advanceStreamState(state, 'para\n\nNext', true);
    expect(buildStreamedSource(state)).toBe(
      'para\n<div class="markdown-stream-delta markdown-stream-delta--a markdown-stream-delta-block">\n\nNext\n</div>',
    );
  });

  it('preserves the paragraph structure of the current source', () => {
    // The builder may add structural newlines around block wrappers (tags
    // must start their own line); collapsing newline runs recovers the
    // paragraph structure of the plain source.
    const normalize = (text: string): string =>
      text.replaceAll(/\n{2,}/g, '\n\n').replace(/\n$/, '');
    let state = createInitialStreamState('');
    for (const src of [
      'Hel',
      'Hello',
      'Hello wor',
      'Hello wor\n\nNext',
      'Hello wor\n\nNext more',
    ]) {
      state = advanceStreamState(state, src, true);
      const markup = buildStreamedSource(state);
      expect(normalize(markup.replaceAll(/<\/?(?:span|div)[^>]*>/g, ''))).toBe(
        src,
      );
    }
  });
});

describe('streamed markup lexing', () => {
  const markdown = new Marked({ gfm: true, breaks: true, silent: true });

  it('lexes an injected inline span as paired html tokens inside the paragraph', () => {
    const tokens = markdown.lexer(
      'hi<span class="markdown-stream-delta markdown-stream-delta--a">\nmore</span>',
    );
    const paragraph = tokens.find(
      (token) => token.type === 'paragraph',
    ) as Tokens.Paragraph;
    expect(paragraph.tokens.map((token) => token.type)).toEqual([
      'text',
      'html',
      'br',
      'text',
      'html',
    ]);
  });

  it('lexes an injected block div as block-level html around the content', () => {
    const tokens = markdown.lexer(
      'para\n<div class="markdown-stream-delta markdown-stream-delta--a markdown-stream-delta-block">\n\nNext\n</div>',
    );
    expect(tokens.map((token) => token.type)).toEqual([
      'paragraph',
      'html',
      'space',
      'paragraph',
      'html',
    ]);
    expect((tokens[1] as Tokens.HTML).block).toBe(true);
    expect((tokens[4] as Tokens.HTML).block).toBe(true);
  });

  it('treats a mid-line closing div as inline html (graceful degradation)', () => {
    const tokens = markdown.lexer(
      'Paragraph</div><span class="markdown-stream-delta markdown-stream-delta--a"> more</span>',
    );
    const paragraph = tokens.find(
      (token) => token.type === 'paragraph',
    ) as Tokens.Paragraph;
    expect(paragraph.tokens.map((token) => token.type)).toEqual([
      'text',
      'html',
      'html',
      'text',
      'html',
    ]);
  });
});

describe('streamHtml pairing', () => {
  const markdown = new Marked({ gfm: true, breaks: true, silent: true });
  // Stand-in for the renderer's per-token switch: containers render their
  // (pair-recursed) children, text renders its text, html renders as an
  // invisible placeholder (what the real renderer does for unmatched tags),
  // everything else its type.
  const renderOne = (token: Token, key: number): ReactNode => {
    const nested = (token as { tokens?: readonly Token[] }).tokens;
    if (nested !== undefined && nested.length > 0) {
      return createElement('div', { key }, pairStreamHtml(nested, renderOne));
    }
    if (token.type === 'text') return token.text;
    if (token.type === 'html') return `<html:${token.text}>`;
    return token.type;
  };
  const pair = (source: string): ReactNode[] =>
    pairStreamHtml(markdown.lexer(source), renderOne);
  const childrenOf = (element: ReactElement): ReactNode[] =>
    (element.props as { children?: ReactNode }).children as ReactNode[];
  const textOf = (nodes: ReactNode[]): string =>
    nodes
      .map((node) => {
        if (typeof node === 'string' || typeof node === 'number')
          return String(node);
        if (isValidElement(node)) {
          return `${String(node.type)}[${textOf(childrenOf(node))}]`;
        }
        return '';
      })
      .join('|');

  it('groups a streamed paragraph into alternating span elements', () => {
    const nodes = pair(
      'hi<span class="markdown-stream-delta markdown-stream-delta--a">\nmore</span><span class="markdown-stream-delta markdown-stream-delta--b">\nand</span>',
    );
    const paragraph = nodes[0] as ReactElement;
    expect(textOf(childrenOf(paragraph))).toBe('hi|span[br|more]|span[br|and]');
    const spans = childrenOf(paragraph).filter(isValidElement);
    expect(
      spans.map((span) => (span.props as { className?: string }).className),
    ).toEqual([
      'markdown-stream-delta markdown-stream-delta--a',
      'markdown-stream-delta markdown-stream-delta--b',
    ]);
  });

  it('groups a block delta into a div wrapping its blocks', () => {
    const nodes = pair(
      'before\n<div class="markdown-stream-delta markdown-stream-delta--a markdown-stream-delta-block">\n\n# Heading\n</div>',
    );
    expect(
      nodes.map((node) => (isValidElement(node) ? node.type : 'text')),
    ).toEqual(['div', 'div']);
    const div = nodes[1] as ReactElement;
    expect((div.props as { className?: string }).className).toContain(
      'markdown-stream-delta-block',
    );
    expect(textOf(childrenOf(div))).toBe('space|div[Heading]');
  });

  it('leaves unmatched wrappers as plain html tokens (graceful degradation)', () => {
    // The open tag sits in the first paragraph, the close in the list item:
    // neither pairs, and the text stays intact.
    const nodes = pair(
      'line1<span class="markdown-stream-delta markdown-stream-delta--a">\n- item</span>',
    );
    expect(textOf(nodes)).toBe(
      'div[line1|<html:<span class="markdown-stream-delta markdown-stream-delta--a">>]|list',
    );
  });

  it('ignores html that is not stream markup', () => {
    const nodes = pair('<span class="user">x</span>');
    expect(textOf(nodes)).toContain('<html:<span class="user">>');
  });
});

describe('tool activity projection', () => {
  /** Minimal tool frame helper: only the fields the grouping reads. The casts
   *  keep the fixtures terse — the grouping only inspects `kind`/`name`/`view`/
   *  `display`/`state`, so the full TranscriptFrame shape isn't needed here. */
  const tool = (
    frameId: string,
    name: string,
    extra: Partial<{
      display: { kind: string; agent_name?: string };
      input: Record<string, unknown>;
      inputText: string;
      output: unknown;
      error: string;
      taskId: string;
      state: ToolCallFrame['state'];
      agentRefs: readonly { agentId: string; role?: 'child' | 'member' }[];
    }> = {},
  ) =>
    ({
      kind: 'tool',
      frameId,
      toolCallId: frameId,
      name,
      state: extra.state ?? 'done',
      ...(extra.display !== undefined ? { display: extra.display } : {}),
      ...(extra.input !== undefined ? { input: extra.input } : {}),
      ...(extra.inputText !== undefined ? { inputText: extra.inputText } : {}),
      ...(extra.output !== undefined ? { output: extra.output } : {}),
      ...(extra.error !== undefined ? { error: extra.error } : {}),
      ...(extra.taskId !== undefined ? { taskId: extra.taskId } : {}),
      ...(extra.agentRefs !== undefined ? { agentRefs: extra.agentRefs } : {}),
    }) as unknown as TranscriptFrame;
  const text = (frameId: string) => ({ kind: 'text', frameId, role: 'assistant', text: '' }) as unknown as TranscriptFrame;
  const thinking = (frameId: string) => ({ kind: 'thinking', frameId, text: '' }) as unknown as TranscriptFrame;
  const step = (frames: readonly TranscriptFrame[]) =>
    ({ kind: 'step', stepId: 's', turnId: 't', ordinal: 1, state: 'completed', frames }) as unknown as TranscriptStep;

  const turn = (steps: readonly TranscriptStep[]) =>
    ({ kind: 'turn', turnId: 't', ordinal: 1, state: 'completed', origin: { kind: 'user' }, steps }) as unknown as TranscriptTurn;

  const commandRun = (
    commands: readonly {
      readonly id: string;
      readonly command: string;
      readonly state: ToolCallFrame['state'];
    }[],
  ) => {
    const entry = toolRunsFromTurn(
      turn([
        step(
          commands.map(({ id, command, state }) =>
            tool(id, 'Bash', { input: { command }, state }),
          ),
        ),
      ]),
    )[0];
    if (entry?.kind !== 'run') throw new Error('expected a grouped command run');
    return entry;
  };

  it('groups consecutive groupable tool frames into one run', () => {
    const entries = toolRunsFromTurn(turn([step([
      tool('a', 'Bash'),
      tool('b', 'Edit'),
      tool('c', 'Write'),
    ])]));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe('run');
    if (entries[0]!.kind === 'run') {
      expect(entries[0]!.frames).toHaveLength(3);
      expect(entries[0]!.summaryParts).toEqual(['编辑了 2 个文件', '运行了 1 条命令']);
    }
  });

  it('splits a run when a standalone frame interrupts', () => {
    const entries = toolRunsFromTurn(turn([step([
      tool('a', 'Bash'),
      tool('b', 'Agent'),
      tool('c', 'Bash'),
    ])]));
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ kind: 'run' });
    expect(entries[1]).toMatchObject({ kind: 'subagents' });
    expect(entries[2]).toMatchObject({ kind: 'run' });
  });

  it('flattens across step boundaries so a run does not split on step edges', () => {
    const entries = toolRunsFromTurn(turn([
      step([tool('a', 'Bash')]),
      step([tool('b', 'Edit')]),
    ]));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'run' });
  });

  it('keeps dedicated search and todo frames outside a subagent run', () => {
    const entries = toolRunsFromTurn(turn([step([
      tool('a', 'Agent'),
      tool('b', 'WebSearch'),
      tool('c', 'TodoWrite'),
    ])]));
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.kind)).toEqual([
      'subagents',
      'standalone',
      'standalone',
    ]);
  });

  it('groups consecutive subagents across step boundaries', () => {
    const entries = toolRunsFromTurn(turn([
      step([tool('a', 'Agent')]),
      step([tool('b', 'Agent')]),
    ]));

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'subagents', frames: [{ frameId: 'a' }, { frameId: 'b' }] });
  });

  it('keeps a pre-spawn subagent failure inspectable as a standalone frame', () => {
    const entries = toolRunsFromTurn(turn([
      step([tool('agent', 'Agent', { state: 'error', error: 'Unknown agent type' })]),
    ]));

    expect(entries).toEqual([
      expect.objectContaining({ kind: 'standalone', frame: expect.objectContaining({ frameId: 'agent' }) }),
    ]);
  });

  it('emits an empty array for a turn with no frames', () => {
    expect(toolRunsFromTurn(turn([step([text('r')])]))).toHaveLength(1);
    expect(toolRunsFromTurn(turn([step([])]))).toHaveLength(0);
  });

  it('keeps thinking/text/notice frames standalone between runs', () => {
    const entries = toolRunsFromTurn(turn([step([
      tool('a', 'Bash'),
      thinking('th'),
      text('r'),
    ])]));
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ kind: 'run' });
    expect(entries[1]).toMatchObject({ kind: 'standalone' });
    expect(entries[2]).toMatchObject({ kind: 'standalone' });
  });

  it('projects one collapsed activity row when grouped commands are live', () => {
    const run = commandRun([
      { id: 'lint', command: 'pnpm lint', state: 'done' },
      { id: 'test', command: 'pnpm test', state: 'running' },
    ]);

    expect(resolveToolRunPresentation(run, 'running', undefined)).toEqual({
      live: true,
      status: 'running',
      label: '正在运行 pnpm test',
      showHeader: true,
      detailsExpanded: false,
    });
  });

  it('projects one completed summary when every grouped command has settled', () => {
    const run = commandRun([
      { id: 'lint', command: 'pnpm lint', state: 'done' },
      { id: 'test', command: 'pnpm test', state: 'done' },
    ]);

    expect(resolveToolRunPresentation(run, 'completed', undefined)).toEqual({
      live: false,
      status: 'done',
      label: '运行了 2 条命令',
      showHeader: true,
      detailsExpanded: false,
    });
  });

  it('replaces the activity label when the next grouped command starts', () => {
    const first = commandRun([
      { id: 'lint', command: 'pnpm lint', state: 'running' },
    ]);
    const next = commandRun([
      { id: 'lint', command: 'pnpm lint', state: 'done' },
      { id: 'test', command: 'pnpm test', state: 'running' },
    ]);

    expect([
      resolveToolRunPresentation(first, 'running', undefined).label,
      resolveToolRunPresentation(next, 'running', undefined).label,
    ]).toEqual(['正在运行 pnpm lint', '正在运行 pnpm test']);
  });

  it('switches a single command from the live header to its settled row', () => {
    const live = commandRun([
      { id: 'test', command: 'pnpm test', state: 'running' },
    ]);
    const settled = commandRun([
      { id: 'test', command: 'pnpm test', state: 'done' },
    ]);

    expect([
      resolveToolRunPresentation(live, 'running', undefined).showHeader,
      resolveToolRunPresentation(settled, 'completed', undefined).showHeader,
    ]).toEqual([true, false]);
  });

  it('shows three subagent capsules and reports one hidden agent', () => {
    const frames = ['Noop 1', 'Noop 2', 'Noop 3', 'Noop 4'].map((label, index) =>
      tool(`agent-${index + 1}`, 'Agent', {
        input: { description: label, subagent_type: 'coder' },
        agentRefs: [{ agentId: `child-${index + 1}` }],
      }),
    ) as readonly ToolCallFrame[];

    const summary = summarizeSubagents(projectSubagentActivity(frames, undefined));

    expect(summary?.visibleEntries.map((entry) => entry.label)).toEqual([
      'Noop 1',
      'Noop 2',
      'Noop 3',
    ]);
    expect(summary?.overflowCount).toBe(1);
  });
});

describe('Codex-style subagent summary projection', () => {
  const task = (
    taskId: string,
    agentId: string,
    state: TranscriptTask['state'],
    description: string,
  ) =>
    ({
      taskId,
      agentId,
      kind: 'subagent',
      state,
      detached: false,
      description,
      outputTail: '',
      resultSummary: state === 'completed' ? `${description} finished` : undefined,
    }) as TranscriptTask;

  const roster = (
    id: string,
    status: SessionSubagentSnapshot['status'],
    description: string,
  ): SessionSubagentSnapshot => ({ id, kind: 'subagent', status, description });

  it('prefers the transcript task when the snapshot repeats the same agent', () => {
    const entries = mergeSessionSubagents(
      [task('task-1', 'child-1', 'completed', 'Noop 1')],
      [roster('child-1', 'running', 'stale snapshot')],
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      agentId: 'child-1',
      label: 'Noop 1',
      state: 'completed',
      snippet: 'Noop 1 finished',
    });
  });

  it('includes a roster-only child agent', () => {
    const entries = mergeSessionSubagents(
      [task('task-1', 'child-1', 'completed', 'Lead')],
      [roster('nested-1', 'running', 'Nested reviewer')],
    );

    expect(entries.map((entry) => entry.agentId)).toEqual(['child-1', 'nested-1']);
  });

  it('reports all four subagents completed', () => {
    const entries = ['1', '2', '3', '4'].map((id) =>
      task(`task-${id}`, `child-${id}`, 'completed', `Noop ${id}`),
    );

    expect(summarizeSubagents(mergeSessionSubagents(entries, []))).toMatchObject({
      inlineLabel: '已完成',
      panelLabel: '4 完成',
    });
  });

  it('reports running while any subagent is still active', () => {
    const entries = [
      task('task-1', 'child-1', 'completed', 'Noop 1'),
      task('task-2', 'child-2', 'running', 'Noop 2'),
    ];

    expect(summarizeSubagents(mergeSessionSubagents(entries, []))).toMatchObject({
      inlineLabel: '已开始工作',
      panelLabel: '1 运行中',
    });
  });

  it('reports a settled failure without claiming full success', () => {
    const entries = [
      task('task-1', 'child-1', 'completed', 'Noop 1'),
      task('task-2', 'child-2', 'failed', 'Noop 2'),
    ];

    expect(summarizeSubagents(mergeSessionSubagents(entries, []))).toMatchObject({
      inlineLabel: '完成但有错误',
      panelLabel: '1 完成 · 1 失败',
    });
  });

  it('binds live swarm labels through each agent task instead of ref position', () => {
    const frame = {
      kind: 'tool',
      frameId: 'swarm-frame',
      toolCallId: 'swarm-call',
      name: 'AgentSwarm',
      state: 'running',
      input: { description: 'Review modules', items: ['alpha', 'beta'] },
      agentRefs: [
        { agentId: 'child-beta', role: 'member' },
        { agentId: 'child-alpha', role: 'member' },
      ],
    } as const satisfies ToolCallFrame;
    const tasks = new Map<string, TranscriptTask>([
      ['child-alpha', task('task-alpha', 'child-alpha', 'running', 'Review alpha')],
      ['child-beta', task('task-beta', 'child-beta', 'running', 'Review beta')],
    ]);

    expect(projectSubagentActivity([frame], tasks).map((entry) => [entry.agentId, entry.label])).toEqual([
      ['child-beta', 'Review beta'],
      ['child-alpha', 'Review alpha'],
    ]);
  });

  it('uses settled swarm output to bind mixed resume and spawn items by agent id', () => {
    const frame = {
      kind: 'tool',
      frameId: 'swarm-frame',
      toolCallId: 'swarm-call',
      name: 'AgentSwarm',
      state: 'done',
      input: {
        description: 'Review modules',
        items: ['alpha', 'beta'],
        resume_agent_ids: { 'child-old': 'continue' },
      },
      agentRefs: [
        { agentId: 'child-beta', role: 'member' },
        { agentId: 'child-old', role: 'member' },
        { agentId: 'child-alpha', role: 'member' },
      ],
      output: [
        {
          type: 'text',
          text: '<agent_swarm_result>\n<subagent mode="resume" agent_id="child-old" item="legacy" outcome="completed">done</subagent>\n<subagent agent_id="child-alpha" item="alpha" outcome="completed">done</subagent>\n<subagent agent_id="child-beta" item="beta" outcome="completed">done</subagent>\n</agent_swarm_result>',
        },
      ],
    } as const satisfies ToolCallFrame;

    expect(projectSubagentActivity([frame], undefined).map((entry) => [entry.agentId, entry.label])).toEqual([
      ['child-beta', 'beta'],
      ['child-old', 'legacy'],
      ['child-alpha', 'alpha'],
    ]);
  });

  it('includes swarm members that never received an agent id', () => {
    const frame = {
      kind: 'tool',
      frameId: 'swarm-frame',
      toolCallId: 'swarm-call',
      name: 'AgentSwarm',
      state: 'done',
      output: '<agent_swarm_result>\n<subagent item="alpha" state="not_started" outcome="aborted">cancelled</subagent>\n<subagent item="beta" state="not_started" outcome="failed">launch failed</subagent>\n</agent_swarm_result>',
    } as const satisfies ToolCallFrame;

    expect(projectSubagentActivity([frame], undefined)).toMatchObject([
      { agentId: undefined, label: 'alpha', state: 'killed' },
      { agentId: undefined, label: 'beta', state: 'failed' },
    ]);
  });

  it('does not treat XML examples in a single agent result as extra agents', () => {
    const frame = {
      kind: 'tool',
      frameId: 'agent-frame',
      toolCallId: 'agent-call',
      name: 'Agent',
      state: 'done',
      input: { description: 'Explain the format' },
      agentRefs: [{ agentId: 'child-1' }],
      output: 'Example: <agent_swarm_result><subagent item="fake" outcome="failed">sample</subagent></agent_swarm_result>',
    } as const satisfies ToolCallFrame;

    expect(projectSubagentActivity([frame], undefined)).toMatchObject([
      { agentId: 'child-1', label: 'Explain the format', state: 'completed' },
    ]);
  });

  it('uses stable aggregate counts for members omitted from a truncated preview', () => {
    const frame = {
      kind: 'tool',
      frameId: 'swarm-frame',
      toolCallId: 'swarm-call',
      name: 'AgentSwarm',
      state: 'done',
      agentRefs: [
        { agentId: 'child-alpha', role: 'member' },
        { agentId: 'child-beta', role: 'member' },
      ],
      output: 'Tool output exceeded 50000 characters; showing a preview only.\n[preview]\n<agent_swarm_result>\n<summary>completed: 1, failed: 1</summary>\n<subagent agent_id="child-alpha" item="alpha" outcome="completed">done</subagent>',
    } as const satisfies ToolCallFrame;

    const entries = projectSubagentActivity([frame], undefined);
    expect(entries.map((entry) => [entry.agentId, entry.state])).toEqual([
      ['child-alpha', 'completed'],
      [undefined, 'failed'],
    ]);
    expect(summarizeSubagents(entries)).toMatchObject({ completedCount: 1, failedCount: 1 });
  });

  it('does not assign aggregate-only failures to a named swarm agent', () => {
    const frame = {
      kind: 'tool',
      frameId: 'swarm-frame',
      toolCallId: 'swarm-call',
      name: 'AgentSwarm',
      state: 'done',
      agentRefs: [
        { agentId: 'child-beta', role: 'member' },
        { agentId: 'child-alpha', role: 'member' },
      ],
      output: '<agent_swarm_result><summary>completed: 1, failed: 1</summary><subagent agent_id="child-alpha" item="alpha" outcome="completed">done</subagent>',
    } as const satisfies ToolCallFrame;
    const laterTasks = new Map<string, TranscriptTask>([
      ['child-beta', task('task-beta', 'child-beta', 'failed', 'Later invocation')],
    ]);

    const entries = projectSubagentActivity([frame], laterTasks);
    expect(entries.find((entry) => entry.agentId === 'child-alpha')?.state).toBe('completed');
    expect(entries.find((entry) => entry.state === 'failed')?.agentId).toBeUndefined();
    expect(entries.some((entry) => entry.agentId === 'child-beta' && entry.state === 'failed')).toBe(false);
  });

  it('ignores XML-looking subagent tags inside a settled swarm result body', () => {
    const frame = {
      kind: 'tool',
      frameId: 'swarm-frame',
      toolCallId: 'swarm-call',
      name: 'AgentSwarm',
      state: 'done',
      input: { items: ['alpha', 'beta'] },
      agentRefs: [
        { agentId: 'child-alpha', role: 'member' },
        { agentId: 'child-beta', role: 'member' },
      ],
      output: '<agent_swarm_result><summary>completed: 2</summary><subagent agent_id="child-alpha" item="alpha" outcome="completed">Example: </subagent><subagent agent_id="fake" item="fake" outcome="failed">fake</subagent><subagent agent_id="child-beta" item="beta" outcome="completed">done</subagent></agent_swarm_result>',
    } as const satisfies ToolCallFrame;

    const entries = projectSubagentActivity([frame], undefined);
    expect(entries.map((entry) => entry.agentId)).toEqual(['child-alpha', 'child-beta']);
    expect(summarizeSubagents(entries)).toMatchObject({ completedCount: 2, failedCount: 0 });
  });

  it('decodes escaped swarm item labels from settled output', () => {
    const frame = {
      kind: 'tool',
      frameId: 'swarm-frame',
      toolCallId: 'swarm-call',
      name: 'AgentSwarm',
      state: 'done',
      agentRefs: [{ agentId: 'child-1', role: 'member' }],
      output: '<agent_swarm_result><subagent agent_id="child-1" item="A &amp; &quot;B&quot; &lt;C&gt;" outcome="completed">done</subagent></agent_swarm_result>',
    } as const satisfies ToolCallFrame;

    expect(projectSubagentActivity([frame], undefined)[0]?.label).toBe('A & "B" <C>');
  });

  it('seals a completed frame against a later resume task state', () => {
    const frame = {
      kind: 'tool',
      frameId: 'agent-frame',
      toolCallId: 'agent-call',
      name: 'Agent',
      state: 'done',
      input: { description: 'Original review' },
      agentRefs: [{ agentId: 'child-1' }],
    } as const satisfies ToolCallFrame;
    const resumed = new Map<string, TranscriptTask>([
      ['child-1', task('task-1', 'child-1', 'failed', 'Continue review')],
    ]);

    expect(projectSubagentActivity([frame], resumed)[0]?.state).toBe('completed');
  });

  it('shows only the running cohort in the compact panel roster', () => {
    const entries = [
      task('task-1', 'child-1', 'completed', 'Noop 1'),
      task('task-2', 'child-2', 'running', 'Noop 2'),
      task('task-3', 'child-3', 'completed', 'Noop 3'),
      task('task-4', 'child-4', 'running', 'Noop 4'),
      task('task-5', 'child-5', 'completed', 'Noop 5'),
    ];
    const projection = selectPanelSubagents(mergeSessionSubagents(entries, []), 4);

    expect(projection.visibleEntries.map((entry) => entry.agentId)).toEqual([
      'child-2',
      'child-4',
    ]);
    expect(projection.overflowCount).toBe(0);
  });

  it('keeps a detached agent active after its launch tool settles', () => {
    const frame = {
      kind: 'tool',
      frameId: 'background-frame',
      toolCallId: 'background-call',
      name: 'Agent',
      state: 'done',
      input: { description: 'Background review', run_in_background: true },
      output: 'task_id: task-1\nstatus: running\nagent_id: child-1',
      agentRefs: [{ agentId: 'child-1' }],
    } as const satisfies ToolCallFrame;
    const tasks = new Map<string, TranscriptTask>([
      ['child-1', task('task-1', 'child-1', 'running', 'Background review')],
    ]);

    expect(projectSubagentActivity([frame], tasks)[0]?.state).toBe('running');
  });
});
