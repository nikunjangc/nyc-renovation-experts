// Saves the room in this browser (IndexedDB): the photo, the room's shape,
// paint, floor and furniture. Nothing leaves the phone unless the person uses
// an AI tool (remove, shop 3D).

const DB = 'room3d';
const STORE = 'kv';

function open() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('no indexedDB'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const st = t.objectStore(STORE);
    const out = fn(st);
    t.oncomplete = () => { db.close(); resolve(out && out.result !== undefined ? out.result : undefined); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error); };
  });
}

export async function put(key, value) {
  try { await tx('readwrite', (st) => st.put(value, key)); return true; }
  catch (e) { console.warn('save failed', e); return false; }
}

export async function get(key) {
  try { return await tx('readonly', (st) => st.get(key)); }
  catch (e) { return undefined; }
}

export async function del(key) {
  try { await tx('readwrite', (st) => st.delete(key)); } catch (_) { /* ignore */ }
}
