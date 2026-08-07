import type { TextFrame as TextFrameModel, TranscriptAttachment } from '@moonshot-ai/transcript';
import { useContext } from 'react';

import { Markdown } from '../../markdown/Markdown';
import { TurnContext } from '../frameContext';

export interface TextFrameProps {
  readonly frame: TextFrameModel;
  /** Attachment entities referenced by `frame.attachmentIds`, when available. */
  readonly attachments?: ReadonlyMap<string, TranscriptAttachment>;
}

/** Assistant / user text frame. User text renders as a right-aligned card
 *  titled "You"; assistant text goes through the markdown pipeline with the
 *  streaming cursor while the enclosing turn is live. */
export function TextFrame({ frame, attachments }: TextFrameProps) {
  const turn = useContext(TurnContext);
  const chips =
    frame.attachmentIds !== undefined && frame.attachmentIds.length > 0 ? (
      <div className="mb-1 flex flex-wrap gap-1">
        {frame.attachmentIds.map((id) => {
          const attachment = attachments?.get(id);
          return (
            <span
              key={id}
              className="rounded border border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-foreground)] opacity-70"
              title={attachment?.mediaType}
            >
              📎 {attachment?.name ?? attachment?.mediaType ?? id}
            </span>
          );
        })}
      </div>
    ) : null;
  if (frame.role === 'user') {
    return (
      <div className="mb-2 flex justify-end">
        <div className="max-w-[80%]">
          {chips}
          <div className="rounded-lg border border-[var(--color-border-light)] bg-[var(--color-background-editor-opaque)] px-3 py-2">
            <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-foreground)] opacity-50">
              You
            </div>
            <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--color-text-foreground)]">
              {frame.text}
            </div>
          </div>
        </div>
      </div>
    );
  }
  const streaming = turn !== null && turn.state === 'running';
  return (
    <div className="mb-2">
      {chips}
      <Markdown source={frame.text} streaming={streaming} />
    </div>
  );
}
