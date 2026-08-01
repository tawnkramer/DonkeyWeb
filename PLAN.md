# Model Save/Load Feature Plan

## Implementation status

Core feature implemented: model metadata storage, legacy migration, a
read-only shipped example, Eval model selection, mobile hamburger menu, model
import/export, training model isolation, and browser regression coverage are
now in place. The shipped example is currently generated deterministically
from the vendored tiny architecture until a trained static artifact is
installed with `npm run install-model`. A trained static artifact is now
installed under `models/default/` from the downloaded export.

## Goal

Allow users to save and load models, choose which model runs in Eval, and start with a working model shipped by the website. The shipped model must remain separate from and immune to user training.

## Current architecture

- The app is a static browser application with no build step.
- TensorFlow.js stores the current trained model at `indexeddb://donkeyweb-model`.
- `train/autopilot.js` loads that hardcoded model key for inference.
- `train/worker.js` saves trained models to that same hardcoded key.
- Eval currently has one Autopilot button and no model selector.
- The top navigation is in `index.html`; navigation behavior is in `sim/navui.js`.
- IndexedDB application data is wrapped by `data/db.js`.

## Design

### Model manager

Create a central model-management module responsible for:

- Listing available models.
- Tracking the active model.
- Loading and warming a selected model.
- Registering trained and imported models.
- Exporting user models.
- Deleting or renaming user models.
- Migrating the existing `donkeyweb-model` slot.

Use separate model categories:

- `builtin`: shipped with the website and read-only.
- `user`: trained or imported by the user.

Store user metadata in a new application IndexedDB object store, separate from TensorFlow.js's internal `models_store`. Metadata should include:

- Stable model ID.
- Display name.
- Source/type (`trained` or `imported`).
- Created and updated timestamps.
- Model profile and input dimensions.
- TensorFlow.js storage key.

### Built-in model

Add a static TensorFlow.js model under a path such as:

```text
models/default/model.json
models/default/weights.bin
```

Load it from the website when no user model exists. It must never be saved into the user model key and must never be overwritten by training. Mark it clearly as `Built-in` in the UI.

### User model storage

Use unique TensorFlow.js IndexedDB keys for user models, for example:

```text
indexeddb://donkeyweb-user-<id>
```

The existing `indexeddb://donkeyweb-model` record should migrate to the first user model so existing sessions retain their trained model.

### Training

Refactor the training worker/controller so training receives a destination user model ID and never writes to the built-in model. On completion:

1. Register or update the user model metadata.
2. Select the newly trained model.
3. Load and warm it for inference.
4. Preserve the current hot-swap behavior.

Recommended first behavior: a training run updates the selected user model. Exporting provides an external snapshot.

### Autopilot

Refactor `train/autopilot.js` to load the model selected by the model manager rather than a hardcoded key. Keep the existing prediction, warm-up, readiness, and safe deactivation behavior.

When changing models while Autopilot is active:

1. Stop Autopilot.
2. Reset the car to the line and zero throttle.
3. Load and warm the new model.
4. Update the Eval UI.

### Eval selector

Add a selector to the existing Eval panel, close to and above the Autopilot button. Each option should identify:

- Model name.
- `Built-in` or user source.
- Profile/input dimensions where useful, such as `tiny · 64×64`.

Persist the selected model across reloads. Keep the selector stacked and touch-friendly on narrow screens.

### Hamburger menu

Add a hamburger button to the main navigation. The menu should work on desktop and mobile, with large touch targets and close-on-selection behavior.

Actions:

- `Load model`: open a file picker for TensorFlow.js `model.json` plus weight files, validate the model, and register it as a user model.
- `Save model`: download the selected user model as TensorFlow.js files. Disable or explain this action for the read-only built-in model.
- `Manage models`: list built-in and user models, allow user-model rename/delete, and prevent deleting the active model without selecting a replacement.

Validate imported models before registration:

- Valid TensorFlow.js layers model.
- Compatible image input dimensions.
- Two expected outputs for steering and throttle.
- Successful warm-up with finite predictions.

Provide clear errors for missing weights, invalid JSON, unsupported models, and storage failures.

## Implementation sequence

1. Implement model metadata storage and the model manager.
2. Separate built-in and user model storage.
3. Refactor Autopilot to use the model manager.
4. Refactor training worker/controller to save user models.
5. Add the shipped default model.
6. Add the Eval model selector.
7. Add hamburger menu, import, export, and model management UI.
8. Add migration, responsive styling, and end-to-end tests.

## Acceptance tests

- A fresh profile loads the shipped built-in model and enables Eval Autopilot.
- Training never modifies the built-in model.
- Existing `donkeyweb-model` data migrates into a user model.
- Multiple user models can coexist.
- User models can be exported and imported again.
- Imported models appear in the Eval selector.
- Selecting a model loads it and updates Autopilot predictions.
- Switching models safely stops Autopilot and resets the car.
- Built-in models cannot be overwritten or deleted.
- The active model persists across reloads.
- Hamburger actions are usable at desktop and mobile viewport sizes.
- File validation rejects malformed or incompatible models with a visible error.
- Existing recording, training, and autopilot tests continue to pass.
