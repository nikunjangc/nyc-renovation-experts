// Design Studio: photoreal compositing via OpenAI gpt-image-1.
//
// Same model ChatGPT routes to internally when you ask it to edit/generate
// an image. Input: the user's room photo + a strict text prompt describing
// what to change. Output: a single edited photo where the new product is
// placed naturally in the scene.
//
// Architecture intentionally mirrors how ChatGPT does it under the hood:
//   1. DeepSeek (text LLM) writes a tight edit prompt with strict rules
//   2. OpenAI's gpt-image-1 renders the actual edit
// Either layer can be swapped (e.g. Midjourney later) — this module is the
// thin glue.
//
// API: https://platform.openai.com/docs/api-reference/images/createEdit
// Endpoint: POST https://api.openai.com/v1/images/edits  (multipart/form-data)
//
// Cost per call (today):
//   - DeepSeek prompt write: ~$0.0001
//   - gpt-image-1 edit at quality=medium: ~$0.04
//   - Total:                              ~$0.04
//
// Cached by SHA-256 of (photo + product + position) for 24h so a re-pick of
// the same product doesn't spend another $0.04.

const crypto = require('crypto');

const OPENAI_EDIT_URL  = 'https://api.openai.com/v1/images/edits';
const OPENAI_CHAT_URL  = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL     = 'gpt-image-1';
// Vision model that actually LOOKS at the room photo to ground the edit prompt
// in the real scene (where the old fixture is, how big it should be) — this is
// the reasoning step ChatGPT does before it renders.
const OPENAI_VISION_MODEL = 'gpt-4o-mini';

const cache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE = 500;

function cacheGet(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) { cache.delete(k); return null; }
  return e.data;
}
function cacheSet(k, data) {
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(k, { ts: Date.now(), data });
}

// Decode a data: URL into a Blob + filename. gpt-image-1 accepts JPEG, PNG,
// or WebP.
function dataUrlToBlob(dataUrl) {
  const m = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!m) {
    const err = new Error('photoUrl must be a base64 data URL');
    err.status = 400;
    throw err;
  }
  const mime = m[1];
  const buf  = Buffer.from(m[2], 'base64');
  const ext  = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  return { blob: new Blob([buf], { type: mime }), filename: `room.${ext}` };
}

function describePosition(seg, photo) {
  if (!seg || !photo) return 'centered';
  const cx = seg.x + seg.w / 2;
  const cy = seg.y + seg.h / 2;
  const w  = photo.width  || 1920;
  const h  = photo.height || 1080;
  const horiz =
    cx < w * 0.33 ? 'on the left side'  :
    cx > w * 0.66 ? 'on the right side' : 'in the center';
  const vert =
    cy < h * 0.33 ? 'upper'  :
    cy > h * 0.66 ? 'lower'  : 'middle';
  const size = (seg.w * seg.h) / (w * h);
  const sizeWord = size > 0.25 ? 'large' : size > 0.08 ? 'medium-sized' : 'small';
  return `the ${sizeWord} ${horiz} ${vert} area of the photo`;
}

// Exact detected location of the old fixture as image-relative percentages, so
// the vision model has a hard anchor and can't drift the swap toward center.
function describeExactLocation(seg, photo) {
  if (!seg || !photo) return '';
  const w = photo.width || 1920;
  const h = photo.height || 1080;
  const cx = Math.round(((seg.x + seg.w / 2) / w) * 100);
  const cy = Math.round(((seg.y + seg.h / 2) / h) * 100);
  const bw = Math.round((seg.w / w) * 100);
  const bh = Math.round((seg.h / h) * 100);
  return `The existing fixture's center is at ${cx}% from the left and ${cy}% from the top of the image, and it spans roughly ${bw}% of the image width and ${bh}% of the height. Install the new fixture centered on that exact point at that same scale.`;
}

// Use DeepSeek to write a tight, strict edit prompt. If DeepSeek isn't
// configured (or call fails), fall back to a canned template — the feature
// still works.
// Vision-grounded prompt writer — the ChatGPT-style step. Sends the ACTUAL
// room photo (and the product image when available) to a vision LLM and asks
// it to locate the old fixture and describe its correct real-world scale, then
// emit one tight edit instruction. Falls back to null so callers can drop to
// the blind text writer / canned prompt.
async function writeVisionPrompt({ segmentLabel, product, photoUrl, locationAnchor }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key || !photoUrl) return null;

  const anchorLine = locationAnchor
    ? `\nWe already detected the old fixture's location: ${locationAnchor} Treat this as the ground truth for WHERE the new fixture goes — do not move it toward the center or anywhere else.`
    : '';

  const sys = `You are directing a photorealistic image edit. You are shown a ROOM PHOTO and (sometimes) a PRODUCT PHOTO. Your job is to write ONE short instruction to swap a single ${segmentLabel} in the room.
First, silently look at the room photo: find the existing ${segmentLabel}, note WHERE it is (which wall/ceiling area, above what) and how BIG it is relative to the room.${anchorLine}
Then write the instruction so that:
- The existing ${segmentLabel} is REMOVED and the new one installed in the EXACT SAME position it occupies now — same spot, do not recenter it.
- The new ${segmentLabel} is sized to look natural in THIS room — reference the real objects near it (e.g. "about the width of the island below it") so it is not oversized or undersized.
- If a product photo is given, the new ${segmentLabel} matches that product's design, shape, and finish.
- Everything else in the room stays identical; match the existing perspective, lighting, and shadows.
Output ONLY the instruction, one or two sentences, no preface or quotes. End with "Photorealistic. No text, no watermarks."`;

  const content = [
    { type: 'text', text: `Room photo:` },
    { type: 'image_url', image_url: { url: photoUrl, detail: 'high' } },
  ];
  if (product?.thumbnail) {
    const pd = await urlToDataUrl(product.thumbnail).catch(() => null);
    if (pd) {
      content.push({ type: 'text', text: `New product to install (${product.title || segmentLabel}):` });
      content.push({ type: 'image_url', image_url: { url: pd, detail: 'low' } });
    }
  }
  content.push({ type: 'text', text: `Write the single edit instruction now.` });

  try {
    const res = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OPENAI_VISION_MODEL,
        messages: [{ role: 'system', content: sys }, { role: 'user', content }],
        max_tokens: 220,
        temperature: 0.3,
      }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const txt = json?.choices?.[0]?.message?.content?.trim() || '';
    return txt || null;
  } catch {
    return null;
  }
}

// Recolor (paint) prompt. Paint is a SURFACE change, not an object swap — the
// model must repaint only the wall/ceiling and leave every object untouched.
function writeRecolorPrompt({ segmentLabel, paintColor }) {
  const surface = /ceiling/i.test(segmentLabel || '') ? 'ceiling' : 'wall';
  const name = paintColor?.name ? `${paintColor.name} (${paintColor.code || ''})`.trim() : '';
  const swatch = [name, paintColor?.hex].filter(Boolean).join(' — ');
  return `Repaint the ${surface} surfaces in this room the paint color ${swatch}. ` +
    `Change ONLY the ${surface} paint color. Keep every object exactly as it is — all furniture, shelves, racks, bookshelves, cabinets, the desk, monitor, papers, boxes, wall art, outlets, trim, the floor and ${surface === 'wall' ? 'ceiling' : 'walls'} must stay identical in position, shape, and color. ` +
    `Apply the new color evenly and realistically, matching the room's existing lighting, shadows, and perspective on the ${surface}. Do not move, remove, add, or distort anything. Photorealistic. No text, no watermarks.`;
}

async function writeEditPrompt({ segmentLabel, product, positionWords, locationAnchor, masked, photoUrl, mode, paintColor }) {
  // Paint recolor is a different kind of edit — return its dedicated prompt.
  if (mode === 'recolor') return writeRecolorPrompt({ segmentLabel, paintColor });
  // Prefer the vision-grounded writer (looks at the actual photo) — this is the
  // reasoning step that lets a maskless render match ChatGPT.
  if (!masked) {
    const visioned = await writeVisionPrompt({ segmentLabel, product, photoUrl, locationAnchor });
    if (visioned) return visioned;
  }
  const dsKey = process.env.DEEPSEEK_API_KEY;
  // When a mask is provided, OpenAI strictly preserves pixels OUTSIDE the
  // mask — we don't need to over-warn the model. But the prompt should still
  // remind the model to ONLY paint a believable product within the masked
  // area, and not to e.g. add text/labels.
  const maskClause = masked
    ? `Paint only within the masked (transparent) area; the rest of the photo will be preserved automatically by the mask.`
    : `Keep all other elements (walls, floor, lighting, other appliances, cabinets) unchanged.`;

  const canned = `Remove the existing ${segmentLabel} from the room and install the new ${segmentLabel}${product?.title ? ` (${product.title})` : ''} in the same spot where the old one was. ` +
                 `Keep it a realistic, natural size and proportion for the space — do NOT make it oversized; it should look like a normal ${segmentLabel} for this room. ` +
                 `${maskClause} ` +
                 `Match the room's perspective, lighting, and shadows, and change nothing else. Photorealistic. No text, no watermarks.`;
  if (!dsKey) return canned;

  // Keep it SIMPLE — over-engineered prompts made the model oversize/mis-place
  // the item. Mirror the plain "remove it and put the new one where it was,
  // natural size" instruction that works well.
  const sys = `You write ONE short image-edit instruction for an AI model replacing a single fixture in a room photo.
Rules:
- Output ONLY the instruction. No preface, quotes, JSON, or markdown.
- Say to REMOVE the existing ${segmentLabel} and install the new product in the SAME location where the old one was.
- Say to keep it a REALISTIC, NATURAL size for the room — never oversized.
- Keep everything else in the room unchanged; match the original lighting, perspective, and shadows.
- ${masked ? 'A mask marks the region to edit; render the product naturally within it.' : 'Do not change the rest of the room.'}
- End with: "Photorealistic. No text, no watermarks."
- One sentence, under 50 words.`;
  const usr = `Remove the existing ${segmentLabel} and replace it, in the same spot at a natural size, with "${product.title}"${product.retailer ? ` (${product.retailer})` : ''}. Write the instruction.`;

  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${dsKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
        max_tokens: 220,
        temperature: 0.3,
      }),
    });
    if (!res.ok) return canned;
    const json = await res.json();
    const txt = json?.choices?.[0]?.message?.content?.trim() || '';
    return txt || canned;
  } catch {
    return canned;
  }
}

// dataUrlToBlob (declared above) is re-used by both photo and mask.


async function callOpenAIEdit({ photoBlob, filename, maskBlob, prompt, size = 'auto', quality = 'medium', refBlobs = [] }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error('OPENAI_API_KEY not configured');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  // gpt-image-1 supports `quality: low | medium | high | auto`. Medium is the
  // sweet spot for cost/quality at ~$0.04/image. Bump to `high` if quality
  // becomes the bottleneck.
  const form = new FormData();
  form.append('model', OPENAI_MODEL);
  // gpt-image-1 accepts MULTIPLE input images via image[] — the room photo plus
  // (optionally) the product photo as a reference, exactly like ChatGPT. With a
  // single image we keep the plain `image` field.
  if (refBlobs.length) {
    form.append('image[]', photoBlob, filename);
    refBlobs.forEach((r, i) => form.append('image[]', r.blob, r.name || `ref${i}.png`));
  } else {
    form.append('image', photoBlob, filename);
  }
  // Mask is a PNG same-sized as the image: alpha=0 (transparent) = edit here,
  // alpha=255 (opaque) = preserve pixels untouched. OpenAI enforces this
  // strictly — pixels outside the mask remain bit-identical to the input.
  if (maskBlob) {
    form.append('mask', maskBlob, 'mask.png');
  }
  form.append('prompt', prompt);
  form.append('n', '1');
  // 'auto' matches the photo's aspect ratio. Hardcoding a square (1024x1024)
  // forced non-square room photos to be re-fit into a square, distorting the
  // scene and worsening drift. The browser composites the result back over the
  // original anyway, so exact output dims don't need to equal the source.
  form.append('size', size);
  form.append('quality', quality);
  // High input fidelity keeps the surrounding context (textures, lighting) the
  // model sees crisp, so the product it paints inside the box matches better.
  form.append('input_fidelity', 'high');

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 55_000);
  let res;
  try {
    res = await fetch(OPENAI_EDIT_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: form,
      signal: abort.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      const err = new Error('OpenAI image edit timed out after 55s');
      err.status = 504;
      throw err;
    }
    throw e;
  }
  clearTimeout(timer);

  if (!res.ok) {
    const detail = await res.text();
    const err = new Error(`OpenAI image edit error: ${res.status}`);
    err.detail = detail.slice(0, 500);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  // gpt-image-1 returns base64 by default. Re-emit as a data URL so the
  // browser can display it directly (no extra storage hop).
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) {
    const err = new Error('OpenAI returned no image payload');
    err.detail = JSON.stringify(json).slice(0, 500);
    throw err;
  }
  return { dataUrl: `data:image/png;base64,${b64}` };
}

// Primary engine: Google Nano Banana 2 (Gemini image edit) via fal.ai. It's an
// instruction editor that matches the room's lighting/perspective, so the
// result integrates instead of looking "pasted". Takes the room photo plus,
// when available, the product photo as a second reference image.
const FAL_NANOBANANA = 'https://fal.run/fal-ai/nano-banana-2/edit';

// fal returns a hosted image URL; re-fetch it server-side and inline as a data
// URL so the browser keeps its existing (data-URL) contract — and so the client
// canvas that clips to the mask isn't tainted by a cross-origin image.
async function urlToDataUrl(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch result image failed: ${r.status}`);
  const mime = r.headers.get('content-type') || 'image/png';
  const buf = Buffer.from(await r.arrayBuffer());
  return `data:${mime};base64,${buf.toString('base64')}`;
}

// Fetch a product image (URL or data URL) into a Blob for use as a reference
// image on the OpenAI edits endpoint.
async function urlToBlob(url) {
  if (!url) return null;
  if (url.startsWith('data:')) { try { return dataUrlToBlob(url).blob; } catch { return null; } }
  const r = await fetch(url);
  if (!r.ok) return null;
  const mime = r.headers.get('content-type') || 'image/png';
  const buf = Buffer.from(await r.arrayBuffer());
  return new Blob([buf], { type: mime });
}

async function callNanoBanana({ photoUrl, prompt, product }) {
  const apiKey = process.env.FAL_API_KEY;
  if (!apiKey) { const e = new Error('FAL_API_KEY not configured'); e.code = 'NOT_CONFIGURED'; throw e; }

  const image_urls = product?.thumbnail ? [photoUrl, product.thumbnail] : [photoUrl];
  const finalPrompt = product?.thumbnail
    ? `${prompt} The exact replacement item is shown in the second reference image — match its design closely.`
    : prompt;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 55_000);
  let res;
  try {
    res = await fetch(FAL_NANOBANANA, {
      method: 'POST',
      headers: { 'Authorization': `Key ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: finalPrompt, image_urls, resolution: '1K' }),
      signal: abort.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') { const er = new Error('Nano Banana timed out after 55s'); er.status = 504; throw er; }
    throw e;
  }
  clearTimeout(timer);

  if (!res.ok) {
    const detail = await res.text();
    const err = new Error(`fal nano-banana-2 error: ${res.status}`);
    err.detail = detail.slice(0, 500); err.status = res.status; throw err;
  }
  const json = await res.json();
  const url = json?.images?.[0]?.url || json?.image?.url
    || (Array.isArray(json?.output) && json.output[0]?.url) || json?.url || null;
  if (!url) { const err = new Error('nano-banana returned no image'); err.detail = JSON.stringify(json).slice(0, 500); throw err; }
  return { dataUrl: await urlToDataUrl(url) };
}

async function compositeProduct({ photoUrl, maskDataUrl, segmentLabel, segmentPosition, product, photoSize, quality, paintColor, mode }) {
  if (!photoUrl) { const e = new Error('photoUrl is required'); e.status = 400; throw e; }
  const recolor = mode === 'recolor';
  // Object-swap needs a product; recolor (paint a surface) needs a color instead.
  if (!recolor && !product?.title) { const e = new Error('product.title is required'); e.status = 400; throw e; }
  if (recolor && !paintColor?.hex) { const e = new Error('paintColor.hex is required for recolor'); e.status = 400; throw e; }

  // Cache by content fingerprint so re-doing the same edit is free.
  const photoHash = crypto.createHash('sha256')
    .update(photoUrl.length > 200_000 ? photoUrl.slice(0, 200_000) : photoUrl)
    .digest('hex').slice(0, 16);
  const cacheKey  = crypto.createHash('sha256')
    .update([
      photoHash,
      recolor ? `recolor:${paintColor.hex}:${paintColor.name || ''}` : (product.thumbnail || product.title),
      segmentLabel || 'object',
      segmentPosition ? `${segmentPosition.x},${segmentPosition.y},${segmentPosition.w},${segmentPosition.h}` : '',
    ].join('|'))
    .digest('hex').slice(0, 24);
  const hit = cacheGet(cacheKey);
  if (hit) return { ...hit, cached: true };

  const positionWords = describePosition(segmentPosition, photoSize);
  const locationAnchor = describeExactLocation(segmentPosition, photoSize);
  const prompt = await writeEditPrompt({ segmentLabel, product, positionWords, locationAnchor, masked: false, photoUrl, mode, paintColor });

  // Primary: Nano Banana 2 (fal). Fallback: gpt-image-1 (mask-based) if Nano
  // Banana errors and OpenAI is configured. The browser still clips the result
  // to the selected mask/box, so only the chosen item changes either way.
  let dataUrl, engine = 'nano-banana-2';
  try {
    dataUrl = (await callNanoBanana({ photoUrl, prompt, product })).dataUrl;
  } catch (e) {
    if (!process.env.OPENAI_API_KEY) throw e;
    console.warn('Nano Banana failed; falling back to gpt-image-1:', e.message);
    engine = 'gpt-image-1';
    const { blob, filename } = dataUrlToBlob(photoUrl);
    const maskBlob = maskDataUrl ? dataUrlToBlob(maskDataUrl).blob : null;
    // Pass the product photo as a second reference image so gpt-image-1 paints
    // the EXACT product — same as ChatGPT. gpt-image-1 accepts a mask alongside
    // image[]; the mask applies to the first image (the room photo), which is
    // what anchors the swap to the old fixture's spot in Precise mode.
    let refBlobs = [];
    let editPrompt = prompt;
    if (product?.thumbnail) {
      const pb = await urlToBlob(product.thumbnail).catch(() => null);
      if (pb) {
        refBlobs = [{ blob: pb, name: 'product.png' }];
        editPrompt = `${prompt} The reference image shows the exact product — match its design, color, and shape, but scale it to a realistic, natural size for the room (not oversized).`;
      }
    }
    try {
      dataUrl = (await callOpenAIEdit({ photoBlob: blob, filename, maskBlob, prompt: editPrompt, quality: quality || 'medium', refBlobs })).dataUrl;
    } catch (err) {
      // Some accounts / model versions reject image[] combined with a mask.
      // Retry once without the reference image so the swap still succeeds.
      if (refBlobs.length) {
        console.warn('gpt-image-1 rejected reference image + mask; retrying without reference:', err.message);
        dataUrl = (await callOpenAIEdit({ photoBlob: blob, filename, maskBlob, prompt, quality: quality || 'medium' })).dataUrl;
      } else {
        throw err;
      }
    }
  }

  const data = { imageDataUrl: dataUrl, promptUsed: prompt, engine };
  cacheSet(cacheKey, data);
  return data;
}

module.exports = { compositeProduct };
