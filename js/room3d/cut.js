// Two tools for splitting a photo into "this" and "not this" (used for the
// floor): colour models (Gaussian mixtures in Lab) and a minimum cut on a
// pixel grid (Boykov-Kolmogorov max flow, each pixel with up to 8 neighbours).
// Plain typed arrays, no DOM, so the Node tests run the same code.

/* ---------- max flow / min cut ------------------------------------------------ */

const NONE = -1, TERMINAL = -2, ORPHAN = -3;
const INF_D = 1 << 30;

// Nodes 0..n-1. Arc a = i * 8 + d goes from node i to head[a] in direction d
// (0..7); direction 7 - d is the opposite one, so the reverse arc of a is
// head[a] * 8 + 7 - d. Capacities are integers (exact zero tests).
export class MaxFlow {
  // head / cap: optional arcs built beforehand (cap is changed by maxflow)
  constructor(n, head = null, cap = null) {
    this.n = n;
    this.head = head || new Int32Array(n * 8).fill(-1);
    this.cap = cap || new Int32Array(n * 8);
    this.tr = new Int32Array(n);      // > 0: from the source, < 0: to the sink
    this.flow = 0;
    this.parent = null;
    this.tree = null;
  }

  // both arcs between i and j (j is i's neighbour in direction d)
  edge(i, d, j, cij, cji) {
    const a = i * 8 + d, b = j * 8 + 7 - d;
    this.head[a] = j; this.cap[a] = cij;
    this.head[b] = i; this.cap[b] = cji;
  }

  // add capacities from the source (cs: cost of putting i on the sink side)
  // and to the sink (ct: cost of putting i on the source side)
  tweights(i, cs, ct) {
    const old = this.tr[i];
    if (old > 0) cs += old; else ct -= old;
    this.flow += Math.min(cs, ct);
    this.tr[i] = cs - ct;
  }

  maxflow() {
    const { n, head, cap, tr } = this;
    const parent = this.parent = new Int32Array(n);
    const tree = this.tree = new Uint8Array(n);       // 1 source tree, 2 sink tree
    const ts = new Int32Array(n), dist = new Int32Array(n);
    const QN = n + 1;
    const q = new Int32Array(QN), inQ = new Uint8Array(n);
    let qh = 0, qt = 0;
    const oq = new Int32Array(QN);
    let oh = 0, ot = 0;
    const setActive = (i) => { if (!inQ[i]) { inQ[i] = 1; q[qt] = i; qt = qt + 1 === QN ? 0 : qt + 1; } };
    const setOrphan = (i) => { parent[i] = ORPHAN; oq[ot] = i; ot = ot + 1 === QN ? 0 : ot + 1; };

    for (let i = 0; i < n; i++) {
      if (tr[i] > 0) { tree[i] = 1; parent[i] = TERMINAL; dist[i] = 1; setActive(i); }
      else if (tr[i] < 0) { tree[i] = 2; parent[i] = TERMINAL; dist[i] = 1; setActive(i); }
      else parent[i] = NONE;
    }

    let TIME = 0, cur = -1;
    for (;;) {
      let i = cur;
      if (i >= 0) { inQ[i] = 0; if (parent[i] === NONE) i = -1; }
      if (i < 0) {
        i = -1;
        while (qh !== qt) {
          const k = q[qh]; qh = qh + 1 === QN ? 0 : qh + 1; inQ[k] = 0;
          if (parent[k] !== NONE) { i = k; break; }
        }
        if (i < 0) break;
      }

      // grow the tree i belongs to
      let found = -1;                       // arc from a source-tree node to a sink-tree node
      const base = i * 8;
      if (tree[i] === 1) {
        for (let d = 0; d < 8; d++) {
          const a = base + d;
          if (cap[a] <= 0) continue;
          const j = head[a];
          if (parent[j] === NONE) {
            tree[j] = 1; parent[j] = j * 8 + 7 - d; ts[j] = ts[i]; dist[j] = dist[i] + 1; setActive(j);
          } else if (tree[j] === 2) { found = a; break; }
          else if (ts[j] <= ts[i] && dist[j] > dist[i]) {
            parent[j] = j * 8 + 7 - d; ts[j] = ts[i]; dist[j] = dist[i] + 1;
          }
        }
      } else {
        for (let d = 0; d < 8; d++) {
          const j = head[base + d];
          if (j < 0) continue;
          const sis = j * 8 + 7 - d;
          if (cap[sis] <= 0) continue;
          if (parent[j] === NONE) {
            tree[j] = 2; parent[j] = sis; ts[j] = ts[i]; dist[j] = dist[i] + 1; setActive(j);
          } else if (tree[j] === 1) { found = sis; break; }
          else if (ts[j] <= ts[i] && dist[j] > dist[i]) {
            parent[j] = sis; ts[j] = ts[i]; dist[j] = dist[i] + 1;
          }
        }
      }
      TIME++;
      if (found < 0) { cur = -1; continue; }
      inQ[i] = 1; cur = i;                  // keep working on i after this path

      // augment along source -> s -> t -> sink
      const s = (found / 8) | 0, t = head[found];
      let bott = cap[found];
      let k = s;
      while (parent[k] !== TERMINAL) {
        const pa = parent[k], sis = head[pa] * 8 + 7 - (pa & 7);
        if (cap[sis] < bott) bott = cap[sis];
        k = head[pa];
      }
      if (tr[k] < bott) bott = tr[k];
      k = t;
      while (parent[k] !== TERMINAL) {
        const pa = parent[k];
        if (cap[pa] < bott) bott = cap[pa];
        k = head[pa];
      }
      if (-tr[k] < bott) bott = -tr[k];

      cap[head[found] * 8 + 7 - (found & 7)] += bott;
      cap[found] -= bott;
      k = s;
      for (;;) {
        const pa = parent[k];
        if (pa === TERMINAL) break;
        const sis = head[pa] * 8 + 7 - (pa & 7);
        cap[pa] += bott; cap[sis] -= bott;
        if (cap[sis] === 0) setOrphan(k);
        k = head[pa];
      }
      tr[k] -= bott;
      if (tr[k] === 0) setOrphan(k);
      k = t;
      for (;;) {
        const pa = parent[k];
        if (pa === TERMINAL) break;
        const sis = head[pa] * 8 + 7 - (pa & 7);
        cap[sis] += bott; cap[pa] -= bott;
        if (cap[pa] === 0) setOrphan(k);
        k = head[pa];
      }
      tr[k] += bott;
      if (tr[k] === 0) setOrphan(k);
      this.flow += bott;

      // adopt the orphans (or free them)
      while (oh !== ot) {
        const o = oq[oh]; oh = oh + 1 === QN ? 0 : oh + 1;
        const src = tree[o] === 1;
        const ob = o * 8;
        let aMin = -1, dMin = INF_D;
        for (let d = 0; d < 8; d++) {
          const a0 = ob + d, j = head[a0];
          if (j < 0) continue;
          // a parent must reach o through an arc with capacity left
          if (src ? cap[j * 8 + 7 - d] <= 0 : cap[a0] <= 0) continue;
          if (tree[j] !== tree[o] || parent[j] === NONE) continue;
          let dd = 0, m = j;
          for (;;) {
            if (ts[m] === TIME) { dd += dist[m]; break; }
            const a = parent[m];
            dd++;
            if (a === TERMINAL) { ts[m] = TIME; dist[m] = 1; break; }
            if (a === ORPHAN) { dd = INF_D; break; }
            m = head[a];
          }
          if (dd < INF_D) {
            if (dd < dMin) { aMin = a0; dMin = dd; }
            for (m = j; ts[m] !== TIME; m = head[parent[m]]) { ts[m] = TIME; dist[m] = dd--; }
          }
        }
        if (aMin >= 0) { parent[o] = aMin; ts[o] = TIME; dist[o] = dMin + 1; continue; }
        for (let d = 0; d < 8; d++) {
          const a0 = ob + d, j = head[a0];
          if (j < 0 || tree[j] !== tree[o] || parent[j] === NONE) continue;
          if (src ? cap[j * 8 + 7 - d] > 0 : cap[a0] > 0) setActive(j);
          const a = parent[j];
          if (a !== TERMINAL && a !== ORPHAN && head[a] === o) setOrphan(j);
        }
        parent[o] = NONE; tree[o] = 0;
      }
    }
    return this.flow;
  }

  // after maxflow(): is node i on the source side?
  isSource(i) { return this.parent[i] !== NONE && this.tree[i] === 1; }
}

/* ---------- colour models ------------------------------------------------------ */

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Gaussian mixture with K components in D dimensions (D <= 6), fitted to the
// m points in X (D numbers per point): k-means++ start, then EM. reg is added
// to each variance (no component gets narrower than sqrt(reg)).
export function fitGMM(X, m, K = 5, { D = 3, iters = 8, reg = 4, seed = 7 } = {}) {
  K = Math.max(1, Math.min(K, m));
  const rand = rng(seed);
  const mu = new Float64Array(K * D);
  const dist2 = (i, k) => {
    let v = 0;
    for (let t = 0; t < D; t++) { const e = X[i * D + t] - mu[k * D + t]; v += e * e; }
    return v;
  };
  // k-means++
  const d2 = new Float64Array(m).fill(Infinity);
  let c = Math.floor(rand() * m);
  for (let k = 0; k < K; k++) {
    for (let t = 0; t < D; t++) mu[k * D + t] = X[c * D + t];
    let tot = 0;
    for (let i = 0; i < m; i++) { const v = dist2(i, k); if (v < d2[i]) d2[i] = v; tot += d2[i]; }
    let r = rand() * tot;
    c = m - 1;
    for (let i = 0; i < m; i++) { r -= d2[i]; if (r <= 0) { c = i; break; } }
  }
  // a few k-means steps
  const lab = new Int32Array(m);
  for (let it = 0; it < 4; it++) {
    for (let i = 0; i < m; i++) {
      let best = 0, bd = Infinity;
      for (let k = 0; k < K; k++) { const v = dist2(i, k); if (v < bd) { bd = v; best = k; } }
      lab[i] = best;
    }
    const sum = new Float64Array(K * D), cnt = new Float64Array(K);
    for (let i = 0; i < m; i++) { const k = lab[i]; cnt[k]++; for (let t = 0; t < D; t++) sum[k * D + t] += X[i * D + t]; }
    for (let k = 0; k < K; k++) if (cnt[k]) for (let t = 0; t < D; t++) mu[k * D + t] = sum[k * D + t] / cnt[k];
  }
  // EM, starting from the hard assignments
  const R = new Float64Array(m * K);
  for (let i = 0; i < m; i++) R[i * K + lab[i]] = 1;
  const g = { K, D, w: new Float64Array(K), mu, icov: new Float64Array(K * D * D), lnorm: new Float64Array(K) };
  const tmp = new Float64Array(K), S = new Float64Array(D * D), Lc = new Float64Array(D * D), Li = new Float64Array(D * D);
  const LOG2PI = Math.log(2 * Math.PI);
  for (let it = 0; it <= iters; it++) {
    // M step
    for (let k = 0; k < K; k++) {
      let nk = 0;
      const mean = new Float64Array(D);
      for (let i = 0; i < m; i++) {
        const r = R[i * K + k];
        if (!r) continue;
        nk += r;
        for (let t = 0; t < D; t++) mean[t] += r * X[i * D + t];
      }
      if (nk < 1e-6) { g.w[k] = 0; g.lnorm[k] = -Infinity; continue; }
      for (let t = 0; t < D; t++) mean[t] /= nk;
      S.fill(0);
      for (let i = 0; i < m; i++) {
        const r = R[i * K + k];
        if (!r) continue;
        for (let a = 0; a < D; a++) {
          const da = X[i * D + a] - mean[a];
          for (let b = 0; b <= a; b++) S[a * D + b] += r * da * (X[i * D + b] - mean[b]);
        }
      }
      for (let a = 0; a < D; a++) {
        for (let b = 0; b <= a; b++) { S[a * D + b] /= nk; S[b * D + a] = S[a * D + b]; }
        S[a * D + a] += reg;
      }
      // Cholesky S = L L^T, then S^-1 = L^-T L^-1 and log|S| = 2 sum log L_ii
      Lc.fill(0);
      let logdet = 0;
      for (let a = 0; a < D; a++) {
        for (let b = 0; b <= a; b++) {
          let v = S[a * D + b];
          for (let t = 0; t < b; t++) v -= Lc[a * D + t] * Lc[b * D + t];
          if (a === b) { v = Math.sqrt(Math.max(v, 1e-9)); Lc[a * D + a] = v; logdet += 2 * Math.log(v); }
          else Lc[a * D + b] = v / Lc[b * D + b];
        }
      }
      Li.fill(0);
      for (let a = 0; a < D; a++) {
        Li[a * D + a] = 1 / Lc[a * D + a];
        for (let b = 0; b < a; b++) {
          let v = 0;
          for (let t = b; t < a; t++) v -= Lc[a * D + t] * Li[t * D + b];
          Li[a * D + b] = v / Lc[a * D + a];
        }
      }
      const o = k * D * D;
      for (let a = 0; a < D; a++) {
        for (let b = 0; b < D; b++) {
          let v = 0;
          for (let t = Math.max(a, b); t < D; t++) v += Li[t * D + a] * Li[t * D + b];
          g.icov[o + a * D + b] = v;
        }
      }
      for (let t = 0; t < D; t++) mu[k * D + t] = mean[t];
      g.w[k] = nk / m;
      g.lnorm[k] = Math.log(g.w[k]) - 0.5 * (D * LOG2PI + logdet);
    }
    if (it === iters) break;
    // E step
    for (let i = 0; i < m; i++) {
      let mx = -Infinity;
      for (let k = 0; k < K; k++) { tmp[k] = compLL(g, k, X, i * D); if (tmp[k] > mx) mx = tmp[k]; }
      let s = 0;
      for (let k = 0; k < K; k++) { tmp[k] = Math.exp(tmp[k] - mx); s += tmp[k]; }
      for (let k = 0; k < K; k++) R[i * K + k] = tmp[k] / s;
    }
  }
  return g;
}

function compLL(g, k, x, o) {
  if (g.lnorm[k] === -Infinity) return -Infinity;
  const D = g.D, ic = g.icov, c = k * D * D, mo = k * D;
  let q = 0;
  for (let a = 0; a < D; a++) {
    const da = x[o + a] - g.mu[mo + a];
    let row = 0;
    for (let b = 0; b < D; b++) row += ic[c + a * D + b] * (x[o + b] - g.mu[mo + b]);
    q += da * row;
  }
  return g.lnorm[k] - 0.5 * q;
}

// log-likelihood of the point x[o .. o + D - 1] under the mixture
export function gmmLL(g, x, o = 0) {
  if (g.D === 4) return gmmLL4(g, x, o);
  let mx = -Infinity;
  const K = g.K;
  const v = gmmLL.tmp && gmmLL.tmp.length >= K ? gmmLL.tmp : (gmmLL.tmp = new Float64Array(Math.max(K, 16)));
  for (let k = 0; k < K; k++) { v[k] = compLL(g, k, x, o); if (v[k] > mx) mx = v[k]; }
  if (mx === -Infinity) return -1e3;
  let s = 0;
  for (let k = 0; k < K; k++) s += Math.exp(v[k] - mx);
  return mx + Math.log(s);
}

// the same for D = 4, unrolled (the floor finder calls this a few million times)
const TMP4 = new Float64Array(64);
function gmmLL4(g, x, o) {
  const K = g.K, mu = g.mu, ic = g.icov, ln = g.lnorm;
  const x0 = x[o], x1 = x[o + 1], x2 = x[o + 2], x3 = x[o + 3];
  let mx = -Infinity;
  for (let k = 0; k < K; k++) {
    if (ln[k] === -Infinity) { TMP4[k] = -Infinity; continue; }
    const m = k * 4, c = k * 16;
    const d0 = x0 - mu[m], d1 = x1 - mu[m + 1], d2 = x2 - mu[m + 2], d3 = x3 - mu[m + 3];
    const q = d0 * (ic[c] * d0 + 2 * (ic[c + 1] * d1 + ic[c + 2] * d2 + ic[c + 3] * d3)) +
      d1 * (ic[c + 5] * d1 + 2 * (ic[c + 6] * d2 + ic[c + 7] * d3)) +
      d2 * (ic[c + 10] * d2 + 2 * ic[c + 11] * d3) +
      d3 * ic[c + 15] * d3;
    const v = ln[k] - 0.5 * q;
    TMP4[k] = v;
    if (v > mx) mx = v;
  }
  if (mx === -Infinity) return -1e3;
  let s = 0;
  for (let k = 0; k < K; k++) s += Math.exp(TMP4[k] - mx);
  return mx + Math.log(s);
}
