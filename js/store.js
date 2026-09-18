/*
 * Session state. Every change is written to IndexedDB straight away so a reloaded tab (Safari
 * drops background tabs freely) comes back exactly as it was.
 *
 * page = {
 *   id, w, h,
 *   originalBlob, origThumbBlob,     downscaled capture (long edge <= 2000) and its thumbnail
 *   corners,                         [[x,y] x4] TL,TR,BR,BL in original coords, null until set
 *   autoCorners, detectRan,          detection result (null if it found nothing)
 *   filter, rotation,
 *   processedBlob, thumbBlob, processedKey   output, and the settings it was made with
 * }
 */
import * as db from './storage.js';

export const session = {
  pages: [],
  pageSize: 'auto',
  name: '',
  defaultFilter: 'enhanced',
};

const subs = new Set();
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
export function emit(what, detail) { subs.forEach(fn => fn(what, detail)); }

export function getPage(id) { return session.pages.find(p => p.id === id) || null; }
export function pageIndex(id) { return session.pages.findIndex(p => p.id === id); }

function metaRecord() {
  return {
    order: session.pages.map(p => p.id),
    pageSize: session.pageSize,
    name: session.name,
    defaultFilter: session.defaultFilter,
  };
}

function warn(err) { console.error('Save failed', err); emit('save-error', err); }

export function saveMeta() { return db.saveMeta(metaRecord()).catch(warn); }
export function savePage(page) { return db.savePage(page).catch(warn); }

export async function load() {
  const { pages, meta } = await db.loadAll();
  const byId = new Map(pages.map(p => [p.id, p]));
  const order = (meta && meta.order) || [];
  session.pages = order.map(id => byId.get(id)).filter(Boolean);
  // Pages left out of the order are deletes that were pending when the tab closed
  const orphans = pages.filter(p => !order.includes(p.id)).map(p => p.id);
  if (orphans.length) db.deletePages(orphans).catch(warn);
  if (meta) {
    session.pageSize = meta.pageSize || 'auto';
    session.name = meta.name || '';
    session.defaultFilter = meta.defaultFilter || 'enhanced';
  }
  emit('load');
}

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export async function addPage(page) {
  if (!session.pages.length && !session.name) session.name = defaultName();
  session.pages.push(page);
  await savePage(page);
  await saveMeta();
  emit('pages');
}

export function updatePage(page, patch) {
  Object.assign(page, patch);
  emit('page', page);
  return savePage(page);
}

// Takes the page out of the session but keeps its record until commitDelete, for undo
export function removePage(id) {
  const index = pageIndex(id);
  if (index < 0) return null;
  const [page] = session.pages.splice(index, 1);
  saveMeta();
  emit('pages');
  return { page, index };
}

export function restorePage(page, index) {
  session.pages.splice(Math.min(index, session.pages.length), 0, page);
  saveMeta();
  emit('pages');
}

export function commitDelete(id) {
  if (getPage(id)) return;
  db.deletePages([id]).catch(warn);
}

export function movePage(from, to) {
  if (from === to || from < 0 || to < 0 || from >= session.pages.length || to >= session.pages.length) return;
  const [p] = session.pages.splice(from, 1);
  session.pages.splice(to, 0, p);
  saveMeta();
  emit('pages');
}

export function setOrder(ids) {
  const byId = new Map(session.pages.map(p => [p.id, p]));
  session.pages = ids.map(id => byId.get(id)).filter(Boolean);
  saveMeta();
  emit('pages');
}

export async function resetSession() {
  session.pages = [];
  session.name = '';
  await db.clearAll().catch(warn);
  await saveMeta();
  emit('pages');
}

export function defaultName(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `Scan ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}
