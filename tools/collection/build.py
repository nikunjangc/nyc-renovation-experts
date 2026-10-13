#!/usr/bin/env python3
"""
build.py - turn a partner catalog into the Partner Collection pages.

  python3 tools/collection/build.py images SLUG MANIFEST [--codes-out FILE]
  python3 tools/collection/build.py posts SLUG
  python3 tools/collection/build.py pages
  python3 tools/collection/build.py nav
  python3 tools/collection/build.py check [--deny "word,word"]

images  Reads collection/SLUG/catalog.json (written by hand) and the manifest
        from extract.py, converts every photo to WebP with no metadata, and
        writes collection/SLUG/img/ plus collection/SLUG/images.json.
        --codes-out writes the private order sheet (our number -> the
        partner's code) to a file OUTSIDE the repo. Never commit it.
posts   Renders one 1080x1350 Instagram image per model into
        collection/posts/SLUG/ and writes the captions to posts.json.
        Needs Node and Playwright.
pages   Writes collection.html, collection-SLUG.html for every live
        collection in collection/collections.json, and collection-posts.html.
        Runs `nav` first.
nav     Adds the Collection link after "Our Services" on every page that
        doesn't have it yet.
check   Scans the generated pages, data, images and tools for anything that
        would identify the partner: words passed with --deny (their name,
        city, code prefix; keep that list out of this public repo), model
        codes, and image metadata. Exits 1 if it finds any.

Run from anywhere; paths are relative to the repo root. Needs Pillow.
The site never shows the partner's name or codes: page text, alt text, file
names and JSON use our own numbers (Bed No. 01, ...).
"""

import argparse
import csv
import html
import json
import os
import re
import subprocess
import sys
import tempfile
from urllib.parse import quote

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TOOLS = os.path.dirname(os.path.abspath(__file__))
SITE = "https://www.nycrenovationexperts.com"   # the apex domain redirects here

# Image sizes (bounding boxes) and WebP quality. Product shots sit on a plain
# background and compress well; room photos and full-width breaks need more.
PRODUCT_BOX, PRODUCT_Q = (1200, 900), 80
ROOM_BOX, ROOM_Q = (1600, 1100), 78
EDITORIAL_BOX, EDITORIAL_Q = (2000, 1300), 76
THUMB_BOX, THUMB_Q = (360, 270), 72

STAGE_BG = "#F8F7F3"   # the partner photos' studio background, measured

DISCLAIMER_LEAD = "This is our partner collection."
DISCLAIMER = ("The pieces on this page are made by our manufacturing partner and offered "
              "through NYC Renovation Experts. Photos are provided by our partner. Sizes, "
              "finishes, materials, pricing and lead times are confirmed with each order, so "
              "ask us for current details.")

SWATCHES = {
    "natural wood": "#C9A77C", "light wood": "#D9C09B", "pale wood": "#E4D8C3",
    "warm brown wood": "#8C5E3C", "dark wood": "#4A3628", "dark brown": "#5B4434",
    "red-brown wood": "#8E4B2E", "cream": "#EEE7D8", "white": "#FFFFFF",
    "cognac": "#9C5A2B", "taupe": "#A89C8C", "camel": "#B5875A", "charcoal": "#4B4B4D",
    "black": "#1F1F1F", "brass tone": "#B79A5B", "cane": "#CDAA6E",
    "dark brown marble-look": "linear-gradient(135deg,#3B271D 0%,#6B4A35 42%,#CBB592 48%,#4A3326 56%,#2F1F17 100%)",
}


# ---------------------------------------------------------------- helpers

def path(*parts):
    return os.path.join(ROOT, *parts)


def esc(value):
    return html.escape(str(value), quote=True)


def load(file):
    with open(file, encoding="utf-8") as fh:
        return json.load(fh)


def dump(file, data):
    os.makedirs(os.path.dirname(file), exist_ok=True)
    with open(file, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
        fh.write("\n")


def read_text(file):
    with open(file, encoding="utf-8") as fh:
        return fh.read()


def write_text(file, text):
    with open(file, "w", encoding="utf-8") as fh:
        fh.write(text)


def inside_repo(file):
    file = os.path.realpath(file)
    return os.path.commonpath([file, os.path.realpath(ROOT)]) == os.path.realpath(ROOT)


def collections():
    return load(path("collection", "collections.json"))["collections"]


def live(slug):
    """catalog + images for a live collection."""
    cat = load(path("collection", slug, "catalog.json"))
    imgs = load(path("collection", slug, "images.json"))
    return cat, imgs


def num(n):
    return f"{n:02d}"


def anchor(cat, model):
    return f"{cat['singular'].lower().replace(' ', '-')}-{num(model['no'])}"


def page_name(slug):
    return f"collection-{slug}.html"


def quote_link(note):
    return "quote.html?note=" + quote(note, safe="")


def model_note(cat, model):
    return (f"Partner collection: {cat['singular']} No. {num(model['no'])} ({model['name']}). "
            f"Please send sizes, finishes and pricing.")


# ---------------------------------------------------------------- images

def hex_to_rgb(value):
    value = value.lstrip("#")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def measure_bg(files):
    """The studio background of the product shots: median of their corner pixels."""
    from PIL import Image
    px = []
    for f in files:
        with Image.open(f) as im:
            im = im.convert("RGB")
            w, h = im.size
            px += [im.getpixel((2, 2)), im.getpixel((w - 3, 2))]
    if not px:
        return STAGE_BG
    mid = [sorted(p[i] for p in px)[len(px) // 2] for i in range(3)]
    return "#{:02X}{:02X}{:02X}".format(*mid)


def feather(im, bg, tol=8):
    """Blend background-coloured pixels near the photo's edges into the stage
    colour, so a product shot sits on the page (or post) with no visible box.
    Product pixels (far from the background colour) are left alone."""
    import numpy as np
    from PIL import Image
    a = np.asarray(im, dtype=np.float32)
    bgv = np.array(hex_to_rgb(bg), dtype=np.float32)
    d = np.abs(a - bgv).max(axis=2)
    close = np.clip(2 - d / tol, 0, 1)            # 1 within tol, fading to 0 at 2*tol
    h, w = d.shape
    width = max(6, round(min(w, h) * 0.04))
    yy = np.arange(h, dtype=np.float32)[:, None]
    xx = np.arange(w, dtype=np.float32)[None, :]
    edge = np.minimum(np.minimum(yy, h - 1 - yy), np.minimum(xx, w - 1 - xx))
    border = np.clip(1 - edge / width, 0, 1)
    k = (close * border)[..., None]
    out = a * (1 - k) + bgv * k
    return Image.fromarray(np.clip(out + 0.5, 0, 255).astype(np.uint8), "RGB")


def to_webp(src, dst, box, quality, bg=None):
    from PIL import Image
    with Image.open(src) as im:
        im = im.convert("RGB")
        if bg:
            im = feather(im, bg)
        im.thumbnail(box, Image.LANCZOS)
        clean = Image.new("RGB", im.size)    # a fresh image: no EXIF, XMP or ICC carried over
        clean.paste(im)
    clean.save(dst, "WEBP", quality=quality, method=6)
    return clean.size


def cmd_images(args):
    slug = args.slug
    cat = load(path("collection", slug, "catalog.json"))
    manifest_file = os.path.abspath(args.manifest)
    if inside_repo(manifest_file):
        sys.exit("Keep the manifest outside the repo: it holds the partner's codes.")
    if args.codes_out and inside_repo(args.codes_out):
        sys.exit("--codes-out must be outside the repo: the order sheet is private.")
    man = load(manifest_file)
    man_dir = os.path.dirname(manifest_file)
    out_dir = path("collection", slug, "img")
    os.makedirs(out_dir, exist_ok=True)
    for name in os.listdir(out_dir):
        if name.endswith(".webp"):
            os.remove(os.path.join(out_dir, name))

    prefix = cat["singular"].lower().replace(" ", "-")
    stage_bg = measure_bg([os.path.join(man_dir, x["file"]) for m in cat["models"]
                           for x in man["models"][m["src"]]["cutouts"]])
    result = {"stage_bg": stage_bg, "models": {}, "editorial": []}
    code_to_no, sheet = {}, []
    for model in cat["models"]:
        mm = man["models"][model["src"]]
        code_to_no[mm["code"]] = model["no"]
        items = [("product", x) for x in mm["cutouts"]] + [("room", x) for x in mm["scenes"]]
        skip = set(model.get("skip", []))
        hero = model.get("hero", 0)
        order = [hero] + [i for i in range(len(items)) if i != hero and i not in skip]
        imgs = []
        for k, i in enumerate(order, 1):
            kind, item = items[i]
            base = f"{prefix}-{num(model['no'])}-{k}"
            box, q = (PRODUCT_BOX, PRODUCT_Q) if kind == "product" else (ROOM_BOX, ROOM_Q)
            src = os.path.join(man_dir, item["file"])
            bg = stage_bg if kind == "product" else None
            w, h = to_webp(src, os.path.join(out_dir, base + ".webp"), box, q, bg)
            to_webp(src, os.path.join(out_dir, base + "-t.webp"), THUMB_BOX, THUMB_Q, bg)
            imgs.append({"src": f"collection/{slug}/img/{base}.webp",
                         "thumb": f"collection/{slug}/img/{base}-t.webp",
                         "w": w, "h": h, "kind": kind})
        result["models"][str(model["no"])] = imgs
        sheet.append([f"{cat['singular']} No. {num(model['no'])}", model["name"], mm["code"],
                      " ".join(str(p) for p in mm["pages"]), len(imgs)])

    for j, ed in enumerate(man.get("editorial", []), 1):
        base = f"{slug}-room-{num(j)}"
        w, h = to_webp(os.path.join(man_dir, ed["image"]["file"]),
                       os.path.join(out_dir, base + ".webp"), EDITORIAL_BOX, EDITORIAL_Q)
        result["editorial"].append({"src": f"collection/{slug}/img/{base}.webp", "w": w, "h": h,
                                    "before": code_to_no.get(ed.get("before"))})

    dump(path("collection", slug, "images.json"), result)
    if args.codes_out:
        with open(args.codes_out, "w", newline="", encoding="utf-8") as fh:
            wr = csv.writer(fh)
            wr.writerow(["our number", "name on our site", "partner code", "catalog pages", "photos"])
            wr.writerows(sheet)
        print(f"order sheet: {args.codes_out} (private, do not commit)")
    total = sum(os.path.getsize(os.path.join(out_dir, n)) for n in os.listdir(out_dir))
    n_photos = sum(len(v) for v in result["models"].values())
    print(f"{slug}: product photo background {stage_bg}")
    print(f"{slug}: {len(cat['models'])} models, {n_photos} photos, "
          f"{len(result['editorial'])} room breaks, {total / 1048576:.1f} MB in collection/{slug}/img/")


# ---------------------------------------------------------------- site shell

NAV_RE = re.compile(
    r'^([ \t]*)<a href="service\.html" class="nav-item nav-link(?: active)?"\s*>Our Services</a\s*>[ \t]*$',
    re.M)
NAV_LINK = '<a href="collection.html" class="nav-item nav-link">Collection</a>'


def cmd_nav(_args=None):
    changed = []
    for name in sorted(os.listdir(ROOT)):
        if not name.endswith(".html"):
            continue
        text = read_text(path(name))
        if 'href="collection.html" class="nav-item nav-link' in text:
            continue
        m = NAV_RE.search(text)
        if not m:
            continue
        text = text[:m.end()] + "\n" + m.group(1) + NAV_LINK + text[m.end():]
        write_text(path(name), text)
        changed.append(name)
    if changed:
        print("nav: added Collection to " + ", ".join(changed))


def shell():
    """Topbar + navbar and footer + scripts, taken from index.html so they match the site."""
    src = read_text(path("index.html"))
    top = src[src.index("<body>") + len("<body>"): src.index("<!-- Navbar End -->") + len("<!-- Navbar End -->")]
    top = top.replace(" nav-link active", " nav-link")
    top = top.replace('<a href="collection.html" class="nav-item nav-link">',
                      '<a href="collection.html" class="nav-item nav-link active">')
    end_tag = '<script src="js/main.js"></script>'
    foot = src[src.index("<!-- Footer Start -->"): src.index(end_tag) + len(end_tag)]
    foot = foot.replace('<a class="btn btn-link" href="service.html">Our Services</a>',
                        '<a class="btn btn-link" href="service.html">Our Services</a>\n'
                        '            <a class="btn btn-link" href="collection.html">Partner Collection</a>')
    return top, foot


def head(title, description, page, image, noindex=False):
    robots = '\n    <meta name="robots" content="noindex" />' if noindex else ""
    return f"""<!DOCTYPE html>
<html lang="en">
  <head>
    <base href="/">
    <meta charset="utf-8" />
    <title>{esc(title)}</title>
    <meta content="width=device-width, initial-scale=1.0" name="viewport" />
    <meta content="{esc(description)}" name="description" />{robots}
    <link rel="canonical" href="{SITE}/{page}" />
    <link href="img/favicon.ico" rel="icon" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="{SITE}/{page}" />
    <meta property="og:title" content="{esc(title)}" />
    <meta property="og:description" content="{esc(description)}" />
    <meta property="og:image" content="{SITE}/{image}" />
    <meta property="twitter:card" content="summary_large_image" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,400&family=Jost:wght@300;400;500&family=Poppins:wght@600;700&family=Roboto:wght@400;500&display=swap" rel="stylesheet" />
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.10.0/css/all.min.css" rel="stylesheet" />
    <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.4.1/font/bootstrap-icons.css" rel="stylesheet" />
    <link href="lib/animate/animate.min.css" rel="stylesheet" />
    <link href="css/bootstrap.min.css" rel="stylesheet" />
    <link href="css/style.css" rel="stylesheet" />
    <link href="css/collection.css" rel="stylesheet" />
  </head>

  <body class="pc-body">"""


def document(title, description, page, image, main, noindex=False):
    top, foot = shell()
    return (head(title, description, page, image, noindex) + top + "\n\n" + main + "\n\n    "
            + foot + '\n    <script src="js/collection.js"></script>\n  </body>\n</html>\n')


def disclaimer_block():
    return f"""      <aside class="pc-disclaimer">
        <div class="pc-wrap">
          <p class="pc-eyebrow">Partner collection</p>
          <p><strong>{esc(DISCLAIMER_LEAD)}</strong> {esc(DISCLAIMER)}</p>
        </div>
      </aside>"""


def swatch(name):
    return SWATCHES.get(name.lower(), "#DDD6CA")


def img_tag(src, w, h, alt, cls="", lazy=True, extra=""):
    c = f' class="{cls}"' if cls else ""
    lz = ' loading="lazy" decoding="async"' if lazy else ' decoding="async"'
    return f'<img{c} src="{esc(src)}" width="{w}" height="{h}" alt="{esc(alt)}"{lz}{extra} />'


# ---------------------------------------------------------------- collection page

def collection_page(slug):
    cat, imgs = live(slug)
    models = cat["models"]
    singular = cat["singular"]
    plural = cat["title"].lower()
    page = page_name(slug)
    eds = imgs["editorial"]
    hero = eds[cat.get("page_hero", 0)] if eds else imgs["models"][str(models[0]["no"])][0]
    n_photos = sum(len(imgs["models"][str(m["no"])]) for m in models)

    counts = {f["tag"]: sum(1 for m in models if f["tag"] in m["tags"]) for f in cat.get("filters", [])}
    chips = [f'<button type="button" class="pc-chip is-on" data-filter="all" aria-pressed="true">All <span>{len(models)}</span></button>']
    for f in cat.get("filters", []):
        if counts[f["tag"]]:
            chips.append(f'<button type="button" class="pc-chip" data-filter="{esc(f["tag"])}" aria-pressed="false">'
                         f'{esc(f["label"])} <span>{counts[f["tag"]]}</span></button>')

    tiles = []
    for m in models:
        first = imgs["models"][str(m["no"])][0]
        tiles.append(f"""          <li class="pc-tile" data-tags="{esc(' '.join(m['tags']))}">
            <a href="{page}#{anchor(cat, m)}">
              <span class="pc-tile-img">{img_tag(first['thumb'], *thumb_size(first), f"{singular} No. {num(m['no'])}, {m['name']}")}</span>
              <span class="pc-tile-no">No. {num(m['no'])}</span>
              <span class="pc-tile-name">{esc(m['name'])}</span>
            </a>
          </li>""")

    breaks = {}
    for i, ed in enumerate(eds):
        if i == cat.get("page_hero", 0) or ed.get("before") is None:
            continue
        breaks.setdefault(ed["before"], []).append(ed)

    sections = []
    for idx, m in enumerate(models):
        for ed in breaks.get(m["no"], []):
            sections.append(f"""      <figure class="pc-break" data-break>
        {img_tag(ed['src'], ed['w'], ed['h'], f"{singular} in a room setting, from the partner collection")}
      </figure>""")
        sections.append(model_section(cat, m, imgs["models"][str(m["no"])], flip=idx % 2 == 1))

    main = f"""    <main class="pc pc-catalog" style="--pc-stage: {esc(imgs.get('stage_bg', STAGE_BG))}">
      <header class="pc-hero">
        {img_tag(hero['src'], hero['w'], hero['h'], f"{cat['title']} from the partner collection, in a room setting", 'pc-hero-img', lazy=False, extra=' fetchpriority="high"')}
        <div class="pc-hero-inner">
          <div class="pc-wrap">
            <nav class="pc-crumbs" aria-label="Breadcrumb"><a href="collection.html">Partner Collection</a><span aria-hidden="true">/</span>{esc(cat['title'])}</nav>
            <h1 class="pc-display">{esc(cat['title'])}</h1>
            <p class="pc-lead">{esc(cat['lead'])}</p>
            <p class="pc-meta">{len(models)} designs &middot; {n_photos} photos</p>
          </div>
        </div>
      </header>

      <section class="pc-intro" aria-labelledby="pc-index-title">
        <div class="pc-wrap">
          <div class="pc-intro-grid">
            <div>
              <p class="pc-eyebrow">The collection</p>
              <h2 class="pc-h2" id="pc-index-title">{len(models)} {esc(plural)}, by number</h2>
            </div>
            <p class="pc-intro-text">{esc(cat['intro'])}</p>
          </div>
          <div class="pc-chips" role="group" aria-label="Filter {esc(plural)}">
            {''.join(chips)}
          </div>
          <ol class="pc-index">
{chr(10).join(tiles)}
          </ol>
          <p class="pc-empty" hidden>Nothing matches that filter.</p>
        </div>
      </section>

{chr(10).join(sections)}

      <section class="pc-end">
        <div class="pc-wrap">
          <p class="pc-eyebrow">Found one you like?</p>
          <h2 class="pc-h2">Send us the number</h2>
          <p>Tell us which {esc(singular.lower())} and the room it's for. We'll come back with sizes, finishes, pricing and lead time.</p>
          <a class="pc-ask" href="{quote_link(f'Partner collection: {plural}. Please send sizes, finishes and pricing for: ')}">Ask about a {esc(singular.lower())} <i class="bi bi-arrow-right" aria-hidden="true"></i></a>
          <a class="pc-link" href="collection.html">All partner collections</a>
        </div>
      </section>

{disclaimer_block()}

{lightbox()}
    </main>"""
    title = f"{cat['title']} | Partner Collection | NYC Renovation Experts"
    description = (f"{len(models)} {plural} from our partner collection, offered through NYC Renovation "
                   f"Experts. {cat['lead']}")
    return page, document(title, description, page, hero["src"], main)


def thumb_size(img):
    w, h = img["w"], img["h"]
    s = min(THUMB_BOX[0] / w, THUMB_BOX[1] / h, 1)
    return max(1, round(w * s)), max(1, round(h * s))


def model_section(cat, m, photos, flip):
    singular = cat["singular"]
    label = f"{singular} No. {num(m['no'])}"
    first = photos[0]
    thumbs = []
    for i, ph in enumerate(photos):
        alt = f"{label}, {m['name']}, photo {i + 1} of {len(photos)}" + (", room setting" if ph["kind"] == "room" else "")
        on = " is-on" if i == 0 else ""
        room = " is-room" if ph["kind"] == "room" else ""
        cur = ' aria-current="true"' if i == 0 else ""
        thumbs.append(
            f'<button type="button" class="pc-thumb{room}{on}"{cur} data-src="{esc(ph["src"])}" data-w="{ph["w"]}" '
            f'data-h="{ph["h"]}" data-kind="{ph["kind"]}" data-alt="{esc(alt)}" aria-label="Show photo {i + 1} of {len(photos)}">'
            f'{img_tag(ph["thumb"], *thumb_size(ph), "")}</button>')
    details = "".join(f"<li>{esc(d)}</li>" for d in m["details"])
    shown = "".join(f'<li><i style="--sw:{swatch(s)}" aria-hidden="true"></i>{esc(s)}</li>' for s in m["shown"])
    stage_cls = "pc-stage is-room" if first["kind"] == "room" else "pc-stage"
    first_alt = f"{label}, {m['name']}, photo 1 of {len(photos)}"
    return f"""      <section class="pc-model{' is-flip' if flip else ''}" id="{anchor(cat, m)}" data-tags="{esc(' '.join(m['tags']))}" data-label="{esc(label)}" data-name="{esc(m['name'])}">
        <div class="pc-wrap pc-model-inner">
          <div class="pc-gallery">
            <button type="button" class="{stage_cls}" data-index="0" aria-label="Enlarge photo">
              {img_tag(first['src'], first['w'], first['h'], first_alt)}
            </button>
            <div class="pc-thumbs">{''.join(thumbs)}</div>
          </div>
          <div class="pc-info">
            <p class="pc-num" aria-hidden="true">{num(m['no'])}</p>
            <p class="pc-eyebrow">{esc(label)}</p>
            <h2 class="pc-name">{esc(m['name'])}</h2>
            <p class="pc-summary">{esc(m['summary'])}</p>
            <ul class="pc-details">{details}</ul>
            <div class="pc-shown"><span class="pc-shown-label">Shown in</span><ul>{shown}</ul></div>
            <a class="pc-ask" href="{quote_link(model_note(cat, m))}">Ask about No. {num(m['no'])} <i class="bi bi-arrow-right" aria-hidden="true"></i></a>
            <p class="pc-photos">{len(photos)} photos &middot; tap a photo to enlarge</p>
          </div>
        </div>
      </section>"""


def lightbox():
    return """      <div class="pc-lb" role="dialog" aria-modal="true" aria-label="Photo viewer" hidden>
        <button type="button" class="pc-lb-btn pc-lb-close" aria-label="Close"><i class="bi bi-x" aria-hidden="true"></i></button>
        <button type="button" class="pc-lb-btn pc-lb-prev" aria-label="Previous photo"><i class="bi bi-chevron-left" aria-hidden="true"></i></button>
        <img class="pc-lb-img" src="data:," alt="" />
        <button type="button" class="pc-lb-btn pc-lb-next" aria-label="Next photo"><i class="bi bi-chevron-right" aria-hidden="true"></i></button>
        <p class="pc-lb-cap" aria-live="polite"></p>
      </div>"""


# ---------------------------------------------------------------- landing page

def landing_page():
    cols = collections()
    lives = [c for c in cols if c["status"] == "live"]
    soons = [c for c in cols if c["status"] != "live"]
    cards, hero = [], None
    for c in lives:
        cat, imgs = live(c["slug"])
        eds = imgs["editorial"]
        cover = eds[cat.get("card_cover", 0)] if eds else imgs["models"][str(cat["models"][0]["no"])][0]
        if hero is None:
            hero = eds[cat.get("landing_hero", 0)] if eds else cover
        n = len(cat["models"])
        cards.append(f"""          <a class="pc-card" href="{page_name(c['slug'])}">
            <span class="pc-card-img">{img_tag(cover['src'], cover['w'], cover['h'], f"{cat['title']} from the partner collection")}</span>
            <span class="pc-card-body">
              <span class="pc-eyebrow">{n} designs</span>
              <span class="pc-card-title">{esc(cat['title'])}</span>
              <span class="pc-card-text">{esc(cat['lead'])}</span>
              <span class="pc-card-link">View the collection <i class="bi bi-arrow-right" aria-hidden="true"></i></span>
            </span>
          </a>""")
    soon = "".join(f"""
            <li class="pc-soon"><span class="pc-eyebrow">Coming soon</span><span class="pc-soon-title">{esc(c['title'])}</span></li>"""
                   for c in soons)
    soon_block = f"""
          <div class="pc-soon-wrap">
            <p class="pc-eyebrow">More collections on the way</p>
            <ul class="pc-soon-list">{soon}
            </ul>
          </div>""" if soons else ""
    main = f"""    <main class="pc pc-landing">
      <header class="pc-hero pc-hero--landing">
        {img_tag(hero['src'], hero['w'], hero['h'], "A bedroom furnished from the partner collection", 'pc-hero-img', lazy=False, extra=' fetchpriority="high"')}
        <div class="pc-hero-inner">
          <div class="pc-wrap">
            <p class="pc-crumbs">NYC Renovation Experts</p>
            <h1 class="pc-display">Partner Collection</h1>
            <p class="pc-lead">Furniture from our manufacturing partner, offered through NYC Renovation Experts. Browse a collection, then ask us about any piece by its number.</p>
          </div>
        </div>
      </header>

      <section class="pc-cards-wrap" aria-label="Collections">
        <div class="pc-wrap">
          <div class="pc-cards">
{chr(10).join(cards)}
          </div>{soon_block}
        </div>
      </section>

      <section class="pc-how" aria-labelledby="pc-how-title">
        <div class="pc-wrap">
          <p class="pc-eyebrow">How it works</p>
          <h2 class="pc-h2" id="pc-how-title">Pick a piece, send us its number.</h2>
          <ol class="pc-steps">
            <li><span class="pc-step-no">1</span><h3>Browse</h3><p>Every piece has a number, like Bed No. 07, and photos of each version.</p></li>
            <li><span class="pc-step-no">2</span><h3>Ask</h3><p>Send us the number through the quote form, or call or email us.</p></li>
            <li><span class="pc-step-no">3</span><h3>Confirm</h3><p>We come back with sizes, finishes, pricing and lead time for your room.</p></li>
          </ol>
          <a class="pc-ask" href="{quote_link('Partner collection: please send details for: ')}">Ask about a piece <i class="bi bi-arrow-right" aria-hidden="true"></i></a>
        </div>
      </section>

{disclaimer_block()}
    </main>"""
    title = "Partner Collection | NYC Renovation Experts"
    description = ("Furniture from our manufacturing partner, offered through NYC Renovation Experts: "
                   + ", ".join(c["title"].lower() for c in lives) + ". Ask about any piece by its number.")
    return "collection.html", document(title, description, "collection.html", hero["src"], main)


# ---------------------------------------------------------------- posts

POST_W, POST_H = 1080, 1350
STAGE_W, STAGE_H, MAX_UPSCALE = 920, 700, 1.45


def caption(cat, m):
    tags = []
    for t in cat.get("hashtags", []) + [m.get("hashtag", "")]:
        if t and t not in tags:
            tags.append(t)
    tags = tags[:5]
    s = cat["singular"]
    return (f"{m['summary']}\n\n"
            f"{s} No. {num(m['no'])}, the {m['name']}. {m['more']}\n\n"
            f"From our partner collection. DM us \"{s} {num(m['no'])}\" for sizes, finishes and pricing.\n\n"
            + " ".join(tags))


def post_html(cat, m, photo_file, w, h, bg=STAGE_BG):
    fonts = "file://" + os.path.join(TOOLS, "fonts")
    s = min(STAGE_W / w, STAGE_H / h, MAX_UPSCALE)
    dw, dh = round(w * s), round(h * s)
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{{font-family:"PCSerif";src:url("{fonts}/cormorant-garamond-latin-500-normal.woff2") format("woff2");font-weight:500;font-style:normal}}
@font-face{{font-family:"PCSerif";src:url("{fonts}/cormorant-garamond-latin-400-italic.woff2") format("woff2");font-weight:400;font-style:italic}}
@font-face{{font-family:"PCSans";src:url("{fonts}/jost-latin-300-normal.woff2") format("woff2");font-weight:300}}
@font-face{{font-family:"PCSans";src:url("{fonts}/jost-latin-400-normal.woff2") format("woff2");font-weight:400}}
html,body{{margin:0;padding:0}}
body{{width:{POST_W}px;height:{POST_H}px;background:{bg};position:relative;overflow:hidden;font-family:"PCSans";color:#1F1D1A;-webkit-font-smoothing:antialiased}}
.mark{{position:absolute;top:96px;left:0;right:0;text-align:center;font-family:"PCSerif";font-weight:500;font-size:38px;letter-spacing:.34em;text-indent:.34em;color:#24211D;white-space:nowrap}}
.sub{{position:absolute;top:160px;left:0;right:0;display:flex;align-items:center;justify-content:center;gap:18px;font-weight:400;font-size:14px;letter-spacing:.46em;text-indent:.46em;color:#8F8A80;text-transform:uppercase}}
.sub i{{display:block;width:40px;height:1px;background:#CFC8BB}}
.stage{{position:absolute;top:228px;left:{(POST_W - STAGE_W) // 2}px;width:{STAGE_W}px;height:{STAGE_H}px;display:flex;align-items:center;justify-content:center}}
.stage img{{display:block;width:{dw}px;height:{dh}px}}
.foot{{position:absolute;left:60px;right:60px;top:968px;display:flex;flex-direction:column;align-items:center;text-align:center}}
.no{{font-family:"PCSerif";font-style:italic;font-weight:400;font-size:32px;color:#9A8F7E;line-height:1;font-variant-numeric:lining-nums}}
.name{{margin-top:18px;font-family:"PCSerif";font-weight:500;font-size:66px;line-height:1.02;color:#1F1D1A;white-space:nowrap}}
.rule{{margin-top:26px;width:46px;height:2px;background:#FDA12B}}
.line{{margin-top:22px;font-weight:300;font-size:26px;letter-spacing:.02em;color:#68635B}}
.site{{position:absolute;bottom:54px;left:0;right:0;text-align:center;font-size:13px;letter-spacing:.34em;text-indent:.34em;text-transform:uppercase;color:#A7A196}}
</style></head><body>
<div class="mark">NYC RENOVATION EXPERTS</div>
<div class="sub"><i></i>Partner Collection<i></i></div>
<div class="stage"><img src="file://{esc(photo_file)}" alt=""></div>
<div class="foot">
  <div class="no">No. {num(m['no'])}</div>
  <div class="name">{esc(m['name'])}</div>
  <div class="rule"></div>
  <div class="line">{esc(m['line'])}</div>
</div>
<div class="site">nycrenovationexperts.com</div>
<script>
(function(){{var n=document.querySelector('.name'),s=66;while(n.scrollWidth>{POST_W - 120}&&s>40){{s-=2;n.style.fontSize=s+'px';}}}})();
</script>
</body></html>"""


def cmd_posts(args):
    slug = args.slug
    cat, imgs = live(slug)
    out_dir = path("collection", "posts", slug)
    os.makedirs(out_dir, exist_ok=True)
    prefix = cat["singular"].lower().replace(" ", "-")
    posts, jobs = [], []
    with tempfile.TemporaryDirectory() as tmp:
        for m in cat["models"]:
            hero = imgs["models"][str(m["no"])][0]
            html_file = os.path.join(tmp, f"{prefix}-{num(m['no'])}.html")
            write_text(html_file, post_html(cat, m, path(hero["src"]), hero["w"], hero["h"],
                                            imgs.get("stage_bg", STAGE_BG)))
            name = f"{prefix}-{num(m['no'])}.jpg"
            jobs.append({"html": html_file, "out": os.path.join(out_dir, name), "w": POST_W, "h": POST_H})
            posts.append({"no": m["no"], "name": m["name"], "image": f"collection/posts/{slug}/{name}",
                          "url": f"{SITE}/collection/posts/{slug}/{name}", "caption": caption(cat, m)})
        job_file = os.path.join(tmp, "jobs.json")
        dump(job_file, jobs)
        subprocess.run(["node", os.path.join(TOOLS, "render_posts.js"), job_file], check=True)
    dump(os.path.join(out_dir, "posts.json"), {"slug": slug, "title": cat["title"], "posts": posts})
    print(f"{slug}: {len(posts)} posts in collection/posts/{slug}/")


def posts_page():
    sections = []
    for c in collections():
        f = path("collection", "posts", c["slug"], "posts.json")
        if c["status"] != "live" or not os.path.exists(f):
            continue
        data = load(f)
        cat = load(path("collection", c["slug"], "catalog.json"))
        cards = []
        for p in data["posts"]:
            cid = f"cap-{c['slug']}-{num(p['no'])}"
            cards.append(f"""            <article class="pc-post">
              <a class="pc-post-img" href="{esc(p['image'])}" target="_blank" rel="noopener">{img_tag(p['image'], 1080, 1350, f"Instagram post for {cat['singular']} No. {num(p['no'])}, {p['name']}")}</a>
              <div class="pc-post-body">
                <p class="pc-post-title"><span>No. {num(p['no'])}</span> {esc(p['name'])}</p>
                <div class="pc-post-actions">
                  <a class="pc-btn" href="{esc(p['image'])}" download>Download</a>
                  <button type="button" class="pc-btn" data-copy="#{cid}">Copy caption</button>
                  <button type="button" class="pc-btn pc-btn--quiet" data-copy-text="{esc(p['url'])}">Copy image link</button>
                </div>
                <details class="pc-post-cap"><summary>Caption</summary><pre id="{cid}">{esc(p['caption'])}</pre></details>
              </div>
            </article>""")
        sections.append(f"""      <section class="pc-posts-sec">
        <div class="pc-wrap">
          <div class="pc-posts-sechead">
            <h2 class="pc-h2">{esc(data['title'])}</h2>
            <a class="pc-link" href="{page_name(c['slug'])}">See the {esc(data['title'].lower())} page</a>
          </div>
          <div class="pc-post-grid">
{chr(10).join(cards)}
          </div>
        </div>
      </section>""")
    main = f"""    <main class="pc pc-posts">
      <section class="pc-posts-head">
        <div class="pc-wrap">
          <p class="pc-eyebrow">For Instagram</p>
          <h1 class="pc-h1">Collection posts</h1>
          <p class="pc-intro-text">One ready-made post per piece: a 1080 &times; 1350 image (the 4:5 size the feed shows in full) and its caption. Download the image, copy the caption, post it from the Instagram app.</p>
        </div>
      </section>

{chr(10).join(sections) if sections else '      <p class="pc-wrap">No posts yet.</p>'}

{disclaimer_block()}
    </main>"""
    image = "img/carousel-1.jpg"
    for c in collections():
        f = path("collection", "posts", c["slug"], "posts.json")
        if c["status"] == "live" and os.path.exists(f):
            image = load(f)["posts"][0]["image"]
            break
    return "collection-posts.html", document("Collection posts | NYC Renovation Experts",
                                             "Ready-made Instagram posts for the partner collection.",
                                             "collection-posts.html", image, main, noindex=True)


def cmd_pages(_args):
    cmd_nav()
    written = []
    for c in collections():
        if c["status"] == "live":
            name, text = collection_page(c["slug"])
            write_text(path(name), text)
            written.append(name)
    name, text = landing_page()
    write_text(path(name), text)
    written.append(name)
    name, text = posts_page()
    write_text(path(name), text)
    written.append(name)
    print("pages: " + ", ".join(written))


CODE_PATTERN = re.compile(r"\b[A-Z]{2}\s?-\s?[A-Z]{1,3}\d{4}\b")
TEXT_EXT = (".html", ".json", ".css", ".js", ".md", ".py", ".txt", ".csv")


def jpeg_has_metadata(data):
    i = 2
    while i + 4 <= len(data) and data[i] == 0xFF:
        marker = data[i + 1]
        if marker in (0xD9, 0xDA):          # end of image / start of scan
            return False
        length = int.from_bytes(data[i + 2:i + 4], "big")
        if marker in (0xE1, 0xED):          # EXIF/XMP, Photoshop/IPTC (an sRGB ICC profile is fine)
            return True
        i += 2 + length
    return False


def webp_has_metadata(data):
    i = 12
    while i + 8 <= len(data):
        chunk = data[i:i + 4]
        length = int.from_bytes(data[i + 4:i + 8], "little")
        if chunk in (b"EXIF", b"XMP ", b"ICCP"):
            return True
        i += 8 + length + (length & 1)
    return False


def cmd_check(args):
    words = [w.strip().lower() for w in (args.deny or "").split(",") if w.strip()]
    files = [path(n) for n in sorted(os.listdir(ROOT)) if n.startswith("collection") and n.endswith(".html")]
    for base in ("collection", os.path.join("tools", "collection")):
        for dirpath, _dirs, names in os.walk(path(base)):
            files += [os.path.join(dirpath, n) for n in sorted(names)]
    files += [path("css", "collection.css"), path("js", "collection.js")]
    problems = []
    for f in files:
        rel = os.path.relpath(f, ROOT)
        low = rel.lower()
        problems += [f"{rel}: file name contains '{w}'" for w in words if w in low]
        if f.endswith(TEXT_EXT):
            for n, line in enumerate(read_text(f).splitlines(), 1):
                ll = line.lower()
                problems += [f"{rel}:{n}: contains '{w}'" for w in words if w in ll]
                if CODE_PATTERN.search(line) and not f.endswith(".py"):
                    problems.append(f"{rel}:{n}: looks like a model code: {CODE_PATTERN.search(line).group(0)}")
        elif f.endswith(".webp"):
            with open(f, "rb") as fh:
                if webp_has_metadata(fh.read()):
                    problems.append(f"{rel}: image metadata")
        elif f.endswith((".jpg", ".jpeg")):
            with open(f, "rb") as fh:
                if jpeg_has_metadata(fh.read()):
                    problems.append(f"{rel}: image metadata")
    for p in problems:
        print(p)
    print(f"check: {len(files)} files, {len(problems)} problem(s)")
    if problems:
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("images")
    a.add_argument("slug")
    a.add_argument("manifest")
    a.add_argument("--codes-out")
    a.set_defaults(fn=cmd_images)
    b = sub.add_parser("posts")
    b.add_argument("slug")
    b.set_defaults(fn=cmd_posts)
    c = sub.add_parser("pages")
    c.set_defaults(fn=cmd_pages)
    d = sub.add_parser("nav")
    d.set_defaults(fn=cmd_nav)
    e = sub.add_parser("check")
    e.add_argument("--deny", help="comma-separated words that must not appear")
    e.set_defaults(fn=cmd_check)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
