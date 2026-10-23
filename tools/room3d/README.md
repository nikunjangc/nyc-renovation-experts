# 3D Room (room3d.html)

Scan a room with a phone (or upload a 360 photo), turn it into a 3D room,
then paint walls, change the floor, remove what's there and place furniture,
live. No app: Safari and Chrome give an https page the camera and the motion
sensors after the person taps Allow.

The page is `room3d.html` (noindex while it's being tested). Code is in
`js/room3d/`, styles in `css/room3d.css`.

## How it works

1. **Capture** (`capture.js`). The back camera (the 0.5x ultra-wide when the
   phone has one: about 16 photos instead of about 31) and `deviceorientation`.
   Dots mark where to point; a photo is taken when the phone lines up with a
   dot and holds still. Each photo keeps the phone's orientation.
2. **Stitch** (`stitch.js`, `calibrate.js`). Small copies of the photos are
   lined up first: the lens's focal length (one value), each photo's
   yaw/pitch/roll (the sensors are off by a degree or two) and each photo's
   exposure and colour, by making overlaps agree (normalized
   cross-correlation, so brightness changes don't pull the alignment). Then
   the GPU projects the full photos into a 4096 x 2048 panorama and blends
   them; gaps straight up or down are filled from the surroundings.
3. **Room shape** (`layout.js`, `room.js`). The person taps the floor in each
   corner; with the phone's height (4.9 ft assumed) each tap is a floor point.
   Corners are squared up when they nearly meet at right angles. The ceiling
   line is found from the strongest wall/ceiling edge and can be slid; typing
   the real ceiling height scales the room. Walls, floor and ceiling are real
   geometry, and the panorama is projected onto them from the photo spot.
4. **Editing** (`app.js`).
   - Paint: a fill (`masks.js`) finds the wall around the tap (same
     chromaticity, smooth lightness, stops at edges and at the wall's outline)
     and the shader recolours it, keeping the photo's light and shadow.
   - Floors (`floor.js`, `cut.js`; run in `floor-worker.js` off the main
     thread, started as soon as the room opens). Spots in front of the walls
     give the floor's look (colour and how grainy it is); the strip of wall
     above the floor line, where furniture stands, gives "not floor". Two
     colour models and a minimum cut (GrabCut, with a Boykov-Kolmogorov max
     flow) then label every pixel: neighbours that look alike stay together,
     so plank joints and grain don't break the floor up, while the edge of a
     rug or a chair does. Only floor that reaches a wall is kept (a rug can
     look just like the floor, but it doesn't reach a wall), and reflections
     on a glossy floor are filled. Tapping the floor adds that spot (and the
     plain floor around it); "Not here" runs it again with that spot held
     out, so the rest of a rug that looks like it goes too. The floor texture
     is laid in real feet and shaded by the photo.
   - On walls, "Not here" takes a patch (a door, a picture) back out.
   - Furniture: the catalog's models (`data/catalog.json`, `models/`) at real
     size; drag, turn, resize, snap to walls; lit by the room's own photo.
   - Remove (`erase.js`): a camera view is cut from the panorama around the
     tap, Segment Anything outlines the object (`/api/ds-mask`), the eraser
     fills it (`/api/room-erase`, fal.ai Bria Eraser, about $0.04), and the
     result is pasted back into the panorama.
   - Shop (`shop.js`): `/api/product-search` (store results with affiliate
     links), then `/api/ds-render3d` makes a 3D model from the product photo.
   - Everything is saved in the browser (IndexedDB, `store.js`).

## Tests

```bash
node --test tools/room3d/test.mjs           # math, room shape, fills, min cut, alignment

python3 -m http.server 8765 --bind 127.0.0.1    # repo root
node tools/room3d/check.js http://127.0.0.1:8765 /tmp/room3d-shots
```

`check.js` drives the page in headless Chromium and saves screenshots. The
backend is mocked. The `floor` scenario also scores the floor it finds in the
sample room against the true floor (`sample-floor-truth.png`, from
`sample_room.py --labels`). The `scan` and `scanwide` scenarios replace the camera and
motion sensors with a simulated phone looking at the sample panorama, with
sensor error and a wrong lens guess, and check that capture, alignment and
stitching come out right. The CDN libraries come from local npm copies (see
the top of the file).

## The sample room

`img/room3d/sample-living-room.jpg` and `data/room3d-sample.json` come from
`sample_room.py` (Blender Cycles, `pip install bpy` for Python 3.11):

```bash
python3.11 tools/room3d/sample_room.py /abs/out.png 4096 40 /abs/art.png --layout /abs/layout.json
```

Everything in it is modeled in the script; floor and wood textures are the
CC0 files in `textures/`. `--labels` renders flat colours by material instead
(floor, wall paint, ceiling, trim, rug, everything else), the truth for
checking the wall and floor fills; `--variant 2` (dark glossy floor, dark
baseboards) and `--variant 3` (light floor, furniture and rug close to its
colour) render harder looks of the same room for testing.

## Limits worth knowing

- Only the walls, floor and ceiling are 3D. Things in the photo (a sofa) look
  flat when you walk away from the photo spot; Remove takes them out.
- Without LiDAR the size comes from the assumed phone height or the ceiling
  height the person types.
- Handheld photos have some parallax (the phone moves as you turn), which can
  leave soft seams on nearby objects. Turning around the phone helps.
- The floor finder goes by colour and texture. Furniture or a rug the same
  colour as the floor can get the new floor too (tap "Not here" on it), and
  glossy floors with strong reflections may need a tap or two.
