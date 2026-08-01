import { tub, tubTrimToLength, BINS } from '../data/tub.js';
import { dbGet } from '../data/db.js';
import { onModeChange } from './mode.js';

// ---------- Data screen ----------
// Full-screen dataset viewer/editor: frame count + live steering histogram
// (so "all straight" data visibly piles up in the middle instead of being
// an invisible problem you only discover after training), scrub to a
// frame, see its image + steer/throttle, and cut everything after it --
// built for the common cleanup case (a bad tail: autopilot left running,
// throttle stuck barely non-zero, ...) rather than general-purpose
// per-frame editing.
const dataEmpty = document.getElementById('dataEmpty');
const dataContent = document.getElementById('dataContent');
const recDot = document.getElementById('recDot');
const dFrames = document.getElementById('dFrames');
const dHist = document.getElementById('dHist');
const scrub = document.getElementById('deScrub');
const info = document.getElementById('deInfo');
const img = document.getElementById('deImg');
const deleteBtn = document.getElementById('deDeleteBtn');

const bars = [];
for (let i = 0; i < BINS; i++) {
  const bar = document.createElement('div');
  bar.className = 'bar';
  dHist.appendChild(bar);
  bars.push(bar);
}

export function drawDataset(isRecording) {
  recDot.classList.toggle('active', isRecording);

  const total = tub.frames.length;
  dFrames.innerHTML = total + '<small>frames</small>';

  const max = Math.max(1, ...tub.bins);
  for (let i = 0; i < BINS; i++) bars[i].style.height = Math.round((tub.bins[i] / max) * 100) + '%';
}

let objectUrl = null;

function enterDataScreen() {
  if (!tub.frames.length) return;
  scrub.max = String(tub.frames.length - 1);
  scrub.value = String(tub.frames.length - 1);
  scheduleRenderFrame();
}
onModeChange(next => { if (next === 'data') enterDataScreen(); });

async function renderFrame() {
  const idx = Number(scrub.value);
  const frame = tub.frames[idx];
  if (!frame) return;
  const total = tub.frames.length;
  const toDelete = total - idx - 1;
  info.textContent = `frame ${idx} / ${total - 1} · t=${frame.t.toFixed(2)}s · steer=${frame.steer.toFixed(2)} · throttle=${frame.throttle.toFixed(2)}`;
  deleteBtn.textContent = toDelete > 0 ? `delete frames ${idx + 1}–${total - 1} (${toDelete})` : 'nothing after this frame';
  deleteBtn.disabled = toDelete === 0;

  const rec = await dbGet(frame.id).catch(() => null);
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = rec && rec.img ? URL.createObjectURL(rec.img) : null;
  img.src = objectUrl || '';
}

// Dragging the scrubber fires many 'input' events per second, each
// wanting its own dbGet() fetch. Firing one per event lets them race --
// whichever is slowest to resolve (e.g. IndexedDB doing housekeeping
// right after a bulk delete) loses to newer ones and never paints, which
// looks frozen until the drag stops. This serializes them instead: at
// most one renderFrame() in flight, and if the scrubber moved again
// while it was running, run exactly one more for wherever it ended up --
// never a backlog, never an overlapping pair to race.
let renderInFlight = false;
let renderAgainRequested = false;
function scheduleRenderFrame() {
  if (renderInFlight) { renderAgainRequested = true; return; }
  renderInFlight = true;
  renderFrame().finally(() => {
    renderInFlight = false;
    if (renderAgainRequested) {
      renderAgainRequested = false;
      scheduleRenderFrame();
    }
  });
}

// The Data screen's empty state flips on the (rare) 0-frames<->has-frames
// transition; called every frame from the main loop like the rest of the
// HUD draw calls, so deleting down to zero while already on this screen
// flips immediately.
let hadFrames = false;
export function syncDataAvailability() {
  const has = tub.frames.length > 0;
  if (has === hadFrames) return;
  hadFrames = has;
  dataEmpty.hidden = has;
  dataContent.hidden = !has;
}

scrub.addEventListener('input', scheduleRenderFrame);
deleteBtn.addEventListener('click', async () => {
  const idx = Number(scrub.value);
  const total = tub.frames.length;
  const toDelete = total - idx - 1;
  if (toDelete <= 0) return;
  if (!confirm(`Delete ${toDelete} frame(s) after frame ${idx}? This can't be undone.`)) return;

  // Disabled and awaited rather than fire-and-forget: renderFrame()'s
  // dbGet() below must not run until the delete's IndexedDB transaction
  // has actually finished, or it queues in behind it and the preview
  // just never updates (see tubTrimToLength).
  deleteBtn.disabled = true;
  scrub.disabled = true;
  deleteBtn.textContent = `deleting ${toDelete} frame(s)…`;
  await tubTrimToLength(idx + 1);
  scrub.disabled = false;

  scrub.max = String(tub.frames.length - 1);
  scrub.value = String(tub.frames.length - 1);
  scheduleRenderFrame();
});
