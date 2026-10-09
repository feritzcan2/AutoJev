---
name: site-extension
description: Add a per-site extension (DOM reader, API collector or HTTP reader) so Jev reads a job/source site's listings and pagination from the page itself instead of guessing links. Use when the user wants to add or fix a site extension ("yeni site ekle", "site extension yap", "<site> için extension", a results URL of a new source site).
---

# Adding a site extension

The user explicitly asked for one extension per site (2026-10-05). This is the
only sanctioned exception to AGENTS.md's "no site-specific fixes" rule: the
site-specific code lives ONLY in `app/site-extensions/<site>.mjs`. Never add a
domain, selector or title check anywhere else.

Reference implementations — read them first:
- `app/site-extensions/stepstone.mjs` — DOM extension (reads the open Chrome page)
- `app/site-extensions/himalayas/` — API collector (no browser): `index.mjs` adapter, `api.mjs`, `detail.mjs`, `cli.mjs` worker process
- `app/site-extensions/linkedin.mjs` — HTTP reader (public guest pages over HTTP, no browser tab)
- `app/site-extensions/index.mjs` — registry, `applySiteExtension`, `readSiteExtension`
- `tests/site-extensions.test.mjs` — test patterns

## What an extension does and does not do

Does: tell Jev which links on a results page are individual listings (clean
URL + title, optional `siteCard` summary) and, when the site exposes it, the
exact pagination (current page, page count, next-page URL).

Does NOT: judge fit, eliminate, score, record, click, scroll, open pages,
store state, or throw. Triage, scoring and records stay in the generic Jev
pipeline. Any failure returns `null` so the generic reader handles the page.

Flow: Chrome loads the page → generic reader (`renderedDocument`) →
`readSiteExtension` (`app/jev/document.mjs`) runs `collect` in the page →
`results(raw)` → `applySiteExtension` marks listing links `listing:true` and
every other link `listing:false` → card triage asks only "does it fit" for
marked listings → remaining listings get detail reads.

## Step 1 — Pick the kind

- **API collector** if the site has a public JSON API with full listing text
  (like Himalayas). Cheaper and sturdier; no card stage. Follow the Himalayas
  files and `app/sources/collector-worker.mjs`.
- **HTTP reader** if the site serves plain HTML result/detail pages without
  login or scripts (like LinkedIn's guest endpoints). Export
  `reader:{handles(url),read(url,{fetch,signal,siteAccess,wait})}`; `read`
  returns an ordinary Jev page object (see `linkedInSearchPage` /
  `linkedInDetailPage`) and must go through `siteAccess` exactly like
  `readLinkedInGuest`: `begin` → `pace` → fetch with a timeout → `complete`,
  throwing `SiteWaitError` on block statuses. The worker calls it through
  `siteReaderFor(url)` instead of opening a tab. Tests mirror
  `tests/linkedin-guest-reader.test.mjs`.
- **DOM extension** otherwise (like StepStone). Continue below.

## Step 2 — Inspect the results page (no own live browser runs)

Do not launch your own headless/live browser experiments; the user runs live
checks in AutoJev. Ask the user for a results URL with a real search. Inspect
with a plain HTTP fetch (`curl -sL -A 'Mozilla/5.0' URL`) of the results page
and a second page. If the fetch is blocked or the content is client-rendered,
ask the user to save the page from Chrome (Save Page As → HTML) or paste
DevTools output, and inspect that file.

Find and write down:
1. **Card element** for one result and **the title link inside it**. Note the
   other links in a card (company logo/board, save, apply, location filters)
   — these must end up `listing:false`.
2. **Embedded state**, most reliable when present: `window.__PRELOADED_STATE__`,
   `script#__NEXT_DATA__`, `window.__INITIAL_STATE__`, `window.__NUXT__`,
   `application/ld+json` (`ItemList`/`JobPosting`). Note the path to the item
   list and each item's id/title/url/company/location/date.
3. **Pagination**: current page, total pages or result count, and how the next
   page URL is formed (template, `page=`/`offset=`/`start=` parameter, or a
   real next link). Prefer a value the site provides over computing one.
4. **URL noise**: tracking parameters that change per position/session
   (StepStone: `rltr`). The listing URL must be stable so known listings are
   recognised on the next scan.
5. **Semantic/sponsored sections** if any (StepStone mixes exact and semantic
   matches). Report them to the user; do not filter them in the extension
   unless asked.

Present findings and a short plan to the user before writing code if anything
is ambiguous (e.g. no embedded state, infinite scroll, login wall).

## Step 3 — Write `app/site-extensions/<site>.mjs`

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

export default {id:'<site>',matches:is<Site>Url,collect:collect<Site>Page,results:<site>Results};
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
- Keep the style of the surrounding code: compact, few comments explaining why.

Register it in `app/site-extensions/index.mjs`:
```js
import <site> from './<site>.mjs';
export const SITE_EXTENSIONS=[stepstone,himalayas,<site>];
```

## Step 4 — Tests in `tests/site-extensions.test.mjs`

Mirror the StepStone tests with fixtures shaped like the real page:
1. Normal page: listings from state/cards, tracking stripped, `siteCard`,
   pagination with the next URL.
2. Last page: only the current pagination entry.
3. Stale state (ids differ, page number differs, state missing): cards only,
   `pagination:null`.
4. No cards / card without URL / `null` raw → `null`; `matches` rejects a
   look-alike host; `siteExtensionFor` finds the new id.
5. `applySiteExtension`: listing links `listing:true`, company/filter links
   `listing:false`, missing listings appended.
6. If the DOM is non-trivial, run `collect<Site>Page` against the saved HTML
   with a minimal DOM stub only if one already exists in the tests; otherwise
   keep `collect` simple enough to review by eye.

Run `node --test tests/site-extensions.test.mjs`, then the full
`npm test`. Report failures with their output.

## Step 5 — Hand over to the user for a live check

Tell the user to restart the app (never restart it yourself) and run a scan on
the source. What to look for in the source's Detay panel:
- the pending list has no company/category/filter URLs;
- page numbers advance as "N / M" and stop at the page budget (15 pages per
  scan, at least 2 per search);
- red "Elendi · Kartta" entries appear for clearly unrelated titles.

For diagnosis use the data locations in memory (`~/Desktop/Loop Verileri/jobloop.sqlite`,
worker transcripts under `~/.claude/projects/…candidates-<workspaceId>/`).

## Do not

- Put site checks in `jev-tasks.mjs`, `jev-document.mjs`, triage rules or the worker.
- Add waits, retries, pacing or navigation to an extension. If the site needs
  pacing, raise it with the user as a separate decision.
- Hard-code search terms, titles or criteria.
- Revert or reformat other people's edits; another editor works in this tree —
  check `git diff` and mtimes before touching shared files.
