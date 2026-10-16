// Local storage in IndexedDB.
//   tasks   — the schedule (with voice recordings)
//   done    — completions { key: date|taskId, at, mood }
//   starts  — when the child pressed "start"
//   meta    — settings: reward goal, days off, weekly praise messages
//   praise  — parents' recorded praise clips
//   photos  — photo the child took after finishing a task (key: date|taskId)
// Binary data is kept as { buf: ArrayBuffer, type } because Safari handles ArrayBuffer more reliably than Blob.

const DB_NAME = 'thoigianbieu';
const STORES = { tasks: 'id', done: 'key', starts: 'key', meta: 'key', praise: 'id', photos: 'key' };
let dbPromise;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 3);
      r.onupgradeneeded = () => {
        for (const [name, keyPath] of Object.entries(STORES)) {
          if (!r.result.objectStoreNames.contains(name)) r.result.createObjectStore(name, { keyPath });
        }
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}

async function run(stores, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(stores, mode);
    const r = fn(tx);
    tx.oncomplete = () => resolve(r && r.result);
    tx.onerror = () => reject(tx.error);
  });
}

const getAll = name => run(name, 'readonly', tx => tx.objectStore(name).getAll());
const get = (name, key) => run(name, 'readonly', tx => tx.objectStore(name).get(key));
const put = (name, obj) => run(name, 'readwrite', tx => { tx.objectStore(name).put(obj); });
const del = (name, key) => run(name, 'readwrite', tx => { tx.objectStore(name).delete(key); });

export const getTasks = () => getAll('tasks');
export const putTask = t => put('tasks', t);
export const getDone = () => getAll('done');
export const getStarts = () => getAll('starts');
export const getAllMeta = () => getAll('meta');
export const getMeta = key => get('meta', key);
export const putMeta = obj => put('meta', obj);
export const getPraise = () => getAll('praise');
export const putPraise = p => put('praise', p);
export const delPraise = id => del('praise', id);
export const getPhoto = key => get('photos', key);
export const putPhoto = p => put('photos', p);
export const setStarted = (date, taskId) => put('starts', { key: `${date}|${taskId}`, date, taskId, at: Date.now() });

export function setDone(date, taskId, on) {
  const key = `${date}|${taskId}`;
  return run('done', 'readwrite', tx => {
    const s = tx.objectStore('done');
    if (on) s.put({ key, date, taskId, at: Date.now() });
    else s.delete(key);
  });
}

export async function updateDone(key, patch) {
  const rec = await get('done', key);
  if (rec) await put('done', { ...rec, ...patch });
}

function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}

// { buf, type } <-> { b64, type } for the JSON backup.
const enc = a => a && { type: a.type, b64: toB64(a.buf) };
const dec = a => a && { type: a.type, buf: fromB64(a.b64) };

export async function exportJSON() {
  return JSON.stringify({
    app: 'thoigianbieu',
    v: 3,
    tasks: (await getTasks()).map(t => ({ ...t, audio: enc(t.audio) })),
    done: await getDone(),
    starts: await getStarts(),
    meta: (await getAllMeta()).map(m => ({ ...m, audio: enc(m.audio) })),
    praise: (await getPraise()).map(p => ({ ...p, audio: enc(p.audio) })),
    photos: (await getAll('photos')).map(p => ({ ...p, img: enc(p.img) })),
  });
}

export async function importJSON(text) {
  const data = JSON.parse(text);
  if (data.app !== 'thoigianbieu' || !Array.isArray(data.tasks)) throw new Error('File không đúng định dạng');
  const rows = {
    tasks: data.tasks.map(t => ({ ...t, audio: dec(t.audio) })),
    done: data.done || [],
    starts: data.starts || [],
    meta: (data.meta || []).map(m => ({ ...m, audio: dec(m.audio) })),
    praise: (data.praise || []).map(p => ({ ...p, audio: dec(p.audio) })),
    photos: (data.photos || []).map(p => ({ ...p, img: dec(p.img) })),
  };
  await run(Object.keys(STORES), 'readwrite', tx => {
    for (const name of Object.keys(STORES)) {
      const s = tx.objectStore(name);
      s.clear();
      rows[name].forEach(r => s.put(r));
    }
  });
}
