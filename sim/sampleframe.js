import { tub } from '../data/tub.js';
import { dbGet } from '../data/db.js';
import { PROFILES, DEFAULT_PROFILE } from '../train/model.js';
import { getMode, onModeChange } from './mode.js';

// ---------- the frame under study ----------
// Which recorded frame the app is currently explaining itself with. Two
// screens ask that question -- Train's saliency map and Learn's backprop
// stage -- and they must not answer it differently: scrubbing to a corner on
// one and then finding the other parked on a straight is the kind of thing
// that makes a teaching tool untrustworthy.
//
// This lives outside both of them rather than in either, because a UI module
// importing state out of a sibling UI module has no obvious direction. Same
// shape as mode.js: one owner, a push subscription, no polling.
//
// The picker is the page's own, not the worker's: tub.frames already holds
// every recorded frame's steering and throttle in memory, and the image for
// any one of them is a single dbGet away. So scrubbing works before a model
// exists, and once one does it still never waits on the worker for the
// picture -- only for the reading the worker alone can give.
let frameIdx = 0;         // position in tub.frames
let bitmap = null;        // decoded picture for frameIdx, at model input size
let drawSeq = 0;          // abandons decodes the thumb has moved past
let profile = DEFAULT_PROFILE;

export const sampleFrame = {
  get index() { return frameIdx; },
  get count() { return tub.frames.length; },
  get frame() { return tub.frames[frameIdx] || null; },
  get bitmap() { return bitmap; },
  get profile() { return profile; },
};

// Decode size follows the training profile, so what is on screen is what the
// network would actually be fed. Set by trainui from its profile picker.
export function setSampleProfile(next) {
  if (!PROFILES[next] || next === profile) return;
  profile = next;
  showFrame(frameIdx, { ask: false });
}

// Subscribers get the current frame immediately on subscribing: module import
// order means a listener can register after the opening frame was already
// shown, and it would otherwise sit blank until the next scrub.
//
// The bitmap handed over is the live one -- showFrame() closes a bitmap only
// once its replacement has arrived, so it stays valid until the next frame is
// emitted. Subscribers must read it at point of use and never hold a captured
// reference across an await.
const listeners = new Set();
export function onSampleFrame(fn) {
  listeners.add(fn);
  if (bitmap && sampleFrame.frame) fn(event(true));
}

// `ask` distinguishes a deliberate move from one made to catch up with
// something else. Only the first should cost a gradient pass.
function event(ask) {
  return { frame: sampleFrame.frame, bitmap, profile, ask };
}

export async function showFrame(idx, { ask = true } = {}) {
  if (!tub.frames.length) return;
  frameIdx = Math.max(0, Math.min(tub.frames.length - 1, idx));
  const frame = sampleFrame.frame;
  // Numbers and slider positions move before any I/O; only the picture waits.
  for (const fn of listeners) fn({ ...event(ask), bitmap: null, pending: true });
  const seq = ++drawSeq;
  const next = await decode(frame.id);
  if (seq !== drawSeq) { if (next) next.close(); return; } // scrubbed past
  if (bitmap) bitmap.close();
  bitmap = next;
  for (const fn of listeners) fn(event(ask));
}

// Decoded to the model's input size rather than the recorded size, because
// the claim being made is that this is what the network sees -- and the
// saliency overlay is one byte per input pixel, so anything else would fail
// to register with it.
async function decode(id) {
  try {
    const rec = await dbGet(id);
    if (!rec || !rec.img) return null;
    const src = await createImageBitmap(rec.img);
    const { w, h } = PROFILES[profile] || PROFILES[DEFAULT_PROFILE];
    const out = await createImageBitmap(src, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' });
    src.close();
    return out;
  } catch (err) {
    console.warn('sample frame: could not decode', id, err);
    return null;
  }
}

// Opening frame, same rule the worker uses when the page has not chosen one:
// the sharpest turn in the recording, because a frame where the car is barely
// steering has no decision in it to explain. Re-evaluated whenever a screen
// that studies frames is opened, since a few more laps may have been recorded
// since -- but never once the user has scrubbed somewhere deliberately.
let picked = false;
export function ensureOpeningFrame() {
  if (picked || !tub.frames.length) return;
  picked = true;
  let best = 0;
  for (let i = 1; i < tub.frames.length; i++) {
    if (Math.abs(tub.frames[i].steer) > Math.abs(tub.frames[best].steer)) best = i;
  }
  showFrame(best);
}

// The tub can fill up after one of these screens is already open: loadTub()
// resolves asynchronously at startup, and "load dataset" adds frames with no
// mode change to react to. A one-shot attempt on entry would leave the screen
// sitting on its empty state with a full tub behind it, so keep asking until
// there is something to show or the user leaves.
const studying = () => getMode() === 'train' || getMode() === 'learn';
let waiting = null;
function wantOpeningFrame() {
  ensureOpeningFrame();
  if (picked || waiting) return;
  waiting = setInterval(() => {
    ensureOpeningFrame();
    if (picked || !studying()) { clearInterval(waiting); waiting = null; }
  }, 400);
}

onModeChange((mode) => { if (mode === 'train' || mode === 'learn') wantOpeningFrame(); });
if (studying()) wantOpeningFrame();
