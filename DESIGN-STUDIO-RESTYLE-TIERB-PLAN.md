# Design Studio — "Restyle this object" (Tier B) Plan
**Project:** nycrenovationexperts.com — change an object's material/design in a photo
**Page:** extends the existing `/designstudio.html` (photo-swap studio)
**Status:** scope / pre-build

---

## 0. Goal

Let a user upload a room photo, click an object (e.g. a **sofa**), and change its
**material / fabric / finish / color** while keeping the *same shape, position,
folds, and lighting*. Input is either a **text description** ("emerald green
velvet") or an **uploaded fabric swatch** image.

This is the "keep the object, change its surface" direction (the SAM 2 + depth +
ControlNet pipeline) — distinct from the current flow, which *replaces* a fixture
with a different retail product.

**Tier A** (already scoped) does a lighter version of this with the existing
`gpt-image-1` masked edit. **Tier B (this doc)** is the higher-fidelity,
cost-controllable, open-source pipeline where structure is locked by a depth map
and the swatch is transferred by IP-Adapter.

---

## 1. What we reuse vs. what's new

Your backend already has the bones (`backend/`):

| Need | Today | Tier B change |
|---|---|---|
| Find the object | `ds-segment.js` → Florence-2 **bounding box** | **Add a pixel mask** via SAM 2 (bbox is too coarse for fabric edges) |
| Edit prompt | `ds-composite.js` → DeepSeek writes prompt | Reuse; new "restyle, keep geometry" system prompt branch |
| Re-render | `ds-composite.js` → gpt-image-1 | **Swap engine** to fal.ai FLUX inpaint w/ depth-ControlNet + IP-Adapter |
| 3D | `ds-render3d.js` → Trellis | Unchanged (optional 3D of restyled object) |
| Routing/caching | `api/index.js`, in-memory caches | Reuse the same patterns |

So Tier B is mostly **two new backend modules + one new endpoint + a restyle mode
in the frontend** — not a rewrite.

---

## 2. Pipeline (all on fal.ai — the vendor you already use)

```
 photo + click point/label            (browser)
        │
        ▼
 1. MASK   fal-ai/evf-sam            text/point -> tight binary mask of the sofa
        │                            (EVF-SAM2: prompt "sofa" -> pixel mask)
        ▼
 2. DEPTH  fal-ai/imageutils/* (Depth Anything V2)   photo -> depth map
        │                            (locks cushion folds & perspective)
        ▼
 3. SWATCH (optional) user uploads fabric image  ->  IP-Adapter reference
        │
        ▼
 4. RENDER fal-ai/flux-general/inpainting
        │   inputs: photo, mask (step 1), controlnet=depth (step 2),
        │           ip_adapter=swatch (step 3), prompt (DeepSeek),
        │           strength ~0.6
        ▼
 restyled photo  (sofa re-upholstered, room untouched)
```

**Confirmed endpoints (verify exact request schema + price on fal.ai before build):**
- **`fal-ai/evf-sam`** — text-prompted SAM 2; returns a pixel mask from a phrase
  like "sofa". (Alt: `fal-ai/sam2/auto-segment` if you pass a click point.)
- **Depth Anything V2** — fal hosts a depth preprocessor; or let the FLUX
  ControlNet take a depth control image we precompute.
- **`fal-ai/flux-general/inpainting`** — the workhorse: FLUX.1[dev] inpainting
  that accepts **ControlNet (depth) + IP-Adapter + LoRA together**, so structure
  (depth) and style (swatch) are both honored inside the masked region.
- Control types available include `depth`, `inpainting`, `seg`.

Why this beats the gpt-image-1 path for *material* edits: gpt-image-1 re-imagines
the whole masked box (can drift the sofa's shape); FLUX + **depth-ControlNet**
pins the geometry so only the surface changes, and **IP-Adapter** reproduces an
actual swatch instead of a text approximation.

---

## 3. New / changed backend

- **`backend/ds-mask.js`** (new) — `getObjectMask({ imageUrl, label, point })`
  → calls `evf-sam`, returns a PNG mask data URL. Cache by (image hash + label),
  mirroring `ds-segment.js`'s cache.
- **`backend/ds-restyle.js`** (new) — `restyleObject({ imageUrl, maskUrl, depthUrl?,
  swatchUrl?, styleText, label })`:
  1. depth map (compute or pass-through),
  2. DeepSeek restyle prompt ("re-upholster the {label} in {styleText}; keep the
     exact same shape, size, position; match room lighting; change only the
     surface material"),
  3. POST to `fal-ai/flux-general/inpainting` with mask + depth controlnet +
     optional ip-adapter swatch,
  4. return the edited image. Cache by (image + mask + style) for 24h.
- **`api/index.js`** — add `POST /api/ds-restyle` (and optionally
  `POST /api/ds-mask` if the browser wants the mask first for preview). Same
  auth/error/caching conventions as the existing `/api/ds-*` routes.
- **Env:** reuses `FAL_API_KEY` + `DEEPSEEK_API_KEY`. No new vendor keys.

**Vercel timeout note:** chain (mask → depth → flux inpaint) can exceed the 60s
window if run as one request. Run **mask + depth + render as separate calls**, or
use fal's **queue** endpoints (like `ds-render3d.js` already does) and poll from
the browser. Don't block one serverless function on the whole chain.

---

## 4. Frontend (`designstudio.html` + `js/designstudio.js`)

- Add a **mode toggle** on a detected segment: **"Find a replacement"** (today)
  vs **"Restyle this one"** (new).
- Restyle panel: a **text box** ("describe the new look") + a **swatch upload**
  ("or drop a fabric photo") + a few quick chips ("Velvet", "Leather", "Linen",
  "Boucle", "Navy", "Emerald").
- On submit → `POST /api/ds-restyle` → show before/after with the existing
  composite UI (reuse the `ds-composite` overlay).
- Reuse the segment mask to draw a highlight so the user sees exactly what will
  change before spending a render.

---

## 5. Cost & latency (verify on fal.ai pricing page)

Per restyle (estimate — fal.ai is GPU-second priced; confirm current rates):

| Step | Model | Rough cost | Latency |
|---|---|---|---|
| Mask | evf-sam (SAM 2) | ~$0.01–0.03 | 1–3 s |
| Depth | Depth Anything V2 | ~$0.005–0.02 | 1–2 s |
| Render | flux-general/inpainting | ~$0.03–0.08 | 8–20 s |
| Prompt | DeepSeek | ~$0.0002 | <1 s |
| **Total** | | **~$0.05–0.13** | **~12–25 s** |

Comparable to or a bit above the gpt-image-1 path (~$0.04) per call, but **more
controllable and cheaper to push toward $0 at scale** (open models, aggressive
caching, batchable). Cache hits (same photo+object+style) are free.

---

## 6. Phased build

- **Phase 1 — mask upgrade (~2 days):** add `ds-mask.js` (evf-sam) and surface a
  pixel-mask highlight in the UI. Immediately improves the *existing* swap too.
- **Phase 2 — restyle render (~3–4 days):** add `ds-restyle.js` +
  `/api/ds-restyle` using `flux-general/inpainting` with mask + depth-ControlNet;
  text-only styling first. Ship "restyle this sofa: emerald velvet."
- **Phase 3 — swatch transfer (~2–3 days):** add IP-Adapter swatch upload so users
  match a real fabric. Add the quick-chips UX.
- **Phase 4 — polish (~2 days):** before/after slider, queue+poll for reliability,
  caching, mobile, "send to quote" CTA on the restyled result.

**~9–11 working days to full Tier B.** Phase 1 alone is a worthwhile standalone
upgrade (better masks everywhere).

---

## 7. Risks & mitigations

1. **Mask precision on cluttered fabric** (pillows, throws, pets). → EVF-SAM2 text
   prompt + optional click-point refine; let users brush-edit the mask.
2. **Geometry drift / melted cushions.** → depth-ControlNet at strength ~0.6;
   keep inpaint strength moderate; A/B against gpt-image-1.
3. **Lighting mismatch** (new fabric looks "pasted"). → prompt instructs "match
   existing light direction and shadows"; Tier C (RGB↔X material decomposition)
   if physically-correct relight is ever needed — parked as research.
4. **Latency / Vercel 60s cap.** → split calls + queue/poll (reuse `ds-render3d.js`
   pattern). Show a progress UI; restyle is an opt-in upgrade, not a blocker.
5. **Cost runaway.** → cache by (photo+mask+style) hash 24h; rate-limit anon
   users; gate heavy renders behind the quote-lead capture.
6. **Endpoint/schema drift on fal.ai.** → confirm `evf-sam` and
   `flux-general/inpainting` request/response shapes on a Phase 0 spike before
   wiring (their schemas evolve; your `ds-segment.js` already shows defensive
   response-parsing is the house style).

---

## 8. Tier A vs Tier B — pick the on-ramp
- **Tier A** (gpt-image-1 masked edit, ~1–2 days): fastest to a demo, reuses
  `ds-composite.js` almost verbatim, weaker geometry lock.
- **Tier B** (this doc, ~9–11 days): faithful folds (depth), real swatches
  (IP-Adapter), cheaper at scale, more infra.

They share the **same UI and `/api` shape**, so Tier A is a valid week-1 milestone
*inside* the Tier B plan (Phase 2 just swaps the render engine). Recommended order
even if B is the goal: ship Phase 1 (SAM 2 masks) → a Tier-A render → then the
FLUX engine.

---

## 9. Open questions
1. **Text-only first, or swatch upload from day one?** (Swatch = Phase 3; adds IP-Adapter.)
2. **Free lead-magnet or gated?** Decides rate-limiting + whether anon users can render.
3. **Restyle scope:** upholstery/fabric only, or also hard finishes (cabinet color,
   countertop, flooring, wall paint)? Same pipeline, different prompt/label set.
4. **Keep gpt-image-1 as a fallback engine** when FLUX drifts, or go all-in on FLUX?
5. **Does the restyled result feed the quote flow** (like the room planner does)?
