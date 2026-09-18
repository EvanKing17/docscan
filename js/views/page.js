/* Page: the flattened result, filter choice, rotation. */
import { session, getPage, pageIndex, updatePage, saveMeta } from '../store.js';
import { editing, ensureCorners, enqueue } from '../pipeline.js';
import { renderPage } from '../cv-client.js';
import { toast } from '../ui.js';
import { go, openCamera, deleteWithUndo } from '../actions.js';

export const FILTERS = [
  { id: 'original', label: 'Original' },
  { id: 'enhanced', label: 'Enhanced' },
  { id: 'gray', label: 'Grayscale' },
  { id: 'bw', label: 'B&W' },
];

const el = document.getElementById('view-page');
const titleEl = el.querySelector('.page-title');
const stage = el.querySelector('.page-stage');
const preview = stage.querySelector('canvas');
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
  renderPreview();
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
  await renderPreview();
  renderChips();
}

export function hide() {
  el.hidden = true;
  token++;
  chipToken++;
  page = null;
  preview.width = 1;
  preview.height = 1;
}

async function renderPreview() {
  const p = page;
  if (!p) return;
  const my = ++token;
  spinner.hidden = false;
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  const maxDim = Math.min(1600, Math.round(Math.max(stage.clientWidth, stage.clientHeight) * dpr));
  try {
    const img = await renderPage(p, { maxDim });
    if (my !== token) return;
    preview.width = img.width;
    preview.height = img.height;
    preview.getContext('2d').putImageData(img, 0, 0);
  } catch (err) {
    if (my === token) toast("Couldn't render the page: " + err.message, { duration: 4000 });
  } finally {
    if (my === token) spinner.hidden = true;
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
