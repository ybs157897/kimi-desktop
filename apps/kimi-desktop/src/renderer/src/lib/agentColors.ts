/**
 * Agent type → color mapping.
 *
 * The transcript data model carries no per-frame model field, so block identity
 * color is driven by tool *family* and, for sub-agents, the agent *type*
 * (`subagent_type` / `subagent_name` / the display name). This module is the
 * single decision point: every renderer calls {@link agentTypeTag} /
 * {@link tagClasses} instead of open-coding colors, so the palette stays
 * consistent and the kind set has one home.
 *
 * Colors reference the `--color-tag-*` palette in `tokens.css`, which mirrors
 * the zcode session-graph node colors (file=sky, skill=violet, command=slate,
 * subagent=olive, session=teal, swarm=amber).
 */

/** The closed set of tag kinds. Each has a `--color-tag-<kind>` and
 *  `--color-tag-<kind>-fill` token in `tokens.css`. */
export type TagKind =
  | 'file'
  | 'shell'
  | 'search'
  | 'skill'
  | 'plan'
  | 'todo'
  | 'agent'
  | 'swarm'
  | 'context'
  | 'generic';

export interface AgentTag {
  /** Display label, normalized (e.g. "Coder Agent", "Explore"). */
  readonly label: string;
  /** Palette slot. */
  readonly tag: TagKind;
}

/** Canonical sub-agent types the engine emits, mapped to a stable color + label.
 *  Matching is case- and delimiter-insensitive (see {@link normType}). */
const KNOWN_AGENT_TYPES: ReadonlyArray<{ readonly match: RegExp; readonly label: string; readonly tag: TagKind }> = [
  { match: /^coder[\s_-]*agent$/i, label: 'Coder Agent', tag: 'agent' },
  { match: /^coder$/i, label: 'Coder Agent', tag: 'agent' },
  { match: /^tidal$/i, label: 'Tidal', tag: 'context' },
  { match: /^explore$/i, label: 'Explore', tag: 'file' },
  { match: /^general[\s_-]*purpose$/i, label: 'Explore', tag: 'file' },
  { match: /^executor$/i, label: 'Executor', tag: 'swarm' },
  { match: /^swarm$/i, label: 'Swarm', tag: 'swarm' },
  { match: /^image[\s_-]*view$/i, label: 'Image View', tag: 'skill' },
];

/** Fallback palette slots for unknown agent types. Hashing the name keeps the
 *  same type stable across sessions while spreading unknowns across hues. */
const FALLBACK_SLOTS: readonly TagKind[] = ['file', 'search', 'skill', 'context', 'shell', 'agent'];

function normType(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

/** Deterministic 32-bit hash (FNV-1a) → used only to pick a fallback slot. */
function hashName(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Resolve the display tag for a sub-agent type. `rawType` may be the
 *  `subagent_type`, the display `agent_name`, or the tool `frame.name`. */
export function agentTypeTag(rawType: string | undefined): AgentTag {
  const fallback: AgentTag = { label: 'SubAgent', tag: 'agent' };
  if (rawType === undefined) return fallback;
  const trimmed = rawType.trim();
  if (trimmed === '') return fallback;
  const normalized = normType(trimmed);
  for (const entry of KNOWN_AGENT_TYPES) {
    if (entry.match.test(trimmed) || entry.match.test(normalized)) {
      return { label: entry.label, tag: entry.tag };
    }
  }
  const slot = FALLBACK_SLOTS[hashName(normalized) % FALLBACK_SLOTS.length]!;
  return { label: trimmed, tag: slot };
}

/**
 * Tailwind arbitrary-value classes per tag kind: background fill + text color.
 * Drop into a `.ui-tag-pill` element.
 *
 * IMPORTANT: Tailwind v4's JIT scanner only emits classes it can see as
 * complete string literals in the source — dynamically interpolated class
 * names (template strings) are silently dropped from the stylesheet. Keep
 * every class here as a full literal; never build them at runtime.
 */
const TAG_CLASSES: Readonly<Record<TagKind, string>> = {
  file: 'bg-[var(--color-tag-file-fill)] text-[var(--color-tag-file)]',
  shell: 'bg-[var(--color-tag-shell-fill)] text-[var(--color-tag-shell)]',
  search: 'bg-[var(--color-tag-search-fill)] text-[var(--color-tag-search)]',
  skill: 'bg-[var(--color-tag-skill-fill)] text-[var(--color-tag-skill)]',
  plan: 'bg-[var(--color-tag-plan-fill)] text-[var(--color-tag-plan)]',
  todo: 'bg-[var(--color-tag-todo-fill)] text-[var(--color-tag-todo)]',
  agent: 'bg-[var(--color-tag-agent-fill)] text-[var(--color-tag-agent)]',
  swarm: 'bg-[var(--color-tag-swarm-fill)] text-[var(--color-tag-swarm)]',
  context: 'bg-[var(--color-tag-context-fill)] text-[var(--color-tag-context)]',
  generic: 'bg-[var(--color-tag-generic-fill)] text-[var(--color-tag-generic)]',
};

/** Tailwind arbitrary-value classes for a tag kind: background fill + text
 *  color. Drop into a `.ui-tag-pill` element. */
export function tagClasses(kind: TagKind): string {
  return TAG_CLASSES[kind];
}

const TAG_ICON_CLASSES: Readonly<Record<TagKind, string>> = {
  file: 'text-[var(--color-tag-file)]',
  shell: 'text-[var(--color-tag-shell)]',
  search: 'text-[var(--color-tag-search)]',
  skill: 'text-[var(--color-tag-skill)]',
  plan: 'text-[var(--color-tag-plan)]',
  todo: 'text-[var(--color-tag-todo)]',
  agent: 'text-[var(--color-tag-agent)]',
  swarm: 'text-[var(--color-tag-swarm)]',
  context: 'text-[var(--color-tag-context)]',
  generic: 'text-[var(--color-tag-generic)]',
};

/** Foreground-only color for an icon tinted by tag kind. */
export function tagIconClass(kind: TagKind): string {
  return TAG_ICON_CLASSES[kind];
}
