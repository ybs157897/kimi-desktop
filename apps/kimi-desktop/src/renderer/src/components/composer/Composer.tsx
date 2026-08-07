/**
 * Composer — the Slate-based input + send/stop row (the Codex-style composer).
 *
 * - Slate rich text (`@file` / `$skill` / `/command` mention chips via the
 *   floating {@link MentionMenu}), drag/drop + paste attachments uploaded via
 *   `POST /files`.
 * - Sends `POST .../prompts` with `content` (text + file parts), plus the
 *   current permission mode / model / thinking overrides; while the session is
 *   busy the send button queues (tooltip "Queue"), a solid stop button aborts
 *   exactly the tracked prompt via `POST .../prompts/{pid}:abort` (Esc too).
 * - A leading `/command` mention with no other text activates the skill
 *   (`POST .../skills/{name}:activate`) instead of sending a prompt.
 * - Busy facts come from the session record, kept live by the global
 *   `event.session.work_changed` stream (a dedicated activity socket).
 */

import type { PromptPermissionMode, PromptSubmission } from '@moonshot-ai/protocol';
import { createEditor, Editor, Range, type Descendant } from 'slate';
import { Editable, ReactEditor, Slate, withReact } from 'slate-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useConnection } from '#/lib/connection';
import { compressImageDataUrl } from '#/lib/clipboardImage';
import {
  useAbortPrompt,
  useActivateSkill,
  useConfig,
  useFsList,
  useModels,
  useSession,
  useSkills,
  useSteerPrompt,
  useSubmitPrompt,
  useUpdateSessionProfile,
  useUploadFile,
} from '#/lib/queries';
import { agentConfigPatch } from '#/lib/sessionModes';
import { createActivitySocket } from '#/lib/ws';
import { loadDefaultPermissionMode, saveDefaultPermissionMode } from '#/lib/permissionMode';

import { ModelSelect, ThinkingEffortSelect } from './ModelSelect';
import { PermissionModeSelect } from './PermissionModeSelect';
import { MentionMenu, type MentionCandidate } from './MentionMenu';
import {
  EMPTY_VALUE,
  createEmptyValue,
  MENTION_TRIGGERS,
  mentionLabel,
  serializeContent,
  triggerToType,
  type ComposerNode,
  type MentionElement,
  type MentionTriggerChar,
} from './mentions';

export interface ComposerProps {
  readonly sessionId: string;
  /** Agent the prompt targets; defaults to the main agent. Side-channel
   *  (btw) composers pass the `agent-<N>` id — the prompt body then carries
   *  `agent_id`. */
  readonly agentId?: string;
}

/** One staged attachment before it is folded into the prompt content. */
interface StagedAttachment {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly fileId: string;
}

/** Build the prompt submission body. `agent_id` rides the body only for
 *  non-main agents (side-channel btw composers); the main agent is the server
 *  default and needs no explicit id. */
export function promptBody(
  content: NonNullable<PromptSubmission['content']>,
  permissionMode: PromptPermissionMode,
  model: string | undefined,
  effort: string | undefined,
  agentId: string | undefined,
): PromptSubmission {
  return {
    content,
    permission_mode: permissionMode,
    model,
    thinking: effort,
    agent_id: agentId === undefined || agentId === 'main' ? undefined : agentId,
  };
}

export function Composer({ sessionId, agentId }: ComposerProps) {
  const { baseUrl, token } = useConnection();
  const [editor] = useState<Editor>(() => withReact(createEditor()));
  const [value, setValue] = useState<ComposerNode[]>(EMPTY_VALUE);
  const [permissionMode, setPermissionMode] = useState<PromptPermissionMode>(loadDefaultPermissionMode);
  const [model, setModel] = useState<string | undefined>(undefined);
  const [effort, setEffort] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [activePromptId, setActivePromptId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [attachments, setAttachments] = useState<readonly StagedAttachment[]>([]);
  const [dragging, setDragging] = useState(false);

  const submit = useSubmitPrompt(sessionId);
  const steer = useSteerPrompt(sessionId);
  const updateSessionProfile = useUpdateSessionProfile(sessionId);
  const abort = useAbortPrompt(sessionId);
  const activate = useActivateSkill(sessionId);
  const upload = useUploadFile();
  const models = useModels();
  const config = useConfig();
  const sessionQuery = useSession(sessionId);
  const session = sessionQuery.data;

  // Mention candidates: skills for `$` and `/`; workspace files for `@`.
  const skills = useSkills(sessionId);
  const files = useFsList(sessionId, { path: '.', depth: 1, limit: 200 });

  const effectiveModel = model ?? session?.agent_config.model ?? config.data?.default_model ?? '';

  const handlePermissionModeChange = useCallback((mode: PromptPermissionMode) => {
    setError(null);
    setPermissionMode(mode);
    saveDefaultPermissionMode(mode);
  }, []);

  const resetInput = useCallback(() => {
    const empty = createEmptyValue();
    editor.children = empty;
    editor.selection = null;
    editor.onChange();
    setValue(empty);
  }, [editor]);

  useEffect(() => {
    setBusy(session?.busy ?? false);
  }, [session?.busy]);

  useEffect(() => {
    const socket = createActivitySocket({
      url: baseUrl,
      token,
      handlers: {
        onWorkChanged: (changedSessionId, facts) => {
          if (changedSessionId !== sessionId) return;
          setBusy(facts.busy);
          if (!facts.busy) setActivePromptId(undefined);
        },
        onSessionCreated: () => {},
        onMetaUpdated: () => {},
        onConfigChanged: () => {},
        onReconnected: () => {},
      },
    });
    return () => socket.close();
  }, [baseUrl, token, sessionId]);

  // -------- mention detection --------
  const [mention, setMention] = useState<{
    readonly trigger: MentionTriggerChar;
    readonly search: string;
    readonly anchor: { readonly top: number; readonly left: number };
    readonly range: Range;
  } | null>(null);

  const candidates = useMemo<readonly MentionCandidate[]>(() => {
    if (mention === null) return [];
    const type = triggerToType(mention.trigger);
    const query = mention.search.toLowerCase();
    const filter = (items: MentionCandidate[]): MentionCandidate[] =>
      items.filter((item) => item.label.toLowerCase().includes(query) || item.value.toLowerCase().includes(query));
    if (type === 'skill') {
      return filter(
        (skills.data?.skills ?? []).map((skill) => ({
          value: skill.name,
          label: skill.name,
          description: skill.description,
          glyph: '🧩',
        })),
      );
    }
    if (type === 'command') {
      // Slash commands ARE skill activations (the engine's `/<skill>` form).
      return filter(
        (skills.data?.skills ?? []).map((skill) => ({
          value: skill.name,
          label: skill.name,
          description: skill.description,
          glyph: '⌘',
        })),
      );
    }
    return filter(
      (files.data?.items ?? []).map((entry) => ({
        value: entry.path,
        label: entry.name,
        description: entry.path,
        glyph: entry.kind === 'directory' ? '📁' : '📄',
      })),
    );
  }, [mention, skills.data, files.data]);

  // Capture the caret position to anchor the menu whenever a mention opens.
  const captureAnchor = useCallback((): { top: number; left: number } => {
    const el = containerRef.current;
    if (el === null) return { top: 0, left: 0 };
    const rect = el.getBoundingClientRect();
    // Best-effort: place the menu just under the input, left-aligned. Slate's
    // native caret rect isn't exposed; this is good enough for a single-line
    // composer and avoids measuring DOM ranges per keystroke.
    return { top: rect.top - 8, left: rect.left + 12 };
  }, []);

  const containerRef = useRef<HTMLDivElement>(null);

  const handleChange = useCallback(
    (next: Descendant[]) => {
      setValue(next as ComposerNode[]);
      // Detect an active mention: a trigger char followed by word characters,
      // starting right after the last space / start of line at the caret.
      const selection = editor.selection;
      if (selection === null || !Range.isCollapsed(selection)) {
        setMention(null);
        return;
      }
      const { anchor: caret } = selection;
      const before = Editor.string(editor, { anchor: { path: caret.path, offset: 0 }, focus: caret });
      const match = /([@$\/])([^\s@$\/]*)$/.exec(before);
      if (match === null) {
        setMention(null);
        return;
      }
      const trigger = match[1] as MentionTriggerChar;
      if (!MENTION_TRIGGERS.includes(trigger)) {
        setMention(null);
        return;
      }
      // `/` only triggers at the start of the line (Codex slash-command rule).
      if (trigger === '/' && before.trim() !== '' && !before.endsWith(' ')) {
        setMention(null);
        return;
      }
      const range: Range = {
        anchor: { path: caret.path, offset: caret.offset - match[0].length },
        focus: caret,
      };
      setMention({ trigger, search: match[2] ?? '', anchor: captureAnchor(), range });
    },
    [editor, captureAnchor],
  );

  const insertMention = useCallback(
    (candidate: MentionCandidate) => {
      if (mention === null) return;
      const type = triggerToType(mention.trigger);
      const node: MentionElement = {
        type: 'mention',
        mentionType: type,
        value: candidate.value,
        children: [{ text: mentionLabel(type, candidate.value) }],
      };
      // Replace the trigger + search text with the mention chip + a trailing space.
      editor.insertNodes(node, {
        at: mention.range,
        select: true,
      });
      editor.insertText(' ');
      setMention(null);
      ReactEditor.focus(editor);
    },
    [editor, mention],
  );

  // -------- attachments --------
  const stageFile = useCallback(
    async (file: File) => {
      setError(null);
      try {
        const meta = await upload.mutateAsync({ file, name: file.name });
        setAttachments((prev) => [
          ...prev,
          {
            id: meta.id,
            name: meta.name,
            mediaType: meta.media_type,
            size: meta.size,
            fileId: meta.id,
          },
        ]);
      } catch (e) {
        setError(e);
      }
    },
    [upload],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const files = Array.from(event.dataTransfer.files);
      for (const file of files) void stageFile(file);
    },
    [stageFile],
  );

  // -------- send / stop --------
  const send = useCallback(() => {
    const text = serializeContent(value).trim();
    if ((text === '' && attachments.length === 0) || submit.isPending) return;
    setError(null);

    // A leading `/command` with nothing else activates the skill.
    const commandMatch = /^\/(\S+)/.exec(text);
    const isCommandOnly = commandMatch !== null && text === `/${commandMatch[1]}`;
    if (isCommandOnly && commandMatch !== null) {
      const skillName = commandMatch[1]!;
      activate.mutate(
        { skillName, body: {} },
        {
          onSuccess: () => {
            resetInput();
            setAttachments([]);
          },
          onError: setError,
        },
      );
      return;
    }

    const content: NonNullable<PromptSubmission['content']> = [];
    if (text !== '') content.push({ type: 'text', text });
    for (const attachment of attachments) {
      content.push({
        type: 'file',
        file_id: attachment.fileId,
        name: attachment.name,
        media_type: attachment.mediaType,
        size: attachment.size,
      });
    }

    submit.mutate(
      promptBody(content, permissionMode, model, effort, agentId),
      {
        onSuccess: (result) => {
          resetInput();
          setAttachments([]);
          setModel(undefined);
          setEffort(undefined);
          setActivePromptId(result.prompt_id);
          setBusy(true);
        },
        onError: setError,
      },
    );
  }, [value, attachments, submit, permissionMode, model, effort, agentId, activate, resetInput]);

  // While busy, Enter steers the active prompt instead of queuing a new one
  // (the engine injects the follow-up into the running turn).
  const steerActive = useCallback(() => {
    const text = serializeContent(value).trim();
    if ((text === '' && attachments.length === 0) || submit.isPending || steer.isPending) return;
    setError(null);
    const content: NonNullable<PromptSubmission['content']> = [];
    if (text !== '') content.push({ type: 'text', text });
    for (const attachment of attachments) {
      content.push({
        type: 'file',
        file_id: attachment.fileId,
        name: attachment.name,
        media_type: attachment.mediaType,
        size: attachment.size,
      });
    }
    void submit
      .mutateAsync(promptBody(content, permissionMode, model, effort, agentId))
      .then(async (result) => {
        resetInput();
        setAttachments([]);
        setModel(undefined);
        setEffort(undefined);
        if (result.status === 'queued') await steer.mutateAsync([result.prompt_id]);
        else {
          setActivePromptId(result.prompt_id);
          setBusy(true);
        }
      })
      .catch(setError);
  }, [value, attachments, submit, steer, permissionMode, model, effort, agentId, resetInput]);

  const stop = useCallback(() => {
    const promptId = activePromptId ?? session?.current_prompt_id;
    if (promptId === undefined || abort.isPending) return;
    setError(null);
    abort.mutate(promptId, { onError: setError });
  }, [activePromptId, session?.current_prompt_id, abort]);

  useEffect(() => {
    if (!busy) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        stop();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, stop]);

  const canStop = (activePromptId ?? session?.current_prompt_id) !== undefined;
  const text = serializeContent(value);
  const sendDisabled = (text.trim() === '' && attachments.length === 0) || submit.isPending || activate.isPending;

  return (
    <div className="px-5 pb-5 pt-2">
      <div className="mx-auto w-full max-w-[46rem]">
        {error !== null ? (
          <div className="mb-2 flex items-center gap-3 rounded-xl border border-[var(--color-border-error)] bg-[color-mix(in_srgb,var(--red-500)_6%,transparent)] px-3 py-2 text-[12px] text-[var(--color-text-danger)]">
            <span className="min-w-0 flex-1">{friendlyComposerError(error)}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
            >
              关闭
            </button>
          </div>
        ) : null}
        <div
        ref={containerRef}
        className={`rounded-[18px] border bg-[var(--color-background-editor-opaque)] shadow-[0_12px_34px_rgb(0_0_0/0.07),0_2px_8px_rgb(0_0_0/0.04)] transition-colors focus-within:border-[var(--color-border-heavy)] ${
          dragging ? 'border-[var(--color-border-focus)]' : 'border-[var(--color-border)]'
        }`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onPaste={(event) => {
          const files = event.clipboardData?.files;
          if (files !== undefined && files.length > 0) {
            event.preventDefault();
            for (const file of Array.from(files)) void stageFile(file);
            return;
          }
          // In-page image items (copied from a browser) surface as files;
          // screenshot-style clipboard images do not — ask the main process
          // for the system clipboard image and stage it through the same
          // upload pipeline. Text paste is untouched (no preventDefault).
          const items = event.clipboardData?.items;
          if (items !== undefined) {
            for (const item of Array.from(items)) {
              if (item.kind === 'file' && item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (file !== null) {
                  event.preventDefault();
                  void stageFile(file);
                  return;
                }
              }
            }
          }
          void (async () => {
            const dataUrl = await window.kimiDesktop.readClipboardImage();
            if (dataUrl === null) return;
            try {
              const file = await compressImageDataUrl(dataUrl);
              void stageFile(file);
            } catch {
              // Undecodable clipboard image — ignore silently.
            }
          })();
        }}
      >
        {attachments.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 px-2 pt-2">
            {attachments.map((attachment) => (
              <span
                key={attachment.id}
                className="flex items-center gap-1 rounded-md border border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-foreground)]"
                title={attachment.name}
              >
                <span aria-hidden>📎</span>
                <span className="max-w-[160px] truncate">{attachment.name}</span>
                <button
                  type="button"
                  aria-label="移除附件"
                  onClick={() =>
                    setAttachments((prev) => prev.filter((entry) => entry.id !== attachment.id))
                  }
                  className="ml-0.5 text-[var(--gray-500)] hover:text-[var(--red-400)]"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <Slate editor={editor} initialValue={value} onChange={handleChange}>
          <Editable
            placeholder={busy ? 'Working…' : 'Do anything'}
            spellCheck={false}
            renderElement={(props) => <MentionView {...props} />}
            onKeyDown={(event) => {
              // While the mention menu is open it owns arrow/Enter/Esc; only let
              // Enter send when no menu is active.
              if (event.nativeEvent.isComposing) return;
              if (mention !== null) return;
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                if (busy) steerActive();
                else send();
              }
            }}
            className="min-h-[4.25rem] max-h-[25dvh] w-full overflow-y-auto px-4 py-3 text-[14px] leading-[1.55] text-[var(--color-text-foreground)] outline-none placeholder:text-[var(--color-text-tertiary)]"
          />
        </Slate>
        <div className="flex items-center gap-1.5 px-2.5 pb-2 pt-1">
          <label
            className="flex h-7 cursor-pointer items-center rounded-lg px-2 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
            title="添加附件"
          >
            <input
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                const files = event.target.files;
                if (files === null) return;
                for (const file of Array.from(files)) void stageFile(file);
                event.target.value = '';
              }}
            />
            <span aria-hidden>📎</span>
          </label>
          <PermissionModeSelect
            value={permissionMode}
            onChange={handlePermissionModeChange}
            disabled={submit.isPending}
          />
          <ModelSelect
            value={effectiveModel}
            models={models.data?.items}
            onChange={(nextModel) => {
              setError(null);
              setModel(nextModel);
            }}
            disabled={submit.isPending}
          />
          {model !== undefined && model !== '' ? (
            <button
              type="button"
              onClick={() => {
                setError(null);
                updateSessionProfile.mutate(agentConfigPatch({ model }));
              }}
              disabled={submit.isPending || updateSessionProfile.isPending}
              title="设为本会话默认模型"
              aria-label="设为本会话默认模型"
              className="flex h-7 items-center rounded-lg px-1.5 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] disabled:opacity-60"
            >
              📌
            </button>
          ) : null}
          <ThinkingEffortSelect
            value={effort}
            onChange={(nextEffort) => {
              setError(null);
              setEffort(nextEffort);
            }}
            disabled={submit.isPending}
          />
          <div className="ml-auto flex items-center gap-1.5">
            {busy ? (
              <button
                type="button"
                onClick={stop}
                disabled={!canStop || abort.isPending}
                title="Stop (Esc)"
                aria-label="停止"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--gray-1000)] text-[var(--color-text-foreground)] transition-colors hover:bg-[var(--gray-900)] disabled:opacity-40"
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden>
                  <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" />
                </svg>
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                if (busy) steerActive();
                else send();
              }}
              disabled={busy ? sendDisabled || steer.isPending : sendDisabled}
              title={busy ? 'Steer' : 'Send'}
              aria-label={busy ? '插入' : '发送'}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--gray-1000)] text-[var(--color-text-foreground)] transition-colors hover:bg-[var(--gray-900)] disabled:opacity-40"
            >
              {busy ? (
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M2 6.5h7M6.5 3l3.5 3.5L6.5 10" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M7 11.5v-8M3.5 6.5 7 3l3.5 3.5" />
                </svg>
              )}
            </button>
          </div>
        </div>
        </div>
      </div>
      {mention !== null ? (
        <MentionMenu
          candidates={candidates}
          anchor={mention.anchor}
          onPick={insertMention}
          onClose={() => setMention(null)}
        />
      ) : null}
    </div>
  );
}

function friendlyComposerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('is not configured') || message.includes('MODEL')) {
    return '当前模型不可用，请从下方模型菜单选择一个已配置的模型。';
  }
  if (message.includes('401') || message.includes('unauthorized')) {
    return '连接已失效，请重新连接后再试。';
  }
  return '消息发送失败，请检查连接和模型设置后重试。';
}

/** A mention chip rendered inline (read-only text styled as a pill). */
function MentionView({
  element,
  attributes,
  children,
}: {
  readonly element: ComposerNode;
  readonly attributes: Record<string, unknown>;
  readonly children: React.ReactNode;
}) {
  if (element.type === 'mention') {
    const glyph = element.mentionType === 'file' ? '@' : element.mentionType === 'skill' ? '$' : '/';
    return (
      <span
        {...(attributes as React.HTMLAttributes<HTMLSpanElement>)}
        contentEditable={false}
        className="mx-0.5 inline-flex items-center rounded-[4px] bg-[var(--color-accent-background)] px-1 text-[12px] text-[var(--color-accent-text)]"
      >
        <span aria-hidden className="mr-0.5 opacity-70">{glyph}</span>
        {element.value}
        {children}
      </span>
    );
  }
  return (
    <p {...(attributes as React.HTMLAttributes<HTMLParagraphElement>)}>{children}</p>
  );
}

/** The prompt content part union (text + file), kept local to avoid importing
 *  the full MessageContent type into the component. */
type PromptContentPart = NonNullable<PromptSubmission['content']>[number];
