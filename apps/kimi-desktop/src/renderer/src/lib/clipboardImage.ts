/**
 * Clipboard-image helpers (M9): downscale a pasted screenshot to a bounded
 * dimension and turn it into a `File` for the composer's existing
 * upload-to-attach pipeline. The scaling math lives in `imageScale.ts` (pure,
 * unit-tested); this canvas path runs only in the renderer.
 */

import { computeScaledSize, PASTE_IMAGE_MAX_DIMENSION } from './imageScale';

/**
 * Load a (PNG) data URL, downscale to the max long edge, and return it as a
 * PNG `File`. Rejects when the data URL is not a decodable image.
 */
export async function compressImageDataUrl(
  dataUrl: string,
  maxDimension: number = PASTE_IMAGE_MAX_DIMENSION,
): Promise<File> {
  const image = await loadImage(dataUrl);
  const size = computeScaledSize(image.naturalWidth, image.naturalHeight, maxDimension);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('canvas 2d context unavailable');
  context.drawImage(image, 0, 0, size.width, size.height);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result !== null) resolve(result);
      else reject(new Error('image encoding failed'));
    }, 'image/png');
  });
  return new File([blob], `paste-${Date.now()}.png`, { type: 'image/png' });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('unable to decode pasted image'));
    image.src = dataUrl;
  });
}
