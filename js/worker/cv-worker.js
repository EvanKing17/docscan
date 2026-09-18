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
  small.delete();
  cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);

  const minArea = gray.cols * gray.rows * 0.2;
  let quad = null;
  const passes = [edgesAuto, edgesFixed, regionOtsu];
  for (let i = 0; i < passes.length && !quad; i++) {
    const map = passes[i](gray);
    quad = findQuad(map, minArea);
    map.delete();
  }
  gray.delete();
  if (!quad) return null;

  return orderCorners(quad).map(([x, y]) => [
    clamp(x / scale, 0, src.cols),
    clamp(y / scale, 0, src.rows),
  ]);
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

function findQuad(map, minArea) {
  const contours = new cv.MatVector();
  const hier = new cv.Mat();
  cv.findContours(map, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
  const list = [];
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    list.push({ c, area: cv.contourArea(c) });
  }
  list.sort((a, b) => b.area - a.area);

  let found = null;
  for (let i = 0; i < Math.min(list.length, 8) && !found; i++) {
    if (list[i].area < minArea * 0.8) break;
    const hull = new cv.Mat();
    cv.convexHull(list[i].c, hull, false, true);
    const peri = cv.arcLength(hull, true);
    for (const eps of [0.02, 0.03, 0.05, 0.08]) {
      const approx = new cv.Mat();
      cv.approxPolyDP(hull, approx, eps * peri, true);
      if (approx.rows === 4 && cv.isContourConvex(approx) && Math.abs(cv.contourArea(approx)) >= minArea) {
        const d = approx.data32S;
        const pts = [[d[0], d[1]], [d[2], d[3]], [d[4], d[5]], [d[6], d[7]]];
        if (minAngle(orderCorners(pts)) > 35) found = pts;
      }
      approx.delete();
      if (found) break;
    }
    hull.delete();
  }

  list.forEach(x => x.c.delete());
  contours.delete();
  hier.delete();
  return found;
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
const MAX_OUT = 2400;

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
  const f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / zz;
  const diag = Math.hypot(iw, ih);
  // Near-frontal shots make f unobservable; edge lengths are accurate there anyway
  if (!(Math.abs(zz) > 1e-12) || !(f2 > 0) || Math.sqrt(f2) < 0.3 * diag || Math.sqrt(f2) > 6 * diag) return null;

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
  cv.warpPerspective(src, out, M, new cv.Size(ow, oh), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
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
    case 'enhanced': return enhanced(rgbaMat);
    case 'gray': return grayscale(rgbaMat);
    case 'bw': return blackWhite(rgbaMat, strength);
    default: return rgbaMat;
  }
}

function enhanced(m) {
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

  rgb.convertTo(rgb, -1, 1.2, -40);

  const hsv = new cv.Mat();
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
  const hv = new cv.MatVector();
  cv.split(hsv, hv);
  const sat = hv.get(1);
  sat.convertTo(sat, -1, 1.35, 0);
  hv.set(1, sat);
  sat.delete();
  cv.merge(hv, hsv);
  hv.delete();
  cv.cvtColor(hsv, rgb, cv.COLOR_HSV2RGB);
  hsv.delete();
  return rgb;
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
  return out;
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
