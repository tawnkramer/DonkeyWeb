import { input, dismissHint } from './input.js';

// ---------- touch sticks: left steers, right throttles ----------
// Both replace on/off buttons with continuous analog input, for the same
// reason mouse steering was chosen over arrow keys: bang-bang input is
// poor behavior-cloning data. The throttle buttons were the worse
// offender -- recording only captures frames with throttle > 0, so every
// recorded frame had throttle pegged at exactly 1.0 and the throttle head
// had nothing to learn from.
//
// Each stick is AXIS-LOCKED: it reads only its own axis and ignores drift
// on the other. A circular 2D gate (clamping the x/y vector's magnitude)
// would bleed sideways thumb wander into the value -- pushing full-up but
// slightly right would cap throttle near 0.7 -- which costs range exactly
// when you're trying to hold a steady value on glass with no tactile
// centre. Locking the axis makes each stick forgiving and full-range.
//
// Pointer Events match the rest of the touch input in input.js;
// setPointerCapture (rather than the old buttons' pointerleave release)
// keeps tracking when the thumb slides past the stick's own bounds, which
// is normal for a stick you're pushing to its limit.
function makeStick(baseId, thumbId, axis, apply) {
  const base = document.getElementById(baseId);
  const thumb = document.getElementById(thumbId);
  if (!base || !thumb) return;

  let activePointerId = null;
  let origin = 0;
  let radius = 1;

  function setThumb(offset) {
    const x = axis === 'x' ? offset : 0;
    const y = axis === 'y' ? offset : 0;
    thumb.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
  }

  function update(client) {
    const delta = Math.max(-radius, Math.min(radius, client - origin));
    setThumb(delta);
    // Screen coordinates grow right and down; both controls want the
    // opposite sign (+1 steer = full LEFT, +1 throttle = forward/UP), so
    // the same negation serves both axes. `|| 0` normalises -0 to 0, as
    // input.js's mousemove handler does.
    const value = -delta / radius;
    apply(value === 0 ? 0 : value);
  }

  base.addEventListener('pointerdown', (e) => {
    activePointerId = e.pointerId;
    // Best-effort: some pointer sources (and any script-synthesized
    // pointer event, e.g. in tests) aren't valid capture targets and throw
    // here -- that must not take out the rest of this handler, which is
    // what computes the initial value below.
    try { base.setPointerCapture(e.pointerId); } catch { /* not critical */ }
    const r = base.getBoundingClientRect();
    // Travel comes from the element's real size, so the CSS is the single
    // source of truth for it -- no constant here to drift out of sync.
    radius = (axis === 'x' ? r.width : r.height) / 2;
    origin = axis === 'x' ? r.left + r.width / 2 : r.top + r.height / 2;
    update(axis === 'x' ? e.clientX : e.clientY);
    dismissHint();
    e.preventDefault();
  });

  base.addEventListener('pointermove', (e) => {
    if (e.pointerId !== activePointerId) return;
    update(axis === 'x' ? e.clientX : e.clientY);
    e.preventDefault();
  });

  // Spring-return: releasing centres the stick and zeroes its value, so
  // letting go of throttle coasts to a stop rather than latching.
  function release(e) {
    if (e.pointerId !== activePointerId) return;
    activePointerId = null;
    setThumb(0);
    apply(0);
  }
  base.addEventListener('pointerup', release);
  base.addEventListener('pointercancel', release);
}

makeStick('joystick', 'joyThumb', 'x', (v) => { input.steer = v; });
// Pulling the throttle stick below centre goes negative, which car.js
// already reads as brake-then-reverse.
makeStick('throttleStick', 'throttleThumb', 'y', (v) => { input.throttle = v; });
