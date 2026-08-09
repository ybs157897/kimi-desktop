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
      className="fixed inset-0 z-50 flex items-center justify-center bg-[color-mix(in_srgb,var(--gray-1000)_78%,transparent)] backdrop-blur-sm"
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
          <span className="max-w-[40vw] truncate text-[12px] text-[color-mix(in_srgb,var(--gray-0)_80%,transparent)]">
            {name}
          </span>
          <button
            type="button"
            aria-label="关闭预览"
            onClick={onClose}
            className="ui-pressable shrink-0 rounded-md border border-[color-mix(in_srgb,var(--gray-0)_20%,transparent)] bg-[color-mix(in_srgb,var(--gray-0)_6%,transparent)] px-2.5 py-1 text-[11px] text-[color-mix(in_srgb,var(--gray-0)_90%,transparent)] hover:bg-[color-mix(in_srgb,var(--gray-0)_14%,transparent)]"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
