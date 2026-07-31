import { pilot, setPilotActive, loadPilotModel } from '../train/autopilot.js';
import { onTraining } from '../train/trainer.js';

// ---------- autopilot toggle ----------
// 'P' rather than 'A' for the shortcut: A is already steer-left.
const btn = document.getElementById('pilotBtn');

btn.addEventListener('click', () => setPilotActive(!pilot.active));
addEventListener('keydown', (e) => {
  if ((e.key === 'p' || e.key === 'P') && pilot.ready) setPilotActive(!pilot.active);
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
}

// A finished training run hot-swaps the model in place: this is the
// plan's collect-more-data -> retrain -> try-again loop with no reload.
onTraining((t) => {
  if (t.state === 'done') loadPilotModel();
});

// Try to load whatever model a previous session trained; enables the
// button (and the shadow needle) without requiring a fresh train first.
loadPilotModel();
