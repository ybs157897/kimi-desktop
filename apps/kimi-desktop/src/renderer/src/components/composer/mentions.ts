/**
 * Slate types + mention extraction for the Composer.
 *
 * The editor stores plain paragraphs with optional inline `mention` nodes
 * (`@file`, `$skill`, `/command`). On send we serialize the editor back to the
 * prompt `content` array: a single text part when there are no mentions, or a
 * text part with the mention labels inlined (the engine resolves `@file` /
 * `$skill` / `/cmd` tokens from the text). Attachments are appended as
 * `{type:'file', file_id}` parts.
 *
 * Nodes are mutable (Slate mutates them in place); the CustomTypes declaration
 * below teaches the editor our element/text shapes.
 */

import type { BaseEditor, BaseElement, BaseText } from 'slate';
import type { ReactEditor } from 'slate-react';

export type MentionType = 'file' | 'skill' | 'command';

export interface MentionElement extends BaseElement {
  type: 'mention';
  mentionType: MentionType;
  /** The resolved value: a file path, skill name, or command name. */
  value: string;
}

export interface ParagraphElement extends BaseElement {
  type: 'paragraph';
}

export interface ComposerText extends BaseText {
  text: string;
}

export type ComposerNode = ParagraphElement | MentionElement;

/** A child of a paragraph: either an inline mention chip or a text run. */
export type ComposerInline = MentionElement | ComposerText;

declare module 'slate' {
  interface CustomTypes {
    Editor: BaseEditor & ReactEditor;
    Element: ParagraphElement | MentionElement;
    Text: ComposerText;
  }
}

/** The trigger character that opens a mention menu. */
export type MentionTriggerChar = '@' | '$' | '/';

export const MENTION_TRIGGERS: readonly MentionTriggerChar[] = ['@', '$', '/'];

/** Map a trigger character to the mention type it opens. */
export function triggerToType(char: MentionTriggerChar): MentionType {
  if (char === '@') return 'file';
  if (char === '$') return 'skill';
  return 'command';
}

/** The inline label rendered for a mention inside the editor. */
export function mentionLabel(type: MentionType, value: string): string {
  if (type === 'file') return `@${value}`;
  if (type === 'skill') return `$${value}`;
  return `/${value}`;
}

/** Serialize the editor tree into the prompt's text body. Mentions are
 *  inlined as their `@value` / `$value` / `/value` tokens; line breaks become
 *  `\n`. A leading `/command` mention with no other text marks the send as a
 *  skill activation (see Composer). */
export function serializeContent(nodes: readonly ComposerNode[]): string {
  const lines: string[] = [];
  for (const node of nodes) {
    if (node.type !== 'paragraph') continue;
    let line = '';
    // `children` is `Descendant[]` (Slate keeps the nested array generic); we
    // narrow each child to our element/text union inline.
    for (const child of node.children as readonly ComposerInline[]) {
      if ('mentionType' in child) {
        line += mentionLabel(child.mentionType, child.value);
      } else {
        line += child.text;
      }
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** An empty editor value (one blank paragraph). */
export const EMPTY_VALUE: ComposerNode[] = [
  { type: 'paragraph', children: [{ text: '' }] },
];

export function createEmptyValue(): ComposerNode[] {
  return [{ type: 'paragraph', children: [{ text: '' }] }];
}
