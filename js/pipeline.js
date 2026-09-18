/*
 * Turning a captured page into its finished image, in the background, one page at a time.
 */
import { detectCorners, renderPage } from './cv-client.js';
import { canvasToBlob, releaseCanvas, THUMB_EDGE } from './capture.js';
import { getPage, updatePage, emit } from './store.js';

export const editing = { id: null };   // the page open in crop/filter; the queue leaves it alone

export function renderKey(page) {
  return JSON.stringify([page.corners, page.filter, page.rotation, page.strength == null ? null : page.strength]);
}

export function isProcessed(page) {
  return !!page.processedBlob && page.processedKey === renderKey(page);
}

export function insetCorners(w, h, f = 0.05) {
  const dx = w * f, dy = h * f;
  return [[dx, dy], [w - dx, dy], [w - dx, h - dy], [dx, h - dy]];
}

export function fullCorners(w, h) {
  return [[0, 0], [w, 0], [w, h], [0, h]];
}

/* Detection result for this page, run once and remembered */
export function getAutoCorners(page) {
  if (page.detectRan) return Promise.resolve(page.autoCorners || null);
  if (!page._detecting) {
    page._detecting = detectCorners(page)
      .then(c => {
        page._detecting = null;
        updatePage(page, { autoCorners: c || null, detectRan: true });
        return c || null;
      })
      .catch(err => {
        page._detecting = null;
        throw err;
      });
  }
  return page._detecting;
}

export async function ensureCorners(page) {
  if (page.corners) return page.corners;
  const auto = await getAutoCorners(page);
  if (!page.corners) await updatePage(page, { corners: auto || insetCorners(page.w, page.h) });
  return page.corners;
}

const scratch = document.createElement('canvas');
const thumbCanvas = document.createElement('canvas');

async function encode(img, filter) {
  scratch.width = img.width;
  scratch.height = img.height;
  scratch.getContext('2d').putImageData(img, 0, 0);
  let blob = await canvasToBlob(scratch, 'image/jpeg', 0.85);
  if (filter === 'bw') {
    const png = await canvasToBlob(scratch, 'image/png');
    if (png.size < blob.size) blob = png;
  }
  const s = Math.min(1, THUMB_EDGE / Math.max(img.width, img.height));
  thumbCanvas.width = Math.max(1, Math.round(img.width * s));
  thumbCanvas.height = Math.max(1, Math.round(img.height * s));
  const tctx = thumbCanvas.getContext('2d');
  tctx.imageSmoothingQuality = 'high';
  tctx.drawImage(scratch, 0, 0, thumbCanvas.width, thumbCanvas.height);
  const thumb = await canvasToBlob(thumbCanvas, 'image/jpeg', 0.8);
  releaseCanvas(scratch);
  releaseCanvas(thumbCanvas);
  return { blob, thumb };
}

export async function processPage(page) {
  await ensureCorners(page);
  for (let tries = 0; tries < 3; tries++) {
    const key = renderKey(page);
    if (page.processedBlob && page.processedKey === key) return;
    page._busy = true;
    emit('page', page);
    try {
      const img = await renderPage(page);
      if (renderKey(page) !== key) continue;   // edited while rendering
      const { blob, thumb } = await encode(img, page.filter);
      if (renderKey(page) !== key) continue;
      await updatePage(page, { processedBlob: blob, thumbBlob: thumb, processedKey: key, outW: img.width, outH: img.height });
    } finally {
      page._busy = false;
      emit('page', page);
    }
  }
}

const queue = [];
let running = false;

export function enqueue(page) {
  if (!queue.includes(page.id)) queue.push(page.id);
  pump();
}

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const id = queue.shift();
    const page = getPage(id);
    if (!page) continue;
    try {
      if (editing.id === id) await ensureCorners(page);
      else await processPage(page);
      page._error = null;
    } catch (err) {
      console.error(err);
      page._error = err.message;
      emit('page', page);
    }
  }
  running = false;
}

export function enqueueUnprocessed(pages) {
  pages.forEach(p => { if (!isProcessed(p)) enqueue(p); });
}
