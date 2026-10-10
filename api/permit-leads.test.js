// Unit tests for the permit-leads module. Run: node --test api/permit-leads.test.js
// No network: NYC Open Data responses are replaced with fixture rows shaped
// exactly like the real Socrata JSON (strings everywhere, nulls omitted).

const test = require('node:test');
const assert = require('node:assert/strict');
const PL = require('./permit-leads');

const NOW = new Date('2026-10-10T15:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString().slice(0, 19) + '.000';

function filing(overrides) {
  return {
    job_filing_number: 'M00000001-I1',
    filing_status: 'Approved',
    house_no: '233',
    street_name: 'BROADWAY',
    borough: 'Manhattan',
    bin: '1087167',
    bbl: '1001237501',
    commmunity_board: '101',
    nta: 'Tribeca-Civic Center',
    postcode: '10007',
    work_on_floor: 'Floor Number(s) 027 through 027',
    job_type: 'Alteration',
    building_type: 'Other',
    initial_cost: '1200000',
    filing_date: daysAgo(5),
    job_description: 'INTERIOR ALTERATION OF EXISTING OFFICE SPACE ON 27TH FLOOR',
    owner_s_business_name: 'RFR REALTY LLC',
    owner_first_name: 'Roy',
    owner_last_name: 'Suskin',
    owner_type: 'Corporation',
    applicant_professional_title: 'PE',
    applicant_license: '089878',
    applicant_first_name: 'Thomas',
    applicant_last_name: 'Newbold',
    applicant_business_name: 'MG ENGINEERING D.P.C.',
    applicant_street_name: '252 EAST AVENUE',
    city: 'NORWALK',
    state: 'CT',
    zip: '06855',
    filing_representative_first_name: 'DANIEL',
    filing_representative_last_name: 'SPIEGEL',
    filing_representative_business_name: 'EXPEDIA BUILDING SOLUTION LLC',
    ...overrides,
  };
}

function permit(overrides) {
  return {
    job_filing_number: 'M00000002-I1',
    work_permit: 'M00000002-I1-GC',
    filing_reason: 'Initial Permit',
    house_no: '1745',
    street_name: 'BROADWAY',
    borough: 'Manhattan',
    work_type: 'General Construction',
    permittee_s_license_type: 'GC',
    applicant_license: '612345',
    applicant_first_name: 'JOHN',
    applicant_last_name: 'SMITH',
    applicant_business_name: 'JRM CONSTRUCTION MGMT LLC',
    applicant_business_address: '242 W 36TH ST, NEW YORK NY 10018',
    issued_date: daysAgo(3),
    job_description: 'OFFICE FIT-OUT 12TH FLOOR',
    estimated_job_costs: '300000',
    owner_business_name: '1745 BROADWAY OWNER LLC',
    owner_name: 'JANE DOE',
    owner_street_address: '1745 BROADWAY',
    owner_city: 'NEW YORK',
    owner_state: 'NY',
    owner_zip_code: '10019',
    ...overrides,
  };
}

const FILINGS = [
  filing({}), // approved, no permit, $1.2M, corporate owner, 5 days ago
  filing({ // permitted (first_permit_date) — same owner, different spelling
    job_filing_number: 'M00000002-I1', filing_status: 'Permit Entire', initial_cost: '300000',
    owner_s_business_name: 'RFR Realty, LLC', first_permit_date: daysAgo(3), filing_date: daysAgo(40),
  }),
  filing({ // in review, Brooklyn, owner business placeholder "PR" -> person name
    job_filing_number: 'B00000003-I1', filing_status: 'Plan Examiner Review', borough: 'Brooklyn',
    nta: 'Park Slope', initial_cost: '80000', owner_s_business_name: 'PR', owner_first_name: 'MARIA',
    owner_last_name: 'LOPEZ', owner_type: 'Individual', filing_date: daysAgo(50),
    applicant_professional_title: 'RA', applicant_license: '031234', applicant_business_name: 'JOHN F. GIUSEFFI, ARCHITECT, PC',
  }),
  filing({ // objections, Queens, no declared cost
    job_filing_number: 'Q00000004-I1', filing_status: 'Objections', borough: 'Queens', nta: 'Astoria',
    initial_cost: '0', owner_s_business_name: 'Not Applicable', owner_type: 'Partnership', filing_date: daysAgo(20),
  }),
  filing({ // withdrawn -> closed
    job_filing_number: 'M00000005-I1', filing_status: 'Filing Withdrawn', initial_cost: '50000', filing_date: daysAgo(60),
  }),
  filing({}), // exact duplicate of the first job -> must be ignored
  filing({ // public owner, big, approved — penalized but still open
    job_filing_number: 'X00000006-I1', filing_status: 'Approved', borough: 'Bronx', nta: 'Mott Haven',
    initial_cost: '2000000', owner_s_business_name: 'NYC DEPARTMENT OF CITYWIDE ADMIN SERVICES',
    owner_type: 'NYC Agency', filing_date: daysAgo(2),
  }),
];

const PERMITS = [
  permit({}),
  permit({ job_filing_number: 'M00000002-I1', work_permit: 'M00000002-I1-GC-2', estimated_job_costs: '250000' }), // same job, lower cost
  permit({ job_filing_number: 'M00000009-I1', estimated_job_costs: '50000', borough: 'Brooklyn', issued_date: daysAgo(10) }),
  permit({ job_filing_number: 'M00000010-I1', applicant_license: '700001', applicant_business_name: 'TITAN CONSTRUCTION MANAGE', estimated_job_costs: '900000' }),
];

const OPTS = PL.parseOptions({ days: '90', segment: 'office' });

test('parseOptions validates and defaults', () => {
  assert.deepEqual(PL.parseOptions({}), { days: 90, segment: 'office', borough: '', minCost: 0 });
  assert.deepEqual(
    PL.parseOptions({ days: '45', segment: 'nope', borough: 'staten island', minCost: '-5' }),
    { days: 90, segment: 'office', borough: 'Staten Island', minCost: 0 },
  );
  assert.equal(PL.parseOptions({ days: '30' }).days, 30);
  assert.equal(PL.parseOptions({ minCost: '100000' }).minCost, 100000);
  assert.equal(PL.parseOptions({ borough: "Manhattan' OR 1=1 --" }).borough, '');
});

test('filings query: initial alteration filings with GC work, segment keywords, borough', () => {
  const q = PL.buildFilingsQuery(PL.parseOptions({ days: '30', segment: 'office', borough: 'manhattan' }), NOW);
  const where = q.get('$where');
  assert.match(where, /filing_date >= '2026-09-10'/);
  assert.match(where, /job_filing_number like '%-I1'/);
  assert.match(where, /upper\(general_construction_work_type_\) = 'YES'/);
  assert.match(where, /job_type in \('Alteration', 'Alteration CO', /);
  assert.match(where, /borough = 'Manhattan'/);
  assert.match(where, /upper\(job_description\) like '%OFFICE%'/);
  assert.equal(q.get('$limit'), String(PL.PAGE_SIZE));
  assert.equal(q.get('$order'), 'filing_date DESC, job_filing_number');
  assert.ok(q.get('$select').split(',').includes('first_permit_date'));
  // URL-encoded form keeps the % wildcard intact for Socrata.
  assert.match(q.toString(), /%25-I1/);
});

test('residential segment also matches condo/co-op owners; "all" has no keyword filter', () => {
  const res = PL.buildFilingsQuery(PL.parseOptions({ segment: 'residential' }), NOW).get('$where');
  assert.match(res, /owner_type in \('Condo Unit Owner or Co-Op Tenant-shareholder'\)/);
  assert.match(res, /like '%APARTMENT%'/);
  const all = PL.buildFilingsQuery(PL.parseOptions({ segment: 'all' }), NOW).get('$where');
  assert.doesNotMatch(all, /job_description/);
});

test('leading-space keywords match whole words, including at the start of the text', () => {
  const where = PL.buildFilingsQuery(PL.parseOptions({ segment: 'commercial' }), NOW).get('$where');
  assert.match(where, /like '% STORE%'/);
  assert.match(where, /like 'STORE%'/);
  assert.match(where, /like '%EATING AND DRINKING%'/);
  assert.doesNotMatch(where, /like '%EATING%'/); // would also hit HEATING
  assert.match(where, /like '% DENTAL%'/); // not INCIDENTAL
  const res = PL.buildFilingsQuery(PL.parseOptions({ segment: 'residential' }), NOW).get('$where');
  assert.match(res, /like '% APT %'/);
  assert.match(res, /like 'APT %'/);
  assert.doesNotMatch(res, /'%COOP%'/); // would hit COOPER
});

test('permits query: initial general-construction permits', () => {
  const where = PL.buildPermitsQuery(OPTS, NOW).get('$where');
  assert.match(where, /issued_date >= '2026-07-12'/);
  assert.match(where, /work_type = 'General Construction'/);
  assert.match(where, /filing_reason = 'Initial Permit'/);
  assert.match(where, /like '%OFFICE%'/);
});

test('classifyStage maps DOB statuses', () => {
  const st = (status, extra = {}) => PL.classifyStage({ status, ...extra });
  assert.equal(st('Approved'), 'approved');
  assert.equal(st('PAA Approved'), 'approved');
  assert.equal(st('Approved', { firstPermitAt: new Date() }), 'permitted');
  assert.equal(st('Permit Entire'), 'permitted');
  assert.equal(st('Permit Issued'), 'permitted');
  assert.equal(st('Objections'), 'objections');
  assert.equal(st('Plan Examiner Review'), 'review');
  assert.equal(st('Pending Plan Examiner Assignment'), 'review');
  assert.equal(st('On Hold – Administrative Action'), 'review');
  assert.equal(st('Filing Withdrawn'), 'closed');
  assert.equal(st('LOC Issued'), 'closed');
  assert.equal(st('TA Certificate of Operation Issued'), 'closed');
  assert.equal(st('LL 158-2017-Denied'), 'closed');
  assert.equal(st('Disapproved'), 'closed');
});

test('scoreLead favors approved, large, recent, private jobs', () => {
  const hot = PL.scoreLead({ cost: 1200000, filedAt: new Date(NOW - 5 * 864e5), ownerType: 'Corporation' }, 'approved', NOW);
  const cold = PL.scoreLead({ cost: 20000, filedAt: new Date(NOW - 80 * 864e5), ownerType: 'Individual' }, 'review', NOW);
  const pub = PL.scoreLead({ cost: 1200000, filedAt: new Date(NOW - 5 * 864e5), ownerType: 'NYC Agency' }, 'approved', NOW);
  assert.ok(hot.score > cold.score);
  assert.ok(hot.score > pub.score);
  assert.ok(hot.score <= 100 && cold.score >= 0);
  assert.ok(hot.reasons.includes('Approved, no permit pulled yet'));
  assert.ok(pub.reasons.some((r) => /public bidding/.test(r)));
});

test('name keys merge spelling variants; helpers format DOB values', () => {
  assert.equal(PL.nameKey('RFR REALTY, LLC'), PL.nameKey('RFR Realty LLC'));
  assert.equal(PL.nameKey('MG ENGINEERING D.P.C.'), 'MG ENGINEERING');
  assert.equal(PL.formatFloor('Floor Number(s) 027 through 027'), 'Floor 27');
  assert.equal(PL.formatFloor('Floor Number(s) 003 through 005'), 'Floors 3–5');
  assert.equal(PL.formatFloor('Floor Number(s) 012 through 004'), 'Floors 4–12');
  assert.equal(PL.formatFloor('Cellar'), 'Cellar');
  assert.equal(PL.parseDate('2026-09-30T00:00:00.000').toISOString(), '2026-09-30T00:00:00.000Z');
  assert.equal(PL.parseDate(''), null);
});

test('analyze builds summary, lists and ranked leads', () => {
  const out = PL.analyze(FILINGS, PERMITS, OPTS, NOW);
  const s = out.summary;
  assert.equal(s.projects, 6, 'duplicate job ignored');
  assert.equal(s.open, 4); // approved x2, review, objections
  assert.equal(s.approvedWaiting, 2);
  assert.equal(s.inReview, 1);
  assert.equal(s.objections, 1);
  assert.equal(s.permitted, 1);
  assert.equal(s.closed, 1);
  assert.equal(s.declaredValue, 1200000 + 300000 + 80000 + 0 + 50000 + 2000000);
  assert.equal(s.openValue, 1200000 + 80000 + 0 + 2000000);
  assert.equal(s.permitsIssued, 3, 'two permits on one job count once');
  assert.equal(s.contractors, 2);

  // Owners: spelling variants merged, placeholders ("PR", "Not Applicable") skipped.
  const rfr = out.owners.find((o) => /RFR/i.test(o.name));
  assert.equal(rfr.projects, 3); // jobs 1, 2 and the withdrawn job 5
  assert.equal(rfr.open, 1);
  assert.ok(!out.owners.some((o) => /^(PR|Not Applicable)$/i.test(o.name)));
  assert.ok(out.owners.find((o) => o.isPublic));

  // Designers grouped by license; contractors by license with deduped jobs.
  const mg = out.designers.find((d) => d.license === '089878');
  assert.equal(mg.projects, 5);
  const jrm = out.contractors.find((c) => c.license === '612345');
  assert.equal(jrm.projects, 2);
  assert.equal(jrm.value, 300000 + 50000, 'per-job max cost, not summed sequences');
  assert.equal(out.contractors[0].firm, 'JRM CONSTRUCTION MGMT LLC');

  // Weekly series spans the window and accounts for every filing.
  assert.ok(out.weekly.length >= 13);
  assert.equal(out.weekly.reduce((n, w) => n + w.projects, 0), 6);
  assert.ok(out.weekly.every((w, i, a) => i === 0 || a[i - 1].week < w.week));
  // Window starts Sun 2026-07-12, so the first week (Mon 07-06) is partial, as is the current week.
  assert.equal(out.weekly[0].week, '2026-07-06');
  assert.equal(out.weekly[0].partial, true);
  assert.equal(out.weekly[out.weekly.length - 1].partial, true);
  assert.equal(out.weekly.filter((w) => w.partial).length, 2);

  // Borough rollup.
  const man = out.boroughs.find((b) => b.borough === 'Manhattan');
  assert.equal(man.projects, 3);
  assert.equal(man.open, 1);

  // Leads: only open jobs, best first, with reasons and the person's name when the business is a placeholder.
  assert.equal(out.leads.length, 4);
  assert.equal(out.leads[0].jobNumber, 'M00000001-I1');
  assert.ok(out.leads.every((l, i, a) => i === 0 || a[i - 1].score >= l.score));
  const brooklyn = out.leads.find((l) => l.borough === 'Brooklyn');
  assert.equal(brooklyn.owner, 'Maria Lopez');
  assert.equal(brooklyn.designerTitle, 'RA');
  assert.equal(out.leads[0].floor, 'Floor 27');
  assert.equal(out.leads[0].address, '233 Broadway');

  // Recent wins come from permits, biggest first.
  assert.equal(out.recentWins[0].cost, 900000);
  assert.equal(out.recentWins[0].contractor, 'TITAN CONSTRUCTION MANAGE');
  assert.equal(out.meta.segmentLabel, 'Office & workplace');
  assert.equal(out.meta.truncated.filings, false);
});

test('minCost filter applies to filings and permits', () => {
  const out = PL.analyze(FILINGS, PERMITS, PL.parseOptions({ minCost: '250000' }), NOW);
  assert.equal(out.summary.projects, 3); // $1.2M, $300K, $2M
  assert.equal(out.summary.permitsIssued, 2); // $300K job and $900K job
});

test('getPermitLeads calls both datasets and reports upstream errors', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    const rows = url.includes('w9ak-ipjd') ? FILINGS : PERMITS;
    return { ok: true, status: 200, json: async () => rows, text: async () => '' };
  };
  const out = await PL.getPermitLeads({ days: '90' }, { fetchImpl: fakeFetch, now: NOW, token: 'abc' });
  assert.equal(calls.length, 2);
  assert.ok(calls.some((c) => c.url.startsWith('https://data.cityofnewyork.us/resource/w9ak-ipjd.json?')));
  assert.ok(calls.some((c) => c.url.startsWith('https://data.cityofnewyork.us/resource/rbx6-tga4.json?')));
  assert.ok(calls.every((c) => c.init.headers['X-App-Token'] === 'abc'));
  assert.equal(out.summary.projects, 6);

  const throttled = async () => ({ ok: false, status: 429, json: async () => ({}), text: async () => 'slow down' });
  await assert.rejects(
    PL.getPermitLeads({}, { fetchImpl: throttled, now: NOW, token: '' }),
    (err) => err.upstreamStatus === 429,
  );

  const weird = async () => ({ ok: true, status: 200, json: async () => ({ message: 'oops' }), text: async () => '' });
  await assert.rejects(PL.getPermitLeads({}, { fetchImpl: weird, now: NOW, token: '' }), /unexpected response/);
});

test('pages through big results; a capped view is flagged and its oldest weeks marked partial', async () => {
  // Page 1: newest 10,000 filings (0–20 days old). Page 2: next 10,000 (20–40 days old).
  const page = (offset) => Array.from({ length: PL.PAGE_SIZE }, (_, i) => filing({
    job_filing_number: `M${String(offset + i).padStart(8, '0')}-I1`,
    filing_date: daysAgo(((offset + i) / (2 * PL.PAGE_SIZE)) * 40),
  }));
  const seen = [];
  const fakeFetch = async (url) => {
    const u = new URL(url);
    const offset = Number(u.searchParams.get('$offset') || 0);
    seen.push({ ds: u.pathname.includes('w9ak-ipjd') ? 'filings' : 'permits', offset, limit: u.searchParams.get('$limit') });
    const rows = u.pathname.includes('w9ak-ipjd') ? page(offset) : PERMITS;
    return { ok: true, status: 200, json: async () => rows, text: async () => '' };
  };
  const out = await PL.getPermitLeads({ days: '90', segment: 'all' }, { fetchImpl: fakeFetch, now: NOW, token: '' });
  const filingCalls = seen.filter((c) => c.ds === 'filings');
  assert.deepEqual(filingCalls.map((c) => c.offset), [0, PL.PAGE_SIZE]);
  assert.equal(seen.filter((c) => c.ds === 'permits').length, 1, 'short page stops paging');
  assert.equal(out.summary.projects, PL.MAX_ROWS);
  assert.equal(out.meta.truncated.filings, true);
  assert.equal(out.meta.truncated.permits, false);
  // Weeks older than ~40 days are incomplete; a week fully inside the data is not.
  const byWeek = Object.fromEntries(out.weekly.map((w) => [w.week, w]));
  assert.equal(byWeek['2026-07-13'].partial, true);
  assert.equal(byWeek['2026-09-28'].partial, false);
  assert.ok(out.leads.length <= PL.MAX_LEADS);
});
