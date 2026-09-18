/* PDF assembly with pdf-lib, one image per page. */

let libPromise = null;

function loadPdfLib() {
  if (window.PDFLib) return Promise.resolve(window.PDFLib);
  if (!libPromise) {
    libPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/pdf-lib.min.js';
      s.onload = () => resolve(window.PDFLib);
      s.onerror = () => { libPromise = null; reject(new Error('Could not load the PDF library')); };
      document.head.appendChild(s);
    });
  }
  return libPromise;
}

const LETTER = [612, 792];
const A4 = [595.28, 841.89];
const AUTO_DPI = 150;

function sizeFor(iw, ih, pageSize) {
  const portrait = ih >= iw;
  const orient = ([a, b]) => (portrait ? [a, b] : [b, a]);
  if (pageSize === 'letter') return orient(LETTER);
  if (pageSize === 'a4') return orient(A4);
  // Auto: a page that is Letter- or A4-shaped (the warp snaps to those) gets that paper size
  const r = Math.min(iw, ih) / Math.max(iw, ih);
  if (Math.abs(r - LETTER[0] / LETTER[1]) < 0.01) return orient(LETTER);
  if (Math.abs(r - A4[0] / A4[1]) < 0.01) return orient(A4);
  return [iw * 72 / AUTO_DPI, ih * 72 / AUTO_DPI];
}

export async function buildPdf(pages, { pageSize, title }, onProgress) {
  const { PDFDocument } = await loadPdfLib();
  const doc = await PDFDocument.create();
  doc.setTitle(title || 'Scan');
  doc.setCreator('DocScan');
  doc.setProducer('DocScan');

  for (let i = 0; i < pages.length; i++) {
    const blob = pages[i].processedBlob;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const img = blob.type === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    const [pw, ph] = sizeFor(img.width, img.height, pageSize);
    const page = doc.addPage([pw, ph]);

    // Same shape as the paper (within 3%): fill it edge to edge. Otherwise fit inside a margin.
    const close = Math.abs((img.width / img.height) / (pw / ph) - 1) < 0.03;
    if (close) {
      page.drawImage(img, { x: 0, y: 0, width: pw, height: ph });
    } else {
      const m = 18;
      const s = Math.min((pw - 2 * m) / img.width, (ph - 2 * m) / img.height);
      const w = img.width * s, h = img.height * s;
      page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
    }
    onProgress && onProgress(i + 1, pages.length);
  }

  const out = await doc.save();
  return new Blob([out], { type: 'application/pdf' });
}
