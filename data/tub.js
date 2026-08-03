import { povCanvas } from '../sim/scene.js';
import { dbPut, dbPutMany, dbDelete, dbDeleteMany, dbGetAll, dbReplaceAll } from './db.js';

// ---------- recording (tub) ----------
// Frames persist to IndexedDB so the tub survives a reload -- see
// loadTub() below. steer/throttle are recorded as the raw driver-
// commanded values (matching what a real donkeycar tub records -- the
// PWM command, not the resulting vehicle state), which is also what's
// already continuous thanks to mouse/wheel input.
//
// tub.frames holds lightweight metadata only (no image); images live in
// IndexedDB and are fetched on demand (export, viewing a frame later),
// so an hour of driving doesn't also duplicate tens of MB of images in JS
// memory on top of what's already on disk.
//
// Frames are stored as PNG, measured against JPEG on real POV frames at
// 160x120: PNG averages 2.7 KB against JPEG q0.70's 2.4 KB and q0.90's
// 3.5 KB. Flat-shaded synthetic renders -- big uniform regions of grass,
// road and sky gradient -- are close to the best case for lossless
// compression and close to the worst case for a DCT, so lossless costs
// ~13% on disk and beats q0.90 outright.
//
// Losing the artifacts matters beyond looks: inference feeds the model the
// RAW POV canvas (see train/autopilot.js), so every artifact in a recorded
// frame is a difference between what the model trains on and what it drives
// on. JPEG q0.70 averaged 3.0/255 of error per channel with ringing up to
// 171 around exactly the high-contrast edges -- lane lines and cones -- that
// the model is supposed to be steering by.

// bins is a live steering histogram over [-1,1], kept in sync incrementally
// on push/trim rather than recomputed from the full frame list every UI
// tick -- cheap now, stays cheap once tubs have thousands of frames.
// steer is +1 = full left, so bin index has to run the other way (low
// index = left) to land left turns on the left side of the display and
// right turns on the right, matching the steering bar elsewhere in the HUD.
export const BINS = 9;
const BIN_WIDTH = 2 / BINS;
function binIndex(steer) {
  return Math.min(BINS - 1, Math.max(0, Math.floor((-steer + 1) / BIN_WIDTH)));
}

export const tub = { frames: [], bins: new Array(BINS).fill(0), loaded: false };

let nextId = 0;
const pendingWork = new Set();

export function tubPush(t, steer, throttle) {
  // Guards against an id collision with frames loadTub() hasn't restored
  // yet (nextId isn't known-correct until that finishes) -- recording
  // just doesn't start until the restore completes, which is normally
  // well under the time it takes a human to start driving after load.
  if (!tub.loaded) return;

  const id = nextId++;
  let settlePersist = null;
  const persistDone = new Promise(resolve => { settlePersist = resolve; });
  const frame = { id, t, steer, throttle, persistDone };
  tub.frames.push(frame);
  tub.bins[binIndex(steer)]++;

  let settleEncode = null;
  const encodeDone = new Promise(resolve => { settleEncode = resolve; });
  pendingWork.add(encodeDone);

  povCanvas.toBlob(blob => {
    pendingWork.delete(encodeDone);
    settleEncode();

    // If this frame got trimmed (off-track) before its image finished
    // encoding, don't let the DB write resurrect it after the fact.
    if (frame.trimmed) {
      settlePersist();
      return;
    }
    const persist = dbPut({ id, t, steer, throttle, img: blob })
      .catch(err => console.warn('tub: failed to persist frame', err))
      .finally(() => {
        pendingWork.delete(persist);
        settlePersist();
      });
    pendingWork.add(persist);
  }, 'image/png');
}

// Shared by both trim paths below. Frames pushed this session carry a
// persistDone promise and must wait for their image write to land before
// the delete (see tubPush); frames restored by loadTub() from a prior
// session are already fully persisted and have no such promise to wait on.
function removeFrame(removed) {
  removed.trimmed = true;
  tub.bins[binIndex(removed.steer)]--;
  const del = () => dbDelete(removed.id).catch(err => console.warn('tub: failed to delete frame', err));
  if (removed.persistDone) removed.persistDone.then(del);
  else del();
}

export function tubTrimLastSeconds(seconds, simTime) {
  const cutoff = simTime - seconds;
  while (tub.frames.length && tub.frames[tub.frames.length - 1].t > cutoff) {
    removeFrame(tub.frames.pop());
  }
}

// Drops every frame after the first `keepCount`, e.g. to cut a bad tail
// (autopilot left engaged, throttle stuck barely non-zero, ...) spotted
// after the fact in the dataset editor. Unlike tubTrimLastSeconds (a
// handful of frames, every tick) this can mean thousands at once, so it
// goes through dbDeleteMany's single transaction instead of removeFrame's
// one-transaction-per-frame -- that isn't just slow at this scale, it can
// starve any IndexedDB request made afterwards (e.g. the dataset editor's
// next preview fetch) behind a queue of thousands of pending deletes.
// Async and meant to be awaited for the same reason: the caller must not
// touch IndexedDB again (like fetching a new preview frame) until this
// has actually finished.
export async function tubTrimToLength(keepCount) {
  const removed = [];
  while (tub.frames.length > keepCount) removed.push(tub.frames.pop());
  if (!removed.length) return;
  for (const r of removed) {
    r.trimmed = true;
    tub.bins[binIndex(r.steer)]--;
  }
  // Frames still mid-encode this session must land in IndexedDB before
  // they can be deleted from it; already-persisted frames (the common
  // case for a historical cleanup like this) have no such promise.
  await Promise.all(removed.filter(r => r.persistDone).map(r => r.persistDone));
  try {
    await dbDeleteMany(removed.map(r => r.id));
  } catch (err) {
    console.warn('tub: failed to delete frames', err);
  }
}

// Restores frames recorded in previous sessions so the tub actually
// persists, rather than IndexedDB silently accumulating data nothing
// ever reads back. Deliberately not awaited by the caller -- the sim
// starts driving immediately, recording just stays paused (tubPush
// no-ops) until this resolves, which is normally near-instant.
export async function loadTub() {
  let records = [];
  try {
    records = await dbGetAll();
  } catch (err) {
    console.warn('tub: failed to load persisted frames, starting empty', err);
  }
  records.sort((a, b) => a.id - b.id);
  for (const r of records) {
    tub.frames.push({ id: r.id, t: r.t, steer: r.steer, throttle: r.throttle });
    tub.bins[binIndex(r.steer)]++;
    if (r.id >= nextId) nextId = r.id + 1;
  }
  tub.loaded = true;
}

// Lets tests wait until all in-flight image/blob writes have either landed
// in IndexedDB or been trimmed away. This makes persistence assertions
// deterministic when several tests share the same browser page state.
export async function waitForTubIdle() {
  while (pendingWork.size) {
    await Promise.allSettled([...pendingWork]);
  }
}

// Replaces both copies of a dataset together. Imported records already have
// their PNG blobs attached, so one IndexedDB transaction keeps a partial
// import from being visible to the rest of the app.
export async function replaceTub(records) {
  await waitForTubIdle();
  await dbReplaceAll(records);
  tub.frames.length = 0;
  tub.bins.fill(0);
  nextId = 0;
  for (const r of records.sort((a, b) => a.id - b.id)) {
    tub.frames.push({ id: r.id, t: r.t, steer: r.steer, throttle: r.throttle });
    tub.bins[binIndex(r.steer)]++;
    if (r.id >= nextId) nextId = r.id + 1;
  }
  tub.loaded = true;
}

export async function appendTub(records) {
  await waitForTubIdle();
  await dbPutMany(records);
  for (const r of records) {
    tub.frames.push({ id: r.id, t: r.t, steer: r.steer, throttle: r.throttle });
    tub.bins[binIndex(r.steer)]++;
    if (r.id >= nextId) nextId = r.id + 1;
  }
  tub.loaded = true;
}
