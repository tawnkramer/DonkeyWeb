import { V, cte, offTrack, throttleVis } from './car.js';
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
