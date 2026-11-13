// IndexedDB の薄いラッパー（端末内にデータ・写真を保存）
//
// put / del … アプリからの変更。OneDrive 同期用に「未送信(_dirty)」の印を付け、
//             同期済みのデータを消したときは削除予定(tombstones)を記録する。
// putRaw / delRaw … 同期処理からの書き込み（印を付けない）。
const DB_NAME = 'genba-pin';
const VERSION = 2;
const TRACKED = new Set(['projects', 'drawings', 'items', 'photos']);
let dbPromise;
const listeners = new Set();

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const emit = (name) => listeners.forEach((fn) => { try { fn(name); } catch (e) { console.error(e); } });

export function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = (e) => {
        const d = req.result;
        if (e.oldVersion < 1) {
          d.createObjectStore('projects', { keyPath: 'id' });
          const dr = d.createObjectStore('drawings', { keyPath: 'id' });
          dr.createIndex('projectId', 'projectId');
          const it = d.createObjectStore('items', { keyPath: 'id' });
          it.createIndex('projectId', 'projectId');
          it.createIndex('drawingId', 'drawingId');
          const ph = d.createObjectStore('photos', { keyPath: 'id' });
          ph.createIndex('itemId', 'itemId');
          ph.createIndex('projectId', 'projectId');
        }
        if (e.oldVersion < 2) {
          const tb = d.createObjectStore('tombstones', { keyPath: 'id' });
          tb.createIndex('projectId', 'projectId');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function req2p(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function store(name, mode = 'readonly') {
  const d = await open();
  return d.transaction(name, mode).objectStore(name);
}

async function write(names, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(names, 'readwrite');
    fn(t);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function mark(name, obj) {
  if (TRACKED.has(name)) { obj._dirty = true; obj._mtime = Date.now(); }
  return obj;
}

export async function get(name, id) { return req2p((await store(name)).get(id)); }
export async function all(name) { return req2p((await store(name)).getAll()); }
export async function by(name, index, value) { return req2p((await store(name)).index(index).getAll(value)); }

export async function put(name, obj) {
  await write(name, (t) => t.objectStore(name).put(mark(name, obj)));
  emit(name);
  return obj;
}
export async function putMany(name, objs) {
  await write(name, (t) => objs.forEach((o) => t.objectStore(name).put(mark(name, o))));
  emit(name);
}
export async function del(name, id) {
  const rec = TRACKED.has(name) ? await get(name, id) : null;
  const names = rec?._etag ? [name, 'tombstones'] : [name];
  await write(names, (t) => {
    t.objectStore(name).delete(id);
    if (rec?._etag) t.objectStore('tombstones').put({ id, store: name, projectId: rec.projectId ?? rec.id, at: Date.now() });
  });
  emit(name);
}

export async function putRaw(name, obj) { await write(name, (t) => t.objectStore(name).put(obj)); return obj; }
export async function delRaw(name, id) { await write(name, (t) => t.objectStore(name).delete(id)); }
