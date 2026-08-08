import type { TextFrame as TextFrameModel, TranscriptAttachment } from '@moonshot-ai/transcript';
import { useContext } from 'react';

import { Markdown } from '../../markdown/Markdown';
import { AttachmentThumbnails } from '../attachments/AttachmentThumbnails';
import { TurnContext } from '../frameContext';

export interface TextFrameProps {
  readonly frame: TextFrameModel;
  /** Attachment entities referenced by `frame.attachmentIds`, when available. */
  readonly attachments?: ReadonlyMap<string, TranscriptAttachment>;
}

/** Assistant / user text frame. User text renders as a right-aligned card
 *  titled "You"; assistant text goes through the markdown pipeline with the
 *  streaming cursor only while this frame is still the live tip of the turn. */
export function TextFrame({ frame, attachments }: TextFrameProps) {
  const turn = useContext(TurnContext);
  // A just-created streaming text frame can exist before its first delta.
  // Rendering Markdown for it shows only a blinking cursor and reserves an
  // otherwise blank row, so wait for meaningful content.
  if (frame.text.trim() === '') return null;
  const chips =
    frame.attachmentIds !== undefined && frame.attachmentIds.length > 0 ? (
      <AttachmentThumbnails ids={frame.attachmentIds} attachments={attachments} />
    ) : null;
  if (frame.role === 'user') {
    return (
      <div className="ui-card-enter mb-3 flex justify-end">
        <div className="max-w-[min(80%,36rem)]">
          {chips}
          <div className="rounded-2xl bg-[var(--color-user-bubble)] px-3.5 py-2.5 shadow-[var(--shadow-sm)]">
            <div className="whitespace-pre-wrap text-[14px] leading-[var(--leading-chat)] tracking-[var(--tracking-tight)] text-[var(--color-text-foreground)]">
              {frame.text}
            </div>
          </div>
        </div>
      </div>
    );
  }
  // Turn stays `running` through tool calls; only the tip text frame streams.
  const streaming = turn?.liveTailFrameId === frame.frameId;
  return (
    <div className="ui-card-enter mb-3 max-w-[46rem] text-[14px] leading-[var(--leading-chat)] tracking-[var(--tracking-tight)]">
      {chips}
      <Markdown source={frame.text} streaming={streaming} />
    </div>
  );
}
