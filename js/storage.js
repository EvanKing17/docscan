/*
 * IndexedDB persistence. One record per page (blobs included) plus one meta record holding the
 * page order and session settings. Fields starting with "_" are runtime-only and never stored.
 */
const DB_NAME = 'docscan';
const DB_VERSION = 1;

let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('pages')) d.createObjectStore('pages', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(stores, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
    result = fn(t);
  });
}

function record(page) {
  const rec = {};
  for (const k of Object.keys(page)) if (k[0] !== '_') rec[k] = page[k];
  return rec;
}

export async function loadAll() {
  let pages = [], meta = null;
  await tx(['pages', 'meta'], 'readonly', t => {
    t.objectStore('pages').getAll().onsuccess = e => { pages = e.target.result || []; };
    t.objectStore('meta').get('session').onsuccess = e => { meta = e.target.result || null; };
  });
  return { pages, meta };
}

export function savePage(page) {
  return tx('pages', 'readwrite', t => { t.objectStore('pages').put(record(page)); });
}

export function saveMeta(meta) {
  return tx('meta', 'readwrite', t => { t.objectStore('meta').put(meta, 'session'); });
}

export function deletePages(ids) {
  return tx('pages', 'readwrite', t => {
    const s = t.objectStore('pages');
    ids.forEach(id => s.delete(id));
  });
}

export function clearAll() {
  return tx(['pages', 'meta'], 'readwrite', t => {
    t.objectStore('pages').clear();
    t.objectStore('meta').clear();
  });
}
