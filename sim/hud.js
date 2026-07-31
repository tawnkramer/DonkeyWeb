import { V, cte, offTrack, throttleVis } from './car.js';
import { tub, BINS } from '../data/tub.js';

// ---------- HUD ----------
const el = {
  speed: document.getElementById('tSpeed'),
  steer: document.getElementById('steerfill'),
  throt: document.getElementById('throtfill'),
  cte:   document.getElementById('tCte'),
  cteItem: document.getElementById('cteItem'),
  fps:   document.getElementById('tFps')
};

export function drawHud() {
  el.speed.innerHTML = Math.round(Math.abs(V.speed)*3.6) + '<small>km/h</small>';
  const s = V.steer / V.MAX_STEER; // +1 left … -1 right
  const pct = Math.abs(s)*50;
  el.steer.style.width = pct + '%';
  el.steer.style.left = s > 0 ? (50-pct) + '%' : '50%';
  el.throt.style.width = Math.max(0, throttleVis)*100 + '%';
  el.cte.innerHTML = cte.toFixed(1) + '<small>m</small>';
  el.cteItem.classList.toggle('offtrack', offTrack);
}

export function setFps(fpsA) {
  el.fps.innerHTML = Math.round(fpsA) + '<small>fps</small>';
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
