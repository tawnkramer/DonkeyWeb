import { setSteer, setThrottle, source, requestReset, dismissHint } from './input.js';

// ---------- gamepad: the closest thing to an RC transmitter ----------
// A physical stick beats every other input here as a behavior-cloning
// source: it is analog end to end, self-centring, and -- unlike the mouse
// -- it has a real mechanical zero, so "hold a steady 30% of right lock
// through this corner" is something a human can actually do. Mouse
// steering was already chosen over keys for continuity (see input.js);
// this is the same argument one step further.
//
// The Gamepad API is POLL-only: there is no "axis moved" event, so this
// module exposes pollGamepads() for the main loop to call once per frame.
// Everything below follows from that -- see the ownership note in
// input.js for why a polled source has to be careful about when it writes.

// Sticks rest off centre on worn hardware, so a deadzone is not optional,
// but it is not free either: everything inside it is travel your thumb
// spends for nothing, and the rest of the throw gets stretched to cover
// full lock. Too wide reads as coarse small corrections -- which is the
// half of the steering signal a cloned policy most needs.
//
// Rescaled rather than clipped: without the rescale the value would jump
// from 0 straight to the deadzone width the instant you leave the dead
// area, a step change in that same small-correction range.
//
// 0.06 is tuned for a DualSense, which self-centres tightly. A worn or
// cheap third-party pad may need this back up around 0.12; that is the
// knob, and gamepad.deadzone below reports what is live.
const STICK_DEADZONE = 0.06;
// Triggers rest at a hard 0 and are much less noisy, so this only needs
// to swallow jitter, not slop.
const TRIGGER_DEADZONE = 0.03;
// How much a reading must change between polls to count as "the user
// moved this", i.e. to claim the axis. Above stick noise, well below any
// deliberate motion.
const MOVE_EPS = 0.02;

export const gamepad = {
  connected: false,
  id: '',
  steer: 0,
  throttle: 0,
  // Which physical control is currently driving throttle: pads differ
  // wildly in what feels right, so both are live at once and whichever
  // the user moves last wins (the same rule as between devices).
  throttleControl: 'triggers',
  // Reported, not just used, so the live value is visible from devtools
  // while tuning it against real hardware -- and so the tests can derive
  // their boundaries from it instead of hardcoding a number that goes
  // stale the next time it moves.
  deadzone: STICK_DEADZONE,
};

// Standard-mapping indices (https://w3c.github.io/gamepad/#remapping).
// Non-standard pads (mapping !== 'standard') are still read on the same
// indices: most report a close-enough layout, and the alternative --
// refusing to work at all -- is worse than an axis in the wrong place
// that the user can see is wrong immediately.
const AXIS_STEER = 0;      // left stick X
const AXIS_THROTTLE = 3;   // right stick Y
const BTN_BRAKE = 6;       // left trigger
const BTN_GAS = 7;         // right trigger
const BTN_RESET = 9;       // start -- the one button that's hard to hit by accident

function deadzone(v, dz) {
  const m = Math.abs(v);
  if (m < dz) return 0;
  return Math.sign(v) * (m - dz) / (1 - dz);
}

// buttons[] entries are objects with an analog .value on real hardware,
// but plain numbers in some synthesized/older shapes -- accept either.
function buttonValue(gp, i) {
  const b = gp.buttons && gp.buttons[i];
  if (b == null) return 0;
  return typeof b === 'number' ? b : (b.value ?? (b.pressed ? 1 : 0));
}

// Previous poll's RAW readings, for the movement test above. null means
// "no pad seen yet": the first poll after a pad appears must only seed
// these, never claim, or a controller resting at a small offset would
// steal steering from the mouse the moment it is plugged in.
let prev = null;
let resetHeld = false;

function seed(gp) {
  prev = {
    steer: gp.axes[AXIS_STEER] ?? 0,
    stick: gp.axes[AXIS_THROTTLE] ?? 0,
    trigger: buttonValue(gp, BTN_GAS) - buttonValue(gp, BTN_BRAKE),
  };
}

// A pad that vanishes mid-drive (battery, cable) must not leave the car
// pinned at its last throttle: hand the axes back at zero. Only axes the
// pad still owns are touched -- if the user has since grabbed the mouse,
// that value is theirs.
function releaseAxes() {
  if (source.steer === 'gamepad') setSteer(0, 'none');
  if (source.throttle === 'gamepad') setThrottle(0, 'none');
}

// Connect/disconnect toast. There is no mode UI to tell you a pad is
// live (last-active-wins means you just pick it up and drive), so this is
// the only feedback that the browser sees the controller at all -- worth
// it, because a pad that never fires a single event looks identical to
// one the browser has not detected. Fades itself out; DOM-in-module
// matches input.js's ownership of the #hint toast.
const toast = document.getElementById('padToast');
let toastTimer = 0;
function showStatus(text) {
  if (!toast) return;
  toast.textContent = text;
  toast.classList.remove('gone');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('gone'), 4000);
}

// Pad names are long and vendor-noisy ("Xbox Wireless Controller
// (STANDARD GAMEPAD Vendor: 045e Product: 02fd)"); the parenthetical is
// never the useful part.
function padName(id) {
  const short = String(id).split('(')[0].trim();
  return short || 'Gamepad';
}

export function pollGamepads() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let gp = null;
  // First connected pad wins; a second controller is ignored rather than
  // fighting the first for the same two axes.
  for (const p of pads) { if (p && p.connected) { gp = p; break; } }

  if (!gp) {
    if (gamepad.connected) {
      gamepad.connected = false;
      gamepad.id = '';
      gamepad.steer = gamepad.throttle = 0;
      prev = null;
      releaseAxes();
      showStatus('Gamepad disconnected');
    }
    return;
  }

  if (!gamepad.connected || gamepad.id !== gp.id) {
    gamepad.connected = true;
    gamepad.id = gp.id;
    seed(gp);
    showStatus(`${padName(gp.id)} · left stick steers · triggers throttle`);
    return; // this poll only established a baseline
  }

  const rawSteer = gp.axes[AXIS_STEER] ?? 0;
  const rawStick = gp.axes[AXIS_THROTTLE] ?? 0;
  const rawTrigger = buttonValue(gp, BTN_GAS) - buttonValue(gp, BTN_BRAKE);

  // Screen/pad coordinates both grow right and down; +1 steer is full
  // LEFT and +1 throttle is forward, so both stick axes get negated --
  // same convention as the mouse and touch sticks. Triggers are already
  // signed the right way (gas positive) by the subtraction above.
  gamepad.steer = -deadzone(rawSteer, STICK_DEADZONE);
  const stickThrottle = -deadzone(rawStick, STICK_DEADZONE);
  const triggerThrottle = deadzone(rawTrigger, TRIGGER_DEADZONE);

  const steerMoved = Math.abs(rawSteer - prev.steer) > MOVE_EPS;
  const stickMoved = Math.abs(rawStick - prev.stick) > MOVE_EPS;
  const triggerMoved = Math.abs(rawTrigger - prev.trigger) > MOVE_EPS;
  prev.steer = rawSteer; prev.stick = rawStick; prev.trigger = rawTrigger;

  if (triggerMoved) gamepad.throttleControl = 'triggers';
  else if (stickMoved) gamepad.throttleControl = 'stick';
  gamepad.throttle = gamepad.throttleControl === 'stick' ? stickThrottle : triggerThrottle;

  // Taking an axis over needs BOTH conditions. Motion alone isn't enough:
  // a pad on the desk drifting a hair past MOVE_EPS would claim steering
  // at 0 and quietly kill the mouse. A non-zero reading alone isn't
  // enough either: a stick parked under a resting hand would re-claim on
  // every poll and fight whatever the user actually switched to. Moving a
  // stick somewhere it can only be on purpose is the unambiguous signal.
  const claimSteer = steerMoved && gamepad.steer !== 0;
  const claimThrottle = (triggerMoved || stickMoved) && gamepad.throttle !== 0;

  // Once claimed, the axis is rewritten every poll for as long as we own
  // it -- that is what makes releasing a stick return the car to centre,
  // since letting go produces no further movement to react to.
  if (claimSteer) dismissHint();
  if (claimSteer || source.steer === 'gamepad') setSteer(gamepad.steer, 'gamepad');

  if (claimThrottle) dismissHint();
  if (claimThrottle || source.throttle === 'gamepad') setThrottle(gamepad.throttle, 'gamepad');

  // Edge-triggered: holding Start must reset once, not every frame.
  const reset = buttonValue(gp, BTN_RESET) > 0.5;
  if (reset && !resetHeld) requestReset();
  resetHeld = reset;
}
