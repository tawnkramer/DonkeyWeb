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

export function newModelId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
  return setUserModel({ id: newModelId(), name, source, ...extra });
}

// Drops user models with nothing behind them: weights that were never
// written, or a record still flagged `pending` because the run that owned it
// never reached a save. Both are the same failure -- pressing train and not
// getting to model.save(), most often the "need 50+ frames" error one button
// press away -- and both used to leave a permanent entry in the picker named
// identically to every real model, which could not be loaded and could only
// be deleted one at a time.
//
// A record is written before the worker has anything to put in it (it needs
// the storage key), so "no artifacts" is only evidence of death once no run
// can be in flight. Hence once per page load, from ensureModelMetadata,
// which runs long before anything can have been trained this session.
export async function pruneDeadModels(tf) {
  const stored = await tf.io.listModels();
  const dead = (await dbModelGetAll())
    .filter((model) => model.pending || !stored[model.storageKey]);
  for (const model of dead) await dbModelDelete(model.id);
  if (dead.some((model) => model.id === getActiveModelId())) setActiveModelId(BUILTIN_MODEL.id);
  return dead.length;
}

export async function deleteUserModel(id) {
  const model = await getModel(id);
  if (!model || model.kind !== 'user') throw new Error('Only user models can be deleted');
  await dbModelDelete(id);
  if (getActiveModelId() === id) setActiveModelId(BUILTIN_MODEL.id);
}

// Existing releases used one unnamed user slot. Preserve it as a selectable
// user model rather than silently replacing it with the website example.
let pruned = false;
export async function ensureModelMetadata(tf) {
  if (!pruned) {
    pruned = true; // set before awaiting, so concurrent callers prune once
    await pruneDeadModels(tf);
  }
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
