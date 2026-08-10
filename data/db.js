// Minimal promise wrapper around the raw IndexedDB API -- no npm `idb`
// dependency yet since the project isn't using a bundler. One object
// store for now (tub frames); "named tubs" from the plan can become
// additional stores or a `tub` index later without changing this shape.
const DB_NAME = 'donkeyweb';
const DB_VERSION = 2;
const STORE = 'frames';
const MODELS = 'models';

let dbPromise = null;
function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(MODELS)) db.createObjectStore(MODELS, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

export async function dbPut(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function dbPutMany(records) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const record of records) store.put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function dbGet(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// One transaction for the whole batch rather than dbDelete() per id.
// This isn't just an optimization: firing hundreds/thousands of unawaited
// dbDelete() calls in a loop queues that many separate readwrite
// transactions on this store, and any *later* request on the same
// store -- e.g. the dataset editor's dbGet() for a frame preview --
// queues in behind all of them and can stall for minutes. Bulk deletes
// must go through here, in one transaction, precisely so nothing else
// gets stuck behind a pile of individual ones.
export async function dbDeleteMany(ids) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const id of ids) store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function dbClear() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function dbReplaceAll(records) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.clear();
    for (const record of records) store.put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function dbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Without this the tub lives in "best effort" storage, which the browser is
// free to throw away wholesale when the disk gets tight -- and it does. A
// dev-server origin is a prime candidate for that: it carries none of the
// engagement signals (bookmarks, repeat visits, installs) that make a browser
// reluctant to evict, while a recording of lossless PNG frames is one of the
// largest things on the origin. The failure is silent and total: the laps are
// simply not there next time the page opens, with nothing to recover from.
//
// Persistent storage is exempt from that automatic eviction -- only an
// explicit clear by the user removes it. Chrome grants it without a prompt on
// localhost; elsewhere it may decline, which is why this reports rather than
// assumes. It is not protection against a genuinely full disk, where the
// writes themselves start failing, only against being collected as spare
// capacity for something else.
export async function requestPersistence() {
  if (!navigator.storage?.persist) return { supported: false, persisted: false };
  try {
    // Asking again when already granted is a no-op, but skipping the second
    // call keeps the (potentially prompting) path off the startup route for
    // everyone who has already answered it once.
    const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    const persisted = already || await navigator.storage.persist();
    if (!persisted) {
      console.warn(
        'donkeyweb: the browser would not mark this origin persistent, so recorded laps ' +
        'may be evicted if the disk runs low. Export anything you care about (Data → save).');
    }
    return { supported: true, persisted };
  } catch (err) {
    console.warn('donkeyweb: could not request persistent storage', err);
    return { supported: true, persisted: false };
  }
}

// Bytes used and available for this origin, or null where unsupported. Only
// ever an estimate -- browsers deliberately blur it to limit fingerprinting.
export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}

// Model metadata deliberately lives in the app database rather than
// TensorFlow.js's private `models_store`, so the UI can list models without
// depending on tfjs's internal IndexedDB schema.
export async function dbModelPut(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MODELS, 'readwrite');
    tx.objectStore(MODELS).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function dbModelGet(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MODELS, 'readonly');
    const req = tx.objectStore(MODELS).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function dbModelDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MODELS, 'readwrite');
    tx.objectStore(MODELS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function dbModelGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MODELS, 'readonly');
    const req = tx.objectStore(MODELS).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
