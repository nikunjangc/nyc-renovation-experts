// Affiliate link rewriter.
//
// Priority per retailer:
//   1. Amazon           → append your Associates tag (Amazon forbids sub-affiliate
//                          networks, so it NEVER goes through Skimlinks/Sovrn).
//   2. Direct programs   → Home Depot / Lowe's / Wayfair via their Impact/CJ click
//                          prefix, if you've joined those directly (they pay more
//                          than a universal network's share).
//   3. Universal network → everything else (Ashley, Bob's, Walmart, Target, eBay,
//                          …) wrapped through ONE universal affiliate network
//                          (Skimlinks OR Sovrn), so most outbound clicks earn
//                          without per-retailer signups.
//   4. Otherwise          → pass through unchanged.
//
// Everything is env-driven and dormant until you set the vars, so deploying this
// changes nothing until you paste your IDs into Vercel.
//
// Env vars (all optional):
//   AMAZON_ASSOCIATE_TAG          e.g. nycrenovation-20
//   UNIVERSAL_AFFILIATE_PROVIDER  'skimlinks' | 'sovrn'   (pick ONE; never both)
//   SKIMLINKS_ID                  your Skimlinks publisher id (e.g. 123456X1234567)
//   SOVRN_KEY                     your Sovrn Commerce (VigLink) API key
//   HOMEDEPOT_AFFILIATE_PREFIX    e.g. https://www.tkqlhce.com/click-XXXX-YYYY?url=
//   LOWES_AFFILIATE_PREFIX        e.g. https://www.anrdoezrs.net/click-XXXX-YYYY?url=
//   WAYFAIR_AFFILIATE_PREFIX      e.g. https://www.dpbolvw.net/click-XXXX-YYYY?url=

function withAmazonTag(rawUrl) {
  const tag = process.env.AMAZON_ASSOCIATE_TAG;
  if (!tag) return rawUrl;
  try {
    const u = new URL(rawUrl);
    u.searchParams.set('tag', tag);
    return u.toString();
  } catch {
    return rawUrl;
  }
}

function withPrefix(rawUrl, prefix) {
  if (!prefix) return rawUrl;
  return prefix + encodeURIComponent(rawUrl);
}

// Wrap a URL through the configured universal affiliate network. Returns the URL
// unchanged if no provider/id is set, if it's not an http(s) URL, or if it's
// already wrapped (avoids double-wrapping).
function wrapUniversal(rawUrl) {
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return rawUrl;
  if (/(skimresources\.com|go\.redirectingat\.com|viglink\.com)/i.test(rawUrl)) return rawUrl;
  const provider = (process.env.UNIVERSAL_AFFILIATE_PROVIDER || '').toLowerCase();
  if (provider === 'skimlinks') {
    const id = process.env.SKIMLINKS_ID;
    if (!id) return rawUrl;
    return `https://go.skimresources.com/?id=${encodeURIComponent(id)}&url=${encodeURIComponent(rawUrl)}`;
  }
  if (provider === 'sovrn' || provider === 'viglink') {
    const key = process.env.SOVRN_KEY;
    if (!key) return rawUrl;
    return `https://redirect.viglink.com/?format=go&key=${encodeURIComponent(key)}&u=${encodeURIComponent(rawUrl)}`;
  }
  return rawUrl;
}

function applyAffiliate(rawUrl, retailer) {
  if (!rawUrl) return rawUrl;
  const r = (retailer || '').toLowerCase();
  // 1. Amazon — its own tag only, never a universal network.
  if (r.includes('amazon')) return withAmazonTag(rawUrl);
  // 2. Direct programs take priority (better rate); fall back to universal.
  if (r.includes('home depot') || r.includes('homedepot')) {
    return process.env.HOMEDEPOT_AFFILIATE_PREFIX
      ? withPrefix(rawUrl, process.env.HOMEDEPOT_AFFILIATE_PREFIX)
      : wrapUniversal(rawUrl);
  }
  if (r.includes('lowe')) {
    return process.env.LOWES_AFFILIATE_PREFIX
      ? withPrefix(rawUrl, process.env.LOWES_AFFILIATE_PREFIX)
      : wrapUniversal(rawUrl);
  }
  if (r.includes('wayfair')) {
    return process.env.WAYFAIR_AFFILIATE_PREFIX
      ? withPrefix(rawUrl, process.env.WAYFAIR_AFFILIATE_PREFIX)
      : wrapUniversal(rawUrl);
  }
  // 3. Everything else → universal network (Ashley, Bob's, Walmart, Target, eBay…).
  return wrapUniversal(rawUrl);
}

module.exports = { applyAffiliate, wrapUniversal };
