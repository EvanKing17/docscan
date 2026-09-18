/* Home: the document's pages. Tap to open, long-press to drag into a new order. */
import { session, subscribe, saveMeta, movePage, setOrder, pageIndex, resetSession, defaultName } from '../store.js';
import { editing, isProcessed, enqueueUnprocessed } from '../pipeline.js';
import { actionSheet, confirmDialog, esc, icon, toast } from '../ui.js';
import { go, openCamera, openGallery, deleteWithUndo } from '../actions.js';
import { openExport } from './export.js';

const el = document.getElementById('view-home');
const main = el.querySelector('.home-main');
const grid = el.querySelector('.grid');
const empty = el.querySelector('.empty');
const docHead = el.querySelector('.doc-head');
const nameInput = el.querySelector('.doc-name');
const countEl = el.querySelector('.doc-count');
const resumeEl = el.querySelector('.resume');
const pdfBtn = el.querySelector('[data-act="pdf"]');
const newBtn = el.querySelector('[data-act="new"]');

let visible = false;
let dirty = true;

el.querySelectorAll('[data-act="camera"]').forEach(b => b.addEventListener('click', openCamera));
el.querySelectorAll('[data-act="gallery"]').forEach(b => b.addEventListener('click', openGallery));
pdfBtn.addEventListener('click', () => { if (session.pages.length) openExport(); });
newBtn.addEventListener('click', async () => {
  const n = session.pages.length;
  const ok = await confirmDialog({
    title: 'Start a new scan?',
    body: `The current ${n} page${n === 1 ? '' : 's'} will be deleted from this device. Export the PDF first if you need it.`,
    ok: 'Delete and start new',
    danger: true,
  });
  if (!ok) return;
  await resetSession();
  resumeEl.hidden = true;
  toast('Started a new scan');
});
resumeEl.querySelector('[data-act="dismiss"]').addEventListener('click', () => { resumeEl.hidden = true; });

nameInput.addEventListener('change', () => {
  session.name = nameInput.value.trim() || defaultName();
  nameInput.value = session.name;
  saveMeta();
});
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') nameInput.blur(); });

subscribe((what, detail) => {
  if (what === 'page' && detail) {
    updateTile(detail);
    return;
  }
  if (what === 'pages' || what === 'load') {
    dirty = true;
    if (visible && !drag) render();
  }
});

export function showResume() {
  if (!session.pages.length) return;
  const n = session.pages.length;
  resumeEl.querySelector('.resume-text').textContent = `Picked up where you left off: ${n} page${n === 1 ? '' : 's'}.`;
  resumeEl.hidden = false;
}

export function show() {
  el.hidden = false;
  visible = true;
  editing.id = null;
  render();
  enqueueUnprocessed(session.pages);
}

export function hide() {
  el.hidden = true;
  visible = false;
  resumeEl.hidden = true;
}

/* ---------- Thumbnails ---------- */

const urls = new Map();   // id -> { blob, url }

function thumbUrl(page) {
  const blob = page.thumbBlob || page.origThumbBlob;
  if (!blob) return '';
  const cur = urls.get(page.id);
  if (cur && cur.blob === blob) return cur.url;
  if (cur) URL.revokeObjectURL(cur.url);
  const url = URL.createObjectURL(blob);
  urls.set(page.id, { blob, url });
  return url;
}

function pruneUrls() {
  const ids = new Set(session.pages.map(p => p.id));
  for (const [id, v] of urls) {
    if (!ids.has(id)) { URL.revokeObjectURL(v.url); urls.delete(id); }
  }
}

/* ---------- Render ---------- */

function render() {
  dirty = false;
  const pages = session.pages;
  const n = pages.length;
  empty.hidden = n > 0;
  grid.hidden = n === 0;
  docHead.hidden = n === 0;
  pdfBtn.disabled = n === 0;
  newBtn.hidden = n === 0;
  if (!n) resumeEl.hidden = true;
  if (document.activeElement !== nameInput) nameInput.value = session.name || defaultName();
  countEl.textContent = `${n} page${n === 1 ? '' : 's'}`;

  grid.innerHTML = pages.map((p, i) => `
    <div class="tile" data-id="${esc(p.id)}">
      <button type="button" class="tile-open" aria-label="Page ${i + 1}">
        <img alt="" draggable="false" src="${thumbUrl(p)}">
      </button>
      <span class="tile-num">${i + 1}</span>
      <button type="button" class="tile-more" aria-label="Page ${i + 1} options">${icon('more')}</button>
      <span class="tile-busy"${isProcessed(p) && !p._error ? ' hidden' : ''}>${p._error ? '!' : '<span class="spin sm"></span>'}</span>
    </div>`).join('');
  pruneUrls();
}

function updateTile(page) {
  if (!visible) return;
  const t = grid.querySelector(`.tile[data-id="${CSS.escape(page.id)}"]`);
  if (!t) return;
  const img = t.querySelector('img');
  const u = thumbUrl(page);
  if (img.getAttribute('src') !== u) img.src = u;
  const b = t.querySelector('.tile-busy');
  const done = isProcessed(page) && !page._busy;
  b.hidden = done && !page._error;
  b.innerHTML = page._error ? '!' : '<span class="spin sm"></span>';
  b.title = page._error || '';
}

/* ---------- Taps and menu ---------- */

let suppressClick = false;

grid.addEventListener('click', async e => {
  if (suppressClick) { suppressClick = false; return; }
  const tile = e.target.closest('.tile');
  if (!tile) return;
  const id = tile.dataset.id;
  if (e.target.closest('.tile-more')) {
    const i = pageIndex(id);
    const last = session.pages.length - 1;
    const choice = await actionSheet([
      { value: 'crop', label: 'Adjust edges', icon: 'crop' },
      { value: 'page', label: 'Filter and rotate', icon: 'auto' },
      { value: 'earlier', label: 'Move earlier', icon: 'left', disabled: i <= 0 },
      { value: 'later', label: 'Move later', icon: 'right', disabled: i >= last },
      { value: 'delete', label: 'Delete page', icon: 'trash', danger: true },
    ], `Page ${i + 1}`);
    if (choice === 'crop') go('#/crop/' + id);
    else if (choice === 'page') go('#/page/' + id);
    else if (choice === 'earlier') movePage(pageIndex(id), pageIndex(id) - 1);
    else if (choice === 'later') movePage(pageIndex(id), pageIndex(id) + 1);
    else if (choice === 'delete') deleteWithUndo(id);
    return;
  }
  go('#/page/' + id);
});

grid.addEventListener('contextmenu', e => { if (e.target.closest('.tile')) e.preventDefault(); });

/* ---------- Long-press drag to reorder ---------- */

const LONG_PRESS = 380;
let press = null;
let drag = null;

grid.addEventListener('pointerdown', e => {
  const tile = e.target.closest('.tile');
  if (!tile || e.target.closest('.tile-more') || !e.isPrimary || drag) return;
  const r = tile.getBoundingClientRect();
  press = {
    tile,
    pointerId: e.pointerId,
    x: e.clientX,
    y: e.clientY,
    grabX: e.clientX - r.left,
    grabY: e.clientY - r.top,
    timer: setTimeout(() => startDrag(e.pointerId), LONG_PRESS),
  };
});

function cancelPress() {
  if (press) clearTimeout(press.timer);
  press = null;
}

function startDrag(pointerId) {
  if (!press || press.pointerId !== pointerId) return;
  drag = press;
  press = null;
  drag.tile.classList.add('lifted');
  grid.classList.add('dragging');
  try { grid.setPointerCapture(pointerId); } catch (_) { /* pointer already gone */ }
  if (navigator.vibrate) navigator.vibrate(12);
  moveDrag(drag.x, drag.y);
}

function moveDrag(x, y) {
  const t = drag.tile;
  t.style.transform = '';
  const r = t.getBoundingClientRect();
  t.style.transform = `translate(${x - drag.grabX - r.left}px, ${y - drag.grabY - r.top}px) scale(1.06)`;

  for (const other of grid.children) {
    if (other === t) continue;
    const o = other.getBoundingClientRect();
    if (x >= o.left && x <= o.right && y >= o.top && y <= o.bottom) {
      const kids = Array.from(grid.children);
      if (kids.indexOf(t) < kids.indexOf(other)) other.after(t); else other.before(t);
      t.style.transform = '';
      const r2 = t.getBoundingClientRect();
      t.style.transform = `translate(${x - drag.grabX - r2.left}px, ${y - drag.grabY - r2.top}px) scale(1.06)`;
      renumber();
      break;
    }
  }

  // Scroll when held near the top or bottom
  const mr = main.getBoundingClientRect();
  if (y < mr.top + 60) main.scrollTop -= 12;
  else if (y > mr.bottom - 60) main.scrollTop += 12;
}

function renumber() {
  Array.from(grid.children).forEach((t, i) => { t.querySelector('.tile-num').textContent = i + 1; });
}

grid.addEventListener('pointermove', e => {
  if (press && e.pointerId === press.pointerId) {
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) cancelPress();
    return;
  }
  if (drag && e.pointerId === drag.pointerId) {
    e.preventDefault();
    drag.x = e.clientX;
    drag.y = e.clientY;
    moveDrag(e.clientX, e.clientY);
  }
});

function endDrag(e) {
  if (press && e.pointerId === press.pointerId) cancelPress();
  if (!drag || e.pointerId !== drag.pointerId) return;
  const t = drag.tile;
  t.classList.remove('lifted');
  t.style.transform = '';
  grid.classList.remove('dragging');
  drag = null;
  suppressClick = e.type === 'pointerup';
  setTimeout(() => { suppressClick = false; }, 400);
  setOrder(Array.from(grid.children).map(x => x.dataset.id));
}
grid.addEventListener('pointerup', endDrag);
grid.addEventListener('pointercancel', endDrag);

// iOS scrolls under a drag unless touchmove is cancelled; this has to be non-passive
grid.addEventListener('touchmove', e => { if (drag) e.preventDefault(); }, { passive: false });
