// 3D Room: erase something from a photo (an old sofa, a lamp) so the room
// can be redesigned without it.
//
// The page cuts a normal camera view out of the 360 photo, gets the object's
// outline from Segment Anything (/api/ds-mask) and sends the view plus that
// outline (white = remove) here. We pass them to fal.ai's Bria Eraser, which
// fills the area with what would be behind it, and return the new image URL.
//
//   POST /api/room-erase  { imageUrl, maskUrl }  ->  { imageUrl }
//
// imageUrl / maskUrl may be data URLs. Cost: about $0.04 per erase (fal.ai
// pricing for fal-ai/bria/eraser). ROOM_ERASE_MODEL can point at another fal
// endpoint with the same inputs.

const ENDPOINT = `https://fal.run/${process.env.ROOM_ERASE_MODEL || 'fal-ai/bria/eraser'}`;
const MAX_INPUT = 8 * 1024 * 1024;   // per data URL

function bad(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function checkUrl(u, name) {
  if (typeof u !== 'string' || !u) throw bad(`${name} is required`);
  if (u.length > MAX_INPUT) throw bad(`${name} is too large`, 413);
  if (!/^data:image\/(png|jpeg|webp);base64,/.test(u) && !/^https:\/\//.test(u)) {
    throw bad(`${name} must be an image data URL or an https URL`);
  }
}

async function eraseObject({ imageUrl, maskUrl }) {
  const apiKey = process.env.FAL_API_KEY;
  if (!apiKey) {
    const err = new Error('FAL_API_KEY not configured');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  checkUrl(imageUrl, 'imageUrl');
  checkUrl(maskUrl, 'maskUrl');

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 55_000);
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_url: imageUrl, mask_url: maskUrl, mask_type: 'manual' }),
      signal: ctl.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw bad('The eraser took too long. Try again.', 504);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = await res.text();
    const err = new Error(`fal.ai eraser error: ${res.status}`);
    err.detail = detail.slice(0, 500);
    err.status = res.status === 422 ? 422 : 502;
    throw err;
  }
  const json = await res.json();
  const url = json?.image?.url || json?.images?.[0]?.url || json?.output?.url || null;
  if (!url) {
    const err = new Error('fal.ai eraser returned no image');
    err.detail = JSON.stringify(json).slice(0, 300);
    throw err;
  }
  return { imageUrl: url };
}

module.exports = { eraseObject };
