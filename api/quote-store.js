// Quote storage on Supabase Postgres. Wraps insert + list operations and
// keeps the service-role key locked to this module (never serialized to a
// response, never sent to the frontend).
//
// Schema lives in Supabase as public.quote_submissions — see the project's
// Supabase setup doc / the SQL run during initial provisioning.

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

// Hash the client IP so we never store it raw. Cheap stable hash (FNV-1a)
// — enough to recognize "same source" without retaining a recoverable IP.
function hashIp(ip) {
  if (!ip) return null;
  let h = 0x811c9dc5;
  for (let i = 0; i < ip.length; i++) {
    h ^= ip.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

function parseCostRange(str) {
  if (!str) return [null, null];
  const matches = String(str).match(/\$?([\d,]+)\s*-\s*\$?([\d,]+)/);
  if (!matches) return [null, null];
  return [
    parseInt(matches[1].replace(/,/g, ''), 10) || null,
    parseInt(matches[2].replace(/,/g, ''), 10) || null,
  ];
}

async function saveQuoteSubmission(input) {
  const client = getClient();
  if (!client) {
    const err = new Error('Supabase is not configured');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const [costMin, costMax] = parseCostRange(input.estimatedCost);

  const row = {
    project_type:           input.projectType || null,
    borough:                input.borough || null,
    square_footage:         input.squareFootage || null,
    budget_range:           input.budgetRange || null,
    timeline:               input.timeline || null,
    description:            input.description || null,
    clarifications:         input.clarifications || null,
    ai_analysis:            input.aiAnalysis || null,
    estimated_cost_min:     costMin,
    estimated_cost_max:     costMax,
    recommended_materials:  input.recommendedMaterials || null,
    recommended_tools:      input.recommendedTools || null,
    contact_name:           input.contactName || null,
    contact_email:          input.contactEmail || null,
    contact_phone:          input.contactPhone || null,
    contact_method:         input.contactMethod || null,
    source:                 input.source || null,
    user_agent:             input.userAgent || null,
    referer:                input.referer || null,
    ip_hash:                hashIp(input.ip),
  };

  const { data, error } = await client
    .from('quote_submissions')
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

async function listQuoteSubmissions({ limit = 50, status } = {}) {
  const client = getClient();
  if (!client) {
    const err = new Error('Supabase is not configured');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  let q = client
    .from('quote_submissions')
    .select('id, created_at, project_type, borough, budget_range, estimated_cost_min, estimated_cost_max, contact_name, contact_email, contact_phone, status, source')
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(+limit || 50, 1), 200));
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) {
    const err = new Error(`Supabase list failed: ${error.message}`);
    err.detail = error.details || error.hint || '';
    throw err;
  }
  return data || [];
}

async function updateQuoteStatus({ id, status, notes }) {
  const client = getClient();
  if (!client) {
    const err = new Error('Supabase is not configured');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  const patch = {};
  if (status) patch.status = status;
  if (notes != null) patch.notes = notes;
  if (!Object.keys(patch).length) return null;
  const { data, error } = await client
    .from('quote_submissions')
    .update(patch)
    .eq('id', id)
    .select('id, status, notes')
    .single();
  if (error) throw new Error(`Supabase update failed: ${error.message}`);
  return data;
}

module.exports = { saveQuoteSubmission, listQuoteSubmissions, updateQuoteStatus };
