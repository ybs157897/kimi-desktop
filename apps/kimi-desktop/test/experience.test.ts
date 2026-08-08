import { describe, expect, it } from 'vitest';
import { Marked } from 'marked';
import type { Token, Tokens } from 'marked';
import { isValidElement, createElement, type ReactElement, type ReactNode } from 'react';

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
import { computeScaledSize } from '../src/renderer/src/lib/imageScale';
import { groupModelCatalog, modelCatalogItemId, resolvePromptModel } from '../src/renderer/src/lib/modelCatalog';
import { webAppUrl } from '../src/renderer/src/lib/webUrl';
import { buildChangeTree } from '../src/renderer/src/lib/changeTree';
import { approvalInteractionPresentation } from '../src/renderer/src/lib/approvalInteraction';
import { goalObjectiveForSubmission } from '../src/renderer/src/lib/sessionModes';
import {
  projectAgentPendingInteractions,
  projectPendingSessionInteractions,
} from '../src/renderer/src/lib/sessionInteractions';
import {
  hasThinkingContent,
  liveTailFrameId,
  pendingInteractionForToolFrame,
  pendingComposerInteractions,
  shouldAbortAfterApproval,
  taskForToolFrame,
  visibleTimelineItems,
} from '../src/renderer/src/lib/timelinePresentation';
import type { TranscriptInteraction, TranscriptTask } from '@moonshot-ai/transcript';

describe('Codex-style streaming timeline presentation', () => {
  it('removes internal undo and plan revision markers from the visible conversation', () => {
    const items = [
      { kind: 'marker' as const, markerId: 'm1', marker: 'undo' },
      { kind: 'marker' as const, markerId: 'm2', marker: 'plan.revision' },
      { kind: 'marker' as const, markerId: 'm3', marker: 'plan.enter' },
      { kind: 'marker' as const, markerId: 'm4', marker: 'interruption' },
      { kind: 'marker' as const, markerId: 'm5', marker: 'compact' },
    ];
    expect(visibleTimelineItems(items).map((item) => item.kind === 'marker' ? item.marker : item.kind))
      .toEqual(['compact']);
  });

  it('docks a subagent approval from the session-level pending collection', () => {
    const projected = projectPendingSessionInteractions([
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
    ], []);

    expect(pendingComposerInteractions(projected).map((pending) => ({
      agentId: pending.sourceAgentId,
      interactionId: pending.interaction.interactionId,
    }))).toEqual([{ agentId: 'agent-0', interactionId: 'approval-child' }]);
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

    expect(pendingComposerInteractions(fallback)[0]?.sourceAgentId).toBe('main');
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

    expect(pendingComposerInteractions(projected)[0]?.interaction.interactionId).toBe(
      'question-newer',
    );
  });

  it('stops the active prompt after rejection, except an explicit plan revision', () => {
    expect(shouldAbortAfterApproval('rejected')).toBe(true);
    expect(shouldAbortAfterApproval('rejected', 'Reject and Exit')).toBe(true);
    expect(shouldAbortAfterApproval('rejected', 'Revise')).toBe(false);
    expect(shouldAbortAfterApproval('approved')).toBe(false);
  });

  it('does not abort the main prompt after rejecting a child agent approval', () => {
    expect(shouldAbortAfterApproval('rejected', undefined, 'agent-0')).toBe(false);
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
    const projected = projectPendingSessionInteractions([
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
    ], []);

    expect(
      pendingInteractionForToolFrame(
        { agentRefs: [{ agentId: 'agent-0' }] },
        projected,
      )?.interaction.interactionId,
    ).toBe('approval-child');
  });

  it('does not reserve a blank streaming reasoning body', () => {
    expect(hasThinkingContent('   ')).toBe(false);
    expect(hasThinkingContent('正在检查项目')).toBe(true);
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
              { kind: 'file', name: 'RECIPES.md', path: '.agents/skills/animate/RECIPES.md', status: 'modified' },
              { kind: 'file', name: 'SKILL.md', path: '.agents/skills/animate/SKILL.md', status: 'modified' },
            ],
          },
          {
            kind: 'directory',
            name: 'apple-design',
            path: '.agents/skills/apple-design',
            children: [
              { kind: 'file', name: 'SKILL.md', path: '.agents/skills/apple-design/SKILL.md', status: 'untracked' },
            ],
          },
        ],
      },
      {
        kind: 'directory',
        name: '.changeset',
        path: '.changeset',
        children: [{ kind: 'file', name: 'desktop.md', path: '.changeset/desktop.md', status: 'added' }],
      },
      { kind: 'file', name: 'README.md', path: 'README.md', status: 'modified' },
    ]);
  });
});

describe('model catalog selection', () => {
  it('groups models into provider submenus without flattening the catalog', () => {
    expect(
      groupModelCatalog([
        { provider: 'qwen', model: 'qwen/qwen3.8-max', max_context_size: 128_000 },
        { provider: 'kimi', model: 'kimi/k2.5', max_context_size: 128_000 },
        { provider: 'qwen', model: 'qwen/qwen3.7-max', max_context_size: 128_000 },
      ]).map((group) => [group.provider, group.entries.map((entry) => entry.model)]),
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
    expect(resolvePromptModel(undefined, '', 'example-provider/example-model')).toBe(
      'example-provider/example-model',
    );
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

describe('goal composer mode', () => {
  it('creates a goal from the next submitted message only when goal mode is armed', () => {
    expect(goalObjectiveForSubmission(true, false, '  完成桌面端修复  ')).toBe('完成桌面端修复');
    expect(goalObjectiveForSubmission(false, false, '普通消息')).toBeUndefined();
    expect(goalObjectiveForSubmission(true, true, '继续已有目标')).toBeUndefined();
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
    expect(webAppUrl('http://x:1', 's/1', undefined)).toBe('http://x:1/sessions/s%2F1');
  });

  it('encodes the token', () => {
    expect(webAppUrl('http://x:1', 's1', 'a b')).toBe('http://x:1/sessions/s1#token=a%20b');
  });
});

// ------------------------------------------------------------ computeScaledSize

describe('computeScaledSize', () => {
  it('keeps sizes already within the bound (no upscaling)', () => {
    expect(computeScaledSize(800, 600, 2048)).toEqual({ width: 800, height: 600 });
  });

  it('scales a wide image down to the long edge', () => {
    expect(computeScaledSize(4096, 2048, 2048)).toEqual({ width: 2048, height: 1024 });
  });

  it('scales a tall image down to the long edge', () => {
    expect(computeScaledSize(1024, 4096, 2048)).toEqual({ width: 512, height: 2048 });
  });

  it('rounds fractional results', () => {
    expect(computeScaledSize(3000, 2000, 1000)).toEqual({ width: 1000, height: 667 });
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
    expect(isImageAttachment({ attachmentId: 'a1', mediaType: 'image/jpeg' })).toBe(true);
    expect(isImageAttachment(undefined)).toBe(false);
  });

  it('uses the url source directly for image attachments', () => {
    expect(
      attachmentImageSrc(
        { attachmentId: 'a1', mediaType: 'image/png', source: { kind: 'url', url: 'https://example.test/x.png' } },
        'http://127.0.0.1:58627',
      ),
    ).toBe('https://example.test/x.png');
  });

  it('resolves file-sourced images to the server download route', () => {
    expect(
      attachmentImageSrc(
        { attachmentId: 'a1', mediaType: 'image/png', source: { kind: 'file', fileId: 'f_1' } },
        'http://127.0.0.1:58627/',
      ),
    ).toBe('http://127.0.0.1:58627/api/v1/files/f_1');
  });

  it('encodes the file id in the download route', () => {
    expect(
      attachmentImageSrc(
        { attachmentId: 'a1', mediaType: 'image/png', source: { kind: 'file', fileId: 'a b/1' } },
        'http://127.0.0.1:58627',
      ),
    ).toBe('http://127.0.0.1:58627/api/v1/files/a%20b%2F1');
  });

  it('rejects non-http image urls', () => {
    expect(
      attachmentImageSrc(
        { attachmentId: 'a1', mediaType: 'image/png', source: { kind: 'url', url: 'file:///tmp/x.png' } },
        'http://127.0.0.1:58627',
      ),
    ).toBeNull();
    expect(
      attachmentImageSrc(
        { attachmentId: 'a1', mediaType: 'image/png', source: { kind: 'url', url: 'not-a-url' } },
        'http://127.0.0.1:58627',
      ),
    ).toBeNull();
  });

  it('returns null for non-image attachments or missing sources', () => {
    expect(
      attachmentImageSrc(
        { attachmentId: 'a1', mediaType: 'application/pdf', source: { kind: 'url', url: 'https://example.test/x.pdf' } },
        'http://127.0.0.1:58627',
      ),
    ).toBeNull();
    expect(attachmentImageSrc({ attachmentId: 'a1', mediaType: 'image/png' }, 'http://127.0.0.1:58627')).toBeNull();
    expect(attachmentImageSrc(undefined, 'http://127.0.0.1:58627')).toBeNull();
  });
});

// ---------------------------------------------------- streaming markdown delta

describe('splitStreamingDelta', () => {
  it('returns none when the source did not grow', () => {
    expect(splitStreamingDelta('hello', 'hello')).toEqual({ kind: 'none', text: '' });
  });

  it('keeps an appended suffix as an inline continuation', () => {
    expect(splitStreamingDelta('hello', 'hello world')).toEqual({ kind: 'inline', text: ' world' });
  });

  it('keeps a soft-line continuation inline', () => {
    expect(splitStreamingDelta('hello\n', 'hello\nworld')).toEqual({ kind: 'inline', text: 'world' });
  });

  it('opens a block wrapper after a blank line', () => {
    expect(splitStreamingDelta('hello', 'hello\n\n# Title')).toEqual({ kind: 'block', text: '\n\n# Title' });
  });

  it('flushes when the boundary sits inside an open code fence', () => {
    expect(splitStreamingDelta('```ts\nconst a', '```ts\nconst a = 1').kind).toBe('flush');
  });

  it('flushes when the delta opens a fence it does not close', () => {
    expect(splitStreamingDelta('hello', 'hello\n```ts\nconst a').kind).toBe('flush');
  });

  it('wraps a complete fence inside a block delta', () => {
    expect(splitStreamingDelta('hello', 'hello\n\n```ts\nconst a = 1\n```').kind).toBe('block');
  });

  it('flushes when the boundary sits inside an open code span', () => {
    expect(splitStreamingDelta('use `foo', 'use `foo` here').kind).toBe('flush');
  });

  it('flushes inside unclosed math delimiters', () => {
    expect(splitStreamingDelta('x \\(a', 'x \\(a+b\\)').kind).toBe('flush');
    expect(splitStreamingDelta('$$', '$$\nx^2').kind).toBe('flush');
    expect(splitStreamingDelta('x \\[a', 'x \\[a+b\\]').kind).toBe('flush');
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
    expect(buildStreamedSource(createInitialStreamState('hello'))).toBe('hello');
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
    for (const src of ['Hel', 'Hello', 'Hello wor', 'Hello wor\n\nNext', 'Hello wor\n\nNext more']) {
      state = advanceStreamState(state, src, true);
      const markup = buildStreamedSource(state);
      expect(normalize(markup.replaceAll(/<\/?(?:span|div)[^>]*>/g, ''))).toBe(src);
    }
  });
});

describe('streamed markup lexing', () => {
  const markdown = new Marked({ gfm: true, breaks: true, silent: true });

  it('lexes an injected inline span as paired html tokens inside the paragraph', () => {
    const tokens = markdown.lexer('hi<span class="markdown-stream-delta markdown-stream-delta--a">\nmore</span>');
    const paragraph = tokens.find((token) => token.type === 'paragraph') as Tokens.Paragraph;
    expect(paragraph.tokens.map((token) => token.type)).toEqual(['text', 'html', 'br', 'text', 'html']);
  });

  it('lexes an injected block div as block-level html around the content', () => {
    const tokens = markdown.lexer(
      'para\n<div class="markdown-stream-delta markdown-stream-delta--a markdown-stream-delta-block">\n\nNext\n</div>',
    );
    expect(tokens.map((token) => token.type)).toEqual(['paragraph', 'html', 'space', 'paragraph', 'html']);
    expect((tokens[1] as Tokens.HTML).block).toBe(true);
    expect((tokens[4] as Tokens.HTML).block).toBe(true);
  });

  it('treats a mid-line closing div as inline html (graceful degradation)', () => {
    const tokens = markdown.lexer('Paragraph</div><span class="markdown-stream-delta markdown-stream-delta--a"> more</span>');
    const paragraph = tokens.find((token) => token.type === 'paragraph') as Tokens.Paragraph;
    expect(paragraph.tokens.map((token) => token.type)).toEqual(['text', 'html', 'html', 'text', 'html']);
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
  const pair = (source: string): ReactNode[] => pairStreamHtml(markdown.lexer(source), renderOne);
  const childrenOf = (element: ReactElement): ReactNode[] =>
    (element.props as { children?: ReactNode }).children as ReactNode[];
  const textOf = (nodes: ReactNode[]): string =>
    nodes
      .map((node) => {
        if (typeof node === 'string' || typeof node === 'number') return String(node);
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
    expect(spans.map((span) => (span.props as { className?: string }).className)).toEqual([
      'markdown-stream-delta markdown-stream-delta--a',
      'markdown-stream-delta markdown-stream-delta--b',
    ]);
  });

  it('groups a block delta into a div wrapping its blocks', () => {
    const nodes = pair(
      'before\n<div class="markdown-stream-delta markdown-stream-delta--a markdown-stream-delta-block">\n\n# Heading\n</div>',
    );
    expect(nodes.map((node) => (isValidElement(node) ? node.type : 'text'))).toEqual(['div', 'div']);
    const div = nodes[1] as ReactElement;
    expect((div.props as { className?: string }).className).toContain('markdown-stream-delta-block');
    expect(textOf(childrenOf(div))).toBe('space|div[Heading]');
  });

  it('leaves unmatched wrappers as plain html tokens (graceful degradation)', () => {
    // The open tag sits in the first paragraph, the close in the list item:
    // neither pairs, and the text stays intact.
    const nodes = pair('line1<span class="markdown-stream-delta markdown-stream-delta--a">\n- item</span>');
    expect(textOf(nodes)).toBe(
      'div[line1|<html:<span class="markdown-stream-delta markdown-stream-delta--a">>]|list',
    );
  });

  it('ignores html that is not stream markup', () => {
    const nodes = pair('<span class="user">x</span>');
    expect(textOf(nodes)).toContain('<html:<span class="user">>');
  });
});
