# Photo Measure — Plan & Research
**Goal:** give users real dimensions from a photo (like the LiDAR "4ft 10in"
app in the reference screenshots), to make Design Studio suggestions and quotes
accurate instead of guessed.

## Research findings (the constraints that shape this)
- The reference app measures with the iPhone's **LiDAR sensor** ("LiDAR Mode On").
  **A mobile browser cannot access LiDAR** — it is a native-app-only capability.
- **iOS Safari does not support WebXR** (still true 2026), so there is **no**
  in-browser live AR measurement on iPhone.
  ([state of WebXR on iOS](https://launch.variant3d.com/blog/23-06-state-webxr-on-ios-beyond))
- **Android Chrome supports WebXR + Depth Sensing** (ARCore) — real in-browser
  AR measuring works on many Android phones, but not iPhones.
  ([W3C WebXR Depth Sensing](https://www.w3.org/TR/webxr-depth-sensing-1/))
- **Apple Depth Pro** (open source) does **metric** monocular depth from one
  photo, no camera intrinsics — the closest thing to LiDAR that runs from a
  plain uploaded image, server-side. ([Apple ML](https://machinelearning.apple.com/research/depth-pro))
- Camera capture in-browser (`<input capture="environment">` / getUserMedia)
  works on **both** iPhone and Android.

**Conclusion:** identical LiDAR-grade measurement in the browser on both phones
is impossible. The cross-platform path is **reference-object calibration** now,
**AI depth** as an assist, and a **native iOS app** later for true LiDAR.

## Phased plan
- **Phase 1 — Camera + Upload (DONE).** "Take a photo" (rear camera) + "Upload"
  added to the Design Studio upload (`designstudio.html`). Cross-platform.
- **Phase 2 — Reference-object Measure (DONE).** New `measure.html` +
  `js/measure.js`: snap/upload a photo → calibrate scale against a known object
  (Letter sheet, credit card, 12" tile, or custom) → tap two points to read
  real dimensions. Fully client-side, no AI cost, iPhone + Android. Results can
  be pushed into the quote flow (`quote.html?note=…`).
- **Phase 3 — AI auto-measure (planned).** Run **Apple Depth Pro** (via
  fal.ai/Replicate/HF) on the uploaded photo to estimate dimensions without a
  reference object. Approximate; good as a one-tap assist. Reuse the existing
  `FAL_API_KEY` backend pattern (`backend/ds-*`).
- **Phase 4 — Integrate into the studios (planned).** Feed a measured fixture
  size into product suggestions ("36-inch range") and feed a measured room size
  into the 3D planner so a template matches real dimensions.
- **Phase 5 — Android WebXR live AR + iOS app (planned).** Optional real-time AR
  measure for Android Chrome; native iOS app (see `IOS-APP-PLAN.md`) for true
  LiDAR — the only way to match the reference screenshots 1:1.

## Accuracy note (set expectations in UI)
Reference-object measuring is accurate when the reference and the measured
object lie on roughly the same flat plane and the camera is roughly square-on.
It is a reliable estimate, not a laser/LiDAR measure. The tool says this plainly.
