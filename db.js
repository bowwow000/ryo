// IndexedDB の薄いラッパー（端末内にデータ・写真を保存）
const DB_NAME = 'genba-pin';
const VERSION = 1;
let dbPromise;

export function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('projects', { keyPath: 'id' });
        const dr = d.createObjectStore('drawings', { keyPath: 'id' });
        dr.createIndex('projectId', 'projectId');
        const it = d.createObjectStore('items', { keyPath: 'id' });
        it.createIndex('projectId', 'projectId');
        it.createIndex('drawingId', 'drawingId');
        const ph = d.createObjectStore('photos', { keyPath: 'id' });
        ph.createIndex('itemId', 'itemId');
        ph.createIndex('projectId', 'projectId');
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

async function write(name, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(name, 'readwrite');
    fn(t.objectStore(name));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function get(name, id) { return req2p((await store(name)).get(id)); }
export async function all(name) { return req2p((await store(name)).getAll()); }
export async function by(name, index, value) { return req2p((await store(name)).index(index).getAll(value)); }
export async function put(name, obj) { await write(name, (s) => s.put(obj)); return obj; }
export async function putMany(name, objs) { await write(name, (s) => objs.forEach((o) => s.put(o))); }
export async function del(name, id) { await write(name, (s) => s.delete(id)); }
