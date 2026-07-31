import { povCanvas } from '../sim/scene.js';
import { dbPut, dbDelete, dbGetAll } from './db.js';

// ---------- recording (tub) ----------
// Frames persist to IndexedDB so the tub survives a reload -- see
// loadTub() below. steer/throttle are recorded as the raw driver-
// commanded values (matching what a real donkeycar tub records -- the
// PWM command, not the resulting vehicle state), which is also what's
// already continuous thanks to mouse/wheel input.
//
// tub.frames holds lightweight metadata only (no image); images live in
// IndexedDB and are fetched on demand (export, viewing a frame later),
// so an hour of driving doesn't also duplicate tens of MB of JPEGs in JS
// memory on top of what's already on disk.

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

export function tubPush(t, steer, throttle) {
  // Guards against an id collision with frames loadTub() hasn't restored
  // yet (nextId isn't known-correct until that finishes) -- recording
  // just doesn't start until the restore completes, which is normally
  // well under the time it takes a human to start driving after load.
  if (!tub.loaded) return;

  const id = nextId++;
  const frame = { id, t, steer, throttle };
  tub.frames.push(frame);
  tub.bins[binIndex(steer)]++;

  povCanvas.toBlob(blob => {
    // If this frame got trimmed (off-track) before its JPEG finished
    // encoding, don't let the DB write resurrect it after the fact.
    if (frame.trimmed) return;
    dbPut({ id, t, steer, throttle, img: blob }).catch(err => console.warn('tub: failed to persist frame', err));
  }, 'image/jpeg', 0.7);
}

export function tubTrimLastSeconds(seconds, simTime) {
  const cutoff = simTime - seconds;
  while (tub.frames.length && tub.frames[tub.frames.length - 1].t > cutoff) {
    const removed = tub.frames.pop();
    removed.trimmed = true;
    tub.bins[binIndex(removed.steer)]--;
    dbDelete(removed.id).catch(err => console.warn('tub: failed to delete frame', err));
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
