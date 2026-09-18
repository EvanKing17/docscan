/*
 * Export sheet. The files are made as soon as the sheet opens (and again when the format or
 * page size changes), so Send runs straight from the tap: browsers only allow the share sheet
 * from a fresh tap, not at the end of a long build.
 */
import { session, saveMeta, defaultName } from '../store.js';
import { processPage } from '../pipeline.js';
import { buildPdf } from '../pdf.js';
import { sheet, esc, icon, toast } from '../ui.js';

const WARN_BYTES = 20 * 1024 * 1024;

function fmtSize(n) {
  return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
}

function safeName(s) {
  return (String(s).replace(/[\\/:*?"<>|]+/g, '-').trim() || defaultName()).slice(0, 120);
}

function seg(name, options, current) {
  return `<div class="seg" role="radiogroup" style="grid-template-columns:repeat(${options.length},1fr)">
    ${options.map(([v, l]) => `<label><input type="radio" name="${name}" value="${v}"${current === v ? ' checked' : ''}><span>${l}</span></label>`).join('')}
  </div>`;
}

export function openExport() {
  const n = session.pages.length;
  const d = sheet(`
    <form class="export" method="dialog">
      <div class="sheet-head">
        <div class="sheet-title">Export ${n} page${n === 1 ? '' : 's'}</div>
        <button value="" class="icon-btn" aria-label="Close">${icon('close')}</button>
      </div>
      <div class="field">
        <span>Format</span>
        ${seg('format', [['pdf', 'PDF'], ['images', 'Images (JPG)']], session.exportFormat || 'pdf')}
      </div>
      <label class="field">
        <span>File name</span>
        <input name="filename" value="${esc(session.name || defaultName())}" autocomplete="off" enterkeyhint="done">
      </label>
      <div class="field size-field">
        <span>Page size</span>
        ${seg('size', [['auto', 'Auto'], ['letter', 'Letter'], ['a4', 'A4']], session.pageSize)}
        <small class="hint">Auto uses Letter or A4 when the page is that shape, otherwise the page's own size.</small>
      </div>

      <div class="export-status">
        <div class="progress"><i></i></div>
        <span class="progress-msg">Preparing</span>
      </div>
      <div class="result-file" hidden></div>
      <p class="warn" hidden></p>

      <div class="result-actions">
        <button type="button" class="btn primary wide send" data-act="send" disabled>${icon('share')}<span>Send<small>Email, text, Drive and more</small></span></button>
        <button type="button" class="btn wide" data-act="save" disabled>${icon('download')}<span>Save to device</span></button>
        <p class="hint no-share" hidden>This browser can't hand files to other apps. Save them, then attach from your files.</p>
      </div>
    </form>`);

  const form = d.querySelector('form');
  const f = form.elements;
  const status = d.querySelector('.export-status');
  const bar = status.querySelector('i');
  const msg = status.querySelector('.progress-msg');
  const fileEl = d.querySelector('.result-file');
  const warnEl = d.querySelector('.warn');
  const sendBtn = d.querySelector('[data-act="send"]');
  const saveBtn = d.querySelector('[data-act="save"]');
  const noShare = d.querySelector('.no-share');
  const sizeField = d.querySelector('.size-field');

  let build = 0;
  let ready = null;   // { format, blobs }
  let open = true;
  d.addEventListener('close', () => { open = false; build++; });

  const format = () => f.format.value || 'pdf';
  const baseName = () => safeName(f.filename.value);

  function files() {
    const name = baseName();
    if (ready.format === 'pdf') return [new File([ready.blobs[0]], name + '.pdf', { type: 'application/pdf' })];
    const many = ready.blobs.length > 1;
    return ready.blobs.map((b, i) => {
      const ext = b.type === 'image/png' ? 'png' : 'jpg';
      return new File([b], `${name}${many ? ` (${i + 1})` : ''}.${ext}`, { type: b.type });
    });
  }

  function showReady() {
    const list = files();
    const total = list.reduce((s, x) => s + x.size, 0);
    fileEl.innerHTML = `${icon(ready.format === 'pdf' ? 'pdf' : 'images')}<div><b>${esc(list.length === 1 ? list[0].name : `${list.length} images`)}</b><small>${fmtSize(total)}</small></div>`;
    fileEl.hidden = false;
    status.hidden = true;
    warnEl.hidden = !(ready.format === 'pdf' && total > WARN_BYTES);
    warnEl.textContent = "This PDF is over 20 MB. Some email services won't accept it; try fewer pages or the B&W filter.";
    const canShare = !!(navigator.canShare && navigator.canShare({ files: list }));
    sendBtn.hidden = !canShare;
    noShare.hidden = canShare;
    sendBtn.disabled = false;
    saveBtn.disabled = false;
    saveBtn.classList.toggle('primary', !canShare);
  }

  async function prepare() {
    const my = ++build;
    ready = null;
    sendBtn.disabled = true;
    saveBtn.disabled = true;
    fileEl.hidden = true;
    warnEl.hidden = true;
    status.hidden = false;
    sizeField.hidden = format() !== 'pdf';

    const pages = session.pages.slice();
    const fmt = format();
    const steps = fmt === 'pdf' ? pages.length * 2 : pages.length;
    const set = (done, text) => { bar.style.width = Math.round(done / steps * 100) + '%'; msg.textContent = text; };
    try {
      for (let i = 0; i < pages.length; i++) {
        set(i, `Preparing page ${i + 1} of ${pages.length}`);
        await processPage(pages[i]);
        if (my !== build) return;
      }
      let blobs;
      if (fmt === 'pdf') {
        const pdf = await buildPdf(pages, { pageSize: session.pageSize, title: baseName() },
          (i, of) => { if (my === build) set(pages.length + i, `Adding page ${i} of ${of}`); });
        blobs = [pdf];
      } else {
        blobs = pages.map(p => p.processedBlob);
      }
      if (my !== build) return;
      ready = { format: fmt, blobs };
      showReady();
    } catch (err) {
      if (my !== build || !open) return;
      console.error(err);
      msg.textContent = "Couldn't prepare the files: " + err.message;
    }
  }

  form.addEventListener('change', e => {
    if (e.target.name === 'format') {
      session.exportFormat = format();
      saveMeta();
      prepare();
    } else if (e.target.name === 'size') {
      session.pageSize = f.size.value || 'auto';
      saveMeta();
      if (format() === 'pdf') prepare();
    }
  });

  f.filename.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); f.filename.blur(); } });
  f.filename.addEventListener('input', () => {
    session.name = baseName();
    saveMeta();
    if (ready) showReady();
  });

  sendBtn.addEventListener('click', async () => {
    if (!ready) return;
    const list = files();
    try {
      await navigator.share({ files: list, title: baseName() });
    } catch (err) {
      if (err.name !== 'AbortError') toast("Couldn't send: " + err.message, { duration: 4000 });
    }
  });

  saveBtn.addEventListener('click', async () => {
    if (!ready) return;
    const list = files();
    for (let i = 0; i < list.length; i++) {
      const url = URL.createObjectURL(list[i]);
      const a = document.createElement('a');
      a.href = url;
      a.download = list[i].name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      // Browsers drop downloads fired in the same instant
      if (i < list.length - 1) await new Promise(r => setTimeout(r, 400));
    }
  });

  prepare();
}
