import { input, dismissHint } from './input.js';

// ---------- touch joystick (steering only) ----------
// Pointer Events, matching the rest of the touch input in input.js.
// Uses setPointerCapture rather than the d-pad buttons' pointerleave-based
// release: a joystick is meant to be dragged past its own visual bounds
// while still tracking, which pointerleave would cut off early.
const JOY_RADIUS_PX = 48; // half of #joystick's 96px diameter
const base = document.getElementById('joystick');
const thumb = document.getElementById('joyThumb');

let activePointerId = null;
let originX = 0, originY = 0;

function setThumb(dx, dy) {
  thumb.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
}

// Only the clamped X displacement drives steer; Y still feeds the thumb's
// visual position (so a diagonal drag feels like a real stick) but never
// throttle -- that stays on the existing separate gas/brake buttons.
function updateFromPointer(clientX, clientY) {
  const dx = clientX - originX, dy = clientY - originY;
  const dist = Math.min(Math.hypot(dx, dy), JOY_RADIUS_PX);
  const angle = Math.atan2(dy, dx);
  const cx = Math.cos(angle) * dist, cy = Math.sin(angle) * dist;
  setThumb(cx, cy);
  // Same sign convention as input.js's mousemove handler: drag right ->
  // negative steer -> right turn (+1 steer = full left).
  const steer = Math.max(-1, Math.min(1, -cx / JOY_RADIUS_PX));
  input.steer = steer === 0 ? 0 : steer;
}

function release(e) {
  if (e.pointerId !== activePointerId) return;
  activePointerId = null;
  input.steer = 0;
  setThumb(0, 0);
}

base.addEventListener('pointerdown', e => {
  activePointerId = e.pointerId;
  // Best-effort: some pointer sources (and any script-synthesized pointer
  // event, e.g. in tests) aren't valid capture targets and throw here --
  // that shouldn't take out the rest of this handler, which is what
  // actually computes the initial steer value below.
  try { base.setPointerCapture(e.pointerId); } catch { /* not critical */ }
  const r = base.getBoundingClientRect();
  originX = r.left + r.width / 2;
  originY = r.top + r.height / 2;
  updateFromPointer(e.clientX, e.clientY);
  dismissHint();
  e.preventDefault();
});
base.addEventListener('pointermove', e => {
  if (e.pointerId !== activePointerId) return;
  updateFromPointer(e.clientX, e.clientY);
  e.preventDefault();
});
base.addEventListener('pointerup', release);
base.addEventListener('pointercancel', release);
