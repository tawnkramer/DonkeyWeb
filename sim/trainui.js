import { training, trainStart, trainStop, onTraining } from '../train/trainer.js';

// ---------- train panel ----------
// One button and a live loss chart. The chart shows per-batch train loss
// (thin light line) with per-epoch val loss on top (cone orange) -- val
// drifting up while train keeps falling is overfitting made visible,
// same pedagogy-by-UI as the steering histogram above it.
const btn = document.getElementById('trainBtn');
const status = document.getElementById('trainStatus');
const chart = document.getElementById('lossChart');
const ctx = chart.getContext('2d');

const CONE = '#ff6a2b';
const LIGHT = 'rgba(243,239,232,.5)';

btn.addEventListener('click', () => {
  if (training.state === 'running') trainStop();
  else trainStart();
});

function statusText() {
  switch (training.state) {
    case 'idle': return 'idle';
    case 'loading': return training.detail || 'loading';
    case 'running': {
      const cur = Math.min(training.epoch + 1, training.epochsTotal);
      return `${training.backend} · epoch ${cur}/${training.epochsTotal}`;
    }
    case 'done': {
      const last = training.epochLog[training.epochLog.length - 1];
      const val = last && Number.isFinite(last.valLoss) ? `val ${last.valLoss.toFixed(3)} · ` : '';
      return `${val}${Math.round(training.elapsed)}s${training.stopped ? ' · stopped' : ''}`;
    }
    case 'error': return training.error || 'error';
  }
}

function render() {
  status.textContent = statusText();
  status.title = training.state === 'error' ? (training.error || '') : '';
  const busy = training.state === 'loading' || training.state === 'running';
  btn.textContent = training.state === 'running' ? 'stop'
    : training.state === 'done' ? 'retrain'
    : 'train model';
  btn.disabled = training.state === 'loading';
  btn.classList.toggle('running', busy);
  drawChart();
}

// Log-scale y: the first batches' loss dwarfs everything after, and a
// linear axis would flatten the entire interesting tail into one pixel.
function drawChart() {
  const w = chart.width, h = chart.height;
  ctx.clearRect(0, 0, w, h);
  const bl = training.batchLosses;
  const el = training.epochLog;
  if (bl.length < 2) return;

  let lo = Infinity, hi = -Infinity;
  for (const v of bl) if (Number.isFinite(v) && v > 0) { if (v < lo) lo = v; if (v > hi) hi = v; }
  for (const e of el) { const v = e.valLoss; if (Number.isFinite(v) && v > 0) { if (v < lo) lo = v; if (v > hi) hi = v; } }
  if (!Number.isFinite(lo)) return;
  const llo = Math.log10(lo);
  const span = Math.max(Math.log10(hi) - llo, 1e-3);
  const X = (i) => (i / Math.max(bl.length - 1, 1)) * (w - 2) + 1;
  const Y = (v) => h - 2 - ((Math.log10(Math.max(v, 1e-8)) - llo) / span) * (h - 4);

  ctx.strokeStyle = LIGHT;
  ctx.lineWidth = 1;
  ctx.beginPath();
  bl.forEach((v, i) => { if (i) ctx.lineTo(X(i), Y(v)); else ctx.moveTo(X(i), Y(v)); });
  ctx.stroke();

  const ex = (e) => X(Math.min(e.atBatch - 1, bl.length - 1));
  ctx.strokeStyle = CONE;
  ctx.fillStyle = CONE;
  if (el.length > 1) {
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    el.forEach((e, i) => { if (i) ctx.lineTo(ex(e), Y(e.valLoss)); else ctx.moveTo(ex(e), Y(e.valLoss)); });
    ctx.stroke();
  }
  for (const e of el) {
    ctx.beginPath();
    ctx.arc(ex(e), Y(e.valLoss), 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

onTraining(render);
render();
