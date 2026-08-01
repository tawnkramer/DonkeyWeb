import { V, throttleVis } from './car.js';
import { tub } from '../data/tub.js';
import { pilot } from '../train/autopilot.js';
import { getMode } from './mode.js';

// ---------- HUD ----------
const el = {
  metricLabel: document.getElementById('tTelemMetric'),
  metricValue: document.getElementById('tTelemValue'),
  steer: document.getElementById('steerfill'),
  throt: document.getElementById('throtfill'),
  fps:   document.getElementById('tFps'),
  needle: document.getElementById('steerneedle')
};

export function drawHud() {
  const evalMode = getMode() === 'eval';
  el.metricLabel.textContent = evalMode ? 'Speed' : 'Frames';
  el.metricValue.innerHTML = evalMode
    ? Math.round(Math.abs(V.speed) * 3.6) + '<small>km/h</small>'
    : tub.frames.length;
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
}

export function setFps(fpsA, idle) {
  el.fps.classList.toggle('idle', idle);
  el.fps.innerHTML = idle ? 'idle' : Math.round(fpsA) + '<small>fps</small>';
}
