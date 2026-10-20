---
name: site-extension
description: Add or fix a per-site extension (DOM reader, HTTP reader or API collector) so Jev finds a source site's listings and pagination from the site itself and, where possible, reads each listing's own description and facts (company, location, pay) without site chrome. Use when the user wants to add or fix a site extension ("add a new site", "make a site extension", "extension for <site>", "yeni site ekle", "site extension yap", "<site> için extension", a results URL of a new source site).
---

# Adding a site extension

The user explicitly asked for one extension per site (2026-10-05). This is the
only sanctioned exception to AGENTS.md's "no site-specific fixes" rule: the
site-specific code lives ONLY in `app/site-extensions/`. Never add a domain,
selector or title check anywhere else.

Reference implementations — read them first:
- `app/site-extensions/index.mjs` — the contract, registry, `applySiteExtension`, `readSiteExtension`, `siteReaderFor`
- `app/site-extensions/listing.mjs` — `listingPage()`, the shape of one read listing; `htmlText`/`decode`
- `app/site-extensions/search.mjs` — the `search` description (results template + filters) and its template helpers
- `app/site-extensions/job-posting.mjs` — the generic schema.org JobPosting reader every browser page gets
- `app/site-extensions/http.mjs` — shared plumbing of `http` readers: `siteFetch` (site access rules, block statuses, 404/410 as `isMissing`), `readerPage`, `htmlPage`/`htmlTitle` (visible text of fetched HTML), `pageEntries`
- `app/site-extensions/stepstone.mjs` — `dom` (reads the open Chrome results page)
- `app/site-extensions/linkedin.mjs` — `http` (guest pages over HTTP, no tab; results and listings parsed from HTML)
- `app/site-extensions/xing.mjs` — `http` (results from the page's embedded Apollo state with card fallback; postings through the JobPosting reader)
- `app/site-extensions/berlin-startup-jobs.mjs` — `http` (WordPress category pages with the site's own next link; listings through the JobPosting reader)
- `app/site-extensions/himalayas/` — `collector` (API through a CLI process; `index.mjs` adapter, `api.mjs`, `detail.mjs`, `cli.mjs`)
- `app/site-extensions/arbeitnow.mjs` — `collector` (public JSON feed read in-process; one feed per country site, no search)
- Tests: `tests/site-extensions.test.mjs`, `tests/linkedin-guest-reader.test.mjs`, `tests/xing-reader.test.mjs`, `tests/berlin-startup-jobs-reader.test.mjs`, `tests/source-collector-worker.test.mjs`, `tests/arbeitnow-collector.test.mjs`

## The contract

An extension is `{id, matches(url)}` plus exactly one way of reading the site:

| Transport | Shape | Used when |
|---|---|---|
| `dom` | `{collect, results}` | the site needs Chrome (scripts, login cookies) |
| `http` | `{handles(url), read(url, options)}` | plain HTML pages without login or scripts |
| `collector` | `{templateId, searchUrl, acceptsQuery, readPage, readDetail, detail}` | a public JSON API |

It can do three jobs:

1. **Find listings** — which links on a results page are individual listings
   (stable URL + title, optional `siteCard`) and the exact pagination
   (current page, page count, next-page URL).
2. **Read a listing** — return one listing through `listingPage()`:
   `{url, title, description, fields, notes}`. `description` is the listing's
   own text only. `fields` are facts the site states (`company`, `location`,
   `workMode`, `salary`, `postedAt`, `employmentType`...). With a description
   the page carries `listing`; Jev's brief then passes the text through
   without classifying blocks (no Jev calls), and the agent reads clean text.
   Without a description it stays an ordinary page.

Job 2 exists today for `http` and `collector`. A `dom` extension only finds
listings: its listing pages go through the generic browser reader. That reader
already uses the page's schema.org `JobPosting` (`app/site-extensions/job-posting.mjs`,
generic, no site names) when exactly one is present, its title is shown on the
page, it has not expired and its description is substantial; Jev's detail
evidence then holds that listing text. Otherwise the brief's Jev filter removes
site chrome. So check `JobPosting` first: when it is there (StepStone, Xing,
Ashby, Indeed in 2026-10), a `dom` extension needs no listing reader.

3. **Describe the search address** (optional `search`, see
   `app/site-extensions/search.mjs`): `{template, ordering, pagination,
   filters, notes}`. `template` is the results address with `{query}` (and
   `{location}`) and the site's own sort parameters; `ordering:'newest_first'`
   only when that sort is certain; `filters` lists the parameters the address
   accepts as `{param, label, values?}` (`values` maps a value to its label,
   without it the filter is free text). The trial agent gets it as
   `assignedSource.siteSearch` and builds the recipe from it instead of
   guessing; the Sources editor shows the filters as controls that rewrite
   the template and a "Use the site template" button. Data only: it never
   decides which filter a workspace uses. When the agent saves a recipe,
   `siteSearchRecipe` restores the template's fixed (sort) parameters and
   sets `pagination` and `ordering` from `search`; the agent keeps the
   terms, path and filter values, and a search form is refused. So verify
   `ordering` yourself (dates across pages) before declaring it.

An extension does NOT judge fit, eliminate, score, record, click, scroll,
store state, retry or pace. Triage, scoring, queues and records stay generic.
`dom` code never throws: any doubt returns `null` and the generic reader
handles the page. `http`/`collector` reads report real request failures as
errors and go through the shared site access rules.

Flows:
- `dom`: Chrome loads the page → generic reader (`renderedDocument`) →
  `readSiteExtension` (`app/jev/document.mjs`) runs `dom.collect` in the page →
  `dom.results(raw)` → `applySiteExtension` marks listing links `listing:true`
  and every other link `listing:false` → card triage → detail reads.
- `http`: the worker calls `siteReaderFor(url).read(...)` instead of opening a
  tab (`app/automation/worker.mjs`); the returned page goes to Jev unchanged.
- `collector`: `app/sources/collector-worker.mjs` calls `readPage`, then
  `detail(job)` per listing, and puts each into Jev's queue as evidence.

## Step 1 — Pick the transport

Check in this order and take the first that works:
1. **collector** if the site has a public JSON API with full listing text
   (like Himalayas). Cheapest and sturdiest; no card stage.
2. **http** if result and listing pages are plain HTML without login or
   scripts (like LinkedIn's guest endpoints).
3. **dom** otherwise (like StepStone).

## Step 2 — Inspect the site (no own live browser runs)

Do not launch your own headless/live browser experiments; the user runs live
checks in AutoJob. Ask the user for a results URL with a real search. Inspect
with a plain HTTP fetch (`curl -sL -A 'Mozilla/5.0' URL`) of the results page,
a second results page and one listing page. If the fetch is blocked or the
content is client-rendered, ask the user to save the page from Chrome (Save
Page As → HTML) or paste DevTools output, and inspect that file.

Results page — find and write down:
1. **Card element** for one result and **the title link inside it**. Note the
   other links in a card (company logo/board, save, apply, location filters)
   — these must end up `listing:false`.
2. **Embedded state**, most reliable when present: `window.__PRELOADED_STATE__`,
   `script#__NEXT_DATA__`, `window.__INITIAL_STATE__`, `window.__NUXT__`,
   `application/ld+json` (`ItemList`). Note the path to the item list and each
   item's id/title/url/company/location/date.
3. **Pagination**: current page, total pages or result count, and how the next
   page URL is formed (template, `page=`/`offset=`/`start=` parameter, or a
   real next link). Prefer a value the site provides over computing one.
4. **URL noise**: tracking parameters that change per position/session
   (StepStone: `rltr`). The listing URL must be stable so known listings are
   recognised on the next scan.
5. **Semantic/sponsored sections** if any (StepStone mixes exact and semantic
   matches). Report them to the user; do not filter them in the extension
   unless asked.

Listing page — find and write down:
1. **Structured data first**: `application/ld+json` with `@type: JobPosting`
   (`description`, `hiringOrganization`, `jobLocation`, `jobLocationType`,
   `baseSalary`, `datePosted`, `employmentType`) or a JSON detail endpoint.
2. Otherwise the element holding **only the listing's own description**, and
   where company, location, work mode and pay are stated.
3. What the page says when a listing is **removed or closed**.

Present findings and a short plan to the user before writing code if anything
is ambiguous (e.g. no embedded state, infinite scroll, login wall).

## Step 3 — Write the extension

### Finding listings (`dom` example)

```js
// <Site> site extension (per-site extensions requested by the user, 2026-10-05).
// <One or two lines: what the generic reader got wrong on this site.>
export const is<Site>Url=value=>{try{const u=new URL(value);return u.protocol==='https:'&&/^(?:www\.)?example\.com$/.test(u.hostname);}catch{return false;}};

// Runs inside the page through page.evaluate: self-contained, no imports or
// outer helpers. Reports what the page shows; <site>Results() decides.
export function collect<Site>Page(){
 return {url:location.href, cards:[...], items:/* embedded state or null */, paging:/* or null */};
}

// {listings:[{url,text,siteCard?}],pagination} or null when the page shows no
// result cards (still loading, a detail page, a changed layout).
export function <site>Results(raw){ ... }

export default {id:'<site>',matches:is<Site>Url,dom:{collect:collect<Site>Page,results:<site>Results}};
```

Rules:
- `matches` checks protocol + exact hostname only (reject `site.com.evil.test`).
- `collect` must return `url: location.href`; `readSiteExtension` drops the
  read if it differs from the document URL (redirect between reads).
- `collect` must never throw on a missing element — use optional chaining and
  return `null` fields.
- `results` returns `null` when there are no cards or any card lacks a URL.
- Use embedded state only when it matches the rendered cards (every card id
  present) and the page number in the address; otherwise fall back to cards
  only with `pagination:null` (StepStone's `fresh` check).
- Resolve relative URLs against `raw.url`; strip only the identified tracking
  parameters.
- Pagination entries use the generic shape
  `{text,url,current,disabled,kind:'link'}`: the current page first
  (`text:'N of M'`, `url:raw.url`, `current:true`), then the next page if it
  exists. On the last page return only the current entry. Return `null` if the
  numbers are invalid or the next URL cannot be built from site data.

`http` results pages are ordinary Jev page objects (`readerPage`) with listing
links marked `listing:true` and the pagination above (`pageEntries`; see
`linkedInSearchPage`, `xingSearchPage`, `berlinStartupJobsListPage`). Prefer
the page's embedded state for the list and its total (Xing: `xingState` cuts
`APOLLO_STATE` out of the non-JSON `window.crate`), fall back to rendered
cards, and take the next-page address from the site when it gives one
(Berlin Startup Jobs: `a.next.page-numbers`).

### Reading a listing (`http` / `collector`)

```js
import {listingPage} from './listing.mjs';

return listingPage({
  browser: '<Site> reader',
  url, // the address the listing was queued under
  title: job.title,
  description: job.description, // the listing's own text, nothing else
  fields: {company: job.company, location: job.location, salary: job.salary},
  notes: job.closed ? ['No longer accepting applications.'] : [],
});
```

Rules:
- `description` holds only this listing: no navigation, cookie text, similar
  listings or company marketing pages. Convert HTML to plain text with line
  breaks for paragraphs and `• ` for list items with `htmlText` from
  `listing.mjs`.
- Put a fact in `fields` only when the site states it. Leave unknown facts out;
  never fill in defaults such as "Remote" or "Worldwide" that the site did not
  say. Empty values are dropped automatically; arrays become comma lists.
- If the description cannot be read, pass none (or return the site's own
  removed/not-found page): the page then stays an ordinary page and nothing
  is assumed. Do not invent a description from the title.
- A `collector`'s `detail(job)` returns `{...listingPage({...}), cells}`;
  `cells` fills the record table (Himalayas: company, location).
- An `http` reader fetches through `siteFetch` from `http.mjs` (site access
  `begin` → `pace` → fetch with a timeout and the caller's `signal` →
  `complete`, `SiteWaitError` on block statuses, 404/410 returned as
  `isMissing` so the reader can say the listing is gone).
- When the listing page carries a JobPosting, an `http` reader needs no
  parser of its own: `jobPostingPage({url, browser, ...jobPostingHtml(html)})`
  from `job-posting.mjs` (Xing, Berlin Startup Jobs). Without a current
  posting return `readerPage` with `htmlPage(html)`: the visible page text,
  as a browser read would give Jev. A collector's `readDetail` can use
  `jobPostingDetail(jobPostingHtml(html))` the same way (Arbeitnow).
- A collector search without a `newest_first` recipe reads only its share of
  the scan's page budget (`recipePageCap`, like browser scans); a feed that
  never ends (Arbeitnow) is therefore safe. Declare `ordering` in the
  template recipe only when the API's sort is certain (Himalayas
  `sort=recent`).

Register the module in `app/site-extensions/index.mjs`:
```js
import <site> from './<site>.mjs';
export const SITE_EXTENSIONS=[stepstone,himalayas,linkedin,<site>];
```

Keep the style of the surrounding code: compact, few comments explaining why.

## Step 4 — Tests

Finding listings (`tests/site-extensions.test.mjs`, mirror StepStone):
1. Normal page: listings from state/cards, tracking stripped, `siteCard`,
   pagination with the next URL.
2. Last page: only the current pagination entry.
3. Stale state (ids differ, page number differs, state missing): cards only,
   `pagination:null`.
4. No cards / card without URL / `null` raw → `null`; `matches` rejects a
   look-alike host; `siteExtensionFor` finds the new id; `siteExtensionKind`
   reports the right kind.
5. `applySiteExtension`: listing links `listing:true`, company/filter links
   `listing:false`, missing listings appended.

Reading a listing (mirror `tests/linkedin-guest-reader.test.mjs`):
6. A fixture shaped like the real listing gives the expected text,
   `page.listing.fields` with only the stated facts, and the queued URL.
7. A removed listing or one without a description has no `listing`.
8. `http`: block statuses start the shared site wait; the fetch receives the
   caller's signal.

Run the touched test files, then the full `npm test`. Report failures with
their output.

## Step 5 — Hand over to the user for a live check

First check: the **extension test bench** (development builds only; Sources →
row menu → "Test extension", or "Test bench" in the header for any address,
`app/sources/extension-bench.mjs`). It reads an address the way the
workspace's scans do — DOM reader in the managed Chrome, HTTP reader or API
collector — without agents, Jev model calls or records, and shows the
extension that matched, whether the DOM reader was applied (and, when not,
what `dom.collect` returned and why `dom.results` gave `null`), the listings,
the links marked as not a listing, the pagination with "Next page →"
(repeats across pages are flagged) and one listing's `fields` and own
description. A listing's "Jev triage" asks Jev the scan's card and detail
questions with the workspace's criteria and shows each answer, the decision
and the exclusion proof (uses Jev tokens, no agent); for an exclusion it also asks a
bench-only question that picks the saved rule or fact and the listing passage it rests on. "Reload extensions" imports every module in
`app/site-extensions/` again (`reload.mjs`), so after an edit the user only
reloads and reads again; a new module registered in `index.mjs` is picked up
too. Changes outside that folder still need a restart.

Then tell the user to restart the app (never restart it yourself) and run a
scan on the source. What to look for:
- the source's Details panel: the pending list has no company/category/filter
  URLs; page numbers advance as "N / M" and stop at the page budget (15 pages
  per scan, at least 2 per search); red "Excluded · On card · …" entries appear for
  clearly unrelated titles;
- with a listing reader: saved records show company and location, and the
  run's `tokenUsage.jevTokens` drops compared with a scan before the change.

For diagnosis use the data locations in memory (`~/Desktop/Loop Verileri/jobloop.sqlite`,
worker transcripts under `~/.claude/projects/…candidates-<workspaceId>/`).

## Do not

- Put site checks in `app/jev/tasks.mjs`, `app/jev/document.mjs`, `app/jev/brief.mjs`,
  triage rules or the worker.
- Add waits, retries, pacing or navigation to an extension. If the site needs
  pacing, raise it with the user as a separate decision.
- Hard-code search terms, titles or criteria, or judge fit inside a reader.
- Revert or reformat other people's edits; another editor works in this tree —
  check `git diff` and mtimes before touching shared files.
