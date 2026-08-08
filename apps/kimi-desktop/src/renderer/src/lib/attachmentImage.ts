/**
 * Pure attachment-image helpers (chat thumbnails). DOM-free — unit-tested in
 * a node environment. The runtime blob fetch for file-sourced attachments
 * lives in the render-layer hook (`components/chat/attachments/`).
 */

import type { TranscriptAttachment } from '@moonshot-ai/transcript';

/** Whether a media type is a displayable image (`image/*`). */
export function isImageMediaType(mediaType: string | undefined): boolean {
  return mediaType !== undefined && mediaType.toLowerCase().startsWith('image/');
}

/** Whether the attachment carries an image media type (also narrows the
 *  attachment type for callers). */
export function isImageAttachment(
  attachment: TranscriptAttachment | undefined,
): attachment is TranscriptAttachment {
  return isImageMediaType(attachment?.mediaType);
}

/**
 * Build the `<img>` src for an image attachment, or null when it is not a
 * displayable image or has no usable source.
 *
 * - `source.kind === 'url'` attachments use the URL directly (http/https only;
 *   a lightbox would otherwise chase `javascript:`/`file:` sources).
 * - `source.kind === 'file'` attachments resolve to the kap-server binary
 *   download route (`GET /api/v1/files/{file_id}`); the renderer fetches the
 *   bytes with the bearer token and turns them into an object URL.
 */
export function attachmentImageSrc(
  attachment: TranscriptAttachment | undefined,
  baseUrl: string,
): string | null {
  if (!isImageAttachment(attachment)) return null;
  const source = attachment.source;
  if (source?.kind === 'url') {
    return isHttpUrl(source.url) ? source.url : null;
  }
  if (source?.kind === 'file') {
    return `${baseUrl.replace(/\/+$/, '')}/api/v1/files/${encodeURIComponent(source.fileId)}`;
  }
  return null;
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
