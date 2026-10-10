// Temporary: reports whether the main API function (api/index.js) can load in
// production, and (with ?leads=1) runs one live permit-leads analysis and
// returns only aggregate counts. Returns no secrets. Remove once verified.
module.exports = async (req, res) => {
  const out = {
    node: process.version,
    aiKeyConfigured: !!(process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY),
  };
  const realExit = process.exit;
  process.exit = (code) => { throw new Error(`process.exit(${code}) called while loading`); };
  try {
    require('./index.js');
    out.indexLoads = true;
  } catch (e) {
    out.indexLoads = false;
    out.error = String((e && (e.stack || e.message)) || e).split('\n').slice(0, 8).join('\n');
  } finally {
    process.exit = realExit;
  }
  if (/leads=1/.test(req.url || '')) {
    const t0 = Date.now();
    try {
      const { getPermitLeads } = require('./permit-leads');
      const d = await getPermitLeads({ days: '90', segment: 'office', refresh: '1' });
      out.leads = {
        ms: Date.now() - t0,
        summary: d.summary,
        truncated: d.meta.truncated,
        weeks: d.weekly.length,
        lists: { owners: d.owners.length, designers: d.designers.length, contractors: d.contractors.length, leads: d.leads.length },
        topStage: d.leads[0] && d.leads[0].stage,
      };
    } catch (e) {
      out.leads = { ms: Date.now() - t0, error: e.message, upstreamStatus: e.upstreamStatus || null, detail: (e.detail || '').slice(0, 300) };
    }
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(out));
};
