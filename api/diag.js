// Temporary: reports whether the main API function (api/index.js) can load in
// production, and why not. Returns no secrets. Remove once diagnosed.
module.exports = (req, res) => {
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
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(out));
};
