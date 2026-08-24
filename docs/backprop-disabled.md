# Backprop visualizer — disabled, not removed

Status: **disabled in the UI as of 2026-08-23**, at the owner's request,
because it is broken in real use and there was no time to fix it. The code is
untouched and still tested. This is a note-to-self so the thread can be picked
up cold.

## What "disabled" means here

The hamburger entry was the only way in — there is no navbar button for it —
so removing that entry takes the feature off the site without touching
anything it is built from. Three lines in `index.html`, commented out in place
with the restore instructions next to them:

```html
<button class="menuSection" type="button" data-submenu="learn" ...>learn</button>
<div class="menuSubmenu" data-submenu-panel="learn">
  <button class="menuModeBtn" data-mode="learn" role="menuitem">backprop visualizer</button>
</div>
```

Still present and still working: `sim/learnui.js`, `train/backprop.js`,
`sim/sampleframe.js`, `#screenLearn` in `index.html`, and the whole of
`test/backprop.test.js`. `'learn'` is still a valid mode in `sim/mode.js`, so
`__sim.setMode('learn')` opens the screen from devtools — which is what the
tests do, and what a fix would be developed against.

`test/backprop.test.js` asserts the menu entry is **absent**. That is
deliberate: restoring the entry makes the suite fail, which is the right
moment to be reminded this note exists.

## The unhelpful part: the tests do not reproduce it

All 13 tests in `test/backprop.test.js` passed on the commit that disabled the
feature, including the arithmetic ones — one step lowers the loss, `Δw` equals
`−lr × grad` to printed precision, reset is exact, a high rate destabilises,
repeated stepping memorises the frame. So **whatever is broken is outside what
those tests reach.** The symptom was not recorded before the feature was
switched off.

Places the tests are structurally blind, roughly in order of suspicion:

- **Anything only a real GPU shows.** The suite runs on software WebGL
  (`--enable-unsafe-swiftshader`). A real WebGL/WebGPU backend takes different
  kernel paths, and this app already has history here — see the note in memory
  about other Chrome tabs starving WebGL contexts. The sandbox model is a
  second `LayersModel` live in the tab alongside the autopilot's.
- **Anything about a real trained model.** The tests default the picker to
  `fresh`, an untrained random model. The `copy · …` path loads real
  artifacts, and the linear profile is 817k weights against tiny's 62k.
- **Rendering and layout.** Every visual claim was checked by headless
  screenshot, never in the owner's browser. Bar heights, the stagger, the
  horizontal scroll, the frame thumbnail.
- **Long sessions.** Tests take a handful of steps. Tensor count was verified
  flat over 30 steps once, by hand, in a scratch probe that no longer exists.

## First moves when picking this up

1. Get the symptom. Open the screen via `__sim.setMode('learn')` in devtools
   with the menu still removed, and watch the console — the error overlay
   (`window.__errors`) catches uncaught errors on mobile where there is no
   console.
2. Try it against a **copied trained model** on the **linear** profile, which
   is the combination the tests never run.
3. Check `tf.memory().numTensors` across a few dozen steps if it degrades
   rather than failing outright.

Re-enable by uncommenting the block in `index.html` and updating the two
routing tests at the top of `test/backprop.test.js`.
