/* Things more than one screen does: taking photos in, deleting with undo, navigating. */
import { importFile } from './capture.js';
import { session, addPage, newId, removePage, restorePage, commitDelete } from './store.js';
import { editing, enqueue, getAutoCorners } from './pipeline.js';
import { toast } from './ui.js';

// Set by crop's Next so the page screen plays the straighten-and-scan intro for that page
export const handoff = { morph: null };

export function go(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}

const camInput = document.getElementById('in-camera');
const galInput = document.getElementById('in-gallery');
const busy = document.getElementById('busy');

// Must run inside the tap handler, or iOS won't open the picker
export function openCamera() { camInput.value = ''; camInput.click(); }
export function openGallery() { galInput.value = ''; galInput.click(); }

camInput.addEventListener('change', () => handleFiles(Array.from(camInput.files || [])));
galInput.addEventListener('change', () => handleFiles(Array.from(galInput.files || [])));

export function showBusy(msg) {
  busy.querySelector('.busy-msg').textContent = msg;
  busy.hidden = false;
}
export function hideBusy() { busy.hidden = true; }

async function handleFiles(files) {
  files = files.filter(f => !f.type || f.type.startsWith('image/'));
  if (!files.length) return;
  const added = [];
  for (let i = 0; i < files.length; i++) {
    showBusy(files.length > 1 ? `Adding photo ${i + 1} of ${files.length}` : 'Opening photo');
    try {
      const r = await importFile(files[i]);
      const page = Object.assign({
        id: newId(),
        corners: null,
        autoCorners: null,
        detectRan: false,
        filter: session.defaultFilter,
        rotation: 0,
        processedBlob: null,
        thumbBlob: null,
        processedKey: null,
      }, r);
      await addPage(page);
      added.push(page);
    } catch (err) {
      console.error(err);
      toast(`Couldn't read ${files[i].name || 'that photo'}`);
    }
  }
  hideBusy();
  if (added.length === 1) {
    const page = added[0];
    editing.id = page.id;
    getAutoCorners(page).catch(() => {});
    go('#/crop/' + page.id);
  } else if (added.length > 1) {
    added.forEach(enqueue);
    go('#/');
    toast(`${added.length} pages added. Tap one to adjust it.`);
  }
}

export function deleteWithUndo(id) {
  const r = removePage(id);
  if (!r) return;
  toast(`Page ${r.index + 1} deleted`, {
    action: 'Undo',
    onAction: () => restorePage(r.page, r.index),
    onExpire: () => commitDelete(id),
  });
}
