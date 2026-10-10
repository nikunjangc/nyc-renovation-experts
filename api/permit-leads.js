// Permit leads — turns NYC Department of Buildings (DOB NOW) filings into
// renovation leads and market analytics for the admin panel.
//
// Two public NYC Open Data datasets (no key needed; SOCRATA_APP_TOKEN raises
// the rate limit):
//   * DOB NOW: Build – Job Application Filings (w9ak-ipjd)
//       every job an architect/engineer files: owner, design professional,
//       expediter, declared cost, status, and first_permit_date (null = no
//       work permit pulled yet, i.e. a contractor may not be locked in).
//   * DOB NOW: Build – Approved Permits (rbx6-tga4)
//       work permits actually issued: the permittee is the contractor (GC).
//
// We keep only initial filings (job number ending "-I1") for alteration jobs
// that include general-construction work, then narrow by market segment using
// keywords in the job description.

const fetch = require('node-fetch');

const SODA_BASE = 'https://data.cityofnewyork.us/resource';
const DATASETS = {
  filings: { id: 'w9ak-ipjd', name: 'DOB NOW: Build – Job Application Filings' },
  permits: { id: 'rbx6-tga4', name: 'DOB NOW: Build – Approved Permits' },
};

const BOROUGHS = ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island'];
const DAY_OPTIONS = [30, 60, 90, 180];
const DEFAULT_DAYS = 90;
const PAGE_SIZE = 10000;        // rows per Socrata request
const MAX_ROWS = 20000;         // per dataset per analysis (newest first)
const MAX_LEADS = 1000;         // open projects returned to the browser
const CACHE_TTL_MS = 20 * 60 * 1000;
const DAY_MS = 86400000;

const OFFICE_WORDS = ['OFFICE', 'WORKSPACE', 'WORKPLACE', 'COWORKING', 'CO-WORKING', 'CORPORATE'];
const SEGMENTS = {
  office: {
    label: 'Office & workplace',
    keywords: OFFICE_WORDS,
  },
  // A keyword with a leading space must start a word (" STORE" skips "RESTORE",
  // " DENTAL" skips "INCIDENTAL"); it also matches at the very start of the text.
  commercial: {
    label: 'All commercial (office, retail, restaurant, medical)',
    // Plain "TENANT" is avoided: residential filings constantly mention "tenant protection plan".
    keywords: OFFICE_WORDS.concat([
      'RETAIL', ' STORE', 'STOREFRONT', 'RESTAURANT', 'EATING AND DRINKING', 'CAFE', 'SALON',
      ' GYM', 'FITNESS', 'SHOWROOM', 'MEDICAL', 'CLINIC', ' DENTAL', ' BANK', 'TENANT FIT',
      'TENANT IMPROVEMENT', 'TENANT SPACE', 'FIT-OUT', 'FIT OUT', 'FITOUT', 'COMMERCIAL', 'LOBBY',
    ]),
  },
  residential: {
    label: 'Apartments & homes',
    keywords: [
      'APARTMENT', ' APT ', ' APT.', ' APTS', 'KITCHEN', 'BATHROOM', 'CONDO', 'CO-OP',
      'DUPLEX', 'DWELLING', 'RESIDEN', 'COMBIN',
    ],
    ownerTypes: ['Condo Unit Owner or Co-Op Tenant-shareholder'],
  },
  all: {
    label: 'All renovation work',
    keywords: [],
  },
};
const DEFAULT_SEGMENT = 'office';

const JOB_TYPES = ['Alteration', 'Alteration CO', 'ALT-CO - New Building with Existing Elements to Remain'];

const PUBLIC_OWNER_TYPES = new Set([
  'School Construction Authority',
  'NYCHA/HHC Owned and Operated',
  'NYC Agency',
  'Other Government Owned and Operated',
]);
const BUSINESS_OWNER_TYPES = new Set([
  'Corporation',
  'Partnership',
  'Non-Profit Organization Owned and Operated',
]);

const FILING_FIELDS = [
  'job_filing_number', 'filing_status', 'house_no', 'street_name', 'borough', 'bin', 'bbl',
  'commmunity_board', 'nta', 'postcode', 'latitude', 'longitude', 'work_on_floor', 'apt_condo_no_s',
  'job_type', 'building_type', 'existing_dwelling_units', 'proposed_dwelling_units', 'initial_cost',
  'total_construction_floor_area', 'filing_date', 'current_status_date', 'approved_date',
  'first_permit_date', 'signoff_date', 'job_description', 'owner_s_business_name',
  'owner_first_name', 'owner_last_name', 'owner_type', 'applicant_professional_title',
  'applicant_license', 'applicant_first_name', 'applicant_last_name', 'applicant_business_name',
  'applicant_street_name', 'city', 'state', 'zip', 'filing_representative_first_name',
  'filing_representative_last_name', 'filing_representative_business_name', 'filing_review_type',
];

const PERMIT_FIELDS = [
  'job_filing_number', 'work_permit', 'filing_reason', 'house_no', 'street_name', 'borough', 'bin',
  'bbl', 'nta', 'zip_code', 'work_on_floor', 'work_type', 'permittee_s_license_type',
  'applicant_license', 'applicant_first_name', 'applicant_last_name', 'applicant_business_name',
  'applicant_business_address', 'issued_date', 'expired_date', 'job_description',
  'estimated_job_costs', 'owner_business_name', 'owner_name', 'owner_street_address', 'owner_city',
  'owner_state', 'owner_zip_code', 'permit_status',
];

// ---------- options & query building ----------

function parseOptions(query = {}) {
  const daysNum = parseInt(query.days, 10);
  const days = DAY_OPTIONS.includes(daysNum) ? daysNum : DEFAULT_DAYS;
  const segment = Object.prototype.hasOwnProperty.call(SEGMENTS, query.segment) ? query.segment : DEFAULT_SEGMENT;
  const boroughIn = String(query.borough || '').trim().toLowerCase();
  const borough = BOROUGHS.find((b) => b.toLowerCase() === boroughIn) || '';
  const minCostNum = Number(query.minCost);
  const minCost = Number.isFinite(minCostNum) && minCostNum > 0 ? Math.round(minCostNum) : 0;
  return { days, segment, borough, minCost };
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function sinceDate(days, now = new Date()) {
  return isoDate(new Date(now.getTime() - days * DAY_MS));
}

// Only constants and allow-listed values reach SoQL, but quote defensively anyway.
function soqlString(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function keywordClause(field, keywords) {
  const parts = [];
  for (const k of keywords) {
    parts.push(`upper(${field}) like ${soqlString(`%${k}%`)}`);
    if (k.startsWith(' ')) parts.push(`upper(${field}) like ${soqlString(`${k.trimStart()}%`)}`);
  }
  return parts.join(' OR ');
}

function buildFilingsQuery(opts, now = new Date()) {
  const seg = SEGMENTS[opts.segment];
  const where = [
    `filing_date >= ${soqlString(sinceDate(opts.days, now))}`,
    `job_type in (${JOB_TYPES.map(soqlString).join(', ')})`,
    `job_filing_number like '%-I1'`,
    `upper(general_construction_work_type_) = 'YES'`,
  ];
  if (opts.borough) where.push(`borough = ${soqlString(opts.borough)}`);
  const segParts = [];
  if (seg.keywords.length) segParts.push(keywordClause('job_description', seg.keywords));
  if (seg.ownerTypes && seg.ownerTypes.length) {
    segParts.push(`owner_type in (${seg.ownerTypes.map(soqlString).join(', ')})`);
  }
  if (segParts.length) where.push(`(${segParts.join(' OR ')})`);
  return new URLSearchParams({
    $select: FILING_FIELDS.join(','),
    $where: where.join(' AND '),
    $order: 'filing_date DESC, job_filing_number', // unique tiebreak keeps paging stable
    $limit: String(PAGE_SIZE),
  });
}

function buildPermitsQuery(opts, now = new Date()) {
  const seg = SEGMENTS[opts.segment];
  const where = [
    `issued_date >= ${soqlString(sinceDate(opts.days, now))}`,
    `work_type = 'General Construction'`,
    `filing_reason = 'Initial Permit'`,
  ];
  if (opts.borough) where.push(`borough = ${soqlString(opts.borough)}`);
  if (seg.keywords.length) where.push(`(${keywordClause('job_description', seg.keywords)})`);
  return new URLSearchParams({
    $select: PERMIT_FIELDS.join(','),
    $where: where.join(' AND '),
    $order: 'issued_date DESC, job_filing_number, work_permit',
    $limit: String(PAGE_SIZE),
  });
}

async function sodaGet(datasetId, params, { fetchImpl = fetch, token, timeoutMs = 25000 } = {}) {
  // Keep "$" (SoQL parameter prefix) and commas literal — both are legal in a
  // query string and it keeps the URL short and readable in logs.
  const qs = params.toString().replace(/%24/g, '$').replace(/%2C/gi, ',');
  const url = `${SODA_BASE}/${datasetId}.json?${qs}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { Accept: 'application/json' };
    if (token) headers['X-App-Token'] = token;
    const res = await fetchImpl(url, { headers, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`NYC Open Data (${datasetId}) returned HTTP ${res.status}`);
      err.upstreamStatus = res.status;
      err.detail = text.slice(0, 300);
      throw err;
    }
    const data = await res.json();
    if (!Array.isArray(data)) {
      const err = new Error(`NYC Open Data (${datasetId}) returned an unexpected response`);
      err.upstreamStatus = 502;
      throw err;
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error(`NYC Open Data (${datasetId}) took too long to answer`);
      err.upstreamStatus = 504;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Pages through a query (newest first) until the data runs out or MAX_ROWS.
async function sodaGetAll(datasetId, params, fetchOpts) {
  const rows = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    const page = new URLSearchParams(params);
    page.set('$limit', String(Math.min(PAGE_SIZE, MAX_ROWS - offset)));
    if (offset) page.set('$offset', String(offset));
    const batch = await sodaGet(datasetId, page, fetchOpts);
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return rows;
}

// ---------- normalization ----------

// Socrata "floating" timestamps carry no zone; read them as UTC so results
// don't shift with the server's timezone.
function parseDate(s) {
  if (!s) return null;
  const str = String(s);
  const withZone = /^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(str) ? `${str}Z` : str;
  const d = new Date(withZone);
  return Number.isNaN(d.getTime()) ? null : d;
}

function squish(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

const PLACEHOLDER_NAMES = /^(pr|n\/?a|na|none|not applicable|null|unknown|tbd|owner|-+|\.+|0+)$/i;
function cleanName(s) {
  const v = squish(s);
  return PLACEHOLDER_NAMES.test(v) ? '' : v;
}

function personName(first, last) {
  return cleanName(`${squish(first)} ${squish(last)}`);
}

function titleCase(s) {
  return squish(s)
    .toLowerCase()
    .replace(/(^|[\s\-/(])([a-z])/g, (m, p, c) => p + c.toUpperCase());
}

// Grouping key: case/punctuation-insensitive, ignores trailing entity suffixes
// so "RFR REALTY, LLC" and "RFR Realty LLC" land together.
const SUFFIXES = /\b(L\s?L\s?C|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LP|LLP|LTD|P\s?C|D\s?P\s?C|PLLC)\b\.?$/;
function nameKey(s) {
  let k = squish(s).toUpperCase().replace(/[.,'"’]/g, '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 2; i++) k = k.replace(SUFFIXES, '').trim();
  return k;
}

function toNumber(v) {
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function formatFloor(s) {
  const v = squish(s);
  if (!v) return '';
  const m = v.match(/floor number\(s\)\s*0*(\d+)\s*through\s*0*(\d+)/i);
  if (m) {
    const [lo, hi] = [Number(m[1]), Number(m[2])].sort((a, b) => a - b);
    return lo === hi ? `Floor ${lo}` : `Floors ${lo}–${hi}`;
  }
  return v.length > 40 ? `${v.slice(0, 40)}…` : v;
}

function jobBase(jobNumber) {
  return squish(jobNumber).split('-')[0];
}

function normalizeFiling(r) {
  const ownerBusiness = cleanName(r.owner_s_business_name);
  const ownerPerson = personName(r.owner_first_name, r.owner_last_name);
  const designerFirm = cleanName(r.applicant_business_name);
  const designerName = personName(r.applicant_first_name, r.applicant_last_name);
  const designerCityLine = squish([squish(r.city), squish(r.state)].filter(Boolean).join(', ') + ' ' + squish(r.zip));
  return {
    jobNumber: squish(r.job_filing_number),
    jobBase: jobBase(r.job_filing_number),
    status: squish(r.filing_status),
    address: titleCase(`${squish(r.house_no)} ${squish(r.street_name)}`),
    borough: squish(r.borough),
    nta: squish(r.nta),
    zip: squish(r.postcode),
    floor: formatFloor(r.work_on_floor),
    apt: squish(r.apt_condo_no_s),
    jobType: squish(r.job_type),
    buildingType: squish(r.building_type),
    cost: toNumber(r.initial_cost),
    floorArea: toNumber(r.total_construction_floor_area) || null,
    filedAt: parseDate(r.filing_date),
    approvedAt: parseDate(r.approved_date),
    firstPermitAt: parseDate(r.first_permit_date),
    description: squish(r.job_description),
    ownerBusiness,
    ownerPerson,
    ownerType: squish(r.owner_type),
    designerFirm,
    designerName,
    designerTitle: squish(r.applicant_professional_title),
    designerLicense: squish(r.applicant_license),
    designerAddress: squish(`${squish(r.applicant_street_name)}${designerCityLine ? `, ${designerCityLine}` : ''}`),
    expediterFirm: cleanName(r.filing_representative_business_name),
    expediterName: personName(r.filing_representative_first_name, r.filing_representative_last_name),
    reviewType: squish(r.filing_review_type),
    bin: squish(r.bin),
    bbl: squish(r.bbl),
    lat: r.latitude != null && r.latitude !== '' ? Number(r.latitude) : null,
    lng: r.longitude != null && r.longitude !== '' ? Number(r.longitude) : null,
  };
}

function normalizePermit(r) {
  const ownerCityLine = squish([squish(r.owner_city), squish(r.owner_state)].filter(Boolean).join(', ') + ' ' + squish(r.owner_zip_code));
  return {
    jobNumber: squish(r.job_filing_number),
    jobBase: jobBase(r.job_filing_number),
    workPermit: squish(r.work_permit),
    address: titleCase(`${squish(r.house_no)} ${squish(r.street_name)}`),
    borough: squish(r.borough),
    nta: squish(r.nta),
    floor: formatFloor(r.work_on_floor),
    issuedAt: parseDate(r.issued_date),
    cost: toNumber(r.estimated_job_costs),
    description: squish(r.job_description),
    contractorFirm: cleanName(r.applicant_business_name),
    contractorName: personName(r.applicant_first_name, r.applicant_last_name),
    contractorLicense: squish(r.applicant_license),
    contractorLicenseType: squish(r.permittee_s_license_type),
    contractorAddress: squish(r.applicant_business_address),
    ownerBusiness: cleanName(r.owner_business_name),
    ownerPerson: cleanName(r.owner_name),
    ownerAddress: squish(`${squish(r.owner_street_address)}${ownerCityLine ? `, ${ownerCityLine}` : ''}`),
    permitStatus: squish(r.permit_status),
    bin: squish(r.bin),
    bbl: squish(r.bbl),
  };
}

// ---------- classification & scoring ----------

const STAGE_LABELS = {
  approved: 'Approved – no permit yet',
  review: 'In plan review',
  objections: 'Objections to clear',
  permitted: 'Permit issued',
  closed: 'Closed / withdrawn',
};

function classifyStage(f) {
  const s = (f.status || '').toLowerCase();
  if (f.firstPermitAt || /^permit\b/.test(s)) return 'permitted';
  if (/withdrawn|disapproved|denied|loc issued|certificate of operation|co issued|signed-off|sign-off/.test(s)) return 'closed';
  if (s === 'approved' || s === 'paa approved') return 'approved';
  if (s.includes('objection')) return 'objections';
  return 'review'; // plan examiner review, pending assignment, QA, incomplete, on hold…
}

function compactMoney(n) {
  if (!n) return '$0';
  if (n >= 1e6) return `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

function scoreLead(f, stage, now = new Date()) {
  const reasons = [];
  let score = { approved: 50, review: 35, objections: 25 }[stage] || 0;
  if (stage === 'approved') reasons.push('Approved, no permit pulled yet');
  else if (stage === 'review') reasons.push('Still in plan review');
  else if (stage === 'objections') reasons.push('Has objections to clear');

  if (f.cost > 0) {
    const pts = Math.max(0, Math.min(30, Math.round(10 * Math.log10(f.cost / 10000))));
    score += pts;
    reasons.push(`${compactMoney(f.cost)} declared`);
  } else {
    reasons.push('No cost declared');
  }

  if (f.filedAt) {
    const days = Math.max(0, Math.floor((now.getTime() - f.filedAt.getTime()) / DAY_MS));
    if (days <= 7) score += 15;
    else if (days <= 14) score += 12;
    else if (days <= 30) score += 8;
    else if (days <= 60) score += 4;
    reasons.push(days === 0 ? 'Filed today' : `Filed ${days} day${days === 1 ? '' : 's'} ago`);
  }

  if (PUBLIC_OWNER_TYPES.has(f.ownerType)) {
    score -= 15;
    reasons.push('Public owner – awarded through public bidding');
  } else if (BUSINESS_OWNER_TYPES.has(f.ownerType)) {
    score += 5;
    reasons.push('Business owner – repeat work potential');
  }
  return { score: Math.max(0, Math.min(100, score)), reasons };
}

// ---------- aggregation ----------

function median(values) {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function mondayOf(d) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (x.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(x.getTime() - dow * DAY_MS);
}

// Tracks the most common original spelling for a grouped name.
function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}
function topSpelling(map) {
  let best = '';
  let n = -1;
  for (const [k, v] of map) if (v > n) { best = k; n = v; }
  return best;
}

function groupBy(items, keyFn, init, add) {
  const groups = new Map();
  for (const it of items) {
    const key = keyFn(it);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, init(it));
    add(groups.get(key), it);
  }
  return [...groups.values()];
}

function byProjectsThenValue(a, b) {
  return (b.projects - a.projects) || (b.value - a.value);
}

const COST_BUCKETS = [
  { label: 'Under $50K', min: 1, max: 50000 },
  { label: '$50K–$250K', min: 50000, max: 250000 },
  { label: '$250K–$1M', min: 250000, max: 1000000 },
  { label: '$1M–$5M', min: 1000000, max: 5000000 },
  { label: '$5M+', min: 5000000, max: Infinity },
];

function analyze(filingRows, permitRows, opts, now = new Date()) {
  const since = sinceDate(opts.days, now);

  // Filings: one row per job (initial filings only, but dedupe defensively).
  const seenJobs = new Set();
  const filings = [];
  for (const row of filingRows) {
    const f = normalizeFiling(row);
    if (!f.jobBase || seenJobs.has(f.jobBase)) continue;
    seenJobs.add(f.jobBase);
    if (opts.minCost && f.cost < opts.minCost) continue;
    f.stage = classifyStage(f);
    filings.push(f);
  }

  // Permits: one row per job (a job can carry several GC permits / sequences).
  const permitsByJob = new Map();
  for (const row of permitRows) {
    const p = normalizePermit(row);
    if (!p.jobBase) continue;
    const prev = permitsByJob.get(p.jobBase);
    if (!prev || p.cost > prev.cost) permitsByJob.set(p.jobBase, p);
  }
  const permits = [...permitsByJob.values()].filter((p) => !opts.minCost || p.cost >= opts.minCost);

  const open = filings.filter((f) => ['approved', 'review', 'objections'].includes(f.stage));
  const countStage = (s) => filings.filter((f) => f.stage === s).length;

  // Weekly series covering the whole window (zero weeks included).
  const weeks = new Map();
  for (let w = mondayOf(new Date(`${since}T00:00:00Z`)); w <= now; w = new Date(w.getTime() + 7 * DAY_MS)) {
    weeks.set(isoDate(w), { week: isoDate(w), projects: 0, value: 0 });
  }
  for (const f of filings) {
    if (!f.filedAt) continue;
    const key = isoDate(mondayOf(f.filedAt));
    if (!weeks.has(key)) weeks.set(key, { week: key, projects: 0, value: 0 });
    const w = weeks.get(key);
    w.projects += 1;
    w.value += f.cost;
  }
  // The first week can start before the window and the current week is still
  // in progress; flag both so the chart doesn't read them as a slowdown. If the
  // row cap cut the query short (newest first), every week up to the oldest row
  // we got is incomplete too.
  const filingsTruncated = filingRows.length >= MAX_ROWS;
  let cutoffWeek = '';
  if (filingsTruncated) {
    const oldest = filingRows.reduce((min, r) => {
      const d = parseDate(r.filing_date);
      return d && (!min || d < min) ? d : min;
    }, null);
    if (oldest) cutoffWeek = isoDate(mondayOf(oldest));
  }
  const weekly = [...weeks.values()]
    .sort((a, b) => a.week.localeCompare(b.week))
    .map((w) => ({
      ...w,
      partial: w.week < since
        || (cutoffWeek !== '' && w.week <= cutoffWeek)
        || new Date(`${w.week}T00:00:00Z`).getTime() + 7 * DAY_MS > now.getTime(),
    }));

  const boroughs = BOROUGHS.map((b) => {
    const inB = filings.filter((f) => f.borough === b);
    return {
      borough: b,
      projects: inB.length,
      open: inB.filter((f) => ['approved', 'review', 'objections'].includes(f.stage)).length,
      value: inB.reduce((s, f) => s + f.cost, 0),
    };
  });

  const costBuckets = COST_BUCKETS.map((bk) => ({
    label: bk.label,
    projects: filings.filter((f) => f.cost >= bk.min && f.cost < bk.max).length,
  }));
  costBuckets.push({ label: 'Not declared', projects: filings.filter((f) => !f.cost).length });

  const isOpen = (f) => ['approved', 'review', 'objections'].includes(f.stage);
  const lastDate = (cur, d) => (d && (!cur || d > cur) ? d : cur);

  const owners = groupBy(
    filings.filter((f) => f.ownerBusiness),
    (f) => nameKey(f.ownerBusiness),
    (f) => ({ spellings: new Map(), type: f.ownerType, projects: 0, open: 0, value: 0, boroughs: new Set(), lastFiled: null, sampleAddress: f.address, contacts: new Set() }),
    (g, f) => {
      bump(g.spellings, f.ownerBusiness);
      g.projects += 1;
      if (isOpen(f)) g.open += 1;
      g.value += f.cost;
      if (f.borough) g.boroughs.add(f.borough);
      g.lastFiled = lastDate(g.lastFiled, f.filedAt);
      if (f.ownerPerson && g.contacts.size < 3) g.contacts.add(titleCase(f.ownerPerson));
    },
  ).map((g) => ({
    name: topSpelling(g.spellings),
    type: g.type,
    isPublic: PUBLIC_OWNER_TYPES.has(g.type),
    projects: g.projects,
    open: g.open,
    value: g.value,
    boroughs: [...g.boroughs],
    lastFiled: g.lastFiled ? isoDate(g.lastFiled) : null,
    sampleAddress: g.sampleAddress,
    contacts: [...g.contacts],
  })).sort(byProjectsThenValue);

  const designers = groupBy(
    filings.filter((f) => f.designerFirm || f.designerName),
    (f) => (f.designerLicense ? `${f.designerTitle}|${f.designerLicense}` : nameKey(f.designerFirm || f.designerName)),
    (f) => ({ firms: new Map(), person: f.designerName, title: f.designerTitle, license: f.designerLicense, address: f.designerAddress, projects: 0, open: 0, value: 0, boroughs: new Set(), lastFiled: null }),
    (g, f) => {
      if (f.designerFirm) bump(g.firms, f.designerFirm);
      g.projects += 1;
      if (isOpen(f)) g.open += 1;
      g.value += f.cost;
      if (f.borough) g.boroughs.add(f.borough);
      g.lastFiled = lastDate(g.lastFiled, f.filedAt);
    },
  ).map((g) => ({
    firm: topSpelling(g.firms) || titleCase(g.person),
    person: g.person ? titleCase(g.person) : '',
    title: g.title,
    license: g.license,
    address: g.address,
    projects: g.projects,
    open: g.open,
    value: g.value,
    boroughs: [...g.boroughs],
    lastFiled: g.lastFiled ? isoDate(g.lastFiled) : null,
  })).sort(byProjectsThenValue);

  const expediters = groupBy(
    filings.filter((f) => f.expediterFirm || f.expediterName),
    (f) => nameKey(f.expediterFirm || f.expediterName),
    (f) => ({ firms: new Map(), people: new Set(), projects: 0, open: 0, value: 0, lastFiled: null }),
    (g, f) => {
      if (f.expediterFirm) bump(g.firms, f.expediterFirm);
      if (f.expediterName && g.people.size < 3) g.people.add(titleCase(f.expediterName));
      g.projects += 1;
      if (isOpen(f)) g.open += 1;
      g.value += f.cost;
      g.lastFiled = lastDate(g.lastFiled, f.filedAt);
    },
  ).map((g) => ({
    firm: topSpelling(g.firms) || [...g.people][0] || '',
    people: [...g.people],
    projects: g.projects,
    open: g.open,
    value: g.value,
    lastFiled: g.lastFiled ? isoDate(g.lastFiled) : null,
  })).sort(byProjectsThenValue);

  const contractors = groupBy(
    permits.filter((p) => p.contractorFirm || p.contractorName),
    (p) => (p.contractorLicense ? `${p.contractorLicenseType}|${p.contractorLicense}` : nameKey(p.contractorFirm || p.contractorName)),
    (p) => ({ firms: new Map(), person: p.contractorName, license: p.contractorLicense, licenseType: p.contractorLicenseType, address: p.contractorAddress, projects: 0, value: 0, boroughs: new Set(), lastIssued: null }),
    (g, p) => {
      if (p.contractorFirm) bump(g.firms, p.contractorFirm);
      g.projects += 1;
      g.value += p.cost;
      if (p.borough) g.boroughs.add(p.borough);
      g.lastIssued = lastDate(g.lastIssued, p.issuedAt);
    },
  ).map((g) => ({
    firm: topSpelling(g.firms) || titleCase(g.person),
    person: g.person ? titleCase(g.person) : '',
    license: g.license,
    licenseType: g.licenseType,
    address: g.address,
    projects: g.projects,
    value: g.value,
    boroughs: [...g.boroughs],
    lastIssued: g.lastIssued ? isoDate(g.lastIssued) : null,
  })).sort(byProjectsThenValue);

  const neighborhoods = groupBy(
    filings.filter((f) => f.nta),
    (f) => `${f.borough}|${f.nta}`,
    (f) => ({ nta: f.nta, borough: f.borough, projects: 0, open: 0, value: 0 }),
    (g, f) => {
      g.projects += 1;
      if (isOpen(f)) g.open += 1;
      g.value += f.cost;
    },
  ).sort(byProjectsThenValue);

  const recentWins = permits
    .slice()
    .sort((a, b) => (b.cost - a.cost) || ((b.issuedAt || 0) - (a.issuedAt || 0)))
    .slice(0, 60)
    .map((p) => ({
      jobNumber: p.jobNumber,
      address: p.address,
      borough: p.borough,
      nta: p.nta,
      floor: p.floor,
      issued: p.issuedAt ? isoDate(p.issuedAt) : null,
      cost: p.cost,
      contractor: p.contractorFirm || titleCase(p.contractorName),
      contractorLicense: p.contractorLicense,
      owner: p.ownerBusiness || titleCase(p.ownerPerson),
      ownerAddress: p.ownerAddress,
      description: p.description,
      bin: p.bin,
    }));

  const leads = open
    .map((f) => {
      const { score, reasons } = scoreLead(f, f.stage, now);
      return {
        jobNumber: f.jobNumber,
        stage: f.stage,
        stageLabel: STAGE_LABELS[f.stage],
        status: f.status,
        score,
        reasons,
        filed: f.filedAt ? isoDate(f.filedAt) : null,
        daysAgo: f.filedAt ? Math.max(0, Math.floor((now.getTime() - f.filedAt.getTime()) / DAY_MS)) : null,
        approved: f.approvedAt ? isoDate(f.approvedAt) : null,
        address: f.address,
        borough: f.borough,
        nta: f.nta,
        zip: f.zip,
        floor: f.floor,
        apt: f.apt,
        cost: f.cost,
        floorArea: f.floorArea,
        jobType: f.jobType,
        buildingType: f.buildingType,
        owner: f.ownerBusiness || titleCase(f.ownerPerson),
        ownerPerson: f.ownerPerson ? titleCase(f.ownerPerson) : '',
        ownerType: f.ownerType,
        isPublicOwner: PUBLIC_OWNER_TYPES.has(f.ownerType),
        designerFirm: f.designerFirm || titleCase(f.designerName),
        designerName: f.designerName ? titleCase(f.designerName) : '',
        designerTitle: f.designerTitle,
        designerLicense: f.designerLicense,
        designerAddress: f.designerAddress,
        expediter: f.expediterFirm || titleCase(f.expediterName),
        description: f.description,
        bin: f.bin,
        bbl: f.bbl,
      };
    })
    .sort((a, b) => (b.score - a.score) || (b.cost - a.cost));

  const ownerKeys = new Set(filings.filter((f) => f.ownerBusiness).map((f) => nameKey(f.ownerBusiness)));

  return {
    meta: {
      segment: opts.segment,
      segmentLabel: SEGMENTS[opts.segment].label,
      borough: opts.borough || 'All boroughs',
      days: opts.days,
      since,
      minCost: opts.minCost,
      generatedAt: now.toISOString(),
      maxRows: MAX_ROWS,
      truncated: {
        filings: filingsTruncated,
        permits: permitRows.length >= MAX_ROWS,
      },
      leadsShown: Math.min(leads.length, MAX_LEADS),
      sources: [
        { name: DATASETS.filings.name, url: `https://data.cityofnewyork.us/d/${DATASETS.filings.id}` },
        { name: DATASETS.permits.name, url: `https://data.cityofnewyork.us/d/${DATASETS.permits.id}` },
      ],
    },
    summary: {
      projects: filings.length,
      declaredValue: filings.reduce((s, f) => s + f.cost, 0),
      medianCost: median(filings.map((f) => f.cost)),
      open: open.length,
      openValue: open.reduce((s, f) => s + f.cost, 0),
      approvedWaiting: countStage('approved'),
      inReview: countStage('review'),
      objections: countStage('objections'),
      permitted: countStage('permitted'),
      closed: countStage('closed'),
      permitsIssued: permits.length,
      permitValue: permits.reduce((s, p) => s + p.cost, 0),
      contractors: contractors.length,
      owners: ownerKeys.size,
      designers: designers.length,
    },
    weekly,
    boroughs,
    costBuckets,
    owners: owners.slice(0, 50),
    designers: designers.slice(0, 50),
    expediters: expediters.slice(0, 30),
    contractors: contractors.slice(0, 50),
    neighborhoods: neighborhoods.slice(0, 20),
    recentWins,
    leads: leads.slice(0, MAX_LEADS),
  };
}

// ---------- entry point (with a small in-memory cache) ----------

const cache = new Map();

async function getPermitLeads(query = {}, deps = {}) {
  const opts = parseOptions(query);
  const now = deps.now || new Date();
  const cacheKey = JSON.stringify(opts);
  const useCache = !deps.fetchImpl && !query.refresh;
  const hit = cache.get(cacheKey);
  if (useCache && hit && now.getTime() - hit.at < CACHE_TTL_MS) {
    return { ...hit.data, meta: { ...hit.data.meta, cached: true } };
  }

  const token = deps.token !== undefined ? deps.token : (process.env.SOCRATA_APP_TOKEN || process.env.NYC_OPEN_DATA_APP_TOKEN || '');
  const fetchOpts = { fetchImpl: deps.fetchImpl || fetch, token };
  const [filingRows, permitRows] = await Promise.all([
    sodaGetAll(DATASETS.filings.id, buildFilingsQuery(opts, now), fetchOpts),
    sodaGetAll(DATASETS.permits.id, buildPermitsQuery(opts, now), fetchOpts),
  ]);
  const data = analyze(filingRows, permitRows, opts, now);

  if (!deps.fetchImpl) {
    if (cache.size > 40) cache.delete(cache.keys().next().value);
    cache.set(cacheKey, { at: now.getTime(), data });
  }
  return data;
}

module.exports = {
  getPermitLeads,
  analyze,
  parseOptions,
  buildFilingsQuery,
  buildPermitsQuery,
  normalizeFiling,
  normalizePermit,
  classifyStage,
  scoreLead,
  nameKey,
  parseDate,
  formatFloor,
  SEGMENTS,
  BOROUGHS,
  DATASETS,
  PAGE_SIZE,
  MAX_ROWS,
  MAX_LEADS,
};
