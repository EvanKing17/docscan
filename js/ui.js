/* Toasts, confirm dialogs and action sheets. */

const ICONS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  camera: '<path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.3l1.6-2.2h7.2L17.2 7h2.3A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/><circle cx="12" cy="13" r="3.6"/>',
  images: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="M21 15.5l-5-5-9.5 9"/>',
  pdf: '<path d="M6 3h8.5L19 7.5V21H6z"/><path d="M14 3v5h5"/><path d="M9.5 13.5h6M9.5 17h4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M9 7V4.5h6V7M6 7l1 13h10l1-13"/>',
  rotR: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4v4.5H15"/>',
  rotL: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4v4.5H9"/>',
  crop: '<path d="M7 2.5V17h14.5"/><path d="M2.5 7H17v14.5"/>',
  more: '<circle cx="5.5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18.5" cy="12" r="1.4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  auto: '<path d="M4 20L15 9"/><path d="M13 7l4 4"/><path d="M18 3v3M16.5 4.5h3M6 4v2M5 5h2M19.5 14v2M18.5 15h2"/>',
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  share: '<path d="M12 3v12M7.5 7.5L12 3l4.5 4.5"/><path d="M5 12v7.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V12"/>',
  download: '<path d="M12 3v12M7.5 10.5L12 15l4.5-4.5"/><path d="M4.5 19.5h15"/>',
  left: '<path d="M14 6l-6 6 6 6"/>',
  right: '<path d="M10 6l6 6-6 6"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
};

export function icon(name) {
  return `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

export function fillIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    if (!el.querySelector('svg.i')) el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
  });
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- Toast ---------- */

let toastTimer = null;
let toastEl = null;

export function toast(message, opts = {}) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.setAttribute('role', 'status');
    document.body.appendChild(toastEl);
  }
  clearTimeout(toastTimer);
  const prevExpire = toastEl._onExpire;
  toastEl._onExpire = null;
  if (prevExpire) prevExpire();

  toastEl.innerHTML = `<span>${esc(message)}</span>` +
    (opts.action ? `<button type="button">${esc(opts.action)}</button>` : '');
  toastEl._onExpire = opts.onExpire || null;
  if (opts.action) {
    toastEl.querySelector('button').onclick = () => {
      toastEl._onExpire = null;
      hideToast();
      opts.onAction && opts.onAction();
    };
  }
  toastEl.classList.add('show');
  toastTimer = setTimeout(() => {
    const fn = toastEl._onExpire;
    toastEl._onExpire = null;
    hideToast();
    if (fn) fn();
  }, opts.duration || (opts.action ? 5000 : 2800));
}

function hideToast() {
  clearTimeout(toastTimer);
  if (toastEl) toastEl.classList.remove('show');
}

/* ---------- Dialogs ---------- */

function makeDialog(cls, html) {
  const d = document.createElement('dialog');
  d.className = cls;
  d.innerHTML = html;
  document.body.appendChild(d);
  d.addEventListener('close', () => setTimeout(() => d.remove(), 250));
  // Tap on the backdrop closes
  d.addEventListener('click', e => { if (e.target === d) d.close(''); });
  return d;
}

export function confirmDialog({ title, body = '', ok = 'OK', cancel = 'Cancel', danger = false }) {
  return new Promise(resolve => {
    const d = makeDialog('dlg', `
      <form method="dialog">
        <h3>${esc(title)}</h3>
        ${body ? `<p>${esc(body)}</p>` : ''}
        <div class="dlg-actions">
          <button value="" class="btn">${esc(cancel)}</button>
          <button value="ok" class="btn ${danger ? 'danger' : 'primary'}">${esc(ok)}</button>
        </div>
      </form>`);
    d.addEventListener('close', () => resolve(d.returnValue === 'ok'));
    d.showModal();
  });
}

/* items: [{ value, label, icon?, danger?, disabled? }] -> chosen value or '' */
export function actionSheet(items, title = '') {
  return new Promise(resolve => {
    const d = makeDialog('sheet', `
      <form method="dialog">
        ${title ? `<div class="sheet-title">${esc(title)}</div>` : ''}
        ${items.map(it => `<button value="${esc(it.value)}" class="sheet-item${it.danger ? ' danger' : ''}"${it.disabled ? ' disabled' : ''}>
          ${it.icon ? icon(it.icon) : ''}<span>${esc(it.label)}</span></button>`).join('')}
        <button value="" class="sheet-item cancel"><span>Cancel</span></button>
      </form>`);
    d.addEventListener('close', () => resolve(d.returnValue));
    d.showModal();
  });
}

export function sheet(html) {
  const d = makeDialog('sheet', html);
  d.showModal();
  return d;
}
