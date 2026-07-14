// Design-render feedback storage on Supabase Postgres. Captures 👍/👎 on AI
// renders plus the user's own words about what they wanted vs what they got, so
// we can learn from failures. Best-effort: if Supabase isn't configured, callers
// treat it as a no-op (the user-facing re-render still works).
//
// Table (run once in Supabase SQL editor):
//   create table if not exists public.design_feedback (
//     id            bigint generated always as identity primary key,
//     created_at    timestamptz not null default now(),
//     rating        text,          -- 'up' | 'down'
//     user_text     text,          -- what they wanted / what went wrong
//     segment_label text,
//     mode          text,          -- 'swap' | 'recolor'
//     engine        text,
//     before_thumb  text,          -- small JPEG data URL
//     after_thumb   text,          -- small JPEG data URL
//     source        text,
//     user_agent    text,
//     ip_hash       text
//   );

const { createClient } = require('@supabase/supabase-js');

let cachedClient = null;
function getClient() {
  if (cachedClient) return cachedClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  cachedClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedClient;
}

function hashIp(ip) {
  if (!ip) return null;
  let h = 0x811c9dc5;
  for (let i = 0; i < ip.length; i++) {
    h ^= ip.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

// Cap a data URL so a huge image never bloats the row (thumbnails are already
// downscaled client-side; this is just a backstop).
function clampThumb(s) {
  if (!s || typeof s !== 'string') return null;
  return s.length > 400_000 ? null : s;
}

async function saveDesignFeedback(input) {
  const client = getClient();
  if (!client) {
    const err = new Error('Supabase is not configured');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  const row = {
    rating:        input.rating === 'up' ? 'up' : 'down',
    user_text:     (input.userText || '').toString().slice(0, 2000) || null,
    segment_label: (input.segmentLabel || '').toString().slice(0, 120) || null,
    mode:          (input.mode || '').toString().slice(0, 40) || null,
    engine:        (input.engine || '').toString().slice(0, 60) || null,
    before_thumb:  clampThumb(input.beforeThumb),
    after_thumb:   clampThumb(input.afterThumb),
    source:        (input.source || '').toString().slice(0, 120) || null,
    user_agent:    (input.userAgent || '').toString().slice(0, 300) || null,
    ip_hash:       hashIp(input.ip),
  };
  const { data, error } = await client
    .from('design_feedback')
    .insert(row)
    .select('id, created_at')
    .single();
  if (error) {
    const err = new Error(`Supabase insert failed: ${error.message}`);
    err.detail = error.details || error.hint || '';
    throw err;
  }
  return data; // { id, created_at }
}

module.exports = { saveDesignFeedback };
