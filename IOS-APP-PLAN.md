# NYC Renovation iOS App — Investigation & Implementation Plan

A native iPhone/iPad app that lets a homeowner scan their room, identify the
fixtures and appliances in it, pick something to upgrade, and place a chosen
replacement product back into the 3D scene — all powered by the existing Vercel
backend (DeepSeek + SerpAPI + Supabase).

> **Scope:** This app is *separate from the website*. No changes to
> `nycrenovationexperts.com` are required. The app calls the same backend
> endpoints we already shipped.

## 1. The user journey we're building

```
1. Open app (first launch) → grant camera permission
2. Tap "Scan a room"
3. App enters RoomPlan capture mode. On-screen guidance:
     "Slowly move around the room. Point at walls, then floor, then objects."
4. App detects walls, floor, ceiling, doors, windows, AND objects
   (cabinets, appliances, fixtures) automatically — that's what RoomPlan does.
5. Scan completes. User sees a 3D model of their room with selectable objects.
6. User rotates / orbits the model (360° view).
7. User taps an object — e.g. the refrigerator.
8. App POSTs to existing /api/clarify-project with the category ("refrigerator")
   → DeepSeek returns clarifying questions (color, finish, capacity, ice maker?)
9. User picks chips, or hits "Skip — use defaults".
10. App POSTs to existing /api/product-search with the refined query
    → SerpAPI returns real products with images, prices, direct retailer links.
11. User picks a product.
12. App overlays the product's image (or 3D model if available) at the original
    object's anchor point in the scene. User can compare visually.
13. User can save the scan + chosen upgrade to Supabase for follow-up.
```

## 2. Why native iOS (not React Native, Flutter, or web AR)

| Capability we need | Native iOS | RN / Flutter | Web AR |
|---|---|---|---|
| RoomPlan (auto room scanning + object labels) | ✅ built-in | ❌ no bridge that exposes RoomPlan; would have to fork ARKit bridges | ❌ doesn't exist |
| LiDAR depth sensing | ✅ ARKit | ⚠️ via plugin | ❌ |
| Object Capture (photogrammetry on-device) | ✅ built-in | ❌ | ❌ |
| RealityKit 3D rendering | ✅ first-party | ⚠️ partial via UIKit interop | ❌ |
| Camera + AR session | ✅ ARKit | ✅ but with limits | ⚠️ WebXR very limited on iOS Safari |

**Decision: pure SwiftUI + RealityKit + RoomPlan + ARKit, no cross-platform layer.**

This means we ship iOS-only. If you want Android too, that becomes a separate
project later (Google's equivalent is ARCore + scene reconstruction, but the
APIs are very different — there's no RoomPlan analogue).

## 3. Architecture

```
                           ┌────────────────────────────────────────────────┐
                           │  USER'S iPHONE                                 │
                           │                                                │
                           │  ┌──────────────┐    ┌──────────────────────┐  │
                           │  │ SwiftUI      │    │ RealityKit + RoomPlan│  │
                           │  │ (screens,    │◄──►│ (scan, render 3D,    │  │
                           │  │  chat, chips)│    │  AR placement)       │  │
                           │  └──────┬───────┘    └──────────────────────┘  │
                           │         │                                       │
                           │  ┌──────▼─────────────────────────────────┐    │
                           │  │  RenoAPI client (URLSession + Codable) │    │
                           │  └──────┬─────────────────────────────────┘    │
                           └─────────┼──────────────────────────────────────┘
                                     │ HTTPS
                                     ▼
                ┌──────────────────────────────────────────┐
                │  VERCEL (existing, no changes)           │
                │                                          │
                │  /api/clarify-project   ──► DeepSeek     │
                │  /api/product-search    ──► SerpAPI      │
                │  /api/recommend-products ──► DeepSeek    │
                │  /api/save-quote        ──► Supabase     │
                └──────────────────────────────────────────┘
```

**Everything green-field is the iOS app. The whole RHS already exists and works
in production today.**

## 4. Component-by-component decisions

For each layer, my recommendation + the runner-up + why.

### 4.1 Scene capture: **RoomPlan**

- **Pick: `RoomPlan` framework (iOS 16+).**
- What it does: scans a room with the camera + LiDAR, outputs a parametric
  model with walls, doors, windows, openings, and *labeled object categories*
  (chair, sofa, bed, table, washer, refrigerator, dishwasher, stove, sink,
  toilet, bathtub, oven, fireplace, television, screen, storage).
- **Why it's a perfect fit for renovation:** Apple already did the "this is a
  refrigerator, this is a sink" segmentation for us. That's the hardest part of
  the Design Studio feature for the web; on iOS, we get it free.
- Runner-up: **Object Capture API** (photogrammetry from photos → USDZ).
  Better for capturing a *single object* in detail (a vase, a chair). Worse
  for whole rooms, and it doesn't label what it's seeing.
- Constraint: **RoomPlan requires LiDAR.** That's iPhone 12 Pro / Pro Max,
  iPhone 13 Pro / Pro Max, iPhone 14 Pro / Pro Max, iPhone 15 Pro / Pro Max,
  iPhone 16 Pro / Pro Max, iPad Pro (2020+). Non-Pro iPhones don't have LiDAR.
  **Open decision for you below.**

### 4.2 3D rendering: **RealityKit**

- **Pick: `RealityKit` (Apple's modern 3D + AR engine, the successor to SceneKit).**
- Renders the RoomPlan output. Handles hit-testing (tap a 3D object in the
  scene). Anchors AR content (placing a replacement model in the real world view).
- Runner-up: **SceneKit**. Mature, works fine, but Apple has clearly bet on
  RealityKit going forward. SceneKit hasn't gotten new features in ~3 years.

### 4.3 Object selection: **RoomPlan's built-in object array**

- RoomPlan output already includes a `[CapturedRoom.Object]` array with each
  object's category (`refrigerator`, `stove`, etc.), bounding box, and anchor
  transform. Tap-to-select just maps a raycast hit to the closest object in
  that array.
- **No custom ML needed.** If RoomPlan's category list is too narrow (e.g.
  we want to distinguish "induction cooktop" from "gas cooktop"), we can
  add a follow-up classification step using `Vision` + a Core ML model — but
  for an MVP, RoomPlan's categories are enough.

### 4.4 UI framework: **SwiftUI**

- **Pick: SwiftUI** (Apple's modern declarative UI). New project; no reason
  to drop down to UIKit except for thin bridges into UIKit-only APIs (the
  RoomPlan capture view is one — we wrap it in `UIViewControllerRepresentable`).

### 4.5 Networking: **`URLSession` + `Codable` against existing Vercel APIs**

- **No new backend.** Reuses:
  - `POST /api/clarify-project` (already there)
  - `POST /api/product-search` (already there)
  - `POST /api/recommend-products` (already there)
  - `POST /api/save-quote` (optional, for save-and-follow-up flow)
- Single Swift module `RenoAPI` with:
  - `ClarifyProjectRequest` / `ClarifyProjectResponse`
  - `ProductSearchRequest` / `ProductSearchResponse`
  - Bearer-token plumbing if we ever add auth (not for v1)
- Base URL config: a single `Config.swift` with the Vercel stable alias
  `https://nyc-renovation-experts.vercel.app` (same URL the website uses).

### 4.6 Replacement product placement: **2D image card anchored in 3D, for v1**

- When the user picks a replacement product, we don't have a 3D model of that
  specific SKU. Options:
  - **v1 (recommended): show the product's `thumbnail` image as a 2D card
    anchored at the original object's position.** Cheap, works for every
    product in SerpAPI results.
  - **v2: parametric 3D placeholder** — drop a generic "refrigerator-shaped
    box" at the right scale, colored to match. Still cheap, slightly more
    immersive.
  - **v3: real 3D models.** Would require either a catalog of USDZ models we
    license (CGTrader, ArchVision — $) OR generating one on demand from the
    product image (Luma AI's image → 3D, ~$0.50/render). Defer until later.

### 4.7 Persistence: **Supabase iOS SDK, optional for v1**

- For v1, scans don't need to persist — the user does a scan, picks an
  upgrade, decides whether to call us. No login.
- If we later want "Save my scan and pick up where I left off," we add
  `supabase-swift` (official Supabase SDK) and a new table
  `room_scans (id, user_id, room_data jsonb, created_at)`.
- **No new backend code needed for save** — Supabase SDK talks directly to
  Supabase from the device using the anon key + RLS.

## 5. Phased build plan

Each phase is independently shippable / demoable. Stop at any phase if
priorities shift.

### Phase 0 — Setup (you, ~1 day total)

Not code, just gates:

- Open an Apple Developer Program account ($99/year) — required for device testing.
- Install Xcode 16 from the Mac App Store (~50 GB download, slow on first install).
- Confirm you have a LiDAR-capable iPhone for testing. iPhone 12 Pro or newer Pro.

### Phase 1 — Scan & view (~1 week of coding)

The scan-only MVP. Demonstrably useful by itself.

- Xcode project scaffold (SwiftUI app, info.plist, entitlements).
- Camera permission flow with friendly explainer screen.
- RoomPlan capture screen — wraps `RoomCaptureView`, shows real-time scan
  progress + tips ("now point at the floor", "scan the corner").
- "Scan complete" screen — opens a RealityKit 3D view of the model. User can
  orbit / zoom with gestures.
- Save scan locally (just a `CapturedRoom` JSON in Documents directory).

**What you'd have after Phase 1:** a working scan-and-view app. You could
demo this to clients as-is.

### Phase 2 — Object tap → AI clarification → product results (~1 week)

- Hit-test in the 3D view: tap an object → identify which category from the
  RoomPlan object array.
- Highlight the tapped object visually (selection halo).
- Bottom sheet slides up: "Replace your refrigerator?"
- Tap "Find replacements" → call `/api/clarify-project` with category info →
  show chip-style multiple choice, same UX as the website's wizard.
- User answers → call `/api/product-search` → show product cards
  (image, price, retailer, rating).
- Tap a card → open the retailer URL in Safari (default for v1).

**What you'd have after Phase 2:** a full "scan room → pick item to replace →
see real products" flow. Genuinely useful for a sales conversation.

### Phase 3 — AR placement of replacement (~1-2 weeks)

- "Place in my room" button on a product card.
- 2D image card anchored at the original object's position in the room model.
- (Optional) switch to AR camera view where the user sees the replacement
  composited into the live camera feed of their actual room.

**What you'd have after Phase 3:** the full upgrade-preview experience.

### Phase 4 — Polish + App Store submission (~2-3 weeks)

- Onboarding flow / first-launch tutorial.
- Empty states, error states, "no LiDAR detected" gate, network failure recovery.
- App icon (you'll need designs in 1024×1024 + assorted sizes).
- App Store screenshots for all required device sizes.
- Privacy nutrition labels (camera, network, no PII).
- Submit to TestFlight first → invite ~5 testers → fix issues → submit to App Store.

**What you'd have after Phase 4:** an app live in the App Store.

## 6. Cost projection

| Item | Cost | Notes |
|---|---|---|
| Apple Developer Program | $99/year | Required, non-negotiable |
| Backend (Vercel + DeepSeek + SerpAPI + Supabase) | $0 incremental | All already paid via website |
| iCloud sync (if added later) | $0 | First 5 GB free, plenty |
| TestFlight beta distribution | $0 | Included with Dev Program |
| App Store distribution | $0 | Included |
| Optional: 3D product model generation (Phase 3 v3) | ~$0.50/render | Luma AI image-to-3D, only if pursued |
| **Total ongoing cost for v1** | **$99/year** | All scale comes from Vercel/SerpAPI already |

The cost story is great: by reusing the existing backend, we add zero new cloud spend.

## 7. Risks & unknowns

| # | Risk | Mitigation |
|---|---|---|
| 1 | **RoomPlan accuracy on real consumer rooms** is variable. Apple's demos are pristine, but a cluttered kitchen might mis-classify a microwave as "storage" or miss appliances behind doors. | Test early with a real kitchen. Have a manual "label this object" fallback when RoomPlan's confidence is low. |
| 2 | **LiDAR requirement excludes non-Pro phones** (~50% of iPhone users). | Ship LiDAR-only for v1, broadly market "iPhone Pro experience". Add non-LiDAR Object Capture flow in v2 if demand justifies it. |
| 3 | **App Store review** for the AI clarification flow: Apple sometimes pushes back on AI-generated content shown to users. | Disclose AI usage in app description + privacy labels. Show that the LLM only suggests *categorical questions*, not arbitrary text the user reads as advice. |
| 4 | **Backend latency from cellular**: DeepSeek calls average 5-10s. Feels slow on a phone. | Show progress with the chip animation we already use on the website. Cache aggressively (clarification questions for a given category change rarely). |
| 5 | **Retailer affiliate disclosure** in app. Apple requires apps to disclose if they earn commission on linked purchases. | Add a one-line disclosure on the product card screen: "We may earn a commission on purchases through these links." Required if you've activated affiliate codes on the website. |

## 8. Open questions — your call before any code is written

You need to answer these so the Phase 1 scaffold isn't built on assumptions:

### Q1: LiDAR-only vs LiDAR-preferred-with-fallback?
- **A) LiDAR-only** (faster to ship, better experience, half the market) — recommended for v1.
- **B) Fall back to Object Capture for non-LiDAR phones** (broader market, ~2 extra weeks, scan quality drops).

### Q2: Do you have an Apple Developer Program account already?
- **A) Yes** — share the team ID (it goes in the Xcode project).
- **B) No** — sign up at https://developer.apple.com/programs/. Takes 24-48h for approval after payment.

### Q3: New GitHub repo for the iOS app, or subdirectory of `nyc-renovation-experts`?
- **A) New repo `nyc-renovation-ios` (Recommended)** — Xcode projects have many generated files and conventions; cleaner to isolate.
- **B) Subdirectory `ios/` in existing repo** — single place, easier cross-reference, but mixes Node and Swift tooling.

### Q4: App name + Bundle ID
- App name on home screen (max 12 chars works best): suggestions — "NYC Reno", "Reno Studio", "RenoVision", "RoomPlan NYC".
- Bundle ID format: `com.nycrenovationexperts.app` (recommended) — you'll need to own the reverse-DNS prefix.

### Q5: Visual branding — match the website (orange #FDA12B + same brand voice), or design from scratch?
- **A) Match the website** — fastest, consistent brand. iOS allows arbitrary tint colors.
- **B) Design from scratch** — opportunity to refresh, but adds time before MVP.

### Q6: Save scans to Supabase, or local-only for v1?
- **A) Local-only v1** (Recommended) — no auth needed, simpler.
- **B) Supabase sync from day one** — requires sign-in flow (Sign in with Apple is one tap, looks polished). Adds ~3 days.

### Q7: Where do "Find a contractor" / lead-generation buttons go?
- Product card screen → "Have us install this" button → calls existing `/api/save-quote` with the scan data + chosen product. Gives you a lead with full context.
- **A) Add the button in Phase 2** (Recommended — it's the monetization path).
- **B) Defer to Phase 4** — keep app feeling like a playground first.

## 9. What I need from you to start writing Swift

1. Answers to **Q1–Q7** above.
2. Confirmation you've installed Xcode 16 (`xcode-select -p` should print `/Applications/Xcode.app/Contents/Developer`).
3. Confirmation you have a LiDAR-capable iPhone to test on (Settings → General → About → Model Name should include "Pro").
4. If you have an Apple Developer account already, the team ID (Settings → General → About → "Apple ID" in the dev portal).
5. If you want a new repo (Q3 = A), create it empty on GitHub: `https://github.com/nikunjangc/nyc-renovation-ios` (or whatever name you pick). I'll need the URL.

## 10. What I'll do once you've answered

1. Scaffold the Xcode project (`.xcodeproj`, info.plist, entitlements, SwiftUI app entry).
2. Write `RenoAPI` Swift module — typed wrappers around our existing endpoints.
3. Implement Phase 1: scan + view. ~600-1000 lines of Swift across ~10 files.
4. Push to your new repo with a `README.md` covering how to build, run, and test.
5. Walk you through opening it in Xcode and running on your device.
6. Hand off Phase 2 + 3 + 4 as separate PRs, each demoable on its own.

Phase 1 first push is realistically ~1 day of my work once Q1–Q7 are answered.

---

*Doc generated 2026-06-16. Source-of-truth lives in this file; updates go via
PR with `[doc]` prefix.*
