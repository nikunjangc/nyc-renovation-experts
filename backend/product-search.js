// Product search: hits SerpAPI Google Shopping to return normalized
// product results across Home Depot, Lowe's, IKEA, Amazon, Wayfair, etc.
//
// Falls back to deterministic mock data if SERPAPI_KEY is not set, so the
// feature is testable end-to-end before the user provisions an API key.
//
// Uses the global fetch (Node 18+) — see product-recommender.js for why.

const { applyAffiliate } = require('./affiliate');

// Direct retailer search URLs.
// SerpAPI's google_shopping `link` field points at Google Shopping
// product pages (one extra click for the user). Google deprecated the
// product-detail API in 2024, so SerpAPI can no longer resolve a
// product_id into a direct retailer URL. As a pragmatic middle ground
// we send users to the retailer's OWN search page for the product title
// — one fewer hop than Google Shopping, no external API call, no quota.
const RETAILER_SEARCH_URLS = {
  'home depot':   (q) => `https://www.homedepot.com/s/${encodeURIComponent(q)}`,
  homedepot:      (q) => `https://www.homedepot.com/s/${encodeURIComponent(q)}`,
  lowes:          (q) => `https://www.lowes.com/search?searchTerm=${encodeURIComponent(q)}`,
  "lowe's":       (q) => `https://www.lowes.com/search?searchTerm=${encodeURIComponent(q)}`,
  amazon:         (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
  ikea:           (q) => `https://www.ikea.com/us/en/search/?q=${encodeURIComponent(q)}`,
  wayfair:        (q) => `https://www.wayfair.com/keyword.php?keyword=${encodeURIComponent(q)}`,
  menards:        (q) => `https://www.menards.com/main/search.html?search=${encodeURIComponent(q)}`,
  'ace hardware': (q) => `https://www.acehardware.com/search?query=${encodeURIComponent(q)}`,
  'build.com':    (q) => `https://www.build.com/search?term=${encodeURIComponent(q)}`,
};

function directRetailerLink(retailer, title) {
  const builder = RETAILER_SEARCH_URLS[(retailer || '').toLowerCase()];
  return builder ? builder(title || '') : null;
}

const PREFERRED_RETAILERS = [
  'home depot',
  'homedepot',
  "lowe's",
  'lowes',
  'ikea',
  'amazon',
  'wayfair',
  'menards',
  'ace hardware',
  'build.com',
];

// In-memory cache: query -> { ts, data }. 24h TTL.
const cache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key, data) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { ts: Date.now(), data });
}

function normalizeRetailer(name) {
  if (!name) return 'unknown';
  const lower = name.toLowerCase();
  for (const r of PREFERRED_RETAILERS) {
    if (lower.includes(r.replace("'", ''))) return r.replace("'", '');
  }
  return lower.split('.')[0];
}

function parsePrice(p) {
  if (typeof p === 'number') return p;
  if (!p) return null;
  const m = String(p).match(/([\d,]+\.?\d*)/);
  return m ? parseFloat(m[1].replace(/,/g, '')) : null;
}

function normalizeResult(r) {
  const retailer = normalizeRetailer(r.source || r.seller);
  const price = parsePrice(r.extracted_price ?? r.price);
  const title = r.title || '';
  const googleShoppingLink = r.product_link || r.link || '';
  // Prefer a direct retailer search URL when we recognize the retailer; fall
  // back to the Google Shopping link otherwise.
  const directLink = directRetailerLink(retailer, title);
  const finalLink = applyAffiliate(directLink || googleShoppingLink, retailer);
  return {
    title,
    price,
    priceDisplay: r.price || (price != null ? `$${price.toFixed(2)}` : null),
    retailer,
    rating: r.rating ?? null,
    reviews: r.reviews ?? null,
    thumbnail: r.thumbnail || r.image || null,
    link: finalLink,
    googleShoppingLink, // kept so the frontend can offer it as a secondary
    productId: r.product_id || null,
    delivery: r.delivery || null,
    snippet: r.snippet || '',
  };
}

function mockResults(query) {
  // Deterministic-ish mock so the UI is exercisable without SerpAPI.
  const retailers = ['home depot', 'lowes', 'amazon', 'ikea', 'wayfair'];
  const base = 30 + (query.length * 7) % 200;
  return retailers.map((retailer, i) => ({
    title: `${query} — ${retailer}`,
    price: +(base + i * 11.5).toFixed(2),
    priceDisplay: `$${(base + i * 11.5).toFixed(2)}`,
    retailer,
    rating: 4 + ((i * 0.13) % 1),
    reviews: 50 + i * 21,
    thumbnail: null,
    link: applyAffiliate(`https://www.${retailer.replace(/[^a-z]/g, '')}.com/s?k=${encodeURIComponent(query)}`, retailer),
    productId: null, // mocks skip the product-detail lookup
    delivery: i % 2 ? 'Free delivery' : 'In stock nearby',
    snippet: 'Mock result — set SERPAPI_KEY to enable live retailer search.',
  }));
}

// fetch with a timeout so one slow source can't stall the whole fan-out.
function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t));
}

// ---- Rate limiter: cap live external searches per hour (cost control) -------
// Per-instance rolling window. The 24h cache absorbs most repeats; this bounds
// worst-case spend on the paid source. Configurable via env.
const _searchWindow = [];
const MAX_PER_HOUR = +(process.env.PRODUCT_SEARCH_MAX_PER_HOUR || 200);
function rateOk() {
  const now = Date.now(), hourAgo = now - 3600_000;
  while (_searchWindow.length && _searchWindow[0] < hourAgo) _searchWindow.shift();
  if (_searchWindow.length >= MAX_PER_HOUR) return false;
  _searchWindow.push(now);
  return true;
}

// ---- Source: Best Buy (free) -----------------------------------------------
async function bestBuySearch(query, limit) {
  const key = process.env.BESTBUY_API_KEY;
  if (!key) return [];
  const terms = query.trim().split(/\s+/).map((w) => `search=${encodeURIComponent(w)}`).join('&');
  const show = 'sku,name,salePrice,regularPrice,image,url,customerReviewAverage,customerReviewCount,manufacturer';
  const url = `https://api.bestbuy.com/v1/products((${terms}))?apiKey=${key}&format=json&pageSize=${limit}&show=${show}&sort=customerReviewAverage.dsc`;
  const r = await fetchWithTimeout(url, {}, 8000);
  if (!r.ok) return [];
  const j = await r.json().catch(() => ({}));
  return (j.products || []).map((p) => {
    const price = p.salePrice ?? p.regularPrice ?? null;
    return {
      title: p.name || '', price, priceDisplay: price != null ? `$${price.toFixed(2)}` : null,
      retailer: 'best buy', rating: p.customerReviewAverage ?? null, reviews: p.customerReviewCount ?? null,
      thumbnail: p.image || null, link: applyAffiliate(p.url || '', 'best buy'),
      googleShoppingLink: '', productId: p.sku ? String(p.sku) : null, delivery: null,
      snippet: p.manufacturer || '', source: 'bestbuy',
    };
  });
}

// ---- Source: eBay Browse (free; OAuth client-credentials token, cached) -----
let _ebayToken = null; // { token, exp }
async function getEbayToken() {
  if (_ebayToken && Date.now() < _ebayToken.exp) return _ebayToken.token;
  const id = process.env.EBAY_CLIENT_ID, secret = process.env.EBAY_CLIENT_SECRET;
  if (!id || !secret) return null;
  const basic = Buffer.from(`${id}:${secret}`).toString('base64');
  const r = await fetchWithTimeout('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
  }, 8000).catch(() => null);
  if (!r || !r.ok) return null;
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) return null;
  _ebayToken = { token: j.access_token, exp: Date.now() + ((j.expires_in ? j.expires_in - 120 : 3600) * 1000) };
  return _ebayToken.token;
}
async function ebaySearch(query, limit) {
  const token = await getEbayToken();
  if (!token) return [];
  const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&limit=${limit}`;
  const r = await fetchWithTimeout(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
  }, 8000);
  if (!r.ok) return [];
  const j = await r.json().catch(() => ({}));
  return (j.itemSummaries || []).map((it) => {
    const price = it.price ? parseFloat(it.price.value) : null;
    return {
      title: it.title || '', price, priceDisplay: price != null ? `$${price.toFixed(2)}` : null,
      retailer: 'ebay', rating: null, reviews: null,
      thumbnail: it.image?.imageUrl || it.thumbnailImages?.[0]?.imageUrl || null,
      link: it.itemWebUrl || '', googleShoppingLink: '', productId: it.itemId || null,
      delivery: null, snippet: it.condition || '', source: 'ebay',
    };
  });
}

// ---- Source: SerpAPI Google Shopping (optional, paid) ----------------------
async function serpApiSearch(query, limit) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return [];
  const params = new URLSearchParams({
    engine: 'google_shopping', q: query, api_key: apiKey,
    location: 'New York, New York, United States', gl: 'us', hl: 'en',
    num: String(Math.min(limit * 3, 30)),
  });
  const r = await fetchWithTimeout(`https://serpapi.com/search.json?${params.toString()}`, {}, 8000);
  if (!r.ok) return [];
  const json = await r.json().catch(() => ({}));
  return (json.shopping_results || []).map(normalizeResult).filter((x) => x.price != null);
}

// Merge across sources: dedupe by retailer+title, then rank (has-image first,
// then rating desc, then price asc) so the best, previewable items lead.
function dedupeAndRank(results, limit) {
  const seen = new Set(), uniq = [];
  for (const r of results) {
    const key = `${r.retailer}|${(r.title || '').toLowerCase().slice(0, 60)}`;
    if (seen.has(key)) continue;
    seen.add(key); uniq.push(r);
  }
  uniq.sort((a, b) => {
    const ai = a.thumbnail ? 1 : 0, bi = b.thumbnail ? 1 : 0;
    if (ai !== bi) return bi - ai;
    const ar = a.rating || 0, br = b.rating || 0;
    if (br !== ar) return br - ar;
    return (a.price ?? 1e9) - (b.price ?? 1e9);
  });
  return uniq.slice(0, limit);
}

// The tagged label (e.g. "television", "sofa") is the query — fanned out to all
// configured sources in parallel.
async function searchProducts(query, { limit = 6, zip = '10001' } = {}) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return { query: '', results: [], source: 'empty' };

  const cacheKey = `${trimmed}|${zip}|${limit}`;
  const hit = cacheGet(cacheKey);
  if (hit) return { ...hit, cached: true };

  const haveLive = process.env.BESTBUY_API_KEY
    || (process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET)
    || process.env.SERPAPI_KEY;
  if (!haveLive) {
    const data = { query: trimmed, results: mockResults(trimmed).slice(0, limit), source: 'mock' };
    cacheSet(cacheKey, data);
    return data;
  }
  if (!rateOk()) {
    // Over the hourly cap: serve mock rather than spend/queue. Not cached, so a
    // later (in-budget) call still fetches live results.
    return { query: trimmed, results: mockResults(trimmed).slice(0, limit), source: 'rate_limited' };
  }

  const perSource = Math.max(limit, 8);
  const settled = await Promise.allSettled([
    bestBuySearch(trimmed, perSource),
    ebaySearch(trimmed, perSource),
    serpApiSearch(trimmed, perSource),
  ]);
  const all = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
  let results = dedupeAndRank(all, limit);

  const sources = [];
  if (process.env.BESTBUY_API_KEY) sources.push('bestbuy');
  if (process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET) sources.push('ebay');
  if (process.env.SERPAPI_KEY) sources.push('serpapi');

  if (!results.length) results = mockResults(trimmed).slice(0, limit);
  const data = { query: trimmed, results, source: results.length && all.length ? sources.join('+') : 'mock' };
  cacheSet(cacheKey, data);
  return data;
}

module.exports = { searchProducts };
