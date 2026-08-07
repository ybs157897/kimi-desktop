/**
 * Pure image-scaling helpers (M9 paste-to-attach). DOM-free — unit-tested in
 * a node environment, and imported by the canvas path in `clipboardImage.ts`.
 */

/** The long-edge cap for pasted images (keeps uploads reasonable). */
export const PASTE_IMAGE_MAX_DIMENSION = 2048;

/**
 * Scale an image to fit within `maxDimension` on its long edge. Never
 * upscales; returns the input size when already within bounds or degenerate.
 */
export function computeScaledSize(
  width: number,
  height: number,
  maxDimension: number,
): { readonly width: number; readonly height: number } {
  if (width <= 0 || height <= 0 || maxDimension <= 0) return { width, height };
  const longEdge = Math.max(width, height);
  if (longEdge <= maxDimension) return { width, height };
  const ratio = maxDimension / longEdge;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}
