/*
 * OpenCV worker. Holds one source image at a time and runs detection, warp and filters on it,
 * so the UI thread never blocks on WASM.
 *
 * Classic worker: opencv.js is UMD and has to come in through importScripts. The main thread
 * fetches opencv.js itself (so it goes through the service worker and the progress can be shown)
 * and passes a blob URL.
 *
 * Messages in:  { id, type, ...payload }
 * Messages out: { id, ...result } or { id, error }
 */
'use strict';

let cv = null;
let src = null;      // CV_8UC4, the page's downscaled original
let srcKey = null;

self.onmessage = e => {
  const msg = e.data;
  Promise.resolve()
    .then(() => handle(msg))
    .then(res => {
      const transfer = res && res.buffer ? [res.buffer] : [];
      self.postMessage(Object.assign({ id: msg.id }, res), transfer);
    })
    .catch(err => self.postMessage({ id: msg.id, error: describe(err) }));
};

function describe(err) {
  if (typeof err === 'number' && cv && cv.exceptionFromPtr) {
    try { return cv.exceptionFromPtr(err).msg; } catch (_) { /* fall through */ }
  }
  return String((err && err.message) || err);
}

function handle(msg) {
  switch (msg.type) {
    case 'init': return init(msg.url);
    case 'source': return setSource(msg);
    case 'detect': return { corners: detect() };
    case 'render': return render(msg);
    default: throw new Error('Unknown message ' + msg.type);
  }
}

function init(url) {
  if (cv) return {};
  return new Promise((resolve, reject) => {
    self.Module = {
      onRuntimeInitialized() {
        cv = self.Module.Mat ? self.Module : self.cv;
        if (!cv || !cv.Mat) reject(new Error('OpenCV loaded without its API'));
        else resolve({});
      },
      onAbort: reason => reject(new Error('OpenCV aborted: ' + reason)),
    };
    try {
      importScripts(url);
    } catch (err) {
      reject(err);
      return;
    }
    // Older builds finish synchronously and never call onRuntimeInitialized
    if (self.cv && self.cv.Mat && typeof self.cv.then !== 'function') {
      cv = self.cv;
      resolve({});
    }
  });
}

function setSource({ key, w, h, buffer }) {
  if (src) src.delete();
  src = cv.matFromImageData({ data: new Uint8ClampedArray(buffer), width: w, height: h });
  srcKey = key;
  return { key: srcKey };
}

/* ---------- Detection ---------- */

function detect() {
  if (!src) throw new Error('No source image');
  const scale = Math.min(1, 500 / Math.max(src.cols, src.rows));
  const small = new cv.Mat();
  cv.resize(src, small, new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)), 0, 0, cv.INTER_AREA);
  const gray = new cv.Mat();
  cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);

  // Every pass proposes quads; each is scored on whether all four sides sit on a real edge
  // with a change in brightness across it, and the best one wins. Taking the first convex
  // quad found picked up outlines that merged the page with things on the desk.
  const minArea = gray.cols * gray.rows * 0.2;
  const scoreEdges = edgesAuto(gray);
  const cands = [];
  const maps = [
    () => edgesAuto(gray),
    () => edgesFixed(gray),
    () => regionOtsu(gray),
    () => regionOtsu(whiteness(small)),
  ];
  for (const make of maps) {
    const map = make();
    collectQuads(map, minArea, cands);
    map.delete();
  }
  small.delete();

  const G = { d: gray.data, w: gray.cols, h: gray.rows };
  const E = { d: scoreEdges.data, w: scoreEdges.cols, h: scoreEdges.rows };
  let best = null;
  for (const q of cands) {
    const s = scoreQuad(q, G, E);
    if (!best || s > best.s) best = { q, s };
  }
  gray.delete();
  scoreEdges.delete();
  if (!best || best.s < 0.3) return null;

  const coarse = best.q.map(([x, y]) => [x / scale, y / scale]);
  const refined = refineCorners(coarse);
  return refined.map(([x, y]) => [clamp(x, 0, src.cols), clamp(y, 0, src.rows)]);
}

// Min of R, G, B: high for white paper, low for wood, carpet and most coloured surfaces
function whiteness(rgba) {
  const chans = new cv.MatVector();
  cv.split(rgba, chans);
  const r = chans.get(0), g = chans.get(1), b = chans.get(2);
  const out = new cv.Mat();
  cv.min(r, g, out);
  cv.min(out, b, out);
  cv.GaussianBlur(out, out, new cv.Size(5, 5), 0);
  r.delete(); g.delete(); b.delete(); chans.delete();
  return out;
}

function collectQuads(map, minArea, out) {
  const contours = new cv.MatVector();
  const hier = new cv.Mat();
  cv.findContours(map, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
  const list = [];
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const area = cv.contourArea(c);
    if (area >= minArea * 0.8) list.push({ c, area }); else c.delete();
  }
  list.sort((a, b) => b.area - a.area);

  const tryApprox = shape => {
    const peri = cv.arcLength(shape, true);
    for (const eps of [0.015, 0.02, 0.03, 0.045, 0.07]) {
      const approx = new cv.Mat();
      cv.approxPolyDP(shape, approx, eps * peri, true);
      let pts = null;
      if (approx.rows === 4 && cv.isContourConvex(approx) && Math.abs(cv.contourArea(approx)) >= minArea) {
        const d = approx.data32S;
        pts = orderCorners([[d[0], d[1]], [d[2], d[3]], [d[4], d[5]], [d[6], d[7]]]);
        if (minAngle(pts) < 35) pts = null;
      }
      approx.delete();
      if (pts) { out.push(pts); return; }
    }
  };

  list.slice(0, 10).forEach(({ c }) => {
    tryApprox(c);
    const hull = new cv.Mat();
    cv.convexHull(c, hull, false, true);
    tryApprox(hull);
    hull.delete();
  });

  list.forEach(x => x.c.delete());
  contours.delete();
  hier.delete();
}

function px(img, x, y) {
  const xi = Math.max(0, Math.min(img.w - 1, Math.round(x)));
  const yi = Math.max(0, Math.min(img.h - 1, Math.round(y)));
  return img.d[yi * img.w + xi];
}

/*
 * 0..1. Per side: the share of sample points lying on an edge pixel, and the share with a
 * clear brightness difference just inside vs just outside. The weakest side dominates, so a
 * quad with one side running through empty table scores low.
 */
function scoreQuad(q, G, E) {
  const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4;
  const cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
  const sides = [];
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const dx = (b[0] - a[0]) / len, dy = (b[1] - a[1]) / len;
    let nx = -dy, ny = dx;
    if (nx * (cx - (a[0] + b[0]) / 2) + ny * (cy - (a[1] + b[1]) / 2) < 0) { nx = -nx; ny = -ny; }
    // A page running off the photo has a side along the frame with nothing to measure
    const onBorder = (p, q2) => (p[0] < 4 && q2[0] < 4) || (p[1] < 4 && q2[1] < 4) ||
      (p[0] > G.w - 5 && q2[0] > G.w - 5) || (p[1] > G.h - 5 && q2[1] > G.h - 5);
    if (onBorder(a, b)) { sides.push(0.6); continue; }
    const N = 40, off = 5;
    let onEdge = 0, contrast = 0;
    for (let k = 0; k < N; k++) {
      const t = 0.1 + 0.8 * k / (N - 1);
      const x = a[0] + dx * len * t, y = a[1] + dy * len * t;
      let hit = false;
      for (let s = -2; s <= 2 && !hit; s++) if (px(E, x + nx * s, y + ny * s)) hit = true;
      if (hit) onEdge++;
      const inside = px(G, x + nx * off, y + ny * off);
      const outside = px(G, x - nx * off, y - ny * off);
      if (Math.abs(inside - outside) > 18) contrast++;
    }
    sides.push(0.5 * onEdge / N + 0.5 * contrast / N);
  }
  const min = Math.min(...sides);
  const mean = sides.reduce((s, v) => s + v, 0) / 4;
  const area = Math.abs(q.reduce((s, p, i) => {
    const r = q[(i + 1) % 4];
    return s + p[0] * r[1] - r[0] * p[1];
  }, 0)) / 2 / (G.w * G.h);
  return 0.65 * min + 0.25 * mean + 0.1 * area;
}

/*
 * The coarse corners come from a 500px copy, so they can be several pixels off at full size.
 * Along each side, find the paper's border on the full-resolution image (the outermost strong
 * brightness step across the side), fit a straight line through those points, and take the
 * corners as the intersections of neighbouring lines.
 */
function refineCorners(c) {
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, gray, new cv.Size(3, 3), 0);
  const G = { d: gray.data, w: gray.cols, h: gray.rows };

  const sample = (x, y) => {
    x = Math.max(0, Math.min(G.w - 1.001, x));
    y = Math.max(0, Math.min(G.h - 1.001, y));
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const i = y0 * G.w + x0;
    return (G.d[i] * (1 - fx) + G.d[i + 1] * fx) * (1 - fy) + (G.d[i + G.w] * (1 - fx) + G.d[i + G.w + 1] * fx) * fy;
  };

  const cx = (c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4;
  const cy = (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4;
  const lines = [];
  let maxR = 0;

  for (let i = 0; i < 4; i++) {
    const a = c[i], b = c[(i + 1) % 4];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const dx = (b[0] - a[0]) / len, dy = (b[1] - a[1]) / len;
    let nx = -dy, ny = dx;
    if (nx * (cx - (a[0] + b[0]) / 2) + ny * (cy - (a[1] + b[1]) / 2) < 0) { nx = -nx; ny = -ny; }
    const R = Math.round(clamp(len * 0.02, 10, 30));
    maxR = Math.max(maxR, R);

    const pts = [];
    const N = 48;
    for (let k = 0; k < N; k++) {
      const t = 0.08 + 0.84 * k / (N - 1);
      const x = a[0] + dx * len * t, y = a[1] + dy * len * t;
      // Profile from outside (-R) to inside (+R)
      const prof = [];
      for (let s = -R; s <= R; s++) prof.push(sample(x + nx * s, y + ny * s));
      const d = [];
      let maxAbs = 0;
      for (let j = 1; j < prof.length - 1; j++) {
        d[j] = prof[j + 1] - prof[j - 1];
        maxAbs = Math.max(maxAbs, Math.abs(d[j]));
      }
      if (maxAbs < 12) continue;
      let j = 1;
      while (j < prof.length - 1 && Math.abs(d[j]) < 0.6 * maxAbs) j++;
      while (j + 1 < prof.length - 1 && Math.abs(d[j + 1]) > Math.abs(d[j])) j++;
      let sub = 0;
      if (j > 1 && j + 1 < prof.length - 1) {
        const l = Math.abs(d[j - 1]), m = Math.abs(d[j]), r = Math.abs(d[j + 1]);
        const den = l - 2 * m + r;
        if (den < 0) sub = clamp(0.5 * (l - r) / den, -0.5, 0.5);
      }
      const s = j - R + sub;
      pts.push([x + nx * s, y + ny * s]);
    }

    let line = pts.length >= 12 ? fitLine(pts) : null;
    if (line) {
      // Drop points far from the first fit (text, table rules, a shadow) and fit again
      const res = pts.map(p => Math.abs((p[0] - line.x) * line.nx + (p[1] - line.y) * line.ny));
      const med = res.slice().sort((u, v) => u - v)[res.length >> 1];
      const keep = pts.filter((p, k) => res[k] <= Math.max(1.5, 2.5 * med));
      line = keep.length >= 10 ? fitLine(keep) : line;
    }
    lines.push(line || fitLine([a, b]));
  }
  gray.delete();

  const out = [];
  for (let i = 0; i < 4; i++) {
    const p = intersect(lines[(i + 3) % 4], lines[i]);
    out.push(p && Math.hypot(p[0] - c[i][0], p[1] - c[i][1]) < maxR * 2.5 ? p : c[i]);
  }
  return out;
}

// Total least squares: a point on the line and the unit normal
function fitLine(pts) {
  const n = pts.length;
  let mx = 0, my = 0;
  pts.forEach(p => { mx += p[0]; my += p[1]; });
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  pts.forEach(p => {
    const u = p[0] - mx, v = p[1] - my;
    sxx += u * u; syy += v * v; sxy += u * v;
  });
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);   // direction of the line
  return { x: mx, y: my, nx: -Math.sin(theta), ny: Math.cos(theta) };
}

function intersect(l1, l2) {
  // n1.p = c1, n2.p = c2
  const c1 = l1.nx * l1.x + l1.ny * l1.y;
  const c2 = l2.nx * l2.x + l2.ny * l2.y;
  const det = l1.nx * l2.ny - l1.ny * l2.nx;
  if (Math.abs(det) < 1e-9) return null;
  return [(c1 * l2.ny - l1.ny * c2) / det, (l1.nx * c2 - c1 * l2.nx) / det];
}

function median(mat) {
  const hist = new Uint32Array(256);
  const d = mat.data;
  for (let i = 0; i < d.length; i++) hist[d[i]]++;
  let acc = 0;
  const half = d.length / 2;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= half) return v;
  }
  return 128;
}

function dilated(edges) {
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  cv.dilate(edges, edges, k);
  k.delete();
  return edges;
}

function edgesAuto(gray) {
  const m = median(gray);
  const edges = new cv.Mat();
  cv.Canny(gray, edges, Math.max(0, 0.66 * m), Math.min(255, 1.33 * m));
  return dilated(edges);
}

function edgesFixed(gray) {
  const edges = new cv.Mat();
  cv.Canny(gray, edges, 30, 100);
  return dilated(edges);
}

function regionOtsu(gray) {
  const bin = new cv.Mat();
  cv.threshold(gray, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
  cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, k);
  k.delete();
  return bin;
}

// TL, TR, BR, BL: sort by angle around the centroid, then start at the smallest x+y
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

function minAngle(q) {
  let min = 180;
  for (let i = 0; i < 4; i++) {
    const p = q[i], a = q[(i + 3) % 4], b = q[(i + 1) % 4];
    const v1 = [a[0] - p[0], a[1] - p[1]], v2 = [b[0] - p[0], b[1] - p[1]];
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(v1[0], v1[1]) * Math.hypot(v2[0], v2[1]) || 1);
    min = Math.min(min, Math.acos(clamp(cos, -1, 1)) * 180 / Math.PI);
  }
  return min;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/* ---------- Output size ---------- */

/*
 * Width/height of the flattened page. Edge lengths alone under-report the side that recedes
 * from the camera, so the real aspect ratio is recovered from the perspective of the quad
 * (Zhang & He, "Whiteboard scanning and image enhancement", 2007), assuming the principal
 * point is the image centre. Ratios within 4% of Letter or A4 are snapped to it.
 */
const PAPER = [8.5 / 11, 210 / 297];
const MAX_OUT = 3000;   // about 270 DPI on a Letter page

function outputSize(c, iw, ih) {
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const [tl, tr, br, bl] = c;
  let W = Math.max(d(tl, tr), d(bl, br));
  let H = Math.max(d(tl, bl), d(tr, br));

  const r = trueAspect(c, iw, ih);
  if (r) {
    const width = Math.max(W, H * r);
    W = width;
    H = width / r;
  }

  const short = Math.min(W, H), long = Math.max(W, H);
  for (const p of PAPER) {
    if (Math.abs(short / long - p) / p < 0.04) {
      if (W < H) W = H * p; else H = W * p;
      break;
    }
  }

  const s = Math.min(1, MAX_OUT / Math.max(W, H));
  return { w: Math.max(1, Math.round(W * s)), h: Math.max(1, Math.round(H * s)) };
}

// Angle in degrees between segment a1-a2 and segment b1-b2
function sideAngle(a1, a2, b1, b2) {
  const u = Math.atan2(a2[1] - a1[1], a2[0] - a1[0]);
  const v = Math.atan2(b2[1] - b1[1], b2[0] - b1[0]);
  let d = Math.abs(u - v) * 180 / Math.PI % 180;
  return Math.min(d, 180 - d);
}

function trueAspect(c, iw, ih) {
  const u0 = iw / 2, v0 = ih / 2;
  const P = p => [p[0] - u0, p[1] - v0, 1];
  const m1 = P(c[0]), m2 = P(c[1]), m4 = P(c[2]), m3 = P(c[3]);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3);
  const k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
  if (!isFinite(k2) || !isFinite(k3)) return null;
  const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];

  const zz = n2[2] * n3[2];
  const diag = Math.hypot(iw, ih);
  let f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / zz;
  // When one pair of sides looks parallel (phone square to the page, just tilted), the focal
  // length can't be recovered from the quad. Use a typical phone main camera instead:
  // 26mm-equivalent, about 0.6 x the image diagonal.
  // The estimate is only stable when both pairs of opposite sides clearly converge.
  const conv = Math.min(sideAngle(c[0], c[1], c[3], c[2]), sideAngle(c[0], c[3], c[1], c[2]));
  if (conv < 8 || !(Math.abs(zz) > 1e-12) || !(f2 > 0) || Math.sqrt(f2) < 0.4 * diag || Math.sqrt(f2) > 2.5 * diag) {
    f2 = Math.pow(0.6 * diag, 2);
  }

  const r = Math.sqrt(
    (n2[0] * n2[0] / f2 + n2[1] * n2[1] / f2 + n2[2] * n2[2]) /
    (n3[0] * n3[0] / f2 + n3[1] * n3[1] / f2 + n3[2] * n3[2]));
  return isFinite(r) && r > 0.2 && r < 5 ? r : null;
}

/* ---------- Render ---------- */

function render({ corners, filter, rotation, maxDim, strength }) {
  if (!src) throw new Error('No source image');
  const full = outputSize(corners, src.cols, src.rows);
  let ow = full.w, oh = full.h;
  let finalW = ow, finalH = oh;
  if (maxDim && Math.max(ow, oh) > maxDim) {
    const s = maxDim / Math.max(ow, oh);
    finalW = Math.max(1, Math.round(ow * s));
    finalH = Math.max(1, Math.round(oh * s));
    // Warp at twice the target, then area-resize, so small previews don't alias
    const s2 = Math.min(1, (maxDim * 2) / Math.max(ow, oh));
    ow = Math.max(1, Math.round(ow * s2));
    oh = Math.max(1, Math.round(oh * s2));
  }

  const flat = corners.flat();
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, flat);
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, ow, 0, ow, oh, 0, oh]);
  const M = cv.getPerspectiveTransform(from, to);
  let out = new cv.Mat();
  cv.warpPerspective(src, out, M, new cv.Size(ow, oh), cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
  from.delete(); to.delete(); M.delete();

  if (ow !== finalW || oh !== finalH) {
    const r = new cv.Mat();
    cv.resize(out, r, new cv.Size(finalW, finalH), 0, 0, cv.INTER_AREA);
    out.delete();
    out = r;
  }

  const filtered = applyFilter(out, filter, strength);
  if (filtered !== out) out.delete();
  const rotated = rotate(filtered, rotation);
  if (rotated !== filtered) filtered.delete();

  const rgba = new cv.Mat();
  const code = rotated.channels() === 1 ? cv.COLOR_GRAY2RGBA : rotated.channels() === 3 ? cv.COLOR_RGB2RGBA : -1;
  if (code >= 0) cv.cvtColor(rotated, rgba, code); else rotated.copyTo(rgba);
  rotated.delete();

  const data = new Uint8ClampedArray(rgba.data);
  const res = { w: rgba.cols, h: rgba.rows, buffer: data.buffer };
  rgba.delete();
  return res;
}

function rotate(m, deg) {
  deg = ((deg || 0) % 360 + 360) % 360;
  if (!deg) return m;
  const out = new cv.Mat();
  if (deg === 180) {
    cv.flip(m, out, -1);
    return out;
  }
  const t = new cv.Mat();
  cv.transpose(m, t);
  cv.flip(t, out, deg === 90 ? 1 : 0);
  t.delete();
  return out;
}

/* ---------- Filters ---------- */

// Paper brightness at each pixel: close away the ink at low resolution, then smooth
function background(ch) {
  const s = Math.min(1, 400 / Math.max(ch.cols, ch.rows));
  const small = new cv.Mat();
  cv.resize(ch, small, new cv.Size(Math.max(1, Math.round(ch.cols * s)), Math.max(1, Math.round(ch.rows * s))), 0, 0, cv.INTER_AREA);
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
  cv.dilate(small, small, k);
  k.delete();
  cv.medianBlur(small, small, 15);
  const bg = new cv.Mat();
  cv.resize(small, bg, new cv.Size(ch.cols, ch.rows), 0, 0, cv.INTER_LINEAR);
  small.delete();
  return bg;
}

// Divide out the lighting so paper goes white and shadows disappear
function flatten(ch) {
  const bg = background(ch);
  const out = new cv.Mat();
  cv.divide(ch, bg, out, 255);
  bg.delete();
  return out;
}

function applyFilter(rgbaMat, filter, strength) {
  switch (filter) {
    case 'enhanced': return enhanced(rgbaMat, 1.2, -40, 1.35, 0.6);
    case 'contrast': return enhanced(rgbaMat, 1.5, -100, 1.5, 0.9);
    case 'gray': return grayscale(rgbaMat);
    case 'bw': return blackWhite(rgbaMat, strength);
    default: return rgbaMat;
  }
}

// Colour kept, lighting flattened, then contrast (alpha, beta), saturation and sharpening
function enhanced(m, alpha, beta, satGain, sharp) {
  const rgb = new cv.Mat();
  cv.cvtColor(m, rgb, cv.COLOR_RGBA2RGB);
  const chans = new cv.MatVector();
  cv.split(rgb, chans);
  const flatChans = new cv.MatVector();
  for (let i = 0; i < 3; i++) {
    const c = chans.get(i);
    const f = flatten(c);
    flatChans.push_back(f);
    c.delete();
    f.delete();
  }
  cv.merge(flatChans, rgb);
  chans.delete();
  flatChans.delete();

  rgb.convertTo(rgb, -1, alpha, beta);

  const hsv = new cv.Mat();
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
  const hv = new cv.MatVector();
  cv.split(hsv, hv);
  const sat = hv.get(1);
  sat.convertTo(sat, -1, satGain, 0);
  hv.set(1, sat);
  sat.delete();
  cv.merge(hv, hsv);
  hv.delete();
  cv.cvtColor(hsv, rgb, cv.COLOR_HSV2RGB);
  hsv.delete();
  return sharpen(rgb, sharp);
}

// Unsharp mask; the radius follows the page size so previews and full pages look alike
function sharpen(m, amount) {
  if (!amount) return m;
  const sigma = Math.max(0.8, Math.max(m.cols, m.rows) / 2200);
  const blur = new cv.Mat();
  cv.GaussianBlur(m, blur, new cv.Size(0, 0), sigma);
  const out = new cv.Mat();
  cv.addWeighted(m, 1 + amount, blur, -amount, 0, out);
  blur.delete();
  m.delete();
  return out;
}

function grayscale(m) {
  const g = new cv.Mat();
  cv.cvtColor(m, g, cv.COLOR_RGBA2GRAY);
  const f = flatten(g);
  g.delete();
  const clahe = new cv.CLAHE(1.2, new cv.Size(8, 8));
  const out = new cv.Mat();
  clahe.apply(f, out);
  clahe.delete();
  f.delete();
  out.convertTo(out, -1, 1.15, -25);
  return sharpen(out, 0.6);
}

function blackWhite(m, strength) {
  const g = new cv.Mat();
  cv.cvtColor(m, g, cv.COLOR_RGBA2GRAY);
  const f = flatten(g);
  g.delete();
  cv.GaussianBlur(f, f, new cv.Size(3, 3), 0);
  const long = Math.max(f.cols, f.rows);
  let block = Math.round(long / 65) | 1;
  block = Math.max(11, Math.min(51, block));
  const C = 8 + (strength == null ? 4 : strength);
  const out = new cv.Mat();
  cv.adaptiveThreshold(f, out, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, block, C);
  f.delete();
  return out;
}
