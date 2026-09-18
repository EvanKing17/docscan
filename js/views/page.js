/* Page: the flattened result, filter choice, rotation. */
import { session, getPage, pageIndex, updatePage, saveMeta } from '../store.js';
import { editing, ensureCorners, enqueue } from '../pipeline.js';
import { renderPage } from '../cv-client.js';
import { toast } from '../ui.js';
import { go, openCamera, deleteWithUndo, handoff } from '../actions.js';

export const FILTERS = [
  { id: 'original', label: 'Original' },
  { id: 'enhanced', label: 'Enhanced' },
  { id: 'contrast', label: 'High contrast' },
  { id: 'gray', label: 'Grayscale' },
  { id: 'bw', label: 'B&W' },
];

const el = document.getElementById('view-page');
const titleEl = el.querySelector('.page-title');
const stage = el.querySelector('.page-stage');
const preview = stage.querySelector('.page-preview');
const spinner = stage.querySelector('.spin-wrap');
const chipsEl = el.querySelector('.chips');

chipsEl.innerHTML = FILTERS.map(f =>
  `<button type="button" class="chip" data-filter="${f.id}"><span class="chip-img"><canvas></canvas></span><span class="chip-label">${f.label}</span></button>`).join('');

let page = null;
let token = 0;
let chipToken = 0;

el.querySelector('[data-act="back"]').addEventListener('click', done);
el.querySelector('[data-act="done"]').addEventListener('click', done);
el.querySelector('[data-act="crop"]').addEventListener('click', () => page && go('#/crop/' + page.id));
el.querySelector('[data-act="rotl"]').addEventListener('click', () => rotate(-90));
el.querySelector('[data-act="rotr"]').addEventListener('click', () => rotate(90));
el.querySelector('[data-act="delete"]').addEventListener('click', () => {
  if (!page) return;
  const id = page.id;
  editing.id = null;
  go('#/');
  deleteWithUndo(id);
});
el.querySelector('[data-act="add"]').addEventListener('click', () => {
  openCamera();   // first, while the tap still counts as a user gesture
  finish();
  go('#/');
});
el.querySelector('[data-act="all"]').addEventListener('click', () => {
  if (!page) return;
  const f = page.filter;
  session.pages.forEach(p => {
    if (p.filter !== f) {
      updatePage(p, { filter: f });
      if (p !== page) enqueue(p);
    }
  });
  const label = FILTERS.find(x => x.id === f).label;
  toast(`${label} applied to all ${session.pages.length} pages`);
});

chipsEl.addEventListener('click', e => {
  const b = e.target.closest('.chip');
  if (!b || !page) return;
  const f = b.dataset.filter;
  if (f === page.filter) return;
  updatePage(page, { filter: f });
  session.defaultFilter = f;
  saveMeta();
  markChip();
  renderPreview({ scan: true });
});

function finish() {
  if (!page) return;
  const p = page;
  editing.id = null;
  enqueue(p);
}

function done() {
  finish();
  go('#/');
}

function rotate(delta) {
  if (!page) return;
  updatePage(page, { rotation: ((page.rotation || 0) + delta + 360) % 360 });
  renderPreview();
  renderChips();
}

function markChip() {
  chipsEl.querySelectorAll('.chip').forEach(b => b.classList.toggle('on', b.dataset.filter === page.filter));
}

export async function show(id) {
  const p = getPage(id);
  el.hidden = false;
  if (!p) return;
  page = p;
  editing.id = p.id;
  titleEl.textContent = `Page ${pageIndex(p.id) + 1} of ${session.pages.length}`;
  markChip();
  const ctx = preview.getContext('2d');
  ctx.clearRect(0, 0, preview.width, preview.height);
  chipsEl.querySelectorAll('canvas').forEach(c => { c.width = 1; c.height = 1; });
  spinner.hidden = false;
  try {
    await ensureCorners(p);
  } catch (err) {
    if (page === p) toast('Scanner not available: ' + err.message, { duration: 4000 });
    return;
  }
  if (page !== p) return;
  const animate = handoff.morph === p.id && !(p.rotation % 360) && !reduceMotion.matches;
  handoff.morph = null;
  if (animate) await playIntro(p);
  else await renderPreview();
  renderChips();
}

export function hide() {
  el.hidden = true;
  token++;
  chipToken++;
  page = null;
  endIntro();
  preview.width = 1;
  preview.height = 1;
}

function previewMaxDim() {
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  return Math.min(1600, Math.round(Math.max(stage.clientWidth, stage.clientHeight) * dpr));
}

/* ---------- Intro: the page lifts out of the photo, then the filter scans down it ---------- */

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const intro = stage.querySelector('.intro');
const introPhoto = intro.querySelector('.intro-photo');
const introPlain = intro.querySelector('.intro-plain');
const introFiltered = intro.querySelector('.intro-filtered');
const scanline = intro.querySelector('.scanline');
let introUrl = null;

function endIntro() {
  intro.hidden = true;
  preview.style.visibility = '';
  introPhoto.removeAttribute('src');
  if (introUrl) { URL.revokeObjectURL(introUrl); introUrl = null; }
  introPlain.width = introPlain.height = 1;
  introFiltered.width = introFiltered.height = 1;
}

const frameP = () => new Promise(r => requestAnimationFrame(r));
const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

async function tween(ms, my, step) {
  const t0 = performance.now();
  for (;;) {
    await frameP();
    if (my !== token) return false;
    const t = Math.min(1, (performance.now() - t0) / ms);
    step(t);
    if (t >= 1) return true;
  }
}

// Homography taking the rectangle (0,0)-(w,h) onto quad q, as a CSS matrix3d
function rectToQuad(w, h, q) {
  const src = [[0, 0], [w, 0], [w, h], [0, h]];
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = q[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  // Gaussian elimination with partial pivoting
  for (let c = 0; c < 8; c++) {
    let piv = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = c + 1; r < 8; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const m = new Array(8);
  for (let r = 7; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < 8; k++) s -= A[r][k] * m[k];
    m[r] = s / A[r][r];
  }
  return `matrix3d(${m[0]},${m[3]},0,${m[6]},${m[1]},${m[4]},0,${m[7]},0,0,1,0,${m[2]},${m[5]},0,1)`;
}

function place(elm, r) {
  elm.style.left = r.x + 'px';
  elm.style.top = r.y + 'px';
  elm.style.width = r.w + 'px';
  elm.style.height = r.h + 'px';
}

async function playIntro(p) {
  const my = ++token;
  const sw = stage.clientWidth, sh = stage.clientHeight;
  preview.style.visibility = 'hidden';
  spinner.hidden = true;

  // The photo, fitted as on the crop screen
  introUrl = URL.createObjectURL(p.originalBlob);
  introPhoto.src = introUrl;
  const ps = Math.min((sw - 32) / p.w, (sh - 24) / p.h);
  const photo = { x: (sw - p.w * ps) / 2, y: (sh - p.h * ps) / 2, w: p.w * ps, h: p.h * ps };
  place(introPhoto, photo);
  introPhoto.style.opacity = 1;
  introPlain.style.opacity = 0;
  introFiltered.style.clipPath = 'inset(0 0 100% 0)';
  scanline.style.opacity = 0;
  intro.hidden = false;

  try {
    const maxDim = previewMaxDim();
    const plain = await renderPage(p, { maxDim, filter: 'original' });
    if (my !== token) return;
    const filtered = p.filter === 'original' ? plain : await renderPage(p, { maxDim });
    if (my !== token) return;

    for (const [c, img] of [[introPlain, plain], [introFiltered, filtered]]) {
      c.width = img.width;
      c.height = img.height;
      c.getContext('2d').putImageData(img, 0, 0);
    }
    // Final spot, the same box the preview canvas takes (stage padding 12px 16px)
    const fs = Math.min((sw - 32) / plain.width, (sh - 24) / plain.height);
    const rect = { x: (sw - plain.width * fs) / 2, y: (sh - plain.height * fs) / 2, w: plain.width * fs, h: plain.height * fs };
    place(introPlain, rect);
    place(introFiltered, rect);
    scanline.style.left = rect.x + 'px';
    scanline.style.width = rect.w + 'px';

    // Where the page sits in the photo, relative to its final box
    const from = p.corners.map(([x, y]) => [photo.x + x * ps - rect.x, photo.y + y * ps - rect.y]);
    const to = [[0, 0], [rect.w, 0], [rect.w, rect.h], [0, rect.h]];
    introPlain.style.transform = rectToQuad(rect.w, rect.h, from);
    introPlain.style.opacity = 1;

    const morphed = await tween(1000, my, t => {
      const e = easeInOut(t);
      const q = from.map((a, i) => [a[0] + (to[i][0] - a[0]) * e, a[1] + (to[i][1] - a[1]) * e]);
      introPlain.style.transform = rectToQuad(rect.w, rect.h, q);
      introPhoto.style.opacity = String(1 - Math.min(1, e * 1.4));
    });
    if (!morphed) return;
    introPlain.style.transform = 'none';

    if (filtered !== plain && !(await scanReveal(my, rect))) return;

    preview.width = filtered.width;
    preview.height = filtered.height;
    preview.getContext('2d').putImageData(filtered, 0, 0);
  } catch (err) {
    if (my === token) toast("Couldn't render the page: " + err.message, { duration: 4000 });
  } finally {
    // Also when cut short (a filter tapped, or the screen left): the normal preview takes over
    if (my === token) endIntro();
  }
}

// The scanline sweeps down introFiltered's box, uncovering it over whatever is beneath
const SCAN_MS = 1400;

function scanReveal(my, rect) {
  scanline.style.left = rect.x + 'px';
  scanline.style.width = rect.w + 'px';
  scanline.style.top = rect.y + 'px';
  scanline.style.opacity = 1;
  introFiltered.style.clipPath = 'inset(0 0 100% 0)';
  return tween(SCAN_MS, my, t => {
    const e = easeInOut(t);
    introFiltered.style.clipPath = `inset(0 0 ${(1 - e) * 100}% 0)`;
    scanline.style.top = (rect.y + e * rect.h) + 'px';
    if (t > 0.88) scanline.style.opacity = String((1 - t) / 0.12);
  });
}

/* opts.scan: sweep the new look in over the old one (a filter change) */
async function renderPreview(opts = {}) {
  const p = page;
  if (!p) return;
  const my = ++token;
  const scan = opts.scan && preview.width > 1 && !reduceMotion.matches;
  if (!scan) endIntro();
  spinner.hidden = false;
  const maxDim = previewMaxDim();
  try {
    const img = await renderPage(p, { maxDim });
    if (my !== token) return;
    if (scan && img.width === preview.width && img.height === preview.height) {
      spinner.hidden = true;
      const sw = stage.clientWidth, sh = stage.clientHeight;
      const fs = Math.min((sw - 32) / img.width, (sh - 24) / img.height);
      const rect = { x: (sw - img.width * fs) / 2, y: (sh - img.height * fs) / 2, w: img.width * fs, h: img.height * fs };
      // Old look underneath, new look on top
      introPlain.width = img.width;
      introPlain.height = img.height;
      introPlain.getContext('2d').drawImage(preview, 0, 0);
      introFiltered.width = img.width;
      introFiltered.height = img.height;
      introFiltered.getContext('2d').putImageData(img, 0, 0);
      introPhoto.style.opacity = 0;
      introPlain.style.transform = 'none';
      introPlain.style.opacity = 1;
      place(introPlain, rect);
      place(introFiltered, rect);
      intro.hidden = false;
      preview.style.visibility = 'hidden';
      const done = await scanReveal(my, rect);
      if (!done) return;
    }
    preview.width = img.width;
    preview.height = img.height;
    preview.getContext('2d').putImageData(img, 0, 0);
  } catch (err) {
    if (my === token) toast("Couldn't render the page: " + err.message, { duration: 4000 });
  } finally {
    if (my === token) {
      spinner.hidden = true;
      endIntro();
    }
  }
}

async function renderChips() {
  const p = page;
  if (!p) return;
  const my = ++chipToken;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const maxDim = Math.round(72 * dpr);
  for (const f of FILTERS) {
    try {
      const img = await renderPage(p, { filter: f.id, maxDim });
      if (my !== chipToken) return;
      const c = chipsEl.querySelector(`[data-filter="${f.id}"] canvas`);
      c.width = img.width;
      c.height = img.height;
      c.getContext('2d').putImageData(img, 0, 0);
    } catch (err) {
      return;
    }
  }
}
