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

const keymap = {
  ArrowLeft:'left', a:'left', A:'left',
  ArrowRight:'right', d:'right', D:'right',
  ArrowUp:'gas', w:'gas', W:'gas',
  ArrowDown:'brake', s:'brake', S:'brake'
};
function applyKeySteer(){ input.steer = (input.left?1:0) - (input.right?1:0); }
function applyKeyThrottle(){ input.throttle = (input.gas?1:0) - (input.brake?1:0); }

// The "R" reset key doesn't call into car.js directly (that would make
// input.js and car.js import each other); whoever wires up the sim
// registers what "reset" means via onReset.
let resetCallback = null;
export function onReset(cb) { resetCallback = cb; }

addEventListener('keydown', e => {
  if (e.key === 'r' || e.key === 'R') { resetCallback && resetCallback(); return; }
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
  input.steer = Math.max(-1, Math.min(1, -off));
});
const WHEEL_SENSITIVITY = 0.0008; // throttle change per unit of wheel deltaY
addEventListener('wheel', e => {
  input.throttle = Math.max(-1, Math.min(1, input.throttle - e.deltaY * WHEEL_SENSITIVITY));
  e.preventDefault(); dismissHint();
}, {passive:false});

let hintGone = false;
function dismissHint(){ if (!hintGone){ hintGone = true; document.getElementById('hint').classList.add('gone'); } }
