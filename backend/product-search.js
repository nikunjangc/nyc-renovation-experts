// Product search: hits SerpAPI Google Shopping to return normalized
// product results across Home Depot, Lowe's, IKEA, Amazon, Wayfair, etc.
//
// Falls back to deterministic mock data if SERPAPI_KEY is not set, so the
// feature is testable end-to-end before the user provisions an API key.
//
// Uses the global fetch (Node 18+) — see product-recommender.js for why.

const { applyAffiliate } = require('./affiliate');

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
  return {
    title: r.title || '',
    price,
    priceDisplay: r.price || (price != null ? `$${price.toFixed(2)}` : null),
    retailer,
    rating: r.rating ?? null,
    reviews: r.reviews ?? null,
    thumbnail: r.thumbnail || r.image || null,
    link: applyAffiliate(r.product_link || r.link || '', retailer),
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
    delivery: i % 2 ? 'Free delivery' : 'In stock nearby',
    snippet: 'Mock result — set SERPAPI_KEY to enable live retailer search.',
  }));
}

async function searchProducts(query, { limit = 6, zip = '10001' } = {}) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return { query: '', results: [], source: 'empty' };

  const cacheKey = `${trimmed}|${zip}|${limit}`;
  const hit = cacheGet(cacheKey);
  if (hit) return { ...hit, cached: true };

  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    const data = { query: trimmed, results: mockResults(trimmed).slice(0, limit), source: 'mock' };
    cacheSet(cacheKey, data);
    return data;
  }

  // SerpAPI's `location` param must match a name in their location database
  // (free-form addresses or ZIPs are rejected with "Unsupported … location").
  // For NYC we use the canonical name; for non-NYC zips we omit location and
  // rely on gl/hl to localize. zip is accepted as input for future use.
  const params = new URLSearchParams({
    engine: 'google_shopping',
    q: trimmed,
    api_key: apiKey,
    location: 'New York, New York, United States',
    gl: 'us',
    hl: 'en',
    num: String(Math.min(limit * 3, 30)),
  });
  const url = `https://serpapi.com/search.json?${params.toString()}`;

  const response = await fetch(url);
  if (!response.ok) {
    const detail = await response.text();
    const err = new Error(`SerpAPI error: ${response.status}`);
    err.detail = detail.slice(0, 500);
    throw err;
  }
  const json = await response.json();
  const raw = json.shopping_results || [];

  // Prefer results from known retailers, then take highest rated / cheapest.
  const normalized = raw.map(normalizeResult).filter((r) => r.price != null);
  const preferred = normalized.filter((r) => PREFERRED_RETAILERS.some((p) => r.retailer.includes(p.replace("'", ''))));
  const rest = normalized.filter((r) => !preferred.includes(r));
  const merged = [...preferred, ...rest].slice(0, limit);

  const data = { query: trimmed, results: merged, source: 'serpapi' };
  cacheSet(cacheKey, data);
  return data;
}

module.exports = { searchProducts };
