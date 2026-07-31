import { V, cte, offTrack, throttleVis } from './car.js';

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
