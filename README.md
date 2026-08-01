# donkey.web

Browser-first [donkeycar](https://www.donkeycar.com/): drive, train, and run
autopilot -- entirely client-side, no installs, no Python environment, no
GPU drivers to set up.

A small three.js sim stands in for a real donkeycar and track. You drive it
by hand, record the driving as training data, train a real convolutional
network (TensorFlow.js) on that data right in the tab, then watch the model
drive the same track back on autopilot.

The model is an exact layer-for-layer clone of donkeycar's `KerasLinear`
(`default_n_linear`) architecture -- same conv/dense stack, same layer
names -- so a model trained here stays weight-compatible with a real
donkeycar, not just conceptually similar to one.

## Features

- **Drive**: mouse steers, scroll wheel (or `W`/`S`) controls throttle --
  continuous input, not on/off keys, because that's what trains a good
  model. `R` resets to the start line.
- **Record**: every driven frame (image + steering + throttle) is captured
  to IndexedDB automatically while you drive forward on-track. A live
  steering histogram shows you when your data is too straight-line-heavy to
  train a model that can recover from a curve.
- **Dataset editor**: scrub through recorded frames, preview each one, and
  cut a bad tail (e.g. autopilot left engaged, or a stuck throttle) without
  losing the good data before it.
- **Train**: one button trains the model in a background Web Worker (WebGPU
  -> WebGL -> CPU, whichever this browser supports) with a live per-batch
  loss chart, so the tab never freezes while it trains.
- **Models**: a built-in example is available immediately in Eval. User
  models can be selected, exported from the hamburger menu, or imported from
  TensorFlow.js `model.json` and weight files.
- **Autopilot**: the selected model drives. A "shadow needle" overlay shows
  the model's opinion vs. your own steering even while you're still driving
  manually, so you can see how it's doing before trusting it with the wheel.

## Quick start

No build step, no install, no server-side anything -- the app is served as
plain static files, and the only two third-party libraries it needs
(three.js, TensorFlow.js) are already vendored into `/vendor`.

```bash
git clone https://github.com/<you>/donkey-web.git
cd donkey-web
node test/serve.js        # or: ./scripts/serve.sh
```

Then open the URL it prints (`http://localhost:8734` by default; set
`PORT=xxxx` to use a different one). That's it -- just [Node.js](https://nodejs.org/)
itself is required, nothing else.

### Installing a trained model as the built-in example

Export a model from the app as one ZIP file, then run:

```bash
npm run install-model -- ~/Downloads/my-model.zip "Track example"
```

The installer validates the ZIP's TensorFlow.js artifacts and installs them
under `models/default/`. It also accepts a directory or standalone
`model.json` for compatibility. Commit the generated files with the website
deployment; new visitors will then receive that model as the read-only
built-in Eval model. Existing user models remain separate.

### Hosting it on GitHub Pages

Since there's no build step, GitHub can serve this repo as-is:

1. Push the repo to GitHub.
2. In **Settings -> Pages**, set Source to "Deploy from a branch", branch
   `main`, folder `/ (root)`.
3. GitHub publishes it at `https://<you>.github.io/<repo>/`.

The repo already has a `.nojekyll` file (so GitHub doesn't run its default
Jekyll processing over the app's files) and every path in the app is
relative to `index.html`, so it works both at a domain root and at a
project-page subpath like the one above.

## Controls

| Input | Effect |
|---|---|
| Mouse | Steer (continuous, follows cursor position relative to screen center) |
| Scroll wheel / `W` `S` | Throttle up/down |
| Arrow keys / `A` `D` | Snap steering full left/right (keyboard is on/off, not continuous) |
| `R` | Reset to the start line |
| `P` | Toggle autopilot (once a model is loaded) |
| Touch | On-screen d-pad appears automatically on touch devices |

## Development

Everything above needs nothing but Node. The rest of this section is for
working on the app itself.

```bash
npm install       # dev tooling only: esbuild, puppeteer-core
npm test          # fast test suite (see below)
npm run vendor    # regenerate /vendor after bumping pinned versions
```

### Tests

```bash
CHROME_PATH=/usr/bin/google-chrome npm test
```

- `scripts/test.sh` runs each `test/*.test.js` file against a real headless
  Chrome via Puppeteer, one file at a time.
- `CHROME_PATH` points at a real Chrome/Chromium binary; on Ubuntu this
  avoids picking up the Snap-packaged Chromium, which Puppeteer can't drive.
  If unset, it falls back to common install paths (see `test/helpers.js`).
- `test/training.test.js` actually trains a real model end-to-end and is by
  far the slowest file (a real TF.js training run through a software-only
  WebGL backend in CI-style environments), so it's **skipped by default**.
  Set `RUN_TRAINING_TESTS=1` to include it -- do this whenever you've
  touched `train/`, `data/tub.js`, or the test itself, or before a final
  check.

### Regenerating `/vendor`

`/vendor/tf.mjs` and `/vendor/three.module.js` are committed so the app
runs with zero build step out of the box. `npm run vendor` (via
`scripts/vendor.sh`) rebuilds them from the pinned versions in
`package.json` -- only needed after bumping those versions, not for normal
day-to-day use.

## Project layout

```
index.html          entry point, HUD markup + styling
sim/                 three.js scene, vehicle physics, input, HUD/UI wiring
data/                the recorded "tub" (frames) and its IndexedDB backing
train/               model architecture, training worker, autopilot inference
test/                browser test suite (node --test + Puppeteer) and the dev server
scripts/             dev-server wrapper, test runner, vendor build
vendor/              self-hosted three.js + TensorFlow.js builds (see above)
```

## Browser support

Needs a browser with WebGL and IndexedDB (i.e. any current Chrome, Edge,
Firefox, or Safari). WebGPU is used opportunistically for training/autopilot
where available and falls back to WebGL otherwise.

## License

[MIT](LICENSE) -- same license as [donkeycar](https://github.com/autorope/donkeycar) itself.
