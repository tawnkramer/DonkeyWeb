import { pilot, setPilotActive, loadPilotModel, getAvailableModels, onPilotModelChange } from '../train/autopilot.js';
import { onTraining } from '../train/trainer.js';
import { dismissHint } from './input.js';

// ---------- autopilot toggle ----------
// 'P' rather than 'A' for the shortcut: A is already steer-left.
const btn = document.getElementById('pilotBtn');
const evalEmpty = document.getElementById('evalEmpty');
const modelSelect = document.getElementById('modelSelect');
const modelStatus = document.getElementById('modelStatus');

btn.addEventListener('click', () => { dismissHint(); setPilotActive(!pilot.active); });
modelSelect.addEventListener('change', async () => {
  dismissHint();
  setPilotActive(false);
  modelSelect.disabled = true;
  modelStatus.textContent = 'loading model…';
  const ready = await loadPilotModel(modelSelect.value);
  modelSelect.disabled = false;
  modelStatus.textContent = ready ? '' : (pilot.error || 'could not load model');
  await refreshModels();
  drawPilot();
});
addEventListener('keydown', (e) => {
  if ((e.key === 'p' || e.key === 'P') && pilot.ready) { dismissHint(); setPilotActive(!pilot.active); }
});

// Immediate-mode like the rest of the HUD: called every frame from the
// main loop, diffed so the DOM is only touched on actual state changes.
// This keeps the button honest no matter who flips pilot state -- the
// click handler, the P key, a finished training run, or a test driving
// window.__sim directly.
let drawn = null;
export function drawPilot() {
  const state = (pilot.ready ? 'r' : '-') + (pilot.active ? 'a' : '-');
  if (state === drawn) return;
  drawn = state;
  btn.disabled = !pilot.ready;
  btn.title = pilot.ready ? '' : 'train a model first';
  btn.classList.toggle('on', pilot.active);
  btn.textContent = pilot.active ? 'autopilot · on' : 'autopilot';
  evalEmpty.hidden = pilot.ready;
}

async function refreshModels() {
  const models = await getAvailableModels();
  const selected = pilot.modelId || models.find(model => model.id === modelSelect.value)?.id;
  modelSelect.replaceChildren(...models.map(model => {
    const label = model.kind === 'builtin' ? 'Built-in' : `User · ${model.name}`;
    const option = new Option(label, model.id);
    option.selected = model.id === selected;
    return option;
  }));
}

onPilotModelChange(() => {
  if (pilot.ready && pilot.modelName) modelStatus.textContent = `${pilot.modelName} ready`;
  refreshModels().catch(err => { modelStatus.textContent = String(err.message || err); });
});

// A finished training run hot-swaps the model in place: this is the
// plan's collect-more-data -> retrain -> try-again loop with no reload.
onTraining((t) => {
  if (t.state === 'done') loadPilotModel();
});

// Try to load whatever model a previous session trained; enables the
// button (and the shadow needle) without requiring a fresh train first.
refreshModels()
  .then(() => loadPilotModel())
  .catch(err => { modelStatus.textContent = String(err.message || err); });
