# Smart Camera + Precise Selection — Plan & Research

**Goal:** a smart camera where opening it auto-detects and tags items, the user
selects each item's *exact* boundary, and that precision flows into Design
Studio so "change the TV" changes only the TV — not the sofa.

## Key research finding: no native app required
On-device AI now runs in the browser on **both** platforms:
- **WebGPU shipped in iOS 26 Safari** (2026) — heavy models run on iPhone Safari,
  not just Android/Chrome. ([Safari 26 / WebKit](https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/))
- **SAM 2 runs 100% in-browser via WebGPU (~50 ms/interaction)**, fully
  client-side. ([webgpu-sam2](https://github.com/lucasgelfond/webgpu-sam2))
- `getUserMedia` (live camera) works on iPhone + Android.

**Decision: build a PWA (installable web app) first.** A native app is only
needed later for **LiDAR measurement** (see `MEASURE-PLAN.md`) and max
performance.

## Why precise masks (the core fix)
The studio detects **bounding boxes** (Florence-2); the hard guarantee that
"only the box changes" clips the AI result to a **rectangle**
(`compositeMaskedRegion`). Rectangles overlap neighbours → edits leak. Replacing
the rectangle with a **per-object pixel mask** (SAM 2) makes the edit follow the
object's real outline. Handles two couches, a couch seen from the back, a
half-shown rug — each tap segments exactly what was tapped.

## Phases
- **Phase 1 — Precise masks in Design Studio (DONE, this PR).** New
  `/api/ds-mask` (fal.ai SAM 2, server-side) + a "Precise select (tap one item)"
  button. Tapping an item fetches its exact mask; the gpt-image-1 edit and the
  client-side clip both use that mask instead of a rectangle. Additive — the
  rectangle path is the fallback when no precise mask is set.
- **Phase 2 — On-device SAM 2 (WebGPU).** Move masking client-side (no per-tap
  server cost, instant) where WebGPU is available; keep the server endpoint as
  the fallback.
- **Phase 3 — Live camera + auto-tagging.** `getUserMedia` feed + on-device
  detector (MediaPipe/transformers.js) drawing live "TV / sofa / carpet" labels;
  tap to lock a precise mask; capture → studio.
- **Phase 4 — PWA packaging.** Manifest + service worker so it installs to the
  home screen and feels like an app on both platforms.
- **Phase 5 — Native iOS app.** Only for true LiDAR measurement (the one thing
  the browser can't do) — ties to `MEASURE-PLAN.md` and `IOS-APP-PLAN.md`.

## Notes / to verify on the preview (Phase 1)
- `FAL_API_KEY` must be set in Vercel for `/api/ds-mask`.
- Confirm the fal.ai `sam2/image` request/response shape (parsing is defensive,
  like `ds-segment.js`, but verify the live response).
- SAM mask images must be CORS-readable to rasterize client-side; if fal's CDN
  blocks it, proxy the mask through the backend (small follow-up).
- This was written without a browser to test in — verify the precise flow on the
  Vercel preview before merging to the live site.
