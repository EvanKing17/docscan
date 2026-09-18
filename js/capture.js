/*
 * Getting photos in. Decoding goes through <img>, which both Safari and Chrome rotate by the
 * EXIF orientation; createImageBitmap's imageOrientation option is ignored by some Safari builds.
 */
export const MAX_EDGE = 3200;   // a 12MP photo at nearly full size; iOS canvas limit is 16.7MP
export const THUMB_EDGE = 360;

export async function loadImage(blob) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try {
    if (img.decode) await img.decode();
    else await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
  } catch (err) {
    URL.revokeObjectURL(url);
    throw new Error('Could not read that image');
  }
  return { img, url, release: () => URL.revokeObjectURL(url) };
}

export function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not encode image'))), type, quality);
  });
}

function scaledCanvas(source, sw, sh, maxEdge) {
  const s = Math.min(1, maxEdge / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * s));
  c.height = Math.max(1, Math.round(sh * s));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return c;
}

// Frees the backing store now instead of whenever GC gets to it; iOS caps total canvas memory
export function releaseCanvas(c) { c.width = 1; c.height = 1; }

/* A photo from the camera or gallery -> stored original and thumbnail */
export async function importFile(file) {
  const { img, release } = await loadImage(file);
  try {
    const big = scaledCanvas(img, img.naturalWidth, img.naturalHeight, MAX_EDGE);
    const originalBlob = await canvasToBlob(big, 'image/jpeg', 0.92);
    const thumb = scaledCanvas(big, big.width, big.height, THUMB_EDGE);
    const origThumbBlob = await canvasToBlob(thumb, 'image/jpeg', 0.8);
    const out = { originalBlob, origThumbBlob, w: big.width, h: big.height };
    releaseCanvas(big);
    releaseCanvas(thumb);
    return out;
  } finally {
    release();
  }
}

/* A stored original -> RGBA pixels for the worker */
export async function blobToImageData(blob) {
  const { img, release } = await loadImage(blob);
  try {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height);
    releaseCanvas(c);
    return data;
  } finally {
    release();
  }
}
