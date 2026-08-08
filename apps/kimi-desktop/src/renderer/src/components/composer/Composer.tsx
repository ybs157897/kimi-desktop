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
import {
  ArrowRight,
  ArrowUp,
  CaretDown,
  Check,
  Folder,
  GitBranch,
  Paperclip,
  Plus,
  PushPin,
  Stop,
  Strategy,
  Target,
  X,
} from '@phosphor-icons/react';
import { createEditor, Editor, Element as SlateElement, Range, type Descendant } from 'slate';
import { Editable, ReactEditor, Slate, withReact } from 'slate-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { useConnection } from '#/lib/connection';
import { isImageMediaType } from '#/lib/attachmentImage';
import { compressImageDataUrl } from '#/lib/clipboardImage';
import {
  useAbortPrompt,
  useActivateSkill,
  useConfig,
  useFsGitBranches,
  useFsGitCheckout,
  useFsGitStatus,
  useFsHome,
  useFsList,
  useGoal,
  useModels,
  useSession,
  useSkills,
  useSteerPrompt,
  useSubmitPrompt,
  useUpdateSessionProfile,
  useUploadFile,
} from '#/lib/queries';
import { agentConfigPatch, goalObjectiveForSubmission } from '#/lib/sessionModes';
import { createActivitySocket } from '#/lib/ws';
import { loadDefaultPermissionMode, normalizePermissionMode } from '#/lib/permissionMode';
import { resolvePromptModel } from '#/lib/modelCatalog';

import { ModelSelect, ThinkingEffortSelect } from './ModelSelect';
import { PermissionModeSelect } from './PermissionModeSelect';
import { ImageLightbox } from '../chat/attachments/ImageLightbox';
import { ComposerAddMenu } from '../session/ModeBar';
import { FolderPicker } from '../sidebar/FolderPicker';
import { MentionMenu, type MentionCandidate } from './MentionMenu';
import {
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
  readonly onSwitchWorkspace?: (cwd: string) => void;
  /** Agent the prompt targets; defaults to the main agent. Side-channel
   *  (btw) composers pass the `agent-<N>` id — the prompt body then carries
   *  `agent_id`. */
  readonly agentId?: string;
  /** True when the transcript has no turns yet — drives the empty-state
   *  placeholder so the words match the moment. */
  readonly empty?: boolean;
}

/** One staged attachment before it is folded into the prompt content. */
interface StagedAttachment {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  /** Original file; kept for image previews (object URL) while staged. */
  readonly file: File;
  /** Undefined until POST /files has completed. Pending entries stay visible
   *  so a prompt cannot race ahead of an upload that started moments before. */
  readonly fileId?: string;
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

export function Composer(props: ComposerProps) {
  // ChatView reuses its composer while navigating. Key the stateful body by
  // both targets so drafts and prompt overrides can never leak into another
  // session or a side-channel agent.
  const target = `${props.sessionId}\u0000${props.agentId ?? 'main'}`;
  return <TargetComposer key={target} {...props} />;
}

function TargetComposer({ sessionId, agentId, empty = false, onSwitchWorkspace }: ComposerProps) {
  const { baseUrl, token } = useConnection();
  const [editor] = useState<Editor>(() => withReact(createEditor()));
  const [value, setValue] = useState<ComposerNode[]>(createEmptyValue);
  const [permissionModeOverride, setPermissionModeOverride] = useState<PromptPermissionMode | undefined>(
    undefined,
  );
  const legacyPermissionMode = useMemo(loadDefaultPermissionMode, []);
  const [model, setModel] = useState<string | undefined>(undefined);
  const [effort, setEffort] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [activePromptId, setActivePromptId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [attachments, setAttachments] = useState<readonly StagedAttachment[]>([]);
  const nextAttachmentId = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [planModeOverride, setPlanModeOverride] = useState<boolean | undefined>(undefined);
  const [goalModeArmed, setGoalModeArmed] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);

  const submit = useSubmitPrompt(sessionId);
  const steer = useSteerPrompt(sessionId);
  const updateSessionProfile = useUpdateSessionProfile(sessionId);
  const abort = useAbortPrompt(sessionId);
  const activate = useActivateSkill(sessionId);
  const upload = useUploadFile();
  const models = useModels();
  const config = useConfig();
  const sessionQuery = useSession(sessionId);
  const goalQuery = useGoal(sessionId);
  const gitStatus = useFsGitStatus(sessionId);
  const gitBranches = useFsGitBranches(sessionId, branchMenuOpen);
  const gitCheckout = useFsGitCheckout(sessionId);
  const fsHome = useFsHome();
  const session = sessionQuery.data;

  // Mention candidates: skills for `$` and `/`; workspace files for `@`.
  const skills = useSkills(sessionId);
  const files = useFsList(sessionId, { path: '.', depth: 1, limit: 200 });

  const promptModel = resolvePromptModel(model, session?.agent_config.model, config.data?.default_model);
  const effectiveModel = promptModel ?? '';
  const selectedModel = models.data?.items.find((entry) => entry.model === effectiveModel);
  const supportedEfforts = selectedModel?.support_efforts;
  const goalActive = goalQuery.data !== null && goalQuery.data !== undefined;
  const goalOn = goalActive || goalModeArmed;
  const sessionPlanMode = session?.agent_config.plan_mode === true;
  const planOn = planModeOverride ?? sessionPlanMode;
  const configuredPermissionMode =
    session?.agent_config.permission_mode !== undefined
      ? normalizePermissionMode(session.agent_config.permission_mode)
      : config.data !== undefined
        ? normalizePermissionMode(config.data.default_permission_mode)
        : undefined;
  // localStorage is only a compatibility fallback while neither server source
  // is available. A selection here is a per-composer prompt override.
  const permissionMode = permissionModeOverride ?? configuredPermissionMode ?? legacyPermissionMode;

  const handlePermissionModeChange = useCallback((mode: PromptPermissionMode) => {
    setError(null);
    setPermissionModeOverride(mode);
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
    if (effort !== undefined && supportedEfforts !== undefined && !supportedEfforts.includes(effort)) {
      setEffort(undefined);
    }
  }, [effort, supportedEfforts]);

  useEffect(() => {
    if (planModeOverride === sessionPlanMode) setPlanModeOverride(undefined);
  }, [planModeOverride, sessionPlanMode]);

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
      const block = Editor.above(editor, {
        at: caret,
        match: (node) => SlateElement.isElement(node) && Editor.isBlock(editor, node),
      });
      const lineStart = Editor.start(editor, block?.[1] ?? []);
      const before = Editor.string(editor, { anchor: lineStart, focus: caret });
      const match = /([@$/])([^\s@$/]*)$/.exec(before);
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
      if (trigger === '/' && match.index !== 0) {
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
      const id = `upload-${nextAttachmentId.current++}`;
      setAttachments((prev) => [
        ...prev,
        {
          id,
          name: file.name,
          mediaType: file.type || 'application/octet-stream',
          size: file.size,
          file,
        },
      ]);
      try {
        const meta = await upload.mutateAsync({ file, name: file.name });
        // Update the placeholder in place. If it was removed, sent, or this
        // target unmounted while uploading, the late result is intentionally
        // ignored rather than appearing in a different draft.
        setAttachments((prev) =>
          prev.map((attachment) =>
            attachment.id === id
              ? {
                  ...attachment,
                  name: meta.name,
                  mediaType: meta.media_type,
                  size: meta.size,
                  fileId: meta.id,
                }
              : attachment,
          ),
        );
      } catch (error) {
        setAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
        setError(error);
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
  const uploadsPending = attachments.some((attachment) => attachment.fileId === undefined);

  const send = useCallback(() => {
    const text = serializeContent(value).trim();
    if (
      (text === '' && attachments.length === 0) ||
      uploadsPending ||
      submit.isPending ||
      activate.isPending
    ) {
      return;
    }
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
      if (attachment.fileId === undefined) return;
      content.push({
        type: 'file',
        file_id: attachment.fileId,
        name: attachment.name,
        media_type: attachment.mediaType,
        size: attachment.size,
      });
    }

    const goalObjective = goalObjectiveForSubmission(goalModeArmed, goalActive, text);
    void (async () => {
      if (goalObjective !== undefined) {
        await updateSessionProfile.mutateAsync(agentConfigPatch({ goal_objective: goalObjective }));
      }
      return submit.mutateAsync(promptBody(content, permissionMode, promptModel, effort, agentId));
    })()
      .then((result) => {
        resetInput();
        setAttachments([]);
        setModel(undefined);
        setEffort(undefined);
        setGoalModeArmed(false);
        setActivePromptId(result.prompt_id);
        setBusy(true);
      })
      .catch(setError);
  }, [
    value,
    attachments,
    uploadsPending,
    submit,
    permissionMode,
    promptModel,
    effort,
    agentId,
    activate,
    resetInput,
    goalModeArmed,
    goalActive,
    updateSessionProfile,
  ]);

  // While busy, Enter steers the active prompt instead of queuing a new one
  // (the engine injects the follow-up into the running turn).
  const steerActive = useCallback(() => {
    const text = serializeContent(value).trim();
    if (
      (text === '' && attachments.length === 0) ||
      uploadsPending ||
      submit.isPending ||
      steer.isPending
    ) {
      return;
    }
    setError(null);
    const content: NonNullable<PromptSubmission['content']> = [];
    if (text !== '') content.push({ type: 'text', text });
    for (const attachment of attachments) {
      if (attachment.fileId === undefined) return;
      content.push({
        type: 'file',
        file_id: attachment.fileId,
        name: attachment.name,
        media_type: attachment.mediaType,
        size: attachment.size,
      });
    }
    void submit
      .mutateAsync(promptBody(content, permissionMode, promptModel, effort, agentId))
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
  }, [
    value,
    attachments,
    uploadsPending,
    submit,
    steer,
    permissionMode,
    promptModel,
    effort,
    agentId,
    resetInput,
  ]);

  const stop = useCallback(() => {
    const promptId = activePromptId ?? session?.current_prompt_id;
    if (promptId === undefined || abort.isPending) return;
    setError(null);
    abort.mutate(promptId, { onError: setError });
  }, [activePromptId, session?.current_prompt_id, abort]);

  useEffect(() => {
    if (!busy) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Let the active interaction, menu, preview, or modal own Escape first.
      // Deferring one microtask also covers window listeners registered after
      // this composer listener.
      queueMicrotask(() => {
        const modalOpen = document.querySelector('[role="dialog"][aria-modal="true"]') !== null;
        if (!event.defaultPrevented && !modalOpen) stop();
      });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, stop]);

  const canStop = (activePromptId ?? session?.current_prompt_id) !== undefined;
  const text = serializeContent(value);
  const sendDisabled =
    (text.trim() === '' && attachments.length === 0) ||
    uploadsPending ||
    submit.isPending ||
    activate.isPending ||
    updateSessionProfile.isPending;

  return (
    <div className="px-6 pb-4 pt-0">
      <div className="mx-auto w-full max-w-[var(--layout-thread-max-width)]">
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
        <div className="relative flex h-10 items-center gap-1 rounded-t-2xl bg-[var(--color-background-surface-under)] px-3 pb-0.5 text-[12px] text-[var(--color-text-secondary)]">
          <button
            type="button"
            aria-label="选择项目目录"
            aria-expanded={workspaceMenuOpen}
            title={session?.metadata.cwd}
            disabled={onSwitchWorkspace === undefined}
            onClick={() => setWorkspaceMenuOpen((value) => !value)}
            className="ui-pressable flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] disabled:pointer-events-none"
          >
            <Folder size={14} weight="regular" className="shrink-0" aria-hidden />
            <span className="max-w-48 truncate">{workspaceLabel(session?.metadata.cwd)}</span>
            <CaretDown size={10} weight="bold" className="shrink-0 opacity-50" aria-hidden />
          </button>
          {gitStatus.data?.branch ? (
            <button
              type="button"
              aria-label="切换 Git 分支"
              aria-expanded={branchMenuOpen}
              onClick={() => setBranchMenuOpen((value) => !value)}
              className="ui-pressable flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
            >
              <GitBranch size={14} weight="regular" className="shrink-0" aria-hidden />
              <span className="max-w-32 truncate">{gitStatus.data.branch}</span>
              <CaretDown size={10} weight="bold" className="shrink-0 opacity-50" aria-hidden />
            </button>
          ) : null}
          {workspaceMenuOpen ? (
            <>
              <button type="button" aria-label="关闭项目目录菜单" className="fixed inset-0 z-10 cursor-default" onClick={() => setWorkspaceMenuOpen(false)} />
              <div className="ui-popover absolute left-3 top-full z-20 mt-1.5 w-80 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-background-panel)] py-1.5 shadow-[var(--shadow-xl)]">
                <div className="px-3 py-1 text-[10px] font-semibold tracking-[var(--tracking-label)] text-[var(--color-text-tertiary)] uppercase">最近项目</div>
                {[...new Set([session?.metadata.cwd, ...(fsHome.data?.recent_roots ?? [])].filter((value): value is string => typeof value === 'string' && value !== ''))].map((root) => (
                  <button key={root} type="button" onClick={() => { setWorkspaceMenuOpen(false); if (root !== session?.metadata.cwd) onSwitchWorkspace?.(root); }} className={`block w-full px-3 py-1.5 text-left hover:bg-[var(--color-list-hover)] ${root === session?.metadata.cwd ? 'bg-[var(--color-list-active)]' : ''}`}>
                    <div className="flex items-center gap-2 text-[12.5px] font-medium text-[var(--color-text-foreground)]"><span className="min-w-0 flex-1 truncate">{workspaceLabel(root)}</span>{root === session?.metadata.cwd ? <Check size={12} weight="bold" aria-hidden /> : null}</div>
                    <div className="truncate font-mono text-[10.5px] text-[var(--color-text-tertiary)]">{root}</div>
                  </button>
                ))}
                <button type="button" onClick={() => { setWorkspaceMenuOpen(false); setFolderPickerOpen(true); }} className="mt-1 block w-full border-t border-[var(--color-border-light)] px-3 py-2 text-left text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]">浏览其它目录…</button>
              </div>
            </>
          ) : null}
          {branchMenuOpen ? (
            <>
              <button type="button" aria-label="关闭分支菜单" className="fixed inset-0 z-10 cursor-default" onClick={() => setBranchMenuOpen(false)} />
              <div className="ui-popover absolute left-40 top-full z-20 mt-1.5 w-64 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-background-panel)] py-1.5 shadow-[var(--shadow-xl)]">
                <div className="px-3 py-1 text-[10px] font-semibold tracking-[var(--tracking-label)] text-[var(--color-text-tertiary)] uppercase">切换分支</div>
                {gitBranches.isLoading ? <div className="px-3 py-2 text-[12px] text-[var(--color-text-tertiary)]">正在加载…</div> : gitBranches.isError ? <div className="px-3 py-2 text-[12px] text-[var(--color-text-danger)]">无法读取分支</div> : gitBranches.data?.branches.map((branch) => (
                  <button key={branch} type="button" disabled={gitCheckout.isPending} onClick={() => { if (branch === gitBranches.data.current) { setBranchMenuOpen(false); return; } gitCheckout.mutate(branch, { onSuccess: () => setBranchMenuOpen(false), onError: setError }); }} className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] hover:bg-[var(--color-list-hover)] disabled:opacity-50 ${branch === gitBranches.data.current ? 'bg-[var(--color-list-active)] text-[var(--color-text-foreground)]' : 'text-[var(--color-text-secondary)]'}`}>
                    <span className="min-w-0 flex-1 truncate">{branch}</span>{branch === gitBranches.data.current ? <Check size={12} weight="bold" aria-hidden /> : null}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
        <div
          ref={containerRef}
          className={`relative -mt-px rounded-2xl border bg-[var(--color-composer-fill)] shadow-[var(--shadow-composer)] backdrop-blur-xl transition-[border-color,box-shadow] duration-[var(--duration-hover)] ease focus-within:border-[var(--color-border-heavy)] focus-within:shadow-[var(--shadow-composer-focus)] ${
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
          {addMenuOpen ? (
            <>
              <div className="fixed inset-0 z-30" onMouseDown={() => setAddMenuOpen(false)} />
              <div className="absolute bottom-full left-0 right-0 z-40 mb-2">
                <ComposerAddMenu
                  sessionId={sessionId}
                  planMode={planOn}
                  onPlanModeChange={setPlanModeOverride}
                  goalMode={goalOn}
                  onGoalModeChange={setGoalModeArmed}
                  onFiles={(files) => {
                    for (const file of files) void stageFile(file);
                  }}
                  onInsertText={(nextText) => {
                    editor.insertText(nextText);
                    ReactEditor.focus(editor);
                  }}
                  onClose={() => setAddMenuOpen(false)}
                />
              </div>
            </>
          ) : null}
          <div className="flex flex-col gap-1 px-3.5 pb-2 pt-3">
            {attachments.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {attachments.map((attachment) => (
                  <StagedAttachmentChip
                    key={attachment.id}
                    attachment={attachment}
                    onRemove={() =>
                      setAttachments((prev) => prev.filter((entry) => entry.id !== attachment.id))
                    }
                  />
                ))}
              </div>
            ) : null}
            <div className="flex items-start gap-2">
              <Slate editor={editor} initialValue={value} onChange={handleChange}>
                <Editable
                  placeholder={
                    busy
                      ? '正在工作… 可继续输入'
                      : goalOn
                        ? '描述你的目标，定义可衡量的成果，以获得最佳效果'
                        : planOn
                          ? '描述你的任务以生成计划…'
                          : empty
                            ? '描述你的任务'
                            : '提出后续修改要求'
                  }
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
                  className="composer-editor max-h-[28dvh] min-h-6 w-full flex-1 text-[14px] leading-[var(--leading-chat)] tracking-[var(--tracking-tight)] text-[var(--color-text-foreground)] outline-none"
                />
              </Slate>
              {busy ? (
                <button
                  type="button"
                  onClick={stop}
                  disabled={!canStop || abort.isPending}
                  title="停止（Esc）"
                  aria-label="停止"
                  className="ui-pressable mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-background-panel)] text-[var(--color-text-foreground)] hover:bg-[var(--color-list-hover)] disabled:opacity-35"
                >
                  <Stop size={11} weight="fill" aria-hidden />
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  if (busy) steerActive();
                  else send();
                }}
                disabled={busy ? sendDisabled || steer.isPending : sendDisabled}
                title={busy ? '插入当前任务' : '发送'}
                aria-label={busy ? '插入' : '发送'}
                className={`ui-pressable mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-100 ${
                  busy
                    ? sendDisabled || steer.isPending
                      ? 'bg-[var(--color-background-button-secondary)] text-[var(--color-text-tertiary)]'
                      : 'bg-[var(--color-button-primary-background)] text-[var(--color-button-primary-foreground)]'
                    : sendDisabled
                      ? 'bg-[var(--color-background-button-secondary)] text-[var(--color-text-tertiary)]'
                      : 'bg-[var(--color-button-primary-background)] text-[var(--color-button-primary-foreground)]'
                }`}
              >
                {busy ? (
                  <ArrowRight size={13} weight="bold" aria-hidden />
                ) : (
                  <ArrowUp size={14} weight="bold" aria-hidden />
                )}
              </button>
            </div>
            <div className="flex h-8 items-center gap-0.5">
              <button
                type="button"
                aria-label="添加"
                title="添加"
                aria-expanded={addMenuOpen}
                onClick={() => setAddMenuOpen((open) => !open)}
                className={`ui-pressable flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                  addMenuOpen
                    ? 'bg-[var(--color-list-active)] text-[var(--color-text-foreground)]'
                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]'
                }`}
              >
                <Plus size={16} weight="bold" aria-hidden />
              </button>
              <PermissionModeSelect
                value={permissionMode}
                onChange={handlePermissionModeChange}
                disabled={submit.isPending}
              />
              {planOn ? (
                <ModeChip
                  icon={<Strategy size={14} weight="regular" />}
                  label="计划"
                  onClick={() => setAddMenuOpen(true)}
                />
              ) : null}
              {goalOn ? (
                <ModeChip
                  icon={<Target size={14} weight="regular" />}
                  label="目标"
                  onClick={() => setAddMenuOpen(true)}
                />
              ) : null}
              <div className="ml-auto flex min-w-0 items-center gap-0.5">
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
                    className="ui-pressable flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] disabled:opacity-60"
                  >
                    <PushPin size={14} weight="regular" aria-hidden />
                  </button>
                ) : null}
                {supportedEfforts?.length === 0 ? null : (
                  <ThinkingEffortSelect
                    value={effort}
                    efforts={supportedEfforts}
                    defaultEffort={selectedModel?.default_effort}
                    onChange={(nextEffort) => {
                      setError(null);
                      setEffort(nextEffort);
                    }}
                    disabled={submit.isPending}
                  />
                )}
              </div>
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
      {folderPickerOpen ? (
        <FolderPicker
          onPick={(cwd) => {
            setFolderPickerOpen(false);
            if (cwd !== session?.metadata.cwd) onSwitchWorkspace?.(cwd);
          }}
          onClose={() => setFolderPickerOpen(false)}
        />
      ) : null}
    </div>
  );
}

function workspaceLabel(cwd: string | undefined): string {
  if (cwd === undefined) return '工作区';
  return cwd.split('/').filter(Boolean).at(-1) ?? cwd;
}

function ModeChip({ icon, label, onClick }: { readonly icon: ReactNode; readonly label: string; readonly onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="ui-pressable flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
    >
      {icon}
      {label}
    </button>
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

/** One staged attachment row: image files preview as a thumbnail (object URL
 *  from the staged `File`, revoked on unmount) with a lightbox on click;
 *  other files keep the paperclip chip. */
function StagedAttachmentChip({
  attachment,
  onRemove,
}: {
  readonly attachment: StagedAttachment;
  readonly onRemove: () => void;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | undefined>(undefined);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  useEffect(() => {
    if (!isImageMediaType(attachment.mediaType)) return;
    const url = URL.createObjectURL(attachment.file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [attachment.mediaType, attachment.file]);

  const removeButton = (
    <button
      type="button"
      aria-label="移除附件"
      onClick={onRemove}
      className="ml-0.5 text-[var(--color-text-tertiary)] hover:text-[var(--red-400)]"
    >
      <X size={11} weight="bold" aria-hidden />
    </button>
  );

  if (previewUrl !== undefined) {
    return (
      <>
        <span
          className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] p-1 pr-2 text-[11.5px] text-[var(--color-text-foreground)]"
          title={attachment.name}
        >
          <button
            type="button"
            aria-label={`预览图片 ${attachment.name}`}
            onClick={() => setLightboxOpen(true)}
            className="ui-pressable relative h-9 w-9 shrink-0 overflow-hidden rounded-md border border-[var(--color-border-light)] bg-[var(--color-background-surface)]"
          >
            <img
              src={previewUrl}
              alt={attachment.name}
              className="h-9 w-9 object-cover"
            />
          </button>
          <span className="max-w-[140px] truncate">{attachment.name}</span>
          {attachment.fileId === undefined ? (
            <span className="text-[10.5px] text-[var(--color-text-tertiary)]" role="status">
              上传中…
            </span>
          ) : null}
          {removeButton}
        </span>
        {lightboxOpen ? (
          <ImageLightbox
            src={previewUrl}
            name={attachment.name}
            onClose={() => setLightboxOpen(false)}
          />
        ) : null}
      </>
    );
  }

  return (
    <span
      className="flex items-center gap-1 rounded-lg border border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] px-2 py-1 text-[11.5px] text-[var(--color-text-foreground)]"
      title={attachment.name}
    >
      <Paperclip size={13} weight="regular" aria-hidden />
      <span className="max-w-[160px] truncate">{attachment.name}</span>
      {attachment.fileId === undefined ? (
        <span className="text-[10.5px] text-[var(--color-text-tertiary)]" role="status">
          上传中…
        </span>
      ) : null}
      {removeButton}
    </span>
  );
}
