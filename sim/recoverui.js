import { recovery, startRecovery, stopRecovery } from './recovery.js';
import { dismissHint } from './input.js';

// ---------- recovery-dataset generator toggle ----------
const btn = document.getElementById('recoverBtn');
const empty = document.getElementById('recoverEmpty');
const stats = document.getElementById('recoverStats');
const episodesEl = document.getElementById('recEpisodes');
const successEl = document.getElementById('recSuccesses');
const framesEl = document.getElementById('recFrames');
const phaseEl = document.getElementById('recPhase');

btn.addEventListener('click', () => {
  dismissHint();
  if (recovery.active) stopRecovery(); else startRecovery();
});

// Immediate-mode like pilotui.js's drawPilot: called every frame from the
// main loop, on/off chrome only touched on an actual state change, the
// live counters refreshed every frame while running.
let drawnActive = null;
export function drawRecover() {
  if (recovery.active !== drawnActive) {
    drawnActive = recovery.active;
    btn.classList.toggle('on', recovery.active);
    btn.textContent = recovery.active ? 'generating · stop' : 'start recovery generation';
    empty.hidden = recovery.active;
    stats.hidden = !recovery.active;
  }
  if (recovery.active) {
    episodesEl.textContent = String(recovery.episodes);
    successEl.textContent = String(recovery.successes);
    framesEl.textContent = String(recovery.frames);
    phaseEl.textContent = recovery.phase;
  }
}
