// input.steer is the continuous value the sim actually drives on, in
// [-1,1] (+1 = full left). Keyboard/touch are inherently on/off, which
// produces sparse, bang-bang steering data that's a poor behavior-cloning
// target -- a human on keys tends to hold straight and snap-correct,
// rather than track a continuous line. Mouse position gives a genuinely
// continuous signal instead: input.steer follows the cursor's horizontal
// offset from screen center every time it moves, independent of the
// discrete left/right key state.
// input.throttle is the continuous counterpart to input.steer, in [-1,1]
// (+1 = full gas, -1 = full brake/reverse). Scroll wheel adjusts it like a
// physical accelerator: each tick nudges the level up or down and it
// holds there, rather than needing to be held down like a key.
export const input = {left:false, right:false, gas:false, brake:false, steer:0, throttle:0};

// Several devices can be attached at once -- mouse and keys and a gamepad
// on a desktop, touch sticks and a pad on a tablet -- and they all write
// to the same two numbers. `source` records which device last actually
// MOVED each axis, and that device owns the axis until another one moves
// it: last active wins, no mode switch to remember.
//
// Event-driven sources (keys, mouse, wheel, touch) claim an axis just by
// firing, since they only fire when the user does something. A polled
// source cannot: the gamepad reports a value every single frame whether
// or not anyone is touching it, so a pad resting at 0 would stamp out
// mouse steering 60 times a second. gamepad.js therefore claims an axis
// only when its reading CHANGES, and checks `source` before writing on
// the frames in between -- see the ownership logic there.
export const source = {steer:'none', throttle:'none'};

// The single place either axis gets written, so ownership can't drift out
// of sync with the value. `=== 0 ? 0 : v` normalises -0 to 0 (it prints as
// "-0" and reads oddly in recorded data).
export function setSteer(v, src){ input.steer = v === 0 ? 0 : v; source.steer = src; }
export function setThrottle(v, src){ input.throttle = v === 0 ? 0 : v; source.throttle = src; }

const keymap = {
  ArrowLeft:'left', a:'left', A:'left',
  ArrowRight:'right', d:'right', D:'right',
  ArrowUp:'gas', w:'gas', W:'gas',
  ArrowDown:'brake', s:'brake', S:'brake'
};
function applyKeySteer(){ setSteer((input.left?1:0) - (input.right?1:0), 'key'); }
function applyKeyThrottle(){ setThrottle((input.gas?1:0) - (input.brake?1:0), 'key'); }

// The "R" reset key doesn't call into car.js directly (that would make
// input.js and car.js import each other); whoever wires up the sim
// registers what "reset" means via onReset. requestReset() is the same
// action for devices that aren't the keyboard (the gamepad's Start
// button), so they don't each need their own copy of the callback.
let resetCallback = null;
export function onReset(cb) { resetCallback = cb; }
export function requestReset(){ resetCallback && resetCallback(); }

addEventListener('keydown', e => {
  if (e.key === 'r' || e.key === 'R') { requestReset(); return; }
  const k = keymap[e.key];
  if (k) {
    input[k] = true;
    if (k==='left'||k==='right') applyKeySteer();
    if (k==='gas'||k==='brake') applyKeyThrottle();
    e.preventDefault(); dismissHint();
  }
});
addEventListener('keyup', e => {
  const k = keymap[e.key];
  if (k) {
    input[k] = false;
    if (k==='left'||k==='right') applyKeySteer();
    if (k==='gas'||k==='brake') applyKeyThrottle();
  }
});
document.querySelectorAll('.pbtn').forEach(b => {
  const k = b.dataset.k;
  const on  = e => { e.preventDefault(); input[k] = true; if (k==='left'||k==='right') applyKeySteer(); if (k==='gas'||k==='brake') applyKeyThrottle(); dismissHint(); };
  const off = e => { e.preventDefault(); input[k] = false; if (k==='left'||k==='right') applyKeySteer(); if (k==='gas'||k==='brake') applyKeyThrottle(); };
  b.addEventListener('pointerdown', on);
  b.addEventListener('pointerup', off);
  b.addEventListener('pointerleave', off);
  b.addEventListener('pointercancel', off);
});
const STEER_SENSITIVITY_PX = 260; // mouse distance from center for full lock
addEventListener('mousemove', e => {
  const off = (e.clientX - innerWidth/2) / STEER_SENSITIVITY_PX;
  setSteer(Math.max(-1, Math.min(1, -off)), 'mouse');
});
const WHEEL_SENSITIVITY = 0.0008; // throttle change per unit of wheel deltaY
addEventListener('wheel', e => {
  // Relative to the CURRENT throttle whoever owns it -- taking over from
  // a gamepad trigger held at 0.4 nudges from 0.4, not from wherever the
  // wheel last left off.
  setThrottle(Math.max(-1, Math.min(1, input.throttle - e.deltaY * WHEEL_SENSITIVITY)), 'wheel');
  e.preventDefault(); dismissHint();
}, {passive:false});

let hintGone = false;
export function dismissHint(){ if (!hintGone){ hintGone = true; document.getElementById('hint').classList.add('gone'); } }
document.getElementById('hintClose').addEventListener('click', dismissHint);
