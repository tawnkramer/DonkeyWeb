import { pilot, loadPilotModel, getAvailableModels } from '../train/autopilot.js';
import {
  createUserModel, deleteUserModel, getModel, modelStorageKey, setActiveModelId,
} from '../train/models.js';
import { unzipEntries, zipEntries } from '../utils/zip.js';

const menuBtn = document.getElementById('modelMenuBtn');
const menu = document.getElementById('modelMenu');
const loadBtn = document.getElementById('loadModelBtn');
const saveBtn = document.getElementById('saveModelBtn');
const deleteBtn = document.getElementById('deleteModelBtn');
const input = document.getElementById('modelFileInput');
const status = document.getElementById('modelMenuStatus');
let transientStatusTimer = null;
const pendingFiles = new Map();

function setStatus(message) {
  if (transientStatusTimer) clearTimeout(transientStatusTimer);
  transientStatusTimer = null;
  status.textContent = message;
}

function setTransientStatus(message, duration = 3000) {
  setStatus(message);
  transientStatusTimer = setTimeout(() => {
    status.textContent = '';
    transientStatusTimer = null;
  }, duration);
}

menuBtn.addEventListener('click', () => {
  const open = menu.classList.toggle('open');
  menuBtn.setAttribute('aria-expanded', String(open));
});

document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('#modelMenuWrap')) {
    menu.classList.remove('open');
    menuBtn.setAttribute('aria-expanded', 'false');
  }
});

loadBtn.addEventListener('click', () => input.click());
input.addEventListener('change', async () => {
  if (!input.files.length) return;
  for (const file of input.files) pendingFiles.set(file.name, file);
  setStatus('checking model files…');
  loadBtn.disabled = true;
  try {
    const files = [...pendingFiles.values()];
    const tf = await import('../vendor/tf.mjs');
    await tf.ready();
    const zip = files.find(file => file.name.toLowerCase().endsWith('.zip'));
    let descriptor, candidate, modelName;
    if (zip) {
      const entries = unzipEntries(await zip.arrayBuffer());
      const modelEntry = entries.get('model.json');
      if (!modelEntry) throw new Error('ZIP does not contain model.json');
      descriptor = JSON.parse(new TextDecoder().decode(modelEntry));
      const weightBytes = (descriptor.weightsManifest || []).flatMap(group => (group.paths || []).map(path => {
        const entry = entries.get(path.split(/[\\/]/).pop());
        if (!entry) throw new Error(`ZIP is missing ${path}`);
        return entry;
      }));
      candidate = await loadArtifactModel(tf, descriptor, weightBytes);
      modelName = zip.name.replace(/\.zip$/i, '');
    } else {
    const json = files.find(file => file.name.endsWith('.json'));
    if (!json) {
      setStatus('choose the model.json file too');
      return;
    }
    descriptor = JSON.parse(await json.text());
    const requiredWeights = (descriptor.weightsManifest || [])
      .flatMap(group => group.paths || [])
      .map(path => path.split(/[\\/]/).pop());
    const missing = requiredWeights.filter(name => !pendingFiles.has(name));
    if (missing.length) {
      setStatus(`selected ${json.name}; now choose ${missing.join(', ')}`);
      return;
    }

    setStatus('loading model…');
    candidate = await tf.loadLayersModel(tf.io.browserFiles(files));
    modelName = json.name.replace(/\.json$/i, '');
    }
    const [, h, w, channels] = candidate.inputs[0]?.shape || [];
    if (!h || !w || channels !== 3 || candidate.outputs.length !== 2) {
      candidate.dispose();
      throw new Error('model must accept an image and produce steering plus throttle');
    }
    const outputs = tf.tidy(() => candidate.predict(tf.zeros([1, h, w, 3])));
    const finite = outputs.every(output => output.dataSync().every(Number.isFinite));
    outputs.forEach(output => output.dispose());
    if (!finite) { candidate.dispose(); throw new Error('model produced a non-finite warm-up prediction'); }

    const base = modelName.replace(/[^a-z0-9 _.-]+/gi, '').trim() || 'Imported model';
    const record = await createUserModel({
      name: base,
      source: 'imported',
      input: `${w}×${h}`,
    });
    await candidate.save(modelStorageKey(record.id));
    candidate.dispose();
    setActiveModelId(record.id);
    await loadPilotModel(record.id);
    pendingFiles.clear();
    setStatus(`${record.name} loaded`);
  } catch (err) {
    setStatus(String(err.message || err));
  } finally {
    input.value = '';
    loadBtn.disabled = false;
    await getAvailableModels().catch(() => {});
  }
});

saveBtn.addEventListener('click', async () => {
  if (!pilot.modelId) { setStatus('no model is loaded'); return; }
  const record = await getModel(pilot.modelId);
  if (!record || record.kind === 'builtin') {
    setStatus('the built-in example is read-only');
    return;
  }
  saveBtn.disabled = true;
  setStatus('preparing download…');
  try {
    const tf = await import('../vendor/tf.mjs');
    await tf.ready();
    const model = await tf.loadLayersModel(record.storageKey);
    let artifacts;
    await model.save(tf.io.withSaveHandler(next => {
      artifacts = next;
      return { modelArtifactsInfo: { dateSaved: new Date(), modelTopologyType: 'JSON', weightDataBytes: next.weightData?.byteLength || 0 } };
    }));
    const modelJson = new TextEncoder().encode(JSON.stringify({
      format: 'layers-model', generatedBy: 'donkey.web', modelTopology: artifacts.modelTopology,
      weightsManifest: [{ paths: ['weights.bin'], weights: artifacts.weightSpecs }],
    }));
    const bundle = zipEntries([
      { name: 'model.json', data: modelJson },
      { name: 'weights.bin', data: new Uint8Array(artifacts.weightData) },
    ]);
    const blob = new Blob([bundle], { type: 'application/zip' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${record.name.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase() || 'model'}.zip`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    model.dispose();
    setTransientStatus('download started');
  } catch (err) {
    setStatus(String(err.message || err));
  } finally {
    saveBtn.disabled = false;
  }
});

deleteBtn.addEventListener('click', async () => {
  if (!pilot.modelId) { setStatus('no model is loaded'); return; }
  const record = await getModel(pilot.modelId);
  if (!record || record.kind === 'builtin') {
    setStatus('the built-in model cannot be deleted');
    return;
  }
  if (!confirm(`Delete ${record.name}? This cannot be undone.`)) return;
  deleteBtn.disabled = true;
  setStatus('deleting model…');
  try {
    const tf = await import('../vendor/tf.mjs');
    await tf.ready();
    await tf.io.removeModel(record.storageKey);
    await deleteUserModel(record.id);
    setActiveModelId('builtin-example');
    await loadPilotModel('builtin-example');
    setStatus(`${record.name} deleted`);
  } catch (err) {
    setStatus(String(err.message || err));
  } finally {
    deleteBtn.disabled = false;
    await getAvailableModels().catch(() => {});
  }
});

async function loadArtifactModel(tf, descriptor, weightBytes) {
  await tf.ready();
  const total = weightBytes.reduce((n, bytes) => n + bytes.length, 0);
  const data = new Uint8Array(total); let at = 0;
  for (const bytes of weightBytes) { data.set(bytes, at); at += bytes.length; }
  return tf.loadLayersModel(tf.io.fromMemory({
    modelTopology: descriptor.modelTopology,
    weightSpecs: (descriptor.weightsManifest || []).flatMap(group => group.weights || []),
    weightData: data.buffer,
  }));
}
