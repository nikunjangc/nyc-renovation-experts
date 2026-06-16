# Design Studio — Implementation Plan
**Project:** nycrenovationexperts.com — photo-to-3D kitchen/bath swap engine
**Status:** Draft v0 (pre-PoC)

---

## 1. Architecture Overview

```
                                                  ┌──────────────────────────────┐
                                                  │ EXTERNAL APIs                │
                                                  │                              │
 ┌───────────────────────┐                        │  ┌────────────────────────┐  │
 │ BROWSER (static HTML) │                        │  │ Photo → 3D vendor      │  │
 │   /designstudio.html  │                        │  │  (Meshy REST)          │  │
 │                       │                        │  └────────────────────────┘  │
 │  jQuery + Bootstrap   │                        │  ┌────────────────────────┐  │
 │  ┌─────────────────┐  │   1. POST photo        │  │ Segmentation           │  │
 │  │ Upload widget   │──┼─────────────┐          │  │  (fal.ai SAM 2 +       │  │
 │  └─────────────────┘  │             │          │  │   Grounding DINO)      │  │
 │  ┌─────────────────┐  │             ▼          │  └────────────────────────┘  │
 │  │ three.js viewer │◄─┼───┐  ┌─────────────┐   │  ┌────────────────────────┐  │
 │  │ (or model-viewer│  │   │  │ VERCEL      │   │  │ DeepSeek (chat)        │  │
 │  │  for MVP)       │  │   │  │ SERVERLESS  │   │  │  via OpenAI-compatible │  │
 │  └─────────────────┘  │   │  │   /api      │   │  └────────────────────────┘  │
 │  ┌─────────────────┐  │   │  │             │◄──┼──┤ SerpAPI google_shopping│  │
 │  │ Clarifier chips │◄─┼───┤  │ Node.js     │   │  └────────────────────────┘  │
 │  │ (10s timeout)   │  │   │  │ functions   │   └──────────────────────────────┘
 │  └─────────────────┘  │   │  │             │
 │  ┌─────────────────┐  │   │  │  /api/ds-*  │              ┌────────────────┐
 │  │ Product cards   │◄─┼───┘  │             │◄────────────►│ Supabase       │
 │  │ (retailer URLs) │  │      └──────┬──────┘              │  - scenes      │
 │  └─────────────────┘  │             │                     │  - segments    │
 └───────────────────────┘             │                     │  - swap_history│
                                       ▼                     │  - cache_lkup  │
                              ┌─────────────────┐            └────────────────┘
                              │ Vercel Blob /   │
                              │ Supabase Storage│
                              │  (photos, GLB)  │
                              └─────────────────┘

CACHING POINTS:
  [A] Browser: GLB + texture atlas (HTTP cache-control: immutable, 1y)
  [B] Edge: SerpAPI product results — already in product-search.js (Map, 24h TTL)
  [C] Supabase: photo SHA-256 → scene_id (skip re-render on identical upload)
  [D] Supabase: (manufacturer + model_no) → cached SerpAPI hit
  [E] LLM: identical clarifier prompt hash → cached questions, 7-day TTL
```

**What runs where:**
- Static HTML/JS/CSS on Vercel's static edge (`/designstudio.html`, `/js/designstudio.js`).
- Serverless Node 18 functions in `/api/index.js` (new routes: `/api/ds-upload`, `/api/ds-segment`, `/api/ds-identify`, `/api/ds-swap`, plus reusing `/api/clarify-project` and `/api/product-search`).
- Heavy GPU work (3D reconstruction, SAM 2) happens at the vendor; Vercel only proxies + caches.
- Supabase Postgres is the system of record for scenes/segments/swaps.

---

## 2. Component Decisions

### 2.1 Photo → 3D scene generation: **Meshy** (image-to-3D REST API)
- **Why:** Documented REST endpoint, returns GLB/FBX, image-to-3D with no scene-stitching code on our side. Async job model fits the Vercel serverless 10s timeout (we poll from the browser, not from the function).
- **Runner-up:** Tripo (similar quality, similar ballpark pricing — Meshy chosen for more mature docs/SDK as of cutoff). Luma Genie produces nicer single objects but is weaker at room-scale scenes. Stability SV3D is single-object only and would force us to do scene composition ourselves.
- **Caveat:** All current image-to-3D vendors produce a **single mesh** per image, not a scene graph. We will NOT get a kitchen with the fridge as a separate node out of the box. This forces the segmentation pass (2.2) to do the heavy lifting and Phase 2 to actually replace components by overlaying separately-generated GLBs onto a reconstructed room shell. Confirm with a vendor PoC before committing.
- **Latency:** Image-to-3D jobs are tens of seconds to a few minutes — must be async.

### 2.2 Per-component segmentation: **Grounding DINO + SAM 2** via fal.ai
- **Why:** SAM 2 alone gives us masks but no labels — we'd be stuck asking "what did you click?" Grounding DINO takes a text prompt ("fridge, cooktop, sink, faucet, cabinet, range hood, dishwasher, microwave, oven, countertop") and produces labeled bounding boxes; feeding those into SAM 2 yields labeled masks in one pipeline. fal.ai hosts both with low cold-start.
- **Runner-up:** Replicate (same models, slightly higher latency pre-cutoff). Mask2Former was considered but its training set (COCO/ADE20K) doesn't have appliance-grained classes like "induction cooktop" vs "gas cooktop" — we'd have to fine-tune. The combo above gives open-vocabulary labels for free.
- **Output:** `{label, confidence, bbox, mask_png_url, polygon}` written to Supabase `segments` table, keyed to `scene_id`.

### 2.3 Browser 3D viewer: **three.js** (vanilla, via CDN)
- **Why:** Matches the existing stack — no framework, no build step, drops into a static HTML page like the rest of the site. `js/designstudio.js` can import three.js as an ES module from a CDN (esm.sh or unpkg) the same way other JS is wired up today. Click-to-pick on meshes is one raycast call. Supports GLB out of the box.
- **Runner-up:** Google's `<model-viewer>` web component is genuinely tempting for the MVP (one tag, AR on iOS for free, no shader code) and is what I'd suggest for **Phase 1 only**. We graduate to three.js in Phase 2 because per-mesh selection / swap / re-light is awkward in `<model-viewer>`. Babylon.js and react-three-fiber were both rejected — Babylon is overkill, r3f drags React into a jQuery codebase.
- **Phase 1 actually skips 3D entirely** (see Section 4) and uses a 2D `<canvas>` overlay of segmentation masks on top of the original photo. Cheap, fast, ships in week 2.

### 2.4 Catalog of swappable models: **Skip 3D catalog; use 2D product cards in Phase 1-2, build a minimal in-house GLB library in Phase 3**
- **Why:** Licensing ArchVision or CGTrader for a representative set of appliances is unknown — verify on the vendor's current pricing page before committing — and almost certainly more expensive than the entire rest of the stack combined. The user's actual ask is "show me what I could buy" — that's a product card, not a CAD rendering. We can serve ~90% of the value by replacing the clicked region with a flat product image from the SerpAPI thumbnail and showing 3-6 retailer cards alongside.
- **Runner-up:** Building our own. Defer until Phase 3 and even then only for the top 20 SKUs per category (fridges, ranges, dishwashers, sinks, faucets). Use Meshy's image-to-3D on the retailer's product photo to generate the GLB on demand, cache forever.
- **Hard rejection:** Licensing a comprehensive catalog. Not worth it for a feature that hasn't shipped yet.

### 2.5 Clarification turn structure: **Reuse `/api/clarify-project` exactly**
- The existing contract — DeepSeek prompt that emits `{intro, questions: [{id, label, question, options[]}]}` with a guaranteed "Surprise me" deferral option on every question, normalized to ≤6 questions of ≤6 options — is **already** the right shape for this feature. The frontend chip rendering in `js/ai-quote.js` (`renderClarification`, `.cq-chip` selection) can be lifted into `designstudio.js` verbatim.
- **Change needed:** add an optional `context` param to `clarifyProject({ quoteData, context })` where `context = { kind: 'component_swap', current: {label, brand?, fuel?}, requested: 'electric burner' }`. The system prompt grows a branch: when `context.kind === 'component_swap'`, ask 2-4 questions specifically about the swap (e.g. "What's your kitchen's wiring — 120V only or do you have a 240V line?", "Induction or radiant electric?", "Size: 30\" or 36\"?"), keeping the same JSON schema so the renderer is unchanged.
- **10s timeout:** implemented client-side. Start a `setTimeout(proceedWithDefaults, 10000)` on render; any chip click clears it. On fire, treat every unanswered question as "Surprise me" and POST to the swap endpoint. This is purely a frontend concern — the backend prompt already handles "Surprise me" as a first-class option.
- **Runner-up:** A free-text follow-up chat (LangChain-style). Rejected — slower, harder to constrain, doesn't match the existing UI vocabulary.

---

## 3. Cost Projection

All figures are per-render unless noted. **Anything marked "unknown — verify" must be checked on the vendor's current pricing page before any commitment.** Only figures cited with confidence from training data are quoted; the rest are flagged.

### Per-render cost components

| Hop | Cost basis | Per-render estimate |
|---|---|---|
| Vercel function invocation | First 1M invocations/month free on Hobby; Pro is $20/mo + usage | ~$0 at our scale |
| Photo storage (Vercel Blob or Supabase Storage) | unknown — verify on vendor pricing page | trivial (<$0.001) |
| DeepSeek (clarify + identify) | DeepSeek is materially cheaper than OpenAI per training-time data; exact $/1M tokens — unknown, verify on platform.deepseek.com | ~$0.001–0.005 per render assuming ~2–4k tokens total |
| SerpAPI google_shopping | SerpAPI plans start in the ~$50/mo range for ~5k searches per training-time data; verify current pricing | ~$0.01 per search, 1–3 searches per render |
| Segmentation (fal.ai SAM 2 + Grounding DINO) | fal.ai is GPU-second priced; exact $/sec — unknown, verify on fal.ai pricing page | ~$0.02–0.10 per image (estimate, verify) |
| Image-to-3D (Meshy) | Meshy sells credit packs; per-job cost — unknown, verify on meshy.ai pricing | likely **$0.20–1.00 per scene** — the dominant cost |

### Scale points

**10 users/day, 3 renders/user, 30 renders/day = ~900/month**
- Per-render: ~$0.25–1.10 (Meshy-dominated)
- Monthly: **~$225–$1,000** + flat platform fees (Vercel ~$20, Supabase free tier likely sufficient, SerpAPI ~$50 entry plan)
- **Total ballpark: ~$300–$1,100/month.** Realistic for a launch experiment.

**100 users/day, 3 renders/user, 9,000 renders/month**
- Per-render same: ~$0.25–1.10
- Monthly: **~$2,250–$10,000** + ~$70 platform
- SerpAPI tier likely needs upgrade — verify which plan covers ~30k searches/mo.
- **Total ballpark: ~$2,500–$10,000/month.**

**1000 users/day, 3 renders/user, 90,000 renders/month**
- Per-render: cache hit rate matters enormously. If 50% of swaps hit the (manufacturer, model) SerpAPI cache and 30% of uploads hit the photo-hash scene cache, effective cost can drop ~40%.
- Monthly raw: **~$22,500–$100,000** before caching; **~$13,500–$60,000** with the caching assumption above.
- **At this scale, negotiating a direct contract with the 3D vendor (committed volume discount) is the lever.**

### Costliest hop and fallback

- **Costliest hop: image-to-3D generation (Meshy).** It is 5–50x every other component.
- **Fallback if budget is tight:** Skip image-to-3D entirely. The 2D-overlay Phase 1 path (photo + SAM 2 masks + product cards) costs ~$0.03–0.13 per render — an order of magnitude less — and delivers most of the user value. Treat 3D as a premium / paid-tier feature.

---

## 4. Phased Build Plan

### Phase 0 — Research & PoC (no production code) — **1.5 weeks**
- Send 8–10 representative consumer kitchen photos through Meshy, Tripo, and Luma Genie. Score on: appliance fidelity, scene coherence, latency, output format.
- Send same 8–10 through fal.ai Grounding-DINO+SAM-2 with our appliance vocabulary; measure label accuracy and mask IoU on hand-labeled ground truth.
- Get real pricing pages screenshotted and tracked in a spreadsheet — replace every "unknown — verify" in Section 3 with a number.
- Deliverable: a go/no-go memo on the 3D vendor + a confirmed monthly cost model.
- **Ships:** nothing.
- **Deferred:** all production code.

### Phase 1 — MVP: upload → 2D segmented overlay → click → retailer products — **3 weeks**
- New static page `/designstudio.html` (Bootstrap-styled to match the site).
- New endpoints:
  - `POST /api/ds-upload` — receive image, write to Vercel Blob, return `scene_id` + signed URL.
  - `POST /api/ds-segment` — call fal.ai Grounding-DINO+SAM-2, persist `segments` rows in Supabase, return labeled polygons.
- Frontend: render the photo on a `<canvas>`, draw mask polygons as hover-highlighted overlays, click a region → call existing `/api/product-search` with the segment label as query.
- Reuse `/api/clarify-project` (with the new `context` param) for the 10s-timeout clarifier dialog.
- Reuse `js/ai-quote.js`'s chip renderer.
- **Ships:** end-to-end "click my fridge → see 6 fridges I could buy."
- **Deferred:** any 3D, scene reconstruction, in-place replacement rendering.
- **Effort:** 3 weeks for one engineer.

### Phase 2 — Real 3D scene — **4–5 weeks**
- Add `POST /api/ds-render-3d` — kicks off async Meshy job, polls status, writes GLB URL to `scenes` table.
- Frontend switches from `<canvas>` to a three.js viewer when the GLB is ready (graceful fallback to 2D if rendering fails or is slow).
- Map segments-from-Phase-1 onto mesh faces using camera intrinsics from the original photo (raycast from segment centroid into the GLB). Persist `segment_id ↔ mesh_node_id` linkage.
- Clicking the 3D mesh highlights the node and triggers the same product search as Phase 1.
- **Ships:** rotatable 3D scene with click-to-select components.
- **Deferred:** in-scene visualization of the replacement (the new fridge doesn't actually appear in the 3D view — user sees product cards in a sidebar).
- **Effort:** 4–5 weeks.

### Phase 3 — Full component swap + clarifier + replacement render — **4–6 weeks**
- New endpoint `POST /api/ds-swap` — orchestrates: identify current component (DeepSeek vision on the cropped segment region or LLM call with segment label + user query) → call enhanced `/api/clarify-project` with `context: {kind: 'component_swap'}` → on completion call `/api/product-search` with refined query → select top candidate → call Meshy on the candidate's product image → return replacement GLB.
- Frontend: in the three.js viewer, swap the selected mesh node for the replacement GLB at the same world position/scale.
- Cache replacement GLBs aggressively keyed by (retailer, sku).
- Add the gas/electric electrician-handoff CTA (see Risk #3) anywhere the swap crosses utility types.
- **Ships:** "swap my gas burner for electric" actually shows an electric range in the 3D scene.
- **Deferred:** multi-component swaps in one session, save-and-share, AR view on iOS, lighting harmonization.
- **Effort:** 4–6 weeks.

**Total to full feature: ~13–16 weeks of one-engineer time. MVP value at week 4–5.**

---

## 5. Top 5 Risks / Unknowns

1. **Segmentation accuracy on real consumer phone photos.** Phase 0 must test photos with motion blur, top-down phone-held-overhead angles, glare on stainless steel, partial occlusion ("fridge half hidden by a barstool"), and HDR-fused iPhone shots that crush detail in shadows. SAM 2's training distribution leans toward web/studio imagery; we have no a priori guarantee on bathroom-faucet-against-chrome-backsplash. Mitigation: ship a "we couldn't identify this — tell us what it is" manual-label fallback chip set, and log every low-confidence segment for later fine-tuning data.

2. **3D-generation latency blocking UX.** Image-to-3D jobs take tens of seconds to minutes. If a user uploads and stares at a spinner for 90 seconds, they leave. Mitigation: Phase 1 ships 2D-only and feels instant; Phase 2 only enters 3D mode after segmentation + product cards are already on screen, so the spinner is a "want a 3D view?" upgrade, not a blocker.

3. **Legal exposure of suggesting electrical/gas appliance swaps without an electrician sign-off.** A gas-to-electric range swap requires a 240V/40–50A circuit that most NYC pre-war apartments don't have. Recommending an electric range to someone who can't install it is a refund-and-bad-review event at best, a liability claim at worst. Mitigation: when the LLM identifies a utility-crossing swap (gas↔electric, hardwired↔plug-in, vented↔ventless), the clarifier MUST include a "send this plan to an NYC-licensed electrician for review" CTA before any "buy" link, and the product cards carry a "professional installation required" badge. Phase 3 explicit. Consult counsel before public launch.

4. **Mobile WebGL performance.** A multi-megabyte GLB on a 3-year-old Android over LTE is a death sentence. Mitigation: Draco-compress all GLBs on the way out of `/api/ds-render-3d`, cap texture resolution at 1024², ship a `<model-viewer>` poster fallback for low-end devices (UA-sniff + WebGL capability check), and keep Phase 1's 2D path available as the canonical mobile experience.

5. **Retailer image licensing.** Showing Home Depot product thumbnails in our UI is *probably* fair use under "use to direct the buyer to that retailer" (we link out, we don't claim authorship, we're affiliate-style), but it's not a settled question. Each retailer's robots/TOS varies. Mitigation: confirm with counsel before launch; in the meantime cache thumbnails ephemerally (24h) and never republish in marketing/social. The existing `affiliate.js` module suggests we have at least thought about retailer relationships before — get that thinking written down.

---

## 6. Open Questions for the User

1. **Budget ceiling.** What's the hard monthly spend cap before we have to throttle? The 1000-users/day scenario can plausibly hit $60k/mo before optimizations. A $1k/mo cap means we ship the 2D-only flavor and never turn on Meshy.

2. **Free vs paid-only gate.** Is Design Studio a free top-of-funnel lead magnet (drives quote requests) or a paid feature ($/render or subscription)? This changes the rate-limiting model and whether 3D generation is even reachable for anonymous users.

3. **Mobile-first or desktop-only at launch?** 60–70% of contractor-lead traffic to sites like this is mobile. three.js + 5–10MB GLBs on mobile is rough. If mobile-first, Phase 2 becomes optional and Phase 1's 2D overlay becomes the canonical UX.

4. **Can Phase 1 ship as a 2D-only "Design Studio" or is the 3D promise non-negotiable in marketing copy?** This is the single biggest scope question. If 2D ships as v1 we get to launch in ~3 weeks at ~5% of the cost. If marketing has already committed to "3D" externally, we're on the 13–16-week path before anything is in production.

5. **One-shot vs saved designs.** Does a user come back tomorrow to refine? If yes we need Supabase auth, a `designs` table, share links, and a UI for "my saved scenes." If no, we save nothing past the session and the data model collapses by half.

6. **"Send to electrician" handoff after a gas/electric swap — do we want this, and do we have a referral relationship?** Tied to Risk #3. If we already have a licensed-electrician partner, this becomes a feature (and a revenue line). If not, it has to be a generic disclaimer.

7. **Affiliate revenue.** `backend/affiliate.js` exists. Are the retailer links we'd produce here run through that wrapper, and does the Design Studio share its conversion attribution with the existing quote-to-product flow, or is it a separate channel? Decides one Supabase table.
