#!/usr/bin/env python3
"""
extract.py - pull the product and room photos out of a partner catalog PDF.

Writes the photos, untouched, plus a manifest that groups them by model:

  python3 tools/collection/extract.py CATALOG.pdf OUT_DIR

Keeps only real photos (embedded JPEGs). Skips the partner's logo, page
furniture (headers, footers, page numbers) and masks, so no partner name or
model code ends up in an image. Model codes are read from the page text and
are only used to group photos and for the private order sheet (build.py
--codes-out); they never appear on the website.

Keep OUT_DIR outside the repo: the manifest holds the partner's codes.

Needs poppler-utils (pdfimages, pdftotext) and Pillow.
"""

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile

from PIL import Image, ImageStat

# A model code: two capital letters, a hyphen, then letters and digits.
CODE_RE = re.compile(r"\b([A-Z]{2})\s*-\s*([A-Z]{1,3}\d{3,5})\b")
MIN_SIDE = 250          # the partner logo is 112 px; real photos are far bigger


def run(cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout


def list_images(pdf):
    rows = []
    for line in run(["pdfimages", "-list", pdf]).splitlines()[2:]:
        f = line.split()
        if len(f) < 9:
            continue
        rows.append({"page": int(f[0]), "num": int(f[1]), "type": f[2],
                     "w": int(f[3]), "h": int(f[4]), "enc": f[8]})
    return rows


def page_codes(pdf):
    """{page: code} for pages that name one model; {page: None} for index pages
    that list many models (their images are thumbnails of the others).

    Uses the raw text order, where a code split over two lines in the layout
    ("MI-" above "S2501") comes out as one run."""
    pages = run(["pdftotext", "-raw", pdf, "-"]).split("\f")
    out = {}
    for i, text in enumerate(pages, 1):
        codes = list(dict.fromkeys("-".join(c) for c in CODE_RE.findall(text)))
        if len(codes) > 3:
            out[i] = None
        elif codes:
            out[i] = codes[0]
    return out


def border_kind(path):
    """'cutout' when the photo sits on a plain light background, else 'scene'.

    Product shots are tightly cropped, so the product often touches an edge;
    the corners are what stay background. Three plain light corners, or a
    plain light top edge, mean a cutout.
    """
    im = Image.open(path).convert("L")
    w, h = im.size
    k = max(4, min(w, h) // 40)
    plain = 0
    for x, y in ((0, 0), (w - k, 0), (0, h - k), (w - k, h - k)):
        st = ImageStat.Stat(im.crop((x, y, x + k, y + k)))
        if st.mean[0] >= 238 and st.stddev[0] < 5:
            plain += 1
    top = ImageStat.Stat(im.crop((0, 0, w, max(2, h // 30))))
    if plain >= 3 or (top.mean[0] >= 242 and top.stddev[0] < 4):
        return "cutout"
    return "scene"


def main(pdf, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    photos_dir = os.path.join(out_dir, "photos")
    os.makedirs(photos_dir, exist_ok=True)
    rows = [r for r in list_images(pdf)
            if r["type"] == "image" and r["enc"] == "jpeg" and min(r["w"], r["h"]) >= MIN_SIDE]
    codes = page_codes(pdf)
    with tempfile.TemporaryDirectory() as tmp:
        run(["pdfimages", "-j", "-p", pdf, os.path.join(tmp, "img")])
        by_num = {}
        for name in os.listdir(tmp):
            m = re.match(r"img-(\d+)-(\d+)\.jpg$", name)
            if m:
                by_num[int(m.group(2))] = os.path.join(tmp, name)
        seen = {}
        pages = {}
        for r in rows:
            src = by_num.get(r["num"])
            if not src:
                continue
            digest = hashlib.sha1(open(src, "rb").read()).hexdigest()[:12]
            if digest in seen:          # the same photo reused on another page
                continue
            dst = os.path.join(photos_dir, f"p{r['page']:03d}-{r['num']:04d}.jpg")
            with open(src, "rb") as fi, open(dst, "wb") as fo:
                fo.write(fi.read())
            seen[digest] = dst
            pages.setdefault(r["page"], []).append({
                "file": os.path.relpath(dst, out_dir), "w": r["w"], "h": r["h"],
                "kind": border_kind(dst)})

    # Group pages into models. A page with a code starts or continues that model.
    # A page without a code is either a full-page room photo (an editorial break
    # that introduces the next model) or a continuation of the previous model.
    order = sorted(pages)
    models, editorial, current = {}, [], None
    for p in order:
        if p in codes and codes[p] is None:       # an index page
            continue
        imgs = pages[p]
        code = codes.get(p)
        full_page_scene = (code is None and len(imgs) == 1 and imgs[0]["kind"] == "scene"
                           and imgs[0]["w"] >= 1100)
        if full_page_scene:
            nxt = next((codes[q] for q in order if q > p and codes.get(q)), current)
            editorial.append({"page": p, "image": imgs[0], "before": nxt})
            continue
        if code:
            current = code
        if current is None:
            continue
        m = models.setdefault(current, {"code": current, "pages": [], "cutouts": [], "scenes": []})
        m["pages"].append(p)
        for im in imgs:
            m["cutouts" if im["kind"] == "cutout" else "scenes"].append(im)

    manifest = {"source": os.path.basename(pdf), "models": list(models.values()),
                "editorial": editorial}
    with open(os.path.join(out_dir, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=2)
    n_cut = sum(len(m["cutouts"]) for m in models.values())
    n_scene = sum(len(m["scenes"]) for m in models.values())
    print(f"{len(models)} models, {n_cut} product photos, {n_scene} room photos on product "
          f"pages, {len(editorial)} full-page room photos")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
