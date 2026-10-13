# Partner Collection tools

How a partner catalog PDF becomes a page under `collection.html`, plus a
ready-made Instagram post for every piece.

What's live: `collection.html` (landing), `collection-<slug>.html` (one per
collection), `collection-posts.html` (Instagram posts, not indexed by search
engines). All three are generated; edit the data or `build.py`, not the HTML.

## Rules

- **No partner name, logo or model codes anywhere on the site**: not in page
  text, alt text, file names, JSON or image metadata. Pieces get our own
  numbers (Bed No. 01, Desk No. 01, ...).
- The order sheet that maps our numbers to the partner's codes is private.
  `build.py images --codes-out` writes it outside the repo; never commit it.
  This repo is public, and Vercel serves every file in it.
- Describe only what the photos show (shape, visible finish, versions).
  Sizes, materials, prices and lead times are "on request". Never invent them.
- Every collection page ends with the partner disclaimer. `build.py` adds it
  (`DISCLAIMER_LEAD` and `DISCLAIMER` at the top of the file).
- Keep images lean. `build.py` caps sizes and quality; a collection should
  stay around 10 MB or less in `collection/<slug>/img/`.

## Adding a collection

Work in a scratch folder outside the repo (the source PDF and the manifest
hold the partner's name and codes).

1. **Extract** the photos and group them by model:

   ```bash
   python3 tools/collection/extract.py CATALOG.pdf /path/outside/repo/desks
   ```

   It keeps the real photos (embedded JPEGs), skips the logo and page
   furniture, and writes `manifest.json`: one entry per model code with its
   product shots (`cutouts`) and room photos (`scenes`), plus full-page room
   photos (`editorial`).

2. **Look at every model.** Make contact sheets of each model's photos with
   their indexes (cutouts first, then scenes), check that the grouping is
   right and that no photo shows text or a logo.

3. **Write `collection/<slug>/catalog.json`** by hand. Copy the shape of
   `collection/beds/catalog.json`:
   - `slug`, `title`, `singular`, `lead`, `intro`, `hashtags` (3), `filters`
   - `page_hero`, `card_cover`, `landing_hero`: indexes into the manifest's
     `editorial` list (omit if the catalog has none)
   - per model: `no` (our number), `src` (index into the manifest's
     `models`), `hero` (index of the photo to lead with: cutouts then scenes),
     optional `skip` (indexes to leave out), `name`, `line` (short, for the
     post), `summary`, `details`, `shown` (finishes, see `SWATCHES` in
     build.py), `tags` (must match a filter), `more` (a sentence for the
     caption), `hashtag`
   - Pick heroes at least ~750 px wide; small ones look soft in the posts.

4. **Mark it live** in `collection/collections.json` (`"status": "live"`).

5. **Build**:

   ```bash
   python3 tools/collection/build.py images <slug> /path/outside/repo/desks/manifest.json \
       --codes-out /path/outside/repo/order-sheet-<slug>.csv
   python3 tools/collection/build.py posts <slug>
   python3 tools/collection/build.py pages
   ```

   `images` writes WebP files with no metadata and blends the edges of the
   product shots into the page colour. `posts` renders 1080x1350 JPEGs with
   Playwright (fonts in `tools/collection/fonts/`, OFL). `pages` regenerates
   all collection pages and adds the Collection nav link to any page missing it.

6. **Check** before publishing:

   ```bash
   python3 tools/collection/build.py check --deny "<partner name>,<their city>,<code prefix>"
   ```

   must report 0 problems. It also flags anything shaped like a model code
   and any image metadata. (The deny list stays out of this repo: it would
   put the partner's name in a public file.) Then look at the pages at desktop
   and phone widths, and at a few posts. `preview.js` takes the screenshots
   when the CDNs the site uses can't be reached (setup in its header).

7. **Publish**: commit, push `gh-pages` first (production builds from it),
   then `main`.

## Posting to Instagram

`collection-posts.html` has every post with Download, Copy caption and Copy
image link. Post from the Instagram app, or use the automate_instagram repo:
its connector can publish an image from its public URL
(`https://www.nycrenovationexperts.com/collection/posts/<slug>/<file>.jpg`) after
the usual preview and approval.
