/**
 * Turning a picture off someone's disk into something a level can carry.
 *
 * A level is a single JSON object that lives in localStorage and travels in a
 * share code, so a backdrop cannot be a 12 megapixel phone photo. Everything
 * here exists to get an arbitrary upload down to a size that survives that,
 * without silently producing a smear.
 */

/** Widest the picture is stored at. Wraps the horizon, so width matters most. */
const MAX_WIDTH = 2048;
const MAX_HEIGHT = 1024;

/** Data-URL characters. localStorage is ~5 MB total for every level combined. */
const BUDGET = 900_000;

export interface LoadedImage {
  /** `data:image/jpeg;base64,...` */
  url: string;
  width: number;
  height: number;
  /** Length of the data URL, which is what actually costs storage. */
  bytes: number;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Decodes, downscales and re-encodes a picked file.
 *
 * Re-encodes as JPEG and walks the quality down until it fits the budget, then
 * halves the resolution and tries again. Giving up and storing the original
 * would blow the storage quota for every other level the player has saved.
 */
export async function readBackdropImage(file: File): Promise<LoadedImage> {
  if (!file.type.startsWith('image/')) throw new Error('That file is not an image.');

  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('That image could not be decoded.');
  });

  let width = bitmap.width;
  let height = bitmap.height;
  const fit = Math.min(1, MAX_WIDTH / width, MAX_HEIGHT / height);
  width = Math.max(1, Math.round(width * fit));
  height = Math.max(1, Math.round(height * fit));

  for (let attempt = 0; attempt < 4; attempt++) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser will not give us a canvas to resize with.');
    ctx.drawImage(bitmap, 0, 0, width, height);

    for (const quality of [0.82, 0.7, 0.58, 0.45]) {
      const url = canvas.toDataURL('image/jpeg', quality);
      if (url.length <= BUDGET) {
        bitmap.close();
        return { url, width, height, bytes: url.length };
      }
    }
    width = Math.max(1, Math.round(width / 2));
    height = Math.max(1, Math.round(height / 2));
  }

  bitmap.close();
  throw new Error('That image is too large to store, even shrunk.');
}
