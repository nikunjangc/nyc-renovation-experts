# Permit leads (admin panel)

The **Permit leads** tab in `admin.html` turns NYC Department of Buildings filings into a
call list and a picture of the market. It reads two public NYC Open Data datasets, so
there is nothing to sign up for:

| Dataset | What we use it for |
|---|---|
| [DOB NOW: Build – Job Application Filings](https://data.cityofnewyork.us/d/w9ak-ipjd) | Every job an architect or engineer files: owner, design professional, expediter, declared cost, status, and the date of the first work permit |
| [DOB NOW: Build – Approved Permits](https://data.cityofnewyork.us/d/rbx6-tga4) | Work permits actually issued; the permittee on a General Construction permit is the GC who won the job |

The city refreshes both daily. The API caches each view for 20 minutes; **Update** skips the cache.

## What counts

- **Job**: one initial filing (`-I1` job number) for an Alteration, Alteration CO, or
  ALT-CO job that includes general-construction work, filed inside the date window.
- **Market**: keyword match on the job description.
  - *Office & workplace*: office, workplace, workspace, coworking, corporate
  - *All commercial*: the office words plus retail, store, restaurant, medical, fit-out, lobby and similar
  - *Apartments & homes*: apartment, kitchen, bathroom, condo, co-op, duplex and similar, plus any job filed by a condo/co-op unit owner
  - *All renovation work*: no keyword filter
- **No permit yet**: the job has no work permit (`first_permit_date` is empty) and it hasn't
  been withdrawn or closed out. These jobs may still be choosing a contractor.
  - *Approved*: plans approved, waiting for a contractor to pull the permit (the hottest leads)
  - *In review* / *Objections*: still working through DOB plan review
- **Score (0–100)**: stage (approved > in review > objections) + declared cost + how recently it
  was filed + owner type (business owners up, public agencies down because they buy through
  public bids). Hover a score to see why.

## How to use it

1. Start with **Approved** jobs in your market. Call the architect or engineer on the filing:
   they usually shortlist the contractors. Ask to bid this job and to be on their list.
2. **Owners & property managers** who file again and again are worth a relationship: offer to be
   their go-to contractor for the next fit-out.
3. **Contractors winning permits** shows who is taking the work. The busiest GCs sometimes need
   subcontract capacity.
4. Every table has a **CSV** button for a spreadsheet or CRM import.

Phone numbers are not in this data. Use the *Find phone* links, or the company addresses in the CSV.

## Setup

None required. Optional: add a free Socrata app token as `SOCRATA_APP_TOKEN` in the Vercel
project's environment variables to avoid rate limits
(create one at <https://data.cityofnewyork.us/profile/edit/developer_settings>).

## Code

- `api/permit-leads.js`: queries, normalization, scoring and analytics
- `api/index.js`: `GET /admin/permit-leads?segment=office&borough=Manhattan&days=90&minCost=0` (admin password required)
- `api/permit-leads.test.js`: unit tests (`node --test api/permit-leads.test.js`)
