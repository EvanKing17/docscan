/*
 * Main-thread side of the OpenCV worker. The worker keeps one source image loaded, so every
 * call that needs a page's pixels runs through exclusive() to stop two pages interleaving.
 */
import { blobToImageData } from './capture.js';

const OPENCV_URL = 'vendor/opencv.js';
const OPENCV_BYTES = 10257309; // for progress when the server sends no usable length

export const cvState = { status: 'idle', progress: 0, error: null };
const listeners = new Set();

function setState(patch) {
  Object.assign(cvState, patch);
  listeners.forEach(fn => fn(cvState));
}

export function onCvState(fn) {
  listeners.add(fn);
  fn(cvState);
  return () => listeners.delete(fn);
}

let worker = null;
let readyPromise = null;
let seq = 0;
const pending = new Map();

function call(type, payload = {}, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage(Object.assign({ id, type }, payload), transfer);
  });
}

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Could not download the scanner (' + res.status + ')');
  if (!res.body || !res.body.getReader) return URL.createObjectURL(await res.blob());
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(Math.min(0.99, got / OPENCV_BYTES));
  }
  return URL.createObjectURL(new Blob(chunks, { type: 'text/javascript' }));
}

export function startCv() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    setState({ status: 'loading', progress: 0, error: null });
    const url = await fetchWithProgress(OPENCV_URL, p => setState({ progress: p }));
    setState({ status: 'starting', progress: 1 });
    worker = new Worker('js/worker/cv-worker.js');
    worker.onmessage = e => {
      const { id, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error) p.reject(new Error(error)); else p.resolve(e.data);
    };
    worker.onerror = e => {
      const err = new Error(e.message || 'Scanner worker failed');
      pending.forEach(p => p.reject(err));
      pending.clear();
    };
    try {
      await call('init', { url });
    } finally {
      URL.revokeObjectURL(url);
    }
    setState({ status: 'ready' });
  })().catch(err => {
    if (worker) worker.terminate();
    worker = null;
    readyPromise = null;
    loadedKey = null;
    setState({ status: 'error', error: err.message });
    throw err;
  });
  return readyPromise;
}

let chain = Promise.resolve();
let loadedKey = null;

function exclusive(fn) {
  const run = chain.then(() => fn(), () => fn());
  chain = run.catch(() => {});
  return run;
}

async function loadSource(page) {
  if (loadedKey === page.id) return;
  const img = await blobToImageData(page.originalBlob);
  loadedKey = null;
  await call('source', { key: page.id, w: img.width, h: img.height, buffer: img.data.buffer }, [img.data.buffer]);
  loadedKey = page.id;
}

export async function detectCorners(page) {
  await startCv();
  return exclusive(async () => {
    await loadSource(page);
    const r = await call('detect');
    return r.corners;
  });
}

/* Returns ImageData of the flattened, filtered, rotated page. opts.maxDim for previews. */
export async function renderPage(page, opts = {}) {
  await startCv();
  return exclusive(async () => {
    await loadSource(page);
    const r = await call('render', {
      corners: opts.corners || page.corners,
      filter: opts.filter || page.filter,
      rotation: opts.rotation != null ? opts.rotation : page.rotation,
      maxDim: opts.maxDim || 0,
      strength: page.strength,
    });
    return new ImageData(new Uint8ClampedArray(r.buffer), r.w, r.h);
  });
}
