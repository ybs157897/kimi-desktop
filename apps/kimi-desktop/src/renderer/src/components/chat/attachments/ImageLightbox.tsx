/**
 * ImageLightbox — fullscreen image preview opened from an attachment
 * thumbnail (composer staging or transcript attachment). A dim backdrop with
 * the image centered; Esc / backdrop click / the close button dismiss it.
 * Reuses `useModalDialog` so Escape and focus behavior stack with the other
 * modal dialogs in the app.
 */

import { useRef } from 'react';

import { useModalDialog } from '#/lib/useModalDialog';

export interface ImageLightboxProps {
  readonly src: string;
  readonly name: string;
  readonly onClose: () => void;
}

export function ImageLightbox({ src, name, onClose }: ImageLightboxProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalDialog(dialogRef, onClose);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={name}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(0_0_0/0.78)] backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[85vh] max-w-[85vw] flex-col items-center">
        <img
          src={src}
          alt={name}
          className="max-h-[72vh] max-w-full rounded-lg object-contain shadow-[var(--shadow-xl)]"
        />
        <div className="mt-3 flex min-w-0 items-center gap-3">
          <span className="max-w-[40vw] truncate text-[12px] text-[rgb(255_255_255/0.8)]">
            {name}
          </span>
          <button
            type="button"
            aria-label="关闭预览"
            onClick={onClose}
            className="ui-pressable shrink-0 rounded-md border border-[rgb(255_255_255/0.2)] bg-[rgb(255_255_255/0.06)] px-2.5 py-1 text-[11px] text-[rgb(255_255_255/0.9)] hover:bg-[rgb(255_255_255/0.14)]"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
