import { setMode, getMode, onModeChange } from './mode.js';
import { dismissHint } from './input.js';

// ---------- top nav ----------
const buttons = [...document.querySelectorAll('.navbtn')];

buttons.forEach(btn => {
  btn.addEventListener('click', () => {
    dismissHint();
    setMode(btn.dataset.mode);
  });
});

function syncActive(mode) {
  buttons.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
}
onModeChange(syncActive);
syncActive(getMode());
