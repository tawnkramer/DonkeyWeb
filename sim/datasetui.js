import { tub, tubTrimToLength, replaceTub, appendTub, waitForTubIdle, BINS } from '../data/tub.js';
import { dbGet, dbGetAll } from '../data/db.js';
import { zipEntries, unzipEntries } from '../utils/zip.js';
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
// Two recording indicators, only one of which is visible at a time (CSS
// decides): the one on the cam preview for pointer devices, and one in the
// telemetry strip for touch devices, where the preview is hidden.
const recDots = [document.getElementById('recDot'), document.getElementById('telemRec')];
const dFrames = document.getElementById('dFrames');
const dHist = document.getElementById('dHist');
const scrub = document.getElementById('deScrub');
const info = document.getElementById('deInfo');
const img = document.getElementById('deImg');
const deleteBtn = document.getElementById('deDeleteBtn');
const loadBtn = document.getElementById('loadDataBtn');
const saveBtn = document.getElementById('saveDataBtn');
const fileInput = document.getElementById('dataFileInput');
const loadMode = document.getElementById('dataLoadMode');
const dataStatus = document.getElementById('dataStatus');
let saveBusy = false;

const bars = [];
for (let i = 0; i < BINS; i++) {
  const bar = document.createElement('div');
  bar.className = 'bar';
  dHist.appendChild(bar);
  bars.push(bar);
}

export function drawDataset(isRecording) {
  for (const dot of recDots) dot.classList.toggle('active', isRecording);

  const total = tub.frames.length;
  saveBtn.disabled = total === 0 || saveBusy;
  dFrames.innerHTML = total + '<small>frames</small>';

  const max = Math.max(1, ...tub.bins);
  for (let i = 0; i < BINS; i++) bars[i].style.height = Math.round((tub.bins[i] / max) * 100) + '%';
}

function archiveName(name) {
  return name.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '') || 'dataset';
}

async function saveDataset() {
  if (!tub.frames.length) return;
  saveBusy = true;
  saveBtn.disabled = true;
  dataStatus.textContent = 'preparing download…';
  try {
    await waitForTubIdle();
    const records = new Map((await dbGetAll()).map(record => [record.id, record]));
    const frames = [];
    const entries = [];
    for (let i = 0; i < tub.frames.length; i++) {
      const frame = tub.frames[i];
      const record = records.get(frame.id);
      if (!record?.img) throw new Error(`image missing for frame ${frame.id}`);
      const path = `frames/${String(i).padStart(8, '0')}.png`;
      frames.push({ id: frame.id, t: frame.t, steer: frame.steer, throttle: frame.throttle, image: path });
      entries.push({ name: path, data: new Uint8Array(await record.img.arrayBuffer()) });
    }
    entries.unshift({ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify({
      format: 'donkey-web-dataset', version: 1, frames,
    })) });
    const blob = new Blob([zipEntries(entries)], { type: 'application/zip' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${archiveName('dataset')}.zip`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    dataStatus.textContent = 'download started';
  } catch (err) {
    dataStatus.textContent = String(err.message || err);
  } finally {
    saveBusy = false;
    saveBtn.disabled = tub.frames.length === 0;
  }
}

async function loadDataset(file) {
  loadBtn.disabled = true;
  saveBtn.disabled = true;
  dataStatus.textContent = 'reading dataset…';
  try {
    const entries = unzipEntries(await file.arrayBuffer());
    const manifestBytes = entries.get('manifest.json');
    if (!manifestBytes) throw new Error('ZIP does not contain manifest.json');
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    if (manifest.format !== 'donkey-web-dataset' || manifest.version !== 1 || !Array.isArray(manifest.frames)) {
      throw new Error('unsupported dataset ZIP');
    }
    const append = loadMode.value === 'append';
    if (!append && tub.frames.length && !confirm(`Replace the current ${tub.frames.length}-frame dataset?`)) return;
    const ids = new Set();
    const imported = manifest.frames.map((frame, index) => {
      if (!Number.isInteger(frame.id) || frame.id < 0 || ids.has(frame.id)) throw new Error(`invalid frame id at ${index}`);
      if (!Number.isFinite(frame.t) || !Number.isFinite(frame.steer) || !Number.isFinite(frame.throttle)) {
        throw new Error(`invalid frame metadata at ${index}`);
      }
      ids.add(frame.id);
      const image = entries.get(frame.image);
      if (!image) throw new Error(`ZIP is missing ${frame.image}`);
      return { id: frame.id, t: frame.t, steer: frame.steer, throttle: frame.throttle,
        img: new Blob([image], { type: 'image/png' }) };
    });
    const appendBase = append ? tub.frames.reduce((max, frame) => Math.max(max, frame.id), -1) : -1;
    const records = append
      ? imported.map((frame, index) => ({ ...frame, id: appendBase + index + 1 }))
      : imported;
    if (append) await appendTub(records);
    else await replaceTub(records);
    dataStatus.textContent = `${records.length} frames ${append ? 'appended' : 'loaded'}`;
    scrub.max = String(Math.max(0, tub.frames.length - 1));
    scrub.value = String(Math.max(0, tub.frames.length - 1));
    syncDataAvailability();
    if (records.length) scheduleRenderFrame();
  } catch (err) {
    dataStatus.textContent = String(err.message || err);
  } finally {
    fileInput.value = '';
    loadBtn.disabled = false;
    saveBtn.disabled = tub.frames.length === 0;
  }
}

saveBtn.addEventListener('click', saveDataset);
loadBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadDataset(fileInput.files[0]); });

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
