import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupSimPage, waitFor } from './helpers.js';

// The backprop panel makes claims on screen that are only worth making if
// they are true of the actual arithmetic underneath: that one step lowers
// the loss on the frame it stepped on, that reset puts the weights back
// exactly, and that too large a learning rate makes things worse rather than
// better. Each of those is a sentence in the Explain panel, so each gets a
// test -- if the numbers stop backing the prose, the prose is the bug.
//
// Deliberately cheap, unlike training.test.js: one frame, a batch of one, the
// tiny profile, a handful of steps. This runs in the default suite.
let page, teardown;

before(async () => {
  ({ page, teardown } = await setupSimPage());
  // Reduced motion collapses the per-column stagger to a single synchronous
  // paint, so the DOM is settled the moment advance() resolves -- and it
  // exercises the reduced-motion path while it is here.
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
});
after(() => teardown());

async function setupPanel() {
  await page.evaluate(async () => {
    const { tubPush, waitForTubIdle } = await import('/data/tub.js');
    for (let i = 0; i < 6; i++) tubPush(i * 0.05, Math.sin(i) * 0.6, 0.5);
    await waitForTubIdle();
    __sim.setMode('learn');
  });
  // A fresh random model rather than a copy: it needs no artifacts to load and
  // its error is large enough that one step moves it unmistakably.
  await waitFor(page, () => !!document.getElementById('bpSource'), { message: 'panel never mounted' });
  await page.evaluate(() => {
    const select = document.getElementById('bpSource');
    select.value = 'fresh';
    select.dispatchEvent(new Event('change'));
  });
  await waitFor(page, () => window.__sim.learn.ready, {
    timeout: 30000, message: 'the sandbox never became ready',
  });
}

const advance = (n) => page.evaluate(async (count) => {
  for (let i = 0; i < count; i++) await __sim.learn.advance();
}, n);

const lossText = () => page.evaluate(() => document.getElementById('bpLoss').textContent);

// The visualizer is DISABLED (see docs/backprop-disabled.md). The hamburger
// entry was its only way in, so removing that entry is the whole switch --
// and this test is the switch's position, asserted rather than assumed. It
// fails if the menu item comes back, which is the right moment to be
// reminded that the rest of this file, and the note in docs/, describe a
// feature users cannot currently reach.
//
// Everything below still runs against the screen directly, so the coverage
// stays alive for whoever picks the fix up.
test('the visualizer is unreachable from the UI while disabled', async () => {
  await page.evaluate(() => __sim.setMode('drive'));
  await page.click('#modelMenuBtn');

  const menu = await page.evaluate(() => ({
    section: !!document.querySelector('[data-submenu="learn"]'),
    item: !!document.querySelector('.menuModeBtn[data-mode="learn"]'),
    // The screen itself is untouched -- disabling is a routing change, not a
    // teardown, so re-enabling stays a three-line edit.
    screenExists: !!document.getElementById('screenLearn'),
  }));
  assert.equal(menu.section, false, 'the learn menu section should be gone while disabled');
  assert.equal(menu.item, false, 'the backprop menu item should be gone while disabled');
  assert.equal(menu.screenExists, true, 'the screen should still exist, just be unrouted');
  await page.evaluate(() => { document.getElementById('modelMenu').classList.remove('open'); });
});

// Reached directly, the way the tests below and a re-enabled menu both do.
test('the screen still works when opened directly', async () => {
  await page.evaluate(() => __sim.setMode('learn'));
  const state = await page.evaluate(() => ({
    mode: document.body.dataset.mode,
    shown: getComputedStyle(document.getElementById('screenLearn')).display,
    // With nothing recorded there is no frame to step, and the page has to
    // say so rather than showing an empty stage.
    empty: !document.getElementById('learnEmpty').hidden,
    panelHidden: document.getElementById('backpropPanel').hidden,
    // It must not have been left behind on the Train screen.
    onTrainScreen: !!document.querySelector('#screenTrain #backpropPanel'),
  }));
  assert.equal(state.mode, 'learn');
  assert.equal(state.shown, 'block', 'the Learn screen should be visible');
  assert.equal(state.empty, true, 'expected the "drive a lap first" message');
  assert.equal(state.panelHidden, true, 'the stage should stay hidden with no frame');
  assert.equal(state.onTrainScreen, false, 'the panel should not be on the Train screen');
});

// Regression: the screen retries until it has a PICTURE, not merely until a
// frame exists. tubPush() appends to tub.frames synchronously but encodes the
// PNG and writes it to IndexedDB afterwards, so for a few milliseconds there
// is a frame that cannot be read back. Latching the opening pick on that left
// the stage permanently blank with a full tub behind it -- and because the
// retry loop considered itself satisfied, nothing ever went back for it.
//
// Recording while ALREADY on the screen is what makes the window reachable,
// which is exactly what "load dataset" does.
test('a frame recorded while the screen is open still gets its picture', async () => {
  await page.evaluate(() => __sim.setMode('learn'));
  await page.evaluate(async () => {
    const { tubPush } = await import('/data/tub.js');
    // Deliberately NOT awaiting waitForTubIdle(): the point is to be looking
    // at the screen during the window where the frame exists and its image
    // does not.
    for (let i = 0; i < 8; i++) tubPush(i * 0.05, Math.sin(i) * 0.8, 0.5);
  });

  await waitFor(page, () => {
    const canvas = document.getElementById('bpFrame');
    return canvas && canvas.width > 0 && canvas.height > 0;
  }, { timeout: 15000, message: 'the frame thumbnail never arrived after an in-place recording' });

  const shown = await page.evaluate(() => ({
    empty: !document.getElementById('learnEmpty').hidden,
    panelHidden: document.getElementById('backpropPanel').hidden,
    tag: document.getElementById('bpFrameTag').textContent,
  }));
  assert.equal(shown.empty, false, 'the empty-state message should have gone away');
  assert.equal(shown.panelHidden, false, 'the stage should be showing');
  assert.match(shown.tag, /\/ 8$/, `expected the picker to span the recording, got "${shown.tag}"`);
});

test('the panel draws a column per layer, plus the frame and the error', async () => {
  await setupPanel();
  const counts = await page.evaluate(() => ({
    columns: document.querySelectorAll('#bpLayers .bpCol').length,
    layers: __sim.learn.sandbox.columns.length,
    input: document.querySelectorAll('#bpLayers .bpColInput').length,
    error: document.querySelectorAll('#bpLayers .bpColError').length,
  }));
  assert.equal(counts.input, 1, 'expected one frame column');
  assert.equal(counts.error, 1, 'expected one error column');
  assert.equal(counts.columns, counts.layers + 2, 'every layer should get a column');
});

test('no error is drawn until the output meets the label', async () => {
  await page.evaluate(() => __sim.learn.reset());
  await advance(1); // act 1: forward only

  const afterForward = await page.evaluate(() => ({
    act: __sim.learn.act,
    activationBars: [...document.querySelectorAll('#bpLayers .bpTrackAct .bpFill')]
      .map((el) => parseFloat(el.style.height) || 0),
    errorBars: [...document.querySelectorAll('#bpLayers .bpColError .bpFill')]
      .map((el) => parseFloat(el.style.height) || 0),
  }));
  assert.equal(afterForward.act, 'forward');
  assert.ok(afterForward.activationBars.some((h) => h > 0), 'forward pass should raise activation bars');
  assert.ok(afterForward.errorBars.every((h) => h === 0),
    `error bars must stay at zero through the forward pass, got ${JSON.stringify(afterForward.errorBars)}`);

  await advance(1); // act 2: compare
  const errorBars = await page.evaluate(() => [...document.querySelectorAll('#bpLayers .bpColError .bpFill')]
    .map((el) => parseFloat(el.style.height) || 0));
  assert.ok(errorBars.some((h) => h > 0), 'the error appears once the prediction meets the label');
});

test('the backward pass reports a finite gradient for every weighted layer', async () => {
  await advance(1); // act 3: backward
  const grads = await page.evaluate(() => ({
    act: __sim.learn.act,
    bars: [...document.querySelectorAll('#bpLayers .bpTrackGrad .bpFill')]
      .map((el) => parseFloat(el.style.height)),
    weighted: __sim.learn.sandbox.columns.filter((c) => c.params > 0).length,
  }));
  assert.equal(grads.act, 'backward');
  assert.equal(grads.bars.length, grads.weighted, 'one gradient bar per weighted layer');
  assert.ok(grads.bars.every(Number.isFinite), `non-finite gradient bar in ${JSON.stringify(grads.bars)}`);
  assert.ok(grads.bars.some((h) => h > 0), 'at least one layer should carry gradient');
});

test('one step lowers the loss on the frame it stepped on', async () => {
  await page.evaluate(() => { __sim.learn.reset(); __sim.learn.setLr(0.01); });
  await advance(2); // act 1 forward, act 2 compare -- the loss appears at 2
  const before = Number(await lossText());
  assert.ok(Number.isFinite(before) && before > 0, `expected a real starting loss, got ${before}`);

  // One full lap of the cycle: backward, update, forward, compare. Landing
  // back on act 2 is the point -- the shrink shows up in the same place the
  // error first appeared, not in a special finale act.
  await advance(4);
  const after = Number(await lossText());
  const state = await page.evaluate(() => ({ act: __sim.learn.act, steps: __sim.learn.steps }));

  assert.equal(state.act, 'error');
  assert.equal(state.steps, 1, 'exactly one weight update should have been applied');
  assert.ok(after < before, `loss should fall after a step: ${before} -> ${after}`);
});

test('the applied step is the gradient scaled by the learning rate', async () => {
  const line = await page.evaluate(() => document.getElementById('bpWeight').textContent);
  // e.g. "n_outputs1: one weight 0.23938 - 0.01 x -4.76e-2 -> 0.24986"
  const numbers = line.match(/-?\d+\.\d+(e[-+]\d+)?/gi) || [];
  assert.ok(numbers.length >= 4, `expected a before/rate/gradient/after readout, got "${line}"`);
  const [before, rate, grad, after] = numbers.map(Number);
  // Tolerance comes from what the line PRINTS, not from the arithmetic: the
  // weights are shown to 5 decimals and the gradient to 4 significant
  // figures, so two roundings and a truncated multiplicand is the floor on
  // how well the readout can reconcile with itself.
  const tolerance = Math.abs(rate * grad) * 1e-3 + 2e-5;
  assert.ok(Math.abs((after - before) - (-rate * grad)) < tolerance,
    `the printed weight change should equal -rate x gradient: ${before} -> ${after}, rate ${rate}, grad ${grad}`);
});

test('reset puts the weights back exactly', async () => {
  await page.evaluate(() => __sim.learn.reset());
  await advance(2); // the loss is published at act 2, not act 1
  const restored = Number(await lossText());
  await advance(4);
  const stepped = Number(await lossText());
  assert.ok(stepped < restored, 'sanity: the second step should also help');

  await page.evaluate(() => __sim.learn.reset());
  await advance(2);
  const again = Number(await lossText());
  assert.equal(again, restored, `reset should reproduce the starting loss exactly: ${restored} vs ${again}`);
  assert.equal(await page.evaluate(() => __sim.learn.steps), 0, 'reset should zero the step counter');
});

// The Explain panel says the top of the slider makes the loss bounce rather
// than fall, and can send it to infinity. That is the claim worth pinning --
// NOT "one step makes it worse", which is measurably not true: a big step
// overshoots the minimum and often lands somewhere better by accident. It is
// the instability that is reliable, so it is the instability that is tested.
async function lossOverSteps(rate, steps) {
  await page.evaluate((r) => { __sim.learn.reset(); __sim.learn.setLr(r); }, rate);
  await advance(2); // forward, compare -- the loss is published at act 2
  const series = [Number(await lossText())];
  // Four acts is one step, every time, and lands back on the comparison.
  for (let i = 0; i < steps; i++) {
    await advance(4);
    series.push(Number(await lossText()));
  }
  return series;
}

test('a rate at the bottom of the range descends smoothly, every step', async () => {
  const series = await lossOverSteps(0.01, 5);
  for (let i = 1; i < series.length; i++) {
    assert.ok(series[i] < series[i - 1],
      `a small rate should fall on every step, but ${series[i - 1]} -> ${series[i]} in ${JSON.stringify(series)}`);
  }
});

test('a rate at the top of the range overshoots instead of descending', async () => {
  const series = await lossOverSteps(0.5, 5);
  const roseSomewhere = series.some((v, i) => i > 0 && !(v < series[i - 1]));
  assert.ok(roseSomewhere,
    `a rate of 0.5 should overshoot rather than descend cleanly, got ${JSON.stringify(series)}`);
});

// Switching the picker disposes the old sandbox. Its layers are shared with
// the activation sub-model built over them, so a disposal that reached
// through that reference would take the weights of the model still in use --
// which only shows up on the SECOND switch, once something is there to break.
test('switching the model source rebuilds a working sandbox', async () => {
  const swap = (value) => page.evaluate(async (v) => {
    const select = document.getElementById('bpSource');
    select.value = v;
    select.dispatchEvent(new Event('change'));
  }, value);

  const options = await page.evaluate(() =>
    [...document.getElementById('bpSource').options].map((o) => o.value));
  assert.ok(options.includes('builtin-example'), `expected a copyable model, got ${options}`);

  await swap('builtin-example');
  await waitFor(page, () => window.__sim.learn.ready, { timeout: 30000, message: 'copy never became ready' });
  const copied = await page.evaluate(() => __sim.learn.sandbox.columns.length);
  assert.ok(copied > 0, 'a copied model should still report layers');

  await swap('fresh');
  await waitFor(page, () => window.__sim.learn.ready, { timeout: 30000, message: 'rebuild never became ready' });

  await page.evaluate(() => __sim.learn.setLr(0.02));
  await advance(2);
  const before = Number(await lossText());
  await advance(4);
  const after = Number(await lossText());
  assert.ok(Number.isFinite(before) && Number.isFinite(after),
    `the rebuilt sandbox should still produce real losses: ${before} -> ${after}`);
  assert.ok(after < before, `the rebuilt sandbox should still learn: ${before} -> ${after}`);
});

// Regression: with the stagger running (i.e. NOT reduced motion, which the
// rest of this file emulates), act 4's reveal timers were still pending when
// the next act 1 cleared the gradient bars and awaited its forward pass -- so
// they fired during that await and painted the bars back in, against weights
// that no longer existed. Clicking through at a normal pace was enough.
test('a forward pass leaves no gradient bars behind, mid-animation', async () => {
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  try {
    await page.evaluate(() => { __sim.learn.reset(); __sim.learn.setLr(0.01); });
    await advance(5); // through a whole cycle back to act 1, no waiting
    const state = await page.evaluate(() => ({
      act: __sim.learn.act,
      gradients: [...document.querySelectorAll('#bpLayers .bpTrackGrad .bpFill')]
        .map((el) => parseFloat(el.style.height) || 0),
      steps: [...document.querySelectorAll('#bpLayers .bpTrackGrad .bpStep')]
        .map((el) => parseFloat(el.style.height) || 0),
    }));
    assert.equal(state.act, 'forward');
    assert.ok(state.gradients.every((h) => h === 0),
      `gradient bars should be cleared by the forward pass, got ${JSON.stringify(state.gradients)}`);
    assert.ok(state.steps.every((h) => h === 0),
      `step slivers should be cleared too, got ${JSON.stringify(state.steps)}`);

    // And nothing arrives late once the cancelled timers would have fired.
    await new Promise((r) => setTimeout(r, 1500));
    const late = await page.evaluate(() => [...document.querySelectorAll('#bpLayers .bpTrackGrad .bpFill')]
      .map((el) => parseFloat(el.style.height) || 0));
    assert.ok(late.every((h) => h === 0), `a cancelled reveal repainted late: ${JSON.stringify(late)}`);
  } finally {
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  }
});

test('stepping the same frame repeatedly drives its loss toward zero', async () => {
  await page.evaluate(() => { __sim.learn.reset(); __sim.learn.setLr(0.05); });
  await advance(2);
  const before = Number(await lossText());
  // Four acts per step now that the cycle wraps cleanly.
  await advance(4 * 18);
  const after = Number(await lossText());
  // Deliberately a loose bound. How fast a given random initialisation
  // collapses onto one frame varies by more than an order of magnitude --
  // enough dead relus and it crawls -- so a tight threshold here would be
  // testing the luck of the draw. Two orders of magnitude of headroom keeps
  // this about the claim (one frame, stepped enough, gets memorised) rather
  // than about the seed.
  assert.ok(after < before / 20,
    `18 steps on one frame should nearly memorise it: ${before} -> ${after}`);
});
