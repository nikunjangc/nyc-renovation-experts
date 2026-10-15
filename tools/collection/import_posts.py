#!/usr/bin/env python3
"""
import_posts.py - add a collection from ready-made Instagram posts.

  python3 tools/collection/import_posts.py FOLDER CONFIG.json

FOLDER holds 1080x1350 posts made with build.py's post layout, named
<singular>-NN.jpg (sofa-01.jpg, dining-table-01.jpg...), and captions.txt
with one block per post:

  ===== sofa-01.jpg  (Sofa No. 01, Pillow-Arm Deep Sofa)

  <summary: what the photo shows>

  Sofa No. 01, the Pillow-Arm Deep Sofa. <more: versions and finishes>

  From our partner collection. DM us "Sofa 01" for sizes, finishes and pricing.

  #hashtags

CONFIG.json:

  {"slug": "sofas", "title": "Sofas & Sectionals", "noun": "sofa",
   "lead": "...", "intro": "...",
   "filters": [{"tag": "sectional", "label": "Sectionals", "match": ["sectional", "chaise"]}],
   "hero_grid": [1, 12, 9, 23], "rooms": [], "after": "beds"}

"match" entries are regular expressions searched in the name, summary and
"more" text. "hero_grid" picks four pieces for the page header and the
landing card. "rooms" lists the posts whose photo is a room shot rather than
a product on the studio background (look at the posts; the script prints
the ones that might be). "after" places the collection after that slug on the landing
page (default: at the end).

Writes collection/<slug>/catalog.json, images.json and img/ (the product
photo cut out of each post's photo area), copies the posts to
collection/posts/<slug>/ with posts.json, and marks the collection live in
collection/collections.json. Then run: build.py pages, build.py check.
"""

import json
import os
import re
import shutil
import sys
import tempfile

TOOLS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS)
import build  # noqa: E402

HEAD_RE = re.compile(r"^(\S+\.jpg)\s+\((.+?) No\. (\d+), (.+)\)\s*$")
PHOTO_AREA = (40, 200, 1040, 952)     # inside a post: below the wordmark, above "No. NN"


def parse_captions(text):
    posts = []
    for block in re.split(r"^===== ", text, flags=re.M)[1:]:
        head, _, body = block.partition("\n")
        m = HEAD_RE.match(head.strip())
        if not m:
            sys.exit(f"captions.txt: can't read the line '===== {head.strip()}'")
        file, label, no, name = m.group(1), m.group(2), int(m.group(3)), m.group(4).strip()
        caption = body.strip()
        paras = [p.strip() for p in caption.split("\n\n") if p.strip()]
        if len(paras) < 3:
            sys.exit(f"captions.txt: {file} needs a summary, a detail line and the ask")
        prefix = f"{label} No. {no:02d}, the {name}."
        more = paras[1][len(prefix):].strip() if paras[1].startswith(prefix) else paras[1]
        tags = paras[-1].split() if paras[-1].startswith("#") else []
        posts.append({"file": file, "singular": label, "no": no, "name": name,
                      "summary": paras[0], "more": more, "hashtags": tags, "caption": caption})
    return posts


def cut_photo(post_file, bg_hex, room):
    """The photo inside a post, trimmed to what differs from the background.
    Also returns whether it looks like a full-rectangle (room) photo, as a hint."""
    import numpy as np
    from PIL import Image
    im = Image.open(post_file).convert("RGB").crop(PHOTO_AREA)
    a = np.asarray(im, dtype=np.int16)
    bg = np.array(build.hex_to_rgb(bg_hex), dtype=np.int16)
    diff = np.abs(a - bg).max(axis=2)
    mask = diff > 10
    rows = np.where(mask.sum(axis=1) > 2)[0]
    cols = np.where(mask.sum(axis=0) > 2)[0]
    if len(rows) == 0 or len(cols) == 0:
        sys.exit(f"{post_file}: no photo found in the post")
    top, bottom, left, right = rows[0], rows[-1] + 1, cols[0], cols[-1] + 1
    k = 8
    corners = [diff[top:top + k, left:left + k], diff[top:top + k, right - k:right],
               diff[bottom - k:bottom, left:left + k], diff[bottom - k:bottom, right - k:right]]
    looks_room = sum(1 for c in corners if c.mean() > 14) >= 3
    pad = 0 if room else 14
    h, w = diff.shape
    box = (max(0, left - pad), max(0, top - pad), min(w, right + pad), min(h, bottom + pad))
    return looks_room, im.crop(box)


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    folder, config_file = sys.argv[1], sys.argv[2]
    cfg = build.load(config_file)
    slug = cfg["slug"]
    with open(os.path.join(folder, "captions.txt"), encoding="utf-8") as fh:
        posts = parse_captions(fh.read())
    singulars = [p["singular"] for p in posts]
    main_singular = max(set(singulars), key=singulars.count)

    bg = build.STAGE_BG
    models = []
    for p in posts:
        text = " ".join([p["name"], p["summary"], p["more"]]).lower()
        tags = [f["tag"] for f in cfg.get("filters", [])
                if any(re.search(rx, text) for rx in f["match"])]
        m = {"no": p["no"], "name": p["name"], "summary": p["summary"], "more": p["more"],
             "tags": tags, "hashtag": p["hashtags"][-1] if p["hashtags"] else ""}
        if p["singular"] != main_singular:
            m["singular"] = p["singular"]
        models.append(m)
    base_tags = []
    for p in posts:
        for t in p["hashtags"][:3]:
            if t not in base_tags:
                base_tags.append(t)
    cat = {"slug": slug, "title": cfg["title"], "singular": main_singular,
           "noun": cfg.get("noun", main_singular.lower()), "lead": cfg["lead"], "intro": cfg["intro"],
           "source": "Imported from ready-made posts (tools/collection/import_posts.py)",
           "hashtags": base_tags[:3], "filters": [{"tag": f["tag"], "label": f["label"]}
                                                  for f in cfg.get("filters", [])],
           "models": models}
    if cfg.get("hero_grid"):
        cat["hero_grid"] = cfg["hero_grid"]
    keys = [build.anchor(cat, m) for m in models]
    dupes = sorted({k for k in keys if keys.count(k) > 1})
    if dupes:
        sys.exit("Two posts share a number: " + ", ".join(dupes))

    img_dir = build.path("collection", slug, "img")
    post_dir = build.path("collection", "posts", slug)
    for d in (img_dir, post_dir):
        os.makedirs(d, exist_ok=True)
        for name in os.listdir(d):
            if name.endswith((".webp", ".jpg")):
                os.remove(os.path.join(d, name))

    images = {"stage_bg": bg, "models": {}, "editorial": []}
    out_posts, hints = [], []
    rooms = set(cfg.get("rooms", []))
    with tempfile.TemporaryDirectory() as tmp:
        for p, m in zip(posts, models):
            key = build.anchor(cat, m)
            src = os.path.join(folder, p["file"])
            kind = "room" if m["no"] in rooms else "product"
            looks_room, photo = cut_photo(src, bg, kind == "room")
            if looks_room and kind != "room":
                hints.append(m["no"])
            png = os.path.join(tmp, key + ".png")
            photo.save(png)
            feather = bg if kind == "product" else None
            box, q = ((build.PRODUCT_BOX, build.PRODUCT_Q) if kind == "product"
                      else (build.ROOM_BOX, build.ROOM_Q))
            w, h = build.to_webp(png, os.path.join(img_dir, key + "-1.webp"), box, q, feather)
            build.to_webp(png, os.path.join(img_dir, key + "-1-t.webp"), build.THUMB_BOX, build.THUMB_Q, feather)
            images["models"][key] = [{"src": f"collection/{slug}/img/{key}-1.webp",
                                      "thumb": f"collection/{slug}/img/{key}-1-t.webp",
                                      "w": w, "h": h, "kind": kind, "i": 0}]
            dst = os.path.join(post_dir, key + ".jpg")
            with open(src, "rb") as fh:
                data = fh.read()
            if data[:2] == b"\xff\xd8" and not build.jpeg_has_metadata(data):
                shutil.copyfile(src, dst)
            else:
                from PIL import Image
                with Image.open(src) as im:
                    clean = Image.new("RGB", im.size)
                    clean.paste(im.convert("RGB"))
                clean.save(dst, "JPEG", quality=92)
            out_posts.append({"key": key, "label": build.label(cat, m), "no": m["no"], "name": m["name"],
                              "image": f"collection/posts/{slug}/{key}.jpg",
                              "url": f"{build.SITE}/collection/posts/{slug}/{key}.jpg",
                              "caption": p["caption"]})

    build.dump(build.path("collection", slug, "catalog.json"), cat)
    build.dump(build.path("collection", slug, "images.json"), images)
    build.dump(os.path.join(post_dir, "posts.json"), {"slug": slug, "title": cfg["title"], "posts": out_posts})

    cols_file = build.path("collection", "collections.json")
    cols = build.load(cols_file)
    entries = [c for c in cols["collections"] if c["slug"] != slug]
    entry = {"slug": slug, "title": cfg["title"], "status": "live"}
    after = cfg.get("after")
    at = next((i + 1 for i, c in enumerate(entries) if c["slug"] == after), len(entries))
    entries.insert(at, entry)
    cols["collections"] = entries
    build.dump(cols_file, cols)
    n_room = sum(1 for v in images["models"].values() if v[0]["kind"] == "room")
    print(f"{slug}: {len(models)} pieces imported ({n_room} with a room photo), posts copied")
    if hints:
        print(f"  check these posts: their photo fills its box like a room shot: {hints}. "
              f"If any is a room photo, add it to \"rooms\" and run again.")


if __name__ == "__main__":
    main()
