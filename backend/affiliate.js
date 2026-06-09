// Affiliate link rewriter.
// Currently supports Amazon Associates tag injection. Slots for Impact / CJ
// deeplinks are left as env-driven prefixes — once you're approved by the
// affiliate network, set the relevant env var and links pass through it.
//
// Env vars (all optional):
//   AMAZON_ASSOCIATE_TAG   e.g. nycrenoexp-20
//   HOMEDEPOT_AFFILIATE_PREFIX   e.g. https://www.tkqlhce.com/click-XXXX-YYYY?url=
//   LOWES_AFFILIATE_PREFIX       e.g. https://www.anrdoezrs.net/click-XXXX-YYYY?url=
//   WAYFAIR_AFFILIATE_PREFIX     e.g. https://www.dpbolvw.net/click-XXXX-YYYY?url=

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

function applyAffiliate(rawUrl, retailer) {
  if (!rawUrl) return rawUrl;
  const r = (retailer || '').toLowerCase();
  if (r.includes('amazon')) return withAmazonTag(rawUrl);
  if (r.includes('home depot') || r.includes('homedepot')) {
    return withPrefix(rawUrl, process.env.HOMEDEPOT_AFFILIATE_PREFIX);
  }
  if (r.includes('lowe')) return withPrefix(rawUrl, process.env.LOWES_AFFILIATE_PREFIX);
  if (r.includes('wayfair')) return withPrefix(rawUrl, process.env.WAYFAIR_AFFILIATE_PREFIX);
  return rawUrl;
}

module.exports = { applyAffiliate };
