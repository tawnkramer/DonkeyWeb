import { setMode, getMode, onModeChange } from './mode.js';
import { dismissHint } from './input.js';
import { getWorld, onWorldChange } from './world.js';

// ---------- top nav ----------
const buttons = [...document.querySelectorAll('.navbtn')];
const menuModeButtons = [...document.querySelectorAll('.menuModeBtn')];

buttons.forEach(btn => {
  btn.addEventListener('click', () => {
    dismissHint();
    setMode(btn.dataset.mode);
  });
});

menuModeButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    dismissHint();
    setMode(btn.dataset.mode);
  });
});

// Recovery's controller indexes road.centers as one continuous loop. A graph
// deliberately flattens unrelated edges into that compatibility array, so
// exposing the generator there would create mislabeled training data.
function syncWorldCapabilities(world = getWorld()) {
  for (const btn of menuModeButtons.filter(b => b.dataset.mode === 'recover')) {
    btn.disabled = !!world?.graph;
    btn.title = world?.graph ? 'Recovery generation is unavailable on branching roads' : '';
  }
  if (world?.graph && getMode() === 'recover') setMode('drive');
}
onWorldChange(syncWorldCapabilities);
syncWorldCapabilities();

function syncActive(mode) {
  buttons.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
}
onModeChange(syncActive);
syncActive(getMode());
