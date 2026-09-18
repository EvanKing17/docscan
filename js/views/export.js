/* Export sheet: name, page size, build, then Share or Save. */
import { session, saveMeta, defaultName } from '../store.js';
import { processPage } from '../pipeline.js';
import { buildPdf } from '../pdf.js';
import { sheet, esc, icon, toast } from '../ui.js';

const WARN_BYTES = 20 * 1024 * 1024;

function fmtSize(n) {
  return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
}

function safeName(s) {
  return (s.replace(/[\\/:*?"<>|]+/g, '-').trim() || defaultName()).slice(0, 120);
}

export function openExport() {
  const n = session.pages.length;
  const sizes = [['auto', 'Auto'], ['letter', 'Letter'], ['a4', 'A4']];
  const d = sheet(`
    <form class="export" method="dialog">
      <div class="sheet-head">
        <div class="sheet-title">Export PDF</div>
        <button value="" class="icon-btn" aria-label="Close">${icon('close')}</button>
      </div>
      <label class="field">
        <span>File name</span>
        <input name="filename" value="${esc(session.name || defaultName())}" autocomplete="off" enterkeyhint="done">
      </label>
      <div class="field">
        <span>Page size</span>
        <div class="seg" role="radiogroup">
          ${sizes.map(([v, l]) => `<label><input type="radio" name="size" value="${v}"${session.pageSize === v ? ' checked' : ''}><span>${l}</span></label>`).join('')}
        </div>
        <small class="hint">Auto uses Letter or A4 when the page is that shape, otherwise the page's own size.</small>
      </div>
      <div class="export-progress" hidden>
        <div class="progress"><i></i></div>
        <span class="progress-msg"></span>
      </div>
      <div class="export-result" hidden></div>
      <div class="sheet-actions">
        <button type="button" class="btn primary wide" data-act="make">${icon('pdf')}<span>Create PDF · ${n} page${n === 1 ? '' : 's'}</span></button>
      </div>
    </form>`);

  const form = d.querySelector('form');
  const makeBtn = d.querySelector('[data-act="make"]');
  const prog = d.querySelector('.export-progress');
  const bar = prog.querySelector('i');
  const msg = prog.querySelector('.progress-msg');
  const result = d.querySelector('.export-result');
  let objectUrl = null;

  d.addEventListener('close', () => {
    if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
  });

  form.elements.filename.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); form.elements.filename.blur(); } });
  form.addEventListener('change', () => { result.hidden = true; makeBtn.hidden = false; });

  makeBtn.addEventListener('click', async () => {
    const name = safeName(form.elements.filename.value);
    session.name = name;
    session.pageSize = form.elements.size.value || 'auto';
    saveMeta();

    makeBtn.disabled = true;
    result.hidden = true;
    prog.hidden = false;
    const pages = session.pages.slice();
    const total = pages.length * 2;
    const set = (done, text) => { bar.style.width = Math.round(done / total * 100) + '%'; msg.textContent = text; };

    try {
      for (let i = 0; i < pages.length; i++) {
        set(i, `Preparing page ${i + 1} of ${pages.length}`);
        await processPage(pages[i]);
      }
      const blob = await buildPdf(pages, { pageSize: session.pageSize, title: name }, (i, of) => set(pages.length + i, `Adding page ${i} of ${of}`));
      set(total, 'Done');
      const filename = name + '.pdf';
      const file = new File([blob], filename, { type: 'application/pdf' });
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(blob);
      showResult(file, filename);
    } catch (err) {
      console.error(err);
      toast("Couldn't make the PDF: " + err.message, { duration: 5000 });
    } finally {
      makeBtn.disabled = false;
      prog.hidden = true;
    }
  });

  function showResult(file, filename) {
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
    result.innerHTML = `
      <div class="result-file">${icon('pdf')}<div><b>${esc(filename)}</b><small>${fmtSize(file.size)}</small></div></div>
      ${file.size > WARN_BYTES ? '<p class="warn">This file is over 20 MB. Some email services won\'t accept it; try fewer pages or the B&W filter.</p>' : ''}
      <div class="result-actions">
        ${canShare ? `<button type="button" class="btn primary wide" data-act="share">${icon('share')}<span>Share</span></button>` : ''}
        <a class="btn wide${canShare ? '' : ' primary'}" href="${objectUrl}" download="${esc(filename)}">${icon('download')}<span>Save to device</span></a>
      </div>`;
    result.hidden = false;
    makeBtn.hidden = true;
    const shareBtn = result.querySelector('[data-act="share"]');
    if (shareBtn) {
      shareBtn.addEventListener('click', async () => {
        try {
          await navigator.share({ files: [file], title: filename });
        } catch (err) {
          if (err.name !== 'AbortError') toast("Couldn't share: " + err.message);
        }
      });
    }
  }
}
