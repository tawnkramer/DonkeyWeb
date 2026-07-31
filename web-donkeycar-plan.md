# Web Donkeycar — Project Plan

**Working name:** donkey.web (placeholder)
**Goal:** A zero-install, browser-first donkeycar experience. Drive → Train → Autopilot in under 5 minutes, no downloads, no Python environment, no Unity install. Serve as both an onboarding funnel for donkeycar and a standalone learning tool.

---

## 1. Vision & Success Criteria

The core loop, all in one browser tab:

1. **Drive** — Hit Go. A car appears on a track. Steer with arrow keys / WASD / touch / gamepad. Camera view records automatically.
2. **Train** — Hit Train. A small CNN trains on your recorded frames. Loss curve animates live.
3. **Test** — Hit Autopilot. The model you just trained steers the car. You watch it succeed (or hilariously fail), collect more data, retrain.
4. **Graduate** — Export your model in donkeycar-compatible format, or click through to install the real thing.

Success criteria:
- First drivable frame in **< 10 seconds** from page load on a mid-range laptop.
- Full loop (drive 2 laps → train → autopilot) completable in **< 5 minutes**.
- Trained model achieves recognizable lane-following on the sim track.
- Model weights exportable to a real donkeycar (same architecture as the `linear` model).
- Works in Chrome/Edge/Firefox/Safari desktop; degraded-but-functional on tablets.

---

## 2. Architecture Overview

**Everything client-side.** No backend for the MVP. Static hosting (GitHub Pages / Netlify / Cloudflare Pages).

```
┌─────────────────────────────────────────────────┐
│ Browser Tab                                     │
│                                                 │
│  ┌───────────┐   frames +    ┌──────────────┐   │
│  │  Sim      │──controls────▶│  Recorder    │   │
│  │ (three.js)│   @20 Hz      │ (IndexedDB)  │   │
│  └─────▲─────┘               └──────┬───────┘   │
│        │ steering/throttle          │ dataset   │
│  ┌─────┴─────┐               ┌──────▼───────┐   │
│  │ Autopilot │◀────weights───│  Trainer     │   │
│  │ (tfjs)    │               │ (tfjs WebGPU │   │
│  └───────────┘               │  /WebGL)     │   │
│                              └──────────────┘   │
└─────────────────────────────────────────────────┘
```

### 2.1 Simulator: purpose-built three.js (not Unity WebGL)

Decision: **rebuild lightweight rather than port sdsandbox.**

Rationale:
- Unity WebGL builds are 30–100 MB+, kill the <10s load target, and have poor mobile support.
- The sim only needs to be *donkey-like*, not physically exact: a kinematic bicycle model + simple tire slip is plenty for lane-following behavior cloning.
- Full control over the render pipeline lets us render the "car camera" at exactly 160×120 (donkeycar native) into an offscreen framebuffer every frame, cheaply.

Sim components:
- **Track**: start with a faithful recreation of the sdsandbox "generated road" / warehouse-style track. Tracks defined as spline + width + texture data (JSON), so community tracks are easy later. 2–3 tracks at launch (simple oval, warren track–style, mini monaco–style).
- **Vehicle**: kinematic bicycle model with steering rate limits, throttle→acceleration curve, light lateral slip. Tuned to *feel* like the donkey sim car. Fixed timestep physics (50 Hz) decoupled from render.
- **Cameras**: chase cam for the user (main canvas) + car POV cam rendered to 160×120 offscreen target (this is the training input, also shown as picture-in-picture so users see "what the model sees").
- **Visual style**: low-poly, flat/toon shading. Loads fast, looks intentional, and — importantly — high-contrast lane lines that behavior cloning can learn from quickly.
- **Determinism**: seeded spawn positions and optional "ghost replay" of recorded runs.

### 2.2 Data recording

- While driving, capture per frame at 20 Hz: 160×120 RGB image (from POV framebuffer, stored as compressed JPEG blob), steering [-1,1], throttle [0,1], timestamp, lap/segment id.
- Store in **IndexedDB** as a "tub" (mirror donkeycar's tub concept and naming — familiarity matters).
- Live counter UI: frames collected, estimated dataset quality (e.g. steering distribution histogram so users learn why "all straight" data trains badly — sneaky pedagogy).
- Tools: delete last N seconds ("I crashed"), clear tub, multiple named tubs.
- Export tub as a zip in real donkeycar tub format (catalog + images) so the browser data can be used in a real donkeycar training pipeline too.

### 2.3 Training: TensorFlow.js

- **Model**: replicate donkeycar's `KerasLinear` architecture exactly (5 conv layers → flatten → dense → 2 outputs for steering/throttle, or steering-only mode for simplicity). Exact layer parity is what makes weight export to real cars possible.
- **Backend**: WebGPU where available, WebGL fallback, WASM last resort. Train in a **Web Worker** (offscreen) so UI never jankd.
- **UX**: live loss chart (train + val), sample predictions overlaid on validation frames ("model thinks: steer left 0.3, you steered left 0.4"), early-stop button, epochs/lr behind an "advanced" flap — defaults just work.
- **Augmentation** (cheap, big win): horizontal flip with steering negation, brightness jitter, random crop. All doable on-GPU in tfjs.
- Target: 3–5k frames, ~10 epochs, **< 60 s** on a 2020-era laptop GPU.

### 2.4 Autopilot & evaluation

- Run inference in the render loop (tfjs, same backend). At 160×120 this is sub-5ms — easily 20 Hz.
- Fun/teaching features:
  - **Steering needle overlay**: model output vs. your live input (you can "shadow drive").
  - **Intervention mode**: autopilot drives, your key presses override and get recorded — this is DAgger-lite, and it genuinely fixes models fast. Big differentiator.
  - Auto-metrics: laps completed, mean cross-track error (we know ground truth from the spline!), crash count. "Your model: 2 clean laps, avg 12 cm off-center."
- Ghost mode: race your model.

### 2.5 Export / graduation path

- **Export weights** as JSON/binary + a tiny Python script (in the zip) that reconstructs the Keras model and loads them → drop into donkeycar, run on a real car. Architecture parity makes this a weight-copy, not a conversion.
- Export tub in donkeycar format (see 2.2).
- "Next steps" page: link to donkeycar install, sdsandbox, hardware guide. The web app is the top of the funnel.

---

## 3. What We Deliberately Skip (MVP)

- ❌ Backend/accounts/cloud training — client-only keeps cost at ~$0 and privacy trivial.
- ❌ Multiplayer/racing — great v2, not needed for the loop.
- ❌ Full physics fidelity, LIDAR/IMU sim, RL — behavior cloning only.
- ❌ Unity/sdsandbox WebGL port — revisit only if the three.js sim can't feel right.
- ❌ Mobile-first — touch should *work*, but desktop is the target.

---

## 4. Milestones

**M0 — Feel prototype (1–2 weeks)**
Three.js track + drivable car + POV render at 160×120. Tune until driving feels good. *Everything depends on the car feeling fun.*

**M1 — Record & train (1–2 weeks)**
IndexedDB tub, 20 Hz capture, tfjs KerasLinear clone, worker training, live loss chart. Prove: hand-driven laps → model that steers plausibly.

**M2 — The loop (1 week)**
Autopilot mode, needle overlay, crash/reset, delete-last-N-seconds, retrain flow. This is the demoable MVP.

**M3 — Polish & pedagogy (1–2 weeks)**
Onboarding tooltips, steering histogram, augmentation toggles, intervention mode, metrics (cross-track error, laps), second track.

**M4 — Graduation (1 week)**
Tub export, weight export + loader script, verified end-to-end on a real donkeycar. Docs page. Launch to donkeycar Discord/community.

---

## 5. Key Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Sim doesn't "feel" like donkey → trained models don't transfer intuition | Medium | M0 is entirely about feel; borrow tuning constants from sdsandbox car config |
| tfjs training too slow on weak/integrated GPUs | High | Small model + 160×120 input; WASM fallback with reduced dataset; show honest time estimate |
| Safari/WebGPU quirks | Medium | WebGL backend is the tested default; WebGPU is progressive enhancement |
| IndexedDB quota (thousands of JPEGs) | Low | JPEG q=0.7 ≈ 5–8 KB/frame → 5k frames ≈ 35 MB; well under quotas; add usage meter |
| Weight export drifts from donkeycar's architecture over donkeycar versions | Medium | Pin to a donkeycar release; CI test that loads exported weights in real Keras |
| Behavior cloning fails for new users (bad data) | High | Pedagogy features (histogram, what-model-sees PiP, intervention mode) exist precisely for this |

---

## 6. Tech Stack Summary

- **Rendering/sim**: three.js, custom kinematic vehicle, fixed-step loop
- **ML**: TensorFlow.js (WebGPU → WebGL → WASM), Web Worker training
- **Storage**: IndexedDB (idb wrapper), zip export via fflate
- **UI**: lightweight — vanilla or Preact/Svelte; one page, three big buttons: **Drive / Train / Autopilot**
- **Hosting**: static (Cloudflare Pages or GitHub Pages), zero server cost
- **Repo layout**: `/sim`, `/train`, `/data`, `/export`, `/tracks` — tracks as data files to invite contributions

---

## 7. Open Questions

1. Steering-only model first (simpler, trains faster, throttle fixed) vs. steering+throttle parity from day one?
2. Recreate sdsandbox tracks visually, or new tracks designed for fast learning (high-contrast lanes)?
3. Should "graduation" also target donkey gym (sim-to-sim) as an intermediate step before real hardware?
4. Name & home: under the donkeycar org? sdsandbox repo? new repo?
5. Telemetry (anonymous, opt-in) to learn where users drop off in the loop?
