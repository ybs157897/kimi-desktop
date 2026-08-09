/**
 * AttachmentThumbnails — the attachment row under a turn prompt / text frame.
 *
 * Image attachments render as fixed 80px thumbnails with a lightbox on click;
 * every other attachment keeps the compact paperclip chip. File-sourced
 * images are fetched from the kap-server binary route with the bearer token
 * (an `<img>` tag cannot send the header), then shown as an object URL —
 * on failure the attachment degrades to the plain chip.
 */

import type { TranscriptAttachment } from '@moonshot-ai/transcript';
import { Paperclip } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { attachmentImageSrc, isImageAttachment } from '#/lib/attachmentImage';
import { useConnection } from '#/lib/connection';

import { ImageLightbox } from './ImageLightbox';

export interface AttachmentThumbnailsProps {
  readonly ids: readonly string[];
  /** Attachment entities referenced by `ids`, when available. */
  readonly attachments?: ReadonlyMap<string, TranscriptAttachment>;
}

export function AttachmentThumbnails({ ids, attachments }: AttachmentThumbnailsProps) {
  const { baseUrl, token } = useConnection();
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {ids.map((id) => {
        const attachment = attachments?.get(id);
        if (isImageAttachment(attachment)) {
          return (
            <ImageThumb
              key={id}
              id={id}
              attachment={attachment}
              baseUrl={baseUrl}
              token={token}
            />
          );
        }
        return <FileChip key={id} id={id} attachment={attachment} />;
      })}
    </div>
  );
}

/** Resolve the `<img>` src for an image attachment. URL-sourced attachments
 *  use the URL directly; file-sourced ones are fetched with the bearer token
 *  and surfaced as an object URL (revoked on cleanup). Returns undefined
 *  while resolving / on failure so the caller can degrade to the file chip. */
function useAttachmentImageSrc(
  attachment: TranscriptAttachment,
  baseUrl: string,
  token: string,
): string | undefined {
  const src = attachmentImageSrc(attachment, baseUrl);
  const [objectUrl, setObjectUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (attachment.source?.kind !== 'file' || src === null) return;
    let cancelled = false;
    let created: string | undefined;
    setObjectUrl(undefined);
    void (async () => {
      try {
        const response = await fetch(src, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!response.ok) throw new Error(`http ${response.status}`);
        const blob = await response.blob();
        if (cancelled) return;
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
      } catch {
        // Undecodable / expired file — leave the fallback chip in place.
      }
    })();
    return () => {
      cancelled = true;
      if (created !== undefined) URL.revokeObjectURL(created);
    };
  }, [src, token, attachment.source?.kind]);

  return attachment.source?.kind === 'file' ? objectUrl : (src ?? undefined);
}

function ImageThumb({
  id,
  attachment,
  baseUrl,
  token,
}: {
  readonly id: string;
  readonly attachment: TranscriptAttachment;
  readonly baseUrl: string;
  readonly token: string;
}) {
  const src = useAttachmentImageSrc(attachment, baseUrl, token);
  const [loaded, setLoaded] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const name = attachment.name ?? attachment.mediaType ?? id;

  if (src === undefined) return <FileChip id={id} attachment={attachment} />;
  return (
    <>
      <button
        type="button"
        aria-label={`预览图片 ${name}`}
        title={name}
        onClick={() => setLightboxOpen(true)}
        className="ui-pressable relative h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-background-surface-under)] hover:border-[var(--color-border-heavy)]"
      >
        {!loaded ? <span aria-hidden className="skeleton-block absolute inset-0" /> : null}
        <img
          src={src}
          alt={name}
          loading="lazy"
          onLoad={() => setLoaded(true)}
          className={`h-20 w-20 object-cover transition-opacity duration-[var(--duration-hover)] ease ${
            loaded ? 'opacity-100' : 'opacity-0'
          }`}
        />
      </button>
      {lightboxOpen ? (
        <ImageLightbox src={src} name={name} onClose={() => setLightboxOpen(false)} />
      ) : null}
    </>
  );
}

function FileChip({
  id,
  attachment,
}: {
  readonly id: string;
  readonly attachment?: TranscriptAttachment;
}) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded border border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-foreground)] opacity-70"
      title={attachment?.mediaType}
    >
      <Paperclip size={12} weight="regular" className="shrink-0 text-[var(--color-text-secondary)]" aria-hidden />
      {attachment?.name ?? attachment?.mediaType ?? id}
    </span>
  );
}
