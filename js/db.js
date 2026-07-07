// ShelfVision — IndexedDB persistence layer.
// Stores: items (catalog), samples (training embeddings), audits (count history).

const DB_NAME = 'shelfvision';
const DB_VER = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('items')) {
        db.createObjectStore('items', { keyPath: 'item_code' });
      }
      if (!db.objectStoreNames.contains('samples')) {
        const s = db.createObjectStore('samples', { keyPath: 'id', autoIncrement: true });
        s.createIndex('by_item', 'item_code');
      }
      if (!db.objectStoreNames.contains('audits')) {
        db.createObjectStore('audits', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

// --- Items (catalog synced from ERPNext or added locally) ---
export async function putItems(items) {
  const s = await store('items', 'readwrite');
  await Promise.all(items.map((it) => promisify(s.put(it))));
}
export async function getAllItems() {
  return promisify((await store('items')).getAll());
}
export async function deleteItem(code) {
  return promisify((await store('items', 'readwrite')).delete(code));
}

// --- Training samples (embedding: Float32Array, thumb: dataURL) ---
export async function addSample(sample) {
  return promisify((await store('samples', 'readwrite')).add(sample));
}
export async function getAllSamples() {
  return promisify((await store('samples')).getAll());
}
export async function getSamplesByItem(code) {
  const s = await store('samples');
  return promisify(s.index('by_item').getAll(code));
}
export async function deleteSample(id) {
  return promisify((await store('samples', 'readwrite')).delete(id));
}
export async function deleteSamplesByItem(code) {
  const s = await store('samples', 'readwrite');
  const keys = await promisify(s.index('by_item').getAllKeys(code));
  await Promise.all(keys.map((k) => promisify(s.delete(k))));
}

// --- Audit history ---
export async function saveAudit(audit) {
  return promisify((await store('audits', 'readwrite')).add(audit));
}
export async function getAudits() {
  return promisify((await store('audits')).getAll());
}
export async function updateAudit(audit) {
  return promisify((await store('audits', 'readwrite')).put(audit));
}

// --- Backup / restore of training data ---
export async function exportAll() {
  const [items, samples] = await Promise.all([getAllItems(), getAllSamples()]);
  return {
    version: 1,
    exported_at: new Date().toISOString(),
    items,
    samples: samples.map((s) => ({ ...s, embedding: Array.from(s.embedding) })),
  };
}
export async function importAll(data) {
  if (!data || data.version !== 1) throw new Error('Unrecognised backup format');
  await putItems(data.items || []);
  const s = await store('samples', 'readwrite');
  await Promise.all(
    (data.samples || []).map((smp) => {
      const { id, ...rest } = smp;
      rest.embedding = new Float32Array(rest.embedding);
      return promisify(s.add(rest));
    })
  );
}
