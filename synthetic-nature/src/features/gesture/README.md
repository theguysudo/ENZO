# Gesture control — quarantined, not shipping

Webcam hand tracking (MediaPipe Hands) that would let you drive ENZO without a
mouse: pinch to click, swipe to change tab, and so on. **It is not wired into the
app and it does not work.** Everything is here in one folder so it can be picked
up later without hunting; nothing outside this folder imports it.

It is also deliberately not advertised anywhere in the product. A capability
tile for it used to sit on the homepage, describing calibration and pinch-to-click
as if they worked — that was removed, and it must not come back until the two
problems below are fixed.

## Files

| File | What it does |
|---|---|
| `GestureManager.ts` | Owns the camera and MediaPipe Hands, classifies landmarks into a `GestureType`, draws the debug skeleton. This part is the most finished. |
| `ActionController.ts` | Maps a `GestureType` to an app action, with an 800 ms cooldown and continuous scroll. |
| `GestureControlOverlay.tsx` | The whole UI: enable toggle, status, calibration, help. Reads `enzo.gesture.calibration` via `keyVault`. |
| `GestureBetaBadge.tsx` | A floating "beta" badge. Doubly stale — `components/LowPowerToggle.tsx` records that it superseded this badge. |

## Two things are broken. Fix both before mounting anything.

**1. Nothing mounts the overlay, and it takes no props.** `GestureControlOverlay`
has an empty prop signature, so even mounted it has no way to reach `setActiveTab`
or the theme setter. It has to either take those as props or go through the
registry in `ActionController` (see below).

**2. There are three separate, mutually incompatible event vocabularies.**
This is the real bug, and it is why nothing happened even when the overlay ran:

- `ActionController.executeAction()` routes tab and theme gestures to
  `appActions?.nextTab()` — a callback registry filled by `registerAppActions()`.
  **`registerAppActions` is never called**, so `appActions` is permanently `null`
  and those branches are silent no-ops.
- The same file *also* dispatches `gesture-select` and `gesture-select-model`
  CustomEvents. Nothing listens for either.
- `GestureControlOverlay` dispatches a third set — `gesture-switch-tab`,
  `gesture-next-tab`, `gesture-prev-tab`, `gesture-cycle-theme`. Nothing listens
  for these either.
- `App.tsx` used to listen for a single `gesture-detected` event carrying
  `{ gesture, confidence }`. **Nothing has ever dispatched that name.** That
  listener has been removed; re-add it *in this folder*, beside whichever emitter
  wins, so the two names are always edited in the same file.

Pick **one** mechanism. The registry is the better of the two: it is typed, so a
renamed action is a compile error instead of a silent no-op, which is exactly the
failure mode this folder is a monument to.

## Also worth knowing

- `GestureManager.ts:56` loads the MediaPipe WASM from `cdn.jsdelivr.net` at
  runtime. That is a third-party script fetch on a page holding provider keys —
  check it against the CSP in `index.ts` before enabling anything, and prefer
  vendoring the WASM from `node_modules`.
- Camera access needs `Permissions-Policy: camera=(self)`, which the backend
  already sends for this reason.
- The three `@mediapipe/*` dependencies are kept in `package.json` so this folder
  still builds when someone picks it up. They are not in the shipped bundle,
  because nothing imports this folder.
- Vite does not bundle unreferenced files, so leaving this here costs nothing at
  runtime. `tsc --noEmit` *does* check it, which is the point: it stays honest.
