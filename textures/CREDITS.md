# Texture Credits

Every texture here comes from **[ambientCG](https://ambientcg.com/)** by Lennart Demes,
released under **CC0 1.0 Universal (Public Domain)**: free for any use, including
commercial, with no attribution required. We credit it anyway.

The source images were obtained as web-ready files via the MIT-licensed
[open3dFloorplan](https://github.com/theLodgeBots/open3dFloorplan) project, which
lists the ambientCG asset IDs used below. They are shipped here as WebP (quality 82).
`thumbs/` holds 96px previews for the finish pickers.

## Straight from ambientCG

| File | ambientCG asset | Shown as |
|---|---|---|
| wood-honey-oak.webp | WoodFloor040 | Honey oak |
| wood-rustic-walnut.webp | WoodFloor043 | Rustic walnut |
| wood-espresso-strip.webp | WoodFloor048 | Espresso strip |
| herringbone-honey-oak.webp | WoodFloor012 | Herringbone oak |
| parquet-block.webp | WoodFloor024 | Block parquet |
| wood-siding.webp | WoodSiding009 | Painted wood siding |
| tile-checker-black-beige.webp | Tiles074 | Black & beige checker |
| tile-blue-pattern.webp | Tiles099 | Blue pattern tile |
| tile-delft-blue.webp | Tiles101 | Delft blue tile |
| stone-pavers.webp | Tiles093 | Stone pavers |
| marble-carrara.webp | Marble012 | Carrara marble |
| marble-black.webp | Marble006 | Black marble |
| slate.webp | Rock030 | Slate |
| stone-natural.webp | Rock051 | Natural stone |
| concrete-textured.webp | Concrete048 | Textured concrete |
| concrete-polished.webp | Concrete034 | Polished concrete |
| brick-dark-red.webp | Bricks097 | Dark red brick |
| brick-red-white-mortar.webp | Bricks059 | Red brick |
| carpet-beige.webp | Carpet008 | Beige carpet |

## Made from those ambientCG images

CC0 allows modification, so these were derived from the images above
(recolored, or cut and laid out as tile patterns). They stay CC0.

| File | Made from | How |
|---|---|---|
| wood-white-oak.webp | WoodFloor040 | Recolored lighter and less yellow |
| herringbone-white-oak.webp | WoodFloor012 | Recolored lighter and less yellow |
| wood-graywash-oak.webp | WoodFloor040 | Desaturated, cool gray wash |
| marble-calacatta-gold.webp | Marble012 | Whitened base, veins tinted gold |
| quartz-white.webp | Marble012 | Very light, low-contrast speckle |
| tile-checker-black-white.webp | Marble012 + Marble006 | 12" squares cut from each, with grout |
| tile-subway-white.webp | Concrete034 (surface variation) | 3x6" running-bond tiles with grout |
| tile-subway-sage.webp | Concrete034 (surface variation) | Same, sage glaze |
| tile-hex-white.webp | Marble012 (surface variation) | 3" hexagon tiles with grout |
| butcher-block.webp | WoodFloor040 | 1.5" strips with staggered end joints |

## Adding more

Drop a seamless `.webp` in this folder, a 96px `.jpg` preview in `thumbs/`, and
add an entry to the `MATERIALS` list in `js/designstudio3d.js`. That entry needs
`sizeFt` (the real-world width one repeat covers) and `use` (`f` = floor,
`w` = walls, `o` = furniture). Prefer CC0 sources, and record them here.
