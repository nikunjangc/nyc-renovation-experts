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
const OPENAI_MODEL     = 'gpt-image-1';

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

// Use DeepSeek to write a tight, strict edit prompt. If DeepSeek isn't
// configured (or call fails), fall back to a canned template — the feature
// still works.
async function writeEditPrompt({ segmentLabel, product, positionWords, masked }) {
  const dsKey = process.env.DEEPSEEK_API_KEY;
  // When a mask is provided, OpenAI strictly preserves pixels OUTSIDE the
  // mask — we don't need to over-warn the model. But the prompt should still
  // remind the model to ONLY paint a believable product within the masked
  // area, and not to e.g. add text/labels.
  const maskClause = masked
    ? `Paint only within the masked (transparent) area; the rest of the photo will be preserved automatically by the mask.`
    : `Keep all other elements (walls, floor, lighting, other appliances, cabinets) unchanged.`;

  const canned = `Replace the ${segmentLabel} ${positionWords} with: ${product.title}. ` +
                 `${maskClause} ` +
                 `Match the photo's lighting and perspective. Photorealistic. No text, no watermarks, no labels.`;
  if (!dsKey) return canned;

  const sys = `You write a single concise image-edit prompt for an AI image model.
Hard rules:
- Output ONLY the prompt text. No preface, no quotes, no JSON, no markdown.
- Be specific about WHAT product to render.
- ${masked
    ? 'A binary mask is also provided; the model will only paint inside the transparent region. Tell it to render the product naturally within that masked area.'
    : 'ALWAYS include: "Keep all other elements unchanged. Match the original photo\'s lighting and perspective."'}
- ALWAYS include: "Photorealistic. No text, no watermarks, no labels."
- 1-2 sentences total. Under 60 words.`;
  const usr = `Replace the ${segmentLabel} in ${positionWords} of a kitchen/bathroom photo with this product:
"${product.title}"${product.retailer ? ` (sold at ${product.retailer})` : ''}.
Write the edit prompt.`;

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


async function callOpenAIEdit({ photoBlob, filename, maskBlob, prompt, size = '1024x1024', quality = 'medium' }) {
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
  form.append('image', photoBlob, filename);
  // Mask is a PNG same-sized as the image: alpha=0 (transparent) = edit here,
  // alpha=255 (opaque) = preserve pixels untouched. OpenAI enforces this
  // strictly — pixels outside the mask remain bit-identical to the input.
  if (maskBlob) {
    form.append('mask', maskBlob, 'mask.png');
  }
  form.append('prompt', prompt);
  form.append('n', '1');
  form.append('size', size);
  form.append('quality', quality);

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

async function compositeProduct({ photoUrl, maskDataUrl, segmentLabel, segmentPosition, product, photoSize, quality }) {
  if (!photoUrl)       { const e = new Error('photoUrl is required');      e.status = 400; throw e; }
  if (!product?.title) { const e = new Error('product.title is required'); e.status = 400; throw e; }

  // Cache by content fingerprint so re-picking the same product is free.
  const photoHash = crypto.createHash('sha256')
    .update(photoUrl.length > 200_000 ? photoUrl.slice(0, 200_000) : photoUrl)
    .digest('hex').slice(0, 16);
  const cacheKey  = crypto.createHash('sha256')
    .update([
      photoHash,
      product.thumbnail || product.title,
      segmentLabel || 'object',
      segmentPosition ? `${segmentPosition.x},${segmentPosition.y},${segmentPosition.w},${segmentPosition.h}` : '',
    ].join('|'))
    .digest('hex').slice(0, 24);
  const hit = cacheGet(cacheKey);
  if (hit) return { ...hit, cached: true };

  const positionWords = describePosition(segmentPosition, photoSize);
  const prompt = await writeEditPrompt({ segmentLabel, product, positionWords, masked: !!maskDataUrl });
  const { blob, filename } = dataUrlToBlob(photoUrl);
  const maskBlob = maskDataUrl ? dataUrlToBlob(maskDataUrl).blob : null;
  const { dataUrl } = await callOpenAIEdit({
    photoBlob: blob,
    filename,
    maskBlob,
    prompt,
    quality: quality || 'medium',
  });

  const data = { imageDataUrl: dataUrl, promptUsed: prompt };
  cacheSet(cacheKey, data);
  return data;
}

module.exports = { compositeProduct };
