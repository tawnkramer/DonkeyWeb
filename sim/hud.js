import { V, cte, offTrack, throttleVis } from './car.js';
import { tub, BINS } from '../data/tub.js';
import { pilot } from '../train/autopilot.js';

// ---------- HUD ----------
const el = {
  speed: document.getElementById('tSpeed'),
  steer: document.getElementById('steerfill'),
  throt: document.getElementById('throtfill'),
  cte:   document.getElementById('tCte'),
  cteItem: document.getElementById('cteItem'),
  fps:   document.getElementById('tFps'),
  needle: document.getElementById('steerneedle')
};

export function drawHud() {
  el.speed.innerHTML = Math.round(Math.abs(V.speed)*3.6) + '<small>km/h</small>';
  const s = V.steer / V.MAX_STEER; // +1 left … -1 right
  const pct = Math.abs(s)*50;
  el.steer.style.width = pct + '%';
  el.steer.style.left = s > 0 ? (50-pct) + '%' : '50%';
  el.throt.style.width = Math.max(0, throttleVis)*100 + '%';
  // model-opinion needle on the same bar (plan §2.4 "steering needle
  // overlay"): visible whenever a model is loaded, so in manual mode you
  // can shadow-drive against it. +1 = left, same mapping as the fill.
  el.needle.style.display = pilot.ready ? 'block' : 'none';
  if (pilot.ready) el.needle.style.left = (50 - pilot.steer*50) + '%';
  el.cte.innerHTML = cte.toFixed(1) + '<small>m</small>';
  el.cteItem.classList.toggle('offtrack', offTrack);
}

export function setFps(fpsA, idle) {
  el.fps.classList.toggle('idle', idle);
  el.fps.innerHTML = idle ? 'idle' : Math.round(fpsA) + '<small>fps</small>';
}

// ---------- dataset quality ----------
// A live steering histogram, not just a frame count: driving straight for
// a while piles every recorded frame into the center bin, which trains a
// model that never learned to recover once off-center. Seeing that
// imbalance build up while driving is the point.
const recDot = document.getElementById('recDot');
const dFrames = document.getElementById('dFrames');
const dHist = document.getElementById('dHist');
const bars = [];
for (let i = 0; i < BINS; i++) {
  const bar = document.createElement('div');
  bar.className = 'bar';
  dHist.appendChild(bar);
  bars.push(bar);
}

export function drawDataset(isRecording) {
  recDot.classList.toggle('active', isRecording);

  const total = tub.frames.length;
  dFrames.innerHTML = total + '<small>frames</small>';

  const max = Math.max(1, ...tub.bins);
  for (let i = 0; i < BINS; i++) bars[i].style.height = Math.round((tub.bins[i] / max) * 100) + '%';
}
