/* Startup, routing, scanner status and the service worker. */
import { load, session, subscribe } from './store.js';
import { startCv, onCvState } from './cv-client.js';
import { fillIcons, toast } from './ui.js';
import './actions.js';
import * as home from './views/home.js';
import * as crop from './views/crop.js';
import * as pageView from './views/page.js';

fillIcons();

const views = { home, crop, page: pageView };
let current = null;

function route() {
  const [name = '', id] = location.hash.replace(/^#\/?/, '').split('/');
  let key = views[name] && name !== 'home' ? name : 'home';
  if (key !== 'home' && !session.pages.some(p => p.id === id)) {
    history.replaceState(null, '', '#/');
    key = 'home';
  }
  const next = views[key];
  if (current && current !== next) current.hide();
  current = next;
  window.scrollTo(0, 0);
  next.show(id);
}

/* ---------- Scanner / offline status ---------- */

const statusEl = document.querySelector('.status');
let offlineReady = false;

function renderStatus(s) {
  let text = '', cls = '';
  if (s.status === 'loading') text = `Loading scanner ${Math.round(s.progress * 100)}%`;
  else if (s.status === 'starting') text = 'Starting scanner';
  else if (s.status === 'error') { text = 'Scanner failed to load. Tap to retry'; cls = 'err'; }
  else if (s.status === 'ready') { text = offlineReady ? 'Ready offline' : 'Ready'; cls = 'ok'; }
  statusEl.textContent = text;
  statusEl.className = 'status ' + cls;
  statusEl.hidden = !text;
}

statusEl.addEventListener('click', () => {
  if (statusEl.classList.contains('err')) startCv().catch(() => {});
});

let cvStatus = null;
onCvState(s => { cvStatus = s; renderStatus(s); });

subscribe(what => {
  if (what === 'save-error') toast("Couldn't save to this device's storage. Export soon so nothing is lost.", { duration: 6000 });
});

async function checkOffline() {
  if (!('caches' in window)) return false;
  for (let i = 0; i < 40 && !offlineReady; i++) {
    const [a, b] = await Promise.all([caches.match('vendor/opencv.js'), caches.match('index.html')]);
    if (a && b) {
      offlineReady = true;
      if (cvStatus) renderStatus(cvStatus);
      return true;
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  return offlineReady;
}

/* Which build this is, for when a fix doesn't seem to be there yet. Asked of the service worker,
   so it is the version actually being served, and there is only sw.js's VERSION to bump. */
const versionEl = document.querySelector('.app-version');

function askVersion(reg) {
  const sw = navigator.serviceWorker.controller || (reg && reg.active);
  if (sw) sw.postMessage({ type: 'version' });
}

function registerSw() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data && e.data.type === 'version') {
      versionEl.textContent = 'v' + e.data.version;
      versionEl.hidden = false;
    }
  });
  navigator.serviceWorker.register('sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then(reg => { askVersion(reg); return checkOffline(); })
    .catch(err => console.warn('SW', err));
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    askVersion();
    if (hadController) toast('A new version is ready', { action: 'Reload', onAction: () => location.reload(), duration: 10000 });
  });
}

/* ---------- Start ---------- */

async function start() {
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  try {
    await load();
  } catch (err) {
    console.error(err);
    toast("Couldn't open saved pages on this device", { duration: 5000 });
  }
  const resumed = session.pages.length > 0;
  window.addEventListener('hashchange', route);
  route();
  if (resumed && current === home) home.showResume();

  // The SW registers after OpenCV has downloaded, so its precache reuses the HTTP-cached copy
  // instead of fetching 10 MB twice on a first visit
  startCv().catch(() => {}).finally(registerSw);
}

start();
