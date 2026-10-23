// Runs the floor finder (floor.js) off the page's main thread, so looking
// around stays smooth while it works. Messages:
//   { type: 'image', ver, width, height, data }   the small panorama
//   { type: 'find', id, ver, layout, surf, taps, notTaps }  -> { id, result } or { id, error }

import { findFloor } from './floor.js';

let img = null, ver = -1;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'image') {
    img = { width: m.width, height: m.height, data: m.data };
    ver = m.ver;
    return;
  }
  if (m.type !== 'find') return;
  try {
    if (!img || m.ver !== ver) { self.postMessage({ id: m.id, error: 'stale image' }); return; }
    const r = findFloor(img, m.layout, { surf: m.surf, taps: m.taps || [], notTaps: m.notTaps || [] });
    if (!r) { self.postMessage({ id: m.id, result: null }); return; }
    self.postMessage({ id: m.id, result: { cov: r.cov, mean: r.mean, seeds: r.seeds, ms: r.ms } }, [r.cov.buffer]);
  } catch (err) {
    self.postMessage({ id: m.id, error: String((err && err.message) || err) });
  }
};
