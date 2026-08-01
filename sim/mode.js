// Single source of truth for the active top-level screen (Drive/Data/Train/
// Eval). Expressed in the DOM as <body data-mode="..."> so every show/hide
// decision is a plain CSS attribute selector rather than scattered per-
// element JS toggles -- same push-subscription shape as train/trainer.js's
// onTraining, for the same reason (a handful of unrelated modules each want
// to react to a mode change without polling).
const MODES = ['drive', 'data', 'train', 'eval'];
let current = document.body.dataset.mode || 'drive';

const listeners = new Set();
export function onModeChange(fn) { listeners.add(fn); }

export function getMode() { return current; }

export function setMode(next) {
  if (!MODES.includes(next) || next === current) return;
  current = next;
  document.body.dataset.mode = current;
  for (const fn of listeners) fn(current);
}
