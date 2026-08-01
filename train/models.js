import { dbModelDelete, dbModelGetAll, dbModelPut } from '../data/db.js';

// Model metadata is app-owned. TensorFlow.js only owns the actual model
// artifacts in its IndexedDB store; keeping these concerns separate makes
// the model picker independent of tfjs's private database schema.
export const BUILTIN_MODEL = {
  id: 'builtin-example',
  name: 'Example model',
  kind: 'builtin',
  source: 'website',
  url: './models/default/model.json',
  manifestUrl: './models/default/manifest.json',
  profile: 'tiny',
  input: '64×64',
};

export const LEGACY_MODEL_KEY = 'indexeddb://donkeyweb-model';
const ACTIVE_KEY = 'donkeyweb-active-model';

export function modelStorageKey(id) {
  return `indexeddb://donkeyweb-user-${id}`;
}

export async function listModels() {
  const users = await dbModelGetAll();
  let builtin = BUILTIN_MODEL;
  try {
    const response = await fetch(BUILTIN_MODEL.manifestUrl, { cache: 'no-store' });
    if (response.ok) {
      const manifest = await response.json();
      if (manifest.installed) builtin = { ...BUILTIN_MODEL, ...manifest, kind: 'builtin' };
    }
  } catch { /* the deterministic bundled example remains available */ }
  return [builtin, ...users.sort((a, b) => a.name.localeCompare(b.name))];
}

export async function getModel(id) {
  return (await listModels()).find(model => model.id === id) || null;
}

export function getActiveModelId() {
  return localStorage.getItem(ACTIVE_KEY) || BUILTIN_MODEL.id;
}

export function setActiveModelId(id) {
  localStorage.setItem(ACTIVE_KEY, id);
}

export async function setUserModel(record) {
  const now = Date.now();
  const next = {
    ...record,
    kind: 'user',
    updatedAt: record.updatedAt || now,
    createdAt: record.createdAt || now,
    storageKey: record.storageKey || modelStorageKey(record.id),
  };
  await dbModelPut(next);
  return next;
}

export async function createUserModel({ name = 'Trained model', source = 'trained', ...extra } = {}) {
  const id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return setUserModel({ id, name, source, ...extra });
}

export async function deleteUserModel(id) {
  const model = await getModel(id);
  if (!model || model.kind !== 'user') throw new Error('Only user models can be deleted');
  await dbModelDelete(id);
  if (getActiveModelId() === id) setActiveModelId(BUILTIN_MODEL.id);
}

// Existing releases used one unnamed user slot. Preserve it as a selectable
// user model rather than silently replacing it with the website example.
export async function ensureModelMetadata(tf) {
  const users = await dbModelGetAll();
  if (users.some(model => model.storageKey === LEGACY_MODEL_KEY)) return;
  const available = await tf.io.listModels();
  if (!available[LEGACY_MODEL_KEY]) return;
  await setUserModel({
    id: 'legacy-model',
    name: 'Previous trained model',
    source: 'trained',
    storageKey: LEGACY_MODEL_KEY,
  });
}

export function modelLoadUrl(model) {
  return model.kind === 'builtin' ? model.url : model.storageKey;
}
