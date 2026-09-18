/*
 * Crop: four corner handles and four edge handles over the photo. Dragging shows a round loupe
 * with the photo's pixels magnified under a crosshair, placed away from the finger.
 */
import { getPage, updatePage } from '../store.js';
import { editing, getAutoCorners, insetCorners, fullCorners } from '../pipeline.js';
import { onCvState } from '../cv-client.js';
import { toast } from '../ui.js';
import { go } from '../actions.js';

const el = document.getElementById('view-crop');
const stage = el.querySelector('.crop-stage');
const imgEl = stage.querySelector('img');
const svg = stage.querySelector('svg');
const loupe = stage.querySelector('.loupe');
const lctx = loupe.getContext('2d');
const statusEl = el.querySelector('.crop-status');
const nextBtn = el.querySelector('[data-act="next"]');

const LOUPE = 136;          // CSS px
const CORNER_HIT = 44;      // CSS px
const EDGE_HIT = 34;

let page = null;
let W = 0, H = 0;
let corners = null;
let box = { x: 0, y: 0, scale: 1 };
let touched = false;
let drag = null;
let frame = 0;
let anim = 0;
let token = 0;
let imgUrl = null;
let detecting = false;
let cvText = '';

el.querySelector('[data-act="back"]').addEventListener('click', () => {
  if (history.length > 1) history.back(); else go('#/');
});
el.querySelector('[data-act="auto"]').addEventListener('click', runAuto);
el.querySelector('[data-act="full"]').addEventListener('click', () => {
  touched = true;
  animateTo(fullCorners(W, H));
});
nextBtn.addEventListener('click', confirm);

new ResizeObserver(() => { if (page) layout(); }).observe(stage);

onCvState(s => {
  cvText = s.status === 'loading' ? `Loading scanner ${Math.round(s.progress * 100)}%`
    : s.status === 'starting' ? 'Starting scanner'
    : s.status === 'error' ? 'Scanner unavailable, drag the corners'
    : '';
  updateStatus();
});

function updateStatus() {
  const text = detecting ? (cvText || 'Finding edges') : '';
  statusEl.textContent = text;
  statusEl.hidden = !text;
}

export async function show(id) {
  const p = getPage(id);
  el.hidden = false;
  if (!p) return;
  const my = ++token;
  page = p;
  editing.id = p.id;
  W = p.w; H = p.h;
  touched = false;
  drag = null;
  hideLoupe();

  if (imgUrl) URL.revokeObjectURL(imgUrl);
  imgUrl = URL.createObjectURL(p.originalBlob);
  imgEl.src = imgUrl;

  if (p.corners) corners = clone(p.corners);
  else if (p.detectRan) corners = clone(p.autoCorners || insetCorners(W, H));
  else corners = insetCorners(W, H);
  layout();

  if (!p.corners && !p.detectRan) {
    detecting = true;
    updateStatus();
    try {
      const c = await getAutoCorners(p);
      if (my !== token) return;
      if (!touched) {
        if (c) animateTo(c);
        else toast("Couldn't find the page edges. Drag the corners into place.", { duration: 3500 });
      }
    } catch (err) {
      if (my === token) toast("Couldn't find the page edges. Drag the corners into place.", { duration: 3500 });
    } finally {
      if (my === token) { detecting = false; updateStatus(); }
    }
  } else {
    detecting = false;
    updateStatus();
  }
}

export function hide() {
  el.hidden = true;
  token++;
  page = null;
  drag = null;
  cancelAnimationFrame(anim);
  hideLoupe();
  imgEl.removeAttribute('src');
  if (imgUrl) { URL.revokeObjectURL(imgUrl); imgUrl = null; }
}

async function runAuto() {
  if (!page) return;
  touched = true;
  const p = page;
  detecting = true;
  updateStatus();
  try {
    const c = await getAutoCorners(p);
    if (p !== page) return;
    if (c) animateTo(c);
    else toast("Couldn't find the page edges. Drag the corners into place.", { duration: 3500 });
  } catch (err) {
    toast('Scanner not available yet');
  } finally {
    detecting = false;
    updateStatus();
  }
}

async function confirm() {
  if (!page) return;
  let c = corners;
  if (!isValid(c)) c = orderCorners(c);
  if (!isValid(c)) return;
  const p = page;
  await updatePage(p, { corners: c.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]) });
  go('#/page/' + p.id);
}

/* ---------- Geometry ---------- */

function clone(c) { return c.map(p => [p[0], p[1]]); }
function mid(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
function clampPt(p) { return [Math.max(0, Math.min(W, p[0])), Math.max(0, Math.min(H, p[1]))]; }

function isValid(c) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = c[i], b = c[(i + 1) % 4], d = c[(i + 2) % 4];
    const cr = (b[0] - a[0]) * (d[1] - b[1]) - (b[1] - a[1]) * (d[0] - b[0]);
    if (Math.abs(cr) < 1e-6) return false;
    const s = Math.sign(cr);
    if (sign && s !== sign) return false;
    sign = s;
  }
  // Too small to be a page
  const area = Math.abs(c.reduce((s, p, i) => {
    const q = c[(i + 1) % 4];
    return s + p[0] * q[1] - q[0] * p[1];
  }, 0)) / 2;
  return area > W * H * 0.01;
}

function orderCorners(pts) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / 4;
  const cy = pts.reduce((s, p) => s + p[1], 0) / 4;
  const sorted = pts.slice().sort((a, b) =>
    Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let start = 0;
  for (let i = 1; i < 4; i++) {
    if (sorted[i][0] + sorted[i][1] < sorted[start][0] + sorted[start][1]) start = i;
  }
  return [0, 1, 2, 3].map(i => sorted[(start + i) % 4]);
}

/* ---------- Layout and drawing ---------- */

function layout() {
  const r = stage.getBoundingClientRect();
  if (!r.width || !r.height || !W) return;
  const pad = 28;
  const scale = Math.min((r.width - 2 * pad) / W, (r.height - 2 * pad) / H);
  const dw = W * scale, dh = H * scale;
  box = { x: (r.width - dw) / 2, y: (r.height - dh) / 2, scale };
  for (const e of [imgEl, svg]) {
    e.style.left = box.x + 'px';
    e.style.top = box.y + 'px';
    e.style.width = dw + 'px';
    e.style.height = dh + 'px';
  }
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  draw();
}

function schedule() {
  if (!frame) {
    frame = requestAnimationFrame(() => {
      frame = 0;
      draw();
      if (drag) showLoupe(focusPoint());
    });
  }
}

// Built once and updated in place; rebuilding the SVG on every move made dragging stutter
const NS = 'http://www.w3.org/2000/svg';
const mk = (tag, cls) => { const e = document.createElementNS(NS, tag); if (cls) e.setAttribute('class', cls); return e; };
const shadeEl = mk('path', 'shade');
shadeEl.setAttribute('fill-rule', 'evenodd');
const outlineEl = mk('polygon', 'outline');
const edgeEls = [0, 1, 2, 3].map(() => {
  const g = mk('g', 'h-edge');
  g.appendChild(mk('rect'));
  return g;
});
const cornerEls = [0, 1, 2, 3].map(() => mk('circle', 'h-corner'));
svg.append(shadeEl, outlineEl, ...edgeEls, ...cornerEls);

function draw() {
  if (!corners) return;
  const s = box.scale;
  const valid = isValid(corners) || isValid(orderCorners(corners));
  const isAct = (kind, i) => !!(drag && drag.kind === kind && drag.i === i);

  shadeEl.setAttribute('d', `M0 0H${W}V${H}H0Z M${corners.map(p => p[0] + ' ' + p[1]).join(' L')}Z`);
  outlineEl.setAttribute('points', corners.map(p => `${p[0]},${p[1]}`).join(' '));
  outlineEl.setAttribute('class', 'outline' + (valid ? '' : ' bad'));
  outlineEl.style.strokeWidth = 2 / s;

  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4];
    const g = edgeEls[i];
    // No room for a handle between the corners
    g.style.display = dist(a, b) * s < 90 ? 'none' : '';
    const m = mid(a, b);
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
    g.setAttribute('transform', `translate(${m[0]} ${m[1]}) rotate(${ang})`);
    g.setAttribute('class', 'h-edge' + (isAct('edge', i) ? ' active' : ''));
    const r = g.firstChild;
    r.setAttribute('x', -15 / s); r.setAttribute('y', -4.5 / s);
    r.setAttribute('width', 30 / s); r.setAttribute('height', 9 / s); r.setAttribute('rx', 4.5 / s);
    r.style.strokeWidth = 1.5 / s;

    const c = cornerEls[i], p = corners[i];
    c.setAttribute('cx', p[0]); c.setAttribute('cy', p[1]);
    c.setAttribute('r', (isAct('corner', i) ? 16 : 13) / s);
    c.setAttribute('class', 'h-corner' + (isAct('corner', i) ? ' active' : ''));
    c.style.strokeWidth = 2.5 / s;
  }
  nextBtn.disabled = !valid;
}

function animateTo(target) {
  cancelAnimationFrame(anim);
  const from = clone(corners);
  const t0 = performance.now();
  const step = now => {
    const t = Math.min(1, (now - t0) / 260);
    const e = 1 - Math.pow(1 - t, 3);
    corners = from.map((p, i) => [p[0] + (target[i][0] - p[0]) * e, p[1] + (target[i][1] - p[1]) * e]);
    draw();
    if (t < 1) anim = requestAnimationFrame(step);
  };
  anim = requestAnimationFrame(step);
}

/* ---------- Dragging ---------- */

function toImg(e) {
  const r = stage.getBoundingClientRect();
  return [(e.clientX - r.left - box.x) / box.scale, (e.clientY - r.top - box.y) / box.scale];
}

function hit(p) {
  const s = box.scale;
  let best = null, bd = Infinity;
  corners.forEach((c, i) => {
    const d = dist(c, p) * s;
    if (d < CORNER_HIT && d < bd) { bd = d; best = { kind: 'corner', i }; }
  });
  if (best) return best;
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4];
    if (dist(a, b) * s < 90) continue;
    const d = dist(mid(a, b), p) * s;
    if (d < EDGE_HIT && d < bd) { bd = d; best = { kind: 'edge', i }; }
  }
  return best;
}

stage.addEventListener('pointerdown', e => {
  if (!page || drag || !e.isPrimary) return;
  const p = toImg(e);
  const h = hit(p);
  if (!h) return;
  e.preventDefault();
  cancelAnimationFrame(anim);
  touched = true;
  stage.setPointerCapture(e.pointerId);
  drag = Object.assign(h, { pointerId: e.pointerId, last: { x: e.clientX, y: e.clientY, t: e.timeStamp }, orig: clone(corners), d: 0 });
  showLoupe(focusPoint());
  draw();
});

/*
 * The handle follows the finger's movement, not its position: slow movement is scaled down for
 * fine placement, fast movement goes 1:1. Moving slowly lets the handle creep out from under
 * the fingertip too.
 */
function gain(speed) {
  const t = Math.max(0, Math.min(1, (speed - 0.05) / (0.9 - 0.05)));   // CSS px per ms
  return 0.35 + 0.65 * t * t * (3 - 2 * t);
}

stage.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  e.preventDefault();
  const evs = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
  for (const ev of evs) {
    const dx = ev.clientX - drag.last.x, dy = ev.clientY - drag.last.y;
    const dt = Math.max(4, ev.timeStamp - drag.last.t);
    drag.last = { x: ev.clientX, y: ev.clientY, t: ev.timeStamp };
    if (!dx && !dy) continue;
    const k = gain(Math.hypot(dx, dy) / dt) / box.scale;
    if (drag.kind === 'corner') {
      const p = corners[drag.i];
      corners[drag.i] = clampPt([p[0] + dx * k, p[1] + dy * k]);
    } else {
      // Slide the whole edge along its normal
      const i = drag.i, j = (i + 1) % 4;
      const a = drag.orig[i], b = drag.orig[j];
      const len = dist(a, b) || 1;
      const n = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
      drag.d += (dx * n[0] + dy * n[1]) * k;
      corners[i] = clampPt([a[0] + n[0] * drag.d, a[1] + n[1] * drag.d]);
      corners[j] = clampPt([b[0] + n[0] * drag.d, b[1] + n[1] * drag.d]);
    }
  }
  schedule();
});

function endDrag(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  drag = null;
  hideLoupe();
  draw();
}
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);

function focusPoint() {
  if (drag.kind === 'corner') return corners[drag.i];
  return mid(corners[drag.i], corners[(drag.i + 1) % 4]);
}

/* ---------- Loupe ---------- */

function hideLoupe() { loupe.classList.remove('show'); }

function showLoupe(f) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const size = Math.round(LOUPE * dpr);
  if (loupe.width !== size) { loupe.width = size; loupe.height = size; }

  // Put it in the top corner furthest from the point being placed
  const sx = box.x + f[0] * box.scale;
  const sy = box.y + f[1] * box.scale;
  const stageW = stage.clientWidth;
  const left = sx < stageW / 2 ? stageW - LOUPE - 12 : 12;
  let top = 12;
  if (sy < LOUPE + 48 && Math.abs(sx - (left + LOUPE / 2)) < LOUPE) top = stage.clientHeight - LOUPE - 12;
  loupe.style.left = left + 'px';
  loupe.style.top = top + 'px';
  loupe.classList.add('show');

  // About 56 source pixels across at 2000px, so individual pixels show
  const span = Math.max(20, Math.max(W, H) * 0.028);
  const k = size / span;
  const ox = f[0] - span / 2, oy = f[1] - span / 2;
  const c = size / 2;

  lctx.save();
  lctx.clearRect(0, 0, size, size);
  lctx.beginPath();
  lctx.arc(c, c, c, 0, Math.PI * 2);
  lctx.clip();
  lctx.fillStyle = '#0d0f12';
  lctx.fillRect(0, 0, size, size);

  lctx.imageSmoothingEnabled = false;
  const x0 = Math.max(0, ox), y0 = Math.max(0, oy);
  const x1 = Math.min(W, ox + span), y1 = Math.min(H, oy + span);
  if (x1 > x0 && y1 > y0 && imgEl.complete && imgEl.naturalWidth) {
    lctx.drawImage(imgEl, x0, y0, x1 - x0, y1 - y0, (x0 - ox) * k, (y0 - oy) * k, (x1 - x0) * k, (y1 - y0) * k);
  }

  // The page outline, so the edges can be lined up against the paper
  lctx.strokeStyle = 'rgba(34, 184, 165, 0.95)';
  lctx.lineWidth = 2 * dpr;
  lctx.beginPath();
  corners.forEach((p, i) => {
    const X = (p[0] - ox) * k, Y = (p[1] - oy) * k;
    if (i) lctx.lineTo(X, Y); else lctx.moveTo(X, Y);
  });
  lctx.closePath();
  lctx.stroke();

  // Crosshair with a gap at the centre, so the exact pixel stays visible
  const arm = 18 * dpr, gap = 4 * dpr;
  const cross = () => {
    lctx.beginPath();
    lctx.moveTo(c - arm, c); lctx.lineTo(c - gap, c);
    lctx.moveTo(c + gap, c); lctx.lineTo(c + arm, c);
    lctx.moveTo(c, c - arm); lctx.lineTo(c, c - gap);
    lctx.moveTo(c, c + gap); lctx.lineTo(c, c + arm);
    lctx.stroke();
  };
  lctx.lineCap = 'round';
  lctx.strokeStyle = 'rgba(0,0,0,0.75)';
  lctx.lineWidth = 3.5 * dpr;
  cross();
  lctx.strokeStyle = '#fff';
  lctx.lineWidth = 1.5 * dpr;
  cross();
  lctx.restore();

  lctx.beginPath();
  lctx.arc(c, c, c - 1.5 * dpr, 0, Math.PI * 2);
  lctx.strokeStyle = '#fff';
  lctx.lineWidth = 3 * dpr;
  lctx.stroke();
}
