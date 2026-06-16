// Product detail: given a SerpAPI Google Shopping product_id, calls SerpAPI's
// google_product engine to retrieve the list of online sellers with DIRECT
// retailer URLs (Home Depot, Lowe's, IKEA, Amazon, Wayfair...) — bypassing
// the Google Shopping intermediary that the basic search returns.
//
// Cached for 7 days per product_id (sellers don't churn that often) so a
// repeat click on the same item doesn't burn another SerpAPI quota unit.
//
// Falls back gracefully when SERPAPI_KEY is unset — returns null so the
// caller can use the original Google Shopping link.

const { applyAffiliate } = require('./affiliate');

const PREFERRED_RETAILERS = [
  'home depot', 'homedepot',
  "lowe's", 'lowes',
  'ikea',
  'amazon',
  'wayfair',
  'menards',
  'ace hardware',
  'build.com',
];

const cache = new Map();
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_CACHE_ENTRIES = 1000;

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return e.data;
}

function cacheSet(key, data) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { ts: Date.now(), data });
}

function parsePrice(p) {
  if (typeof p === 'number') return p;
  if (!p) return null;
  const m = String(p).match(/([\d,]+\.?\d*)/);
  return m ? parseFloat(m[1].replace(/,/g, '')) : null;
}

function normalizeRetailer(name) {
  if (!name) return 'unknown';
  const lower = name.toLowerCase();
  for (const r of PREFERRED_RETAILERS) {
    if (lower.includes(r.replace("'", ''))) return r.replace("'", '');
  }
  return lower.split(/[.\s]/)[0];
}

function rankSellers(sellers) {
  // Prefer named big-box retailers, then by lowest total price.
  const preferred = sellers.filter((s) =>
    PREFERRED_RETAILERS.some((p) => s.retailer.includes(p.replace("'", ''))));
  const rest = sellers.filter((s) => !preferred.includes(s));
  const sortByPrice = (a, b) =>
    (a.totalPrice ?? a.price ?? Infinity) - (b.totalPrice ?? b.price ?? Infinity);
  preferred.sort(sortByPrice);
  rest.sort(sortByPrice);
  return [...preferred, ...rest];
}

async function getProductDetail(productId) {
  const id = String(productId || '').trim();
  if (!id) return null;

  const cached = cacheGet(id);
  if (cached) return { ...cached, cached: true };

  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return null;

  const params = new URLSearchParams({
    engine: 'google_product',
    product_id: id,
    api_key: apiKey,
    gl: 'us',
    hl: 'en',
  });

  const response = await fetch(`https://serpapi.com/search.json?${params.toString()}`);
  if (!response.ok) {
    const detail = await response.text();
    const err = new Error(`SerpAPI google_product error: ${response.status}`);
    err.detail = detail.slice(0, 500);
    throw err;
  }
  const json = await response.json();

  const onlineSellers = json?.sellers_results?.online_sellers || [];
  const sellers = onlineSellers.map((s) => {
    const retailer = normalizeRetailer(s.name);
    const rawLink = s.link || s.direct_link || '';
    return {
      retailer,
      link: applyAffiliate(rawLink, retailer),
      price: parsePrice(s.base_price ?? s.total_price ?? s.price),
      totalPrice: parsePrice(s.total_price),
      condition: s.condition || null,
      shipping: s.additional_price?.shipping ?? s.shipping ?? null,
      name: s.name || '',
    };
  }).filter((s) => s.link);

  const data = {
    productId: id,
    sellers: rankSellers(sellers),
  };
  cacheSet(id, data);
  return data;
}

module.exports = { getProductDetail };
