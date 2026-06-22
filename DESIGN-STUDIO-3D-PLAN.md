# Design Studio 3D — Room Planner Plan
**Project:** nycrenovationexperts.com
**Page:** `/designstudio3d.html` (new — separate from the existing `/designstudio.html`)
**Status:** Plan / asset-sourcing guide

---

## 0. What this is (and how it differs from the existing Design Studio)

You already have **`designstudio.html`** — a *photo → AI fixture-swap* tool:
upload a photo of your real kitchen/bath, AI detects fixtures, you click one,
it finds replacement products and previews a single 3D model dropped onto your
photo.

What you're describing now is a **different product: a 3D room planner**
(think IKEA Home Planner / Planner5D / RoomSketcher):

- Start from a **floor-plan template** (railroad apartment, 1-bed, 2-bed with
  kitchen + bath + living room, studio, etc.) — or draw your own walls.
- Drag **real 3D furniture/fixture objects** (sofa, fridge, oven, faucet,
  lights, bed, vanity, toilet, cabinets…) from a catalog into the room.
- Move / rotate / resize them, switch between a **2D top-down plan** and a
  **3D walk-through** view.
- Save the design, export an image, and (your business angle) turn it into a
  **quote request** via the existing `/quote.html` flow.

These two tools can live side-by-side and link to each other. This plan only
covers the **new 3D room planner**.

---

## 1. The honest answer about "downloading all 3D objects + templates"

There is **no single place to download "everything"** (every sofa, fridge,
oven, faucet, plus every apartment layout) in one bundle. It comes from two
separate efforts:

1. **3D furniture/fixture models** → downloaded from free CC0 asset libraries
   (below). You curate a starter set of ~40–80 models, one or two per category.
2. **Floor-plan templates** → these are **data you author**, not files you
   download. A "2-bed railroad apartment" is just a list of wall coordinates +
   room labels in a JSON file (~30 lines). You build a handful by hand and the
   planner renders them. (Optionally seed them from real NYC apartment
   layouts you trace.)

So the realistic path is: **download a curated furniture set + hand-author a
dozen template JSON files**, not "download the whole catalog."

---

## 2. Where to get the 3D objects (furniture, appliances, fixtures)

Use **CC0 / clearly-licensed, low-poly `.glb`/`.gltf`** models — `.glb` loads
directly in three.js (which you already use), needs no conversion, and stays
small enough for mobile.

### Recommended free sources (in priority order)

| Source | License | Why | How to download |
|---|---|---|---|
| **[Poly Pizza](https://poly.pizza/)** (e.g. [furniture](https://poly.pizza/search/furniture)) | CC0 / CC-BY | Successor to Google Poly. Thousands of low-poly furniture/appliance models, already `.glb`, browser-friendly. **Best starting point.** | Search → click model → "Download" → GLB. Note the author for CC-BY credit. |
| **[Quaternius](https://quaternius.com/)** | CC0 | Clean low-poly **packs** (interiors, kitchen, furniture) — whole sets in one download, consistent style. | Download the pack `.zip`, extract `.glb` files. |
| **[Poly Haven](https://polyhaven.com/models)** | CC0 | Higher-fidelity models + free HDRIs/textures for nice lighting. | Download `.glb` (pick 1k/2k texture size). |
| **[Sketchfab](https://sketchfab.com/tags/cc0)** (filter to **CC0** or **Downloadable**) | varies — **check each** | Huge selection incl. specific appliances/faucets. | Filter "Downloadable" + license. Download `.glb`. **Do not assume commercial-safe — verify per model.** |
| **[Khronos glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets)** | mixed/CC0 | Reference models for testing your loader. | Clone repo, copy `.glb`. |
| **itch.io** ([glb tag](https://itch.io/game-assets/free/tag-glb)) | varies | More low-poly furniture packs. | Per-asset license check. |

### What to grab for a starter catalog (~one or two per category)

- **Kitchen:** fridge, oven/range, dishwasher, microwave, sink, faucet, range
  hood, base cabinet, wall cabinet, island, countertop.
- **Bathroom:** toilet, vanity, sink + faucet, bathtub, shower, mirror.
- **Living/bedroom:** sofa, armchair, coffee table, TV stand, bed, nightstand,
  dresser, wardrobe, bookshelf, dining table + chairs, rug.
- **Lighting/decor:** ceiling light, pendant, floor lamp, table lamp, plant,
  window, door.

That's ~40 models — a strong v1. Add more over time.

### Licensing rules (important for a commercial site)
- **Prefer CC0** (no attribution, commercial OK). Safest for a business site.
- **CC-BY** is fine **if you credit** the author — keep a `CREDITS.md` and an
  in-app "3D models by…" line.
- **Avoid** "personal use only" / "editorial" / no-redistribution models.
- Keep a spreadsheet: `model | category | source URL | author | license`.
- **Do not** re-host paid catalogs (TurboSquid/CGTrader paid, etc.) without a
  license.

### Optional: generate your own
Your existing backend already calls an image-to-3D vendor (`backend/ds-render3d.js`,
Trellis/Meshy on fal.ai). You can generate a `.glb` from a product photo and
**cache it forever** in the catalog — good for getting an exact SKU you sell.

---

## 3. Where to get the floor-plan templates

**You author these as JSON** — they are not downloadable files. A template is a
list of walls (line segments) + room labels. Example shape:

```json
{
  "id": "railroad-2br",
  "name": "Railroad 2-Bedroom",
  "units": "ft",
  "walls": [
    { "x1": 0, "y1": 0, "x2": 40, "y2": 0 },
    { "x1": 40, "y1": 0, "x2": 40, "y2": 12 },
    { "x1": 40, "y1": 12, "x2": 0, "y2": 12 },
    { "x1": 0, "y1": 12, "x2": 0, "y2": 0 },
    { "x1": 12, "y1": 0, "x2": 12, "y2": 12 },
    { "x1": 26, "y1": 0, "x2": 26, "y2": 12 }
  ],
  "rooms": [
    { "label": "Living Room", "x": 6,  "y": 6 },
    { "label": "Bedroom",     "x": 19, "y": 6 },
    { "label": "Kitchen",     "x": 33, "y": 6 }
  ],
  "doors":   [ { "wall": 4, "at": 0.5 } ],
  "windows": [ { "wall": 0, "at": 0.3 } ]
}
```

Author **8–12 templates**: studio, railroad 1-bed, railroad 2-bed, classic
6, 2-bed/2-bath, open-plan kitchen+living, small bathroom, galley kitchen, etc.
Each is ~30–60 lines. You can trace real NYC layouts from listing floor plans
to get realistic proportions (trace only — don't copy a copyrighted image into
the repo).

**Faster alternative:** adopt an existing open-source planner's data model
instead of inventing one — see §6.

---

## 4. How it fits your current stack (no build step)

Your site is static HTML on Vercel with **three.js loaded from a CDN via an
importmap** (already in `designstudio.html`). The 3D planner uses the same
pattern — **no React, no bundler, no npm build**:

```
/designstudio3d.html        ← new page (Bootstrap-styled like the rest)
/js/designstudio3d.js        ← three.js scene, drag/drop, save (ES module)
/models/                     ← your downloaded .glb files
   /kitchen/fridge.glb …
/data/templates/             ← your floor-plan JSON files
   railroad-2br.json …
/data/catalog.json           ← index: model → {name, category, file, size}
```

three.js add-ons you'll use (all from the same CDN importmap you already have):
`GLTFLoader` (load `.glb`), `OrbitControls` (camera), `TransformControls`
(move/rotate furniture), `RoomEnvironment` (free soft lighting), `DRACOLoader`
(decompress compressed GLBs).

**Reuse from the existing studio:** navbar/footer markup, Bootstrap styling,
the importmap block, and the `/quote.html` hand-off so a finished design
becomes a lead.

---

## 5. Step-by-step to-do list

### Phase A — Assets (do this first, ~1–2 days)
1. Create a `/models/` folder structure by category.
2. Download ~40 CC0 `.glb` models from Poly Pizza + Quaternius (§2). Rename
   consistently (`fridge.glb`, `sofa.glb`…).
3. Run each through a GLB optimizer (`gltf-transform optimize` or
   [gltf.report](https://gltf.report)) to Draco-compress + shrink textures
   (target < 1–2 MB each for mobile).
4. Write `/data/catalog.json` listing every model: name, category, file path,
   default real-world size (so a sofa imports ~7 ft wide, not giant).
5. Start `CREDITS.md` + a license spreadsheet.

### Phase B — Templates (~1 day)
6. Hand-author 8–12 floor-plan JSON files in `/data/templates/` (§3).
7. Add a `templates-index.json` listing them with a thumbnail + name.

### Phase C — The planner page (~1–2 weeks for v1)
8. Create `designstudio3d.html`: navbar/footer copied from `designstudio.html`,
   a left **catalog sidebar** (thumbnails grouped by category), a center
   **3D canvas**, a top **template picker**, and a **2D/3D toggle**.
9. Create `js/designstudio3d.js`:
   - Load three.js + `GLTFLoader`/`OrbitControls`/`TransformControls`.
   - Render the selected template's walls/floor.
   - Click a catalog item → load its `.glb` → place in room.
   - Drag to move, `TransformControls` to rotate/scale, `Delete` to remove.
   - 2D top-down ortho camera ↔ 3D perspective camera toggle.
10. **Save / load:** serialize the scene (list of `{modelId, x, y, rotation,
    scale}` + templateId) to `localStorage` first; later to Supabase (your
    backend already uses it) for accounts.
11. **Export:** "Download image" (canvas screenshot) + "Get a quote for this
    design" button that posts the item list into the existing quote flow.
12. Add a **"Design Studio 3D"** link to the navbar across the site
    (`index.html`, `service.html`, etc. — same nav block in each page).

### Phase D — Polish & ship
13. Mobile: cap texture sizes, lazy-load models, fall back gracefully on low-end
    WebGL. Test on a real phone (60–70% of your traffic is mobile).
14. Deploy: it's static, so a push to the branch → merge → Vercel auto-deploys.
    No new env vars needed for the offline planner (catalog + templates are
    static files). Supabase save and on-demand 3D generation come later.

**v1 (templates + drag-drop catalog + save/export) is ~2–3 weeks.** Phase A+B
(assets) you can start today.

---

## 6. Faster option: fork an existing open-source planner

If you'd rather not build the 3D engine from scratch, adapt one of these
(MIT-ish licenses — verify each) and reskin it to your brand + wire it to your
quote flow:

- **[blueprint3d](https://github.com/furnishup/blueprint3d)** — the classic
  three.js interior planner (2D floorplan + 3D view + furniture). Plain JS,
  closest to your no-build stack.
- **[blueprint-js](https://github.com/aalavandhaann/blueprint-js)** — modern
  ES6 rewrite of blueprint3d. (Its README literally asks for free low-poly
  furniture models — same sourcing problem §2 solves.)
- **[open3dFloorplan](https://github.com/theLodgeBots/open3dFloorplan)** —
  SvelteKit + three.js, 2D editor → 3D view, 140+ items, runs fully in-browser.
- **[architect3d](https://github.com/amitukind/architect3d)** — WebGL 3D
  interior tool with 2D floor planner.

**Trade-off:** forking gets you walls/drag/3D for free but most use a build
step (npm/bundler) — different from your current static pages — and you'd still
supply your own furniture catalog (§2). Building fresh keeps the no-build
simplicity and matches your existing `designstudio.js`.

**Recommendation:** start with **blueprint3d** as a reference (its data model
for walls/rooms is exactly what §3 describes), but implement a slim custom
`designstudio3d.js` so it stays consistent with your current zero-build site.

---

## 7. Open questions for you
1. **Build from scratch (no-build, matches your site)** or **fork blueprint3d**
   (faster engine, adds a build step)?
2. Is the 3D planner a **free lead-magnet** (drives quotes) or a saved-account
   feature (needs Supabase auth)?
3. Should "**Get a quote for this design**" be the primary CTA (turns a layout
   into a renovation lead)? I'd strongly recommend yes — it's your revenue tie-in.
4. How many starter **templates** and **furniture models** do you want for v1
   (I suggest ~12 templates, ~40 models)?

---

*Sources for asset libraries and reference planners are linked inline above.*
