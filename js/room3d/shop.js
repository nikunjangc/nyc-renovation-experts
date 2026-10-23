// Shopping inside the 3D room: live product results from the stores (through
// /api/product-search, which adds our affiliate tags), and a 3D model made
// from the product photo (through /api/ds-render3d) to place in the room.

export const QUICK_SEARCHES = [
  'sofa', 'sectional sofa', 'accent chair', 'coffee table', 'area rug 8x10', 'floor lamp',
  'tv stand', 'bookshelf', 'dining table', 'queen bed frame', 'nightstand', 'dresser',
];

async function postJSON(url, body, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: ctl.signal,
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* not json */ }
    if (!res.ok) {
      const e = new Error((json && json.error) || ('HTTP ' + res.status));
      e.status = res.status;
      throw e;
    }
    return json;
  } catch (e) {
    if (e.name === 'AbortError') { const err = new Error('timeout'); err.status = 504; throw err; }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export async function searchProducts(api, query) {
  const r = await postJSON(api + '/api/product-search', { query, limit: 10 }, 30000);
  const list = (r && r.results) || [];
  return list.filter((p) => p && p.title);
}

export async function makeModel(api, product) {
  if (!product.thumbnail) throw new Error('This product has no photo to build from');
  const r = await postJSON(api + '/api/ds-render3d', { imageUrl: product.thumbnail }, 70000);
  if (r && r.modelUrl) return r.modelUrl;
  throw new Error('No 3D model came back');
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function storeName(r) {
  const s = String(r || '').trim();
  if (!s) return 'Store';
  if (/home ?depot/i.test(s)) return 'Home Depot';
  if (/amazon/i.test(s)) return 'Amazon';
  if (/wayfair/i.test(s)) return 'Wayfair';
  if (/ikea/i.test(s)) return 'IKEA';
  if (/lowe/i.test(s)) return "Lowe's";
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function productCard(p, { onPlace }) {
  const el = document.createElement('div');
  el.className = 'r3d-prod';
  const price = p.priceDisplay || (p.price != null ? '$' + Number(p.price).toFixed(2) : '');
  el.innerHTML = `
    <div class="r3d-prod-img">${p.thumbnail ? `<img src="${esc(p.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<i class="fas fa-image"></i>'}</div>
    <div class="r3d-prod-body">
      <div class="r3d-prod-title">${esc(p.title)}</div>
      <div class="r3d-prod-meta"><strong>${esc(price)}</strong> · ${esc(storeName(p.retailer))}</div>
      <div class="r3d-prod-actions">
        <button type="button" class="r3d-btn r3d-btn-primary r3d-prod-place" ${p.thumbnail ? '' : 'disabled'}><i class="fas fa-cube"></i> See it in my room</button>
        ${p.link ? `<a class="r3d-btn r3d-btn-ghost" href="${esc(p.link)}" target="_blank" rel="noopener sponsored">View</a>` : ''}
      </div>
    </div>`;
  el.querySelector('.r3d-prod-place').addEventListener('click', () => onPlace(p));
  return el;
}
