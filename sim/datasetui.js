import { tub, tubTrimToLength } from '../data/tub.js';
import { dbGet } from '../data/db.js';

// ---------- dataset editor ----------
// Minimal viewer/editor for the recorded tub: scrub to a frame, see its
// image + steer/throttle, and cut everything after it. Built for the
// common cleanup case -- a bad tail (autopilot left running, throttle
// stuck barely non-zero, ...) noticed only after the fact -- rather than
// general-purpose per-frame editing.
const openBtn = document.getElementById('dataEditBtn');
const panel = document.getElementById('datasetEditor');
const closeBtn = document.getElementById('deClose');
const scrub = document.getElementById('deScrub');
const info = document.getElementById('deInfo');
const img = document.getElementById('deImg');
const deleteBtn = document.getElementById('deDeleteBtn');

let objectUrl = null;

function open() {
  if (!tub.frames.length) return;
  scrub.max = String(tub.frames.length - 1);
  scrub.value = String(tub.frames.length - 1);
  panel.hidden = false;
  scheduleRenderFrame();
}
function close() { panel.hidden = true; }

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

// The dataset panel's frame count updates every frame from the main
// loop; the edit button only needs to flip idle<->enabled on the (much
// rarer) 0-frames<->has-frames transition.
let hadFrames = false;
export function drawDatasetEditorAvailability() {
  const has = tub.frames.length > 0;
  if (has === hadFrames) return;
  hadFrames = has;
  openBtn.disabled = !has;
}

openBtn.addEventListener('click', open);
closeBtn.addEventListener('click', close);
addEventListener('keydown', (e) => { if (!panel.hidden && e.key === 'Escape') close(); });
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
