import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {WebTasks} from '../app/automation/web-template.mjs';
import {automationWorkflow} from '../app/automation/worker.mjs';
import {
  normalizeSourceRecipe,
  replayUrl,
  recipeReplay,
  replayMatches,
  recipeRunOutcome,
  advanceRecipeState,
  recipeStatus,
  recipeSummary,
  SCAN_SEARCH_PAGES,
  jevListingItem,
} from '../app/sources/recipe.mjs';
import {sourceScanScope} from '../app/sources/scan.mjs';
import {replayScanWork} from '../app/sources/scan-work.mjs';

const source = 'https://board.test/jobs';
const template = 'https://board.test/jobs/search?q={query}&l={location}&sort=date';
const settle = () => new Promise((resolve) => setImmediate(resolve));
// A card is asked what it opens (listing/other/uncertain) and whether it fits
// (keep or an exclusion). One-answer mocks map onto whichever question it is.
const pick = (choice, criteria) =>
  Object.hasOwn(criteria, choice)
    ? choice
    : Object.hasOwn(criteria, 'keep')
      ? 'keep'
      : Object.hasOwn(criteria, 'listing') &&
          ['hard_constraint', 'qualification', 'unrelated_role'].includes(choice)
        ? 'listing'
        : choice;
const answer = (choice, criteria, confidence = 1) => (
  (choice = pick(choice, criteria)),
  {
    choice,
    confidence,
    probabilities: Object.fromEntries(Object.keys(criteria).map((k) => [k, k === choice ? 1 : 0])),
  }
);

test('recipes are validated as data: placeholders, form fields and pagination kinds', () => {
  const recipe = normalizeSourceRecipe({
    entry: {kind: 'url_template', template},
    pagination: 'url_param',
    notes: 'Sorted by date',
  });
  assert.deepEqual(recipe, {
    entry: {kind: 'url_template', template},
    pagination: 'url_param',
    notes: 'Sorted by date',
  });
  assert.equal(
    normalizeSourceRecipe({entry: {kind: 'url_template', template}, maxPages: 25}).maxPages,
    undefined,
    'the scan page budget replaces per-recipe page limits',
  );
  assert.deepEqual(
    normalizeSourceRecipe({entry: {kind: 'url_template', template: 'https://board.test/jobs'}})
      .entry,
    {kind: 'url_template', template: 'https://board.test/jobs'},
    'a fixed results address needs no placeholder',
  );
  assert.throws(
    () =>
      normalizeSourceRecipe({
        entry: {kind: 'url_template', template: 'https://board.test/jobs'},
        terms: ['ops'],
      }),
    /\{query\}/,
  );
  assert.throws(
    () => normalizeSourceRecipe({entry: {kind: 'url_template', template}, terms: []}),
    /1–5/,
  );
  const termed = normalizeSourceRecipe({
    entry: {kind: 'url_template', template},
    terms: ['Compliance', ' AI Governance ', 'Compliance'],
  });
  assert.deepEqual(termed.terms, ['Compliance', 'AI Governance']);
  assert.throws(
    () => normalizeSourceRecipe({entry: {kind: 'url_template', template: 'ftp://x/{query}'}}),
    /HTTP/,
  );
  assert.throws(
    () =>
      normalizeSourceRecipe({
        entry: {kind: 'search_form', url: source, fields: [{key: 'location', label: 'Ort'}]},
      }),
    /query/,
  );
  assert.throws(
    () => normalizeSourceRecipe({entry: {kind: 'url_template', template}, pagination: 'magic'}),
    /pagination/,
  );
  assert.equal(normalizeSourceRecipe(null), null);
  const form = normalizeSourceRecipe({
    entry: {
      kind: 'search_form',
      url: source + '#top',
      fields: [
        {key: 'query', label: 'Stichwort'},
        {key: 'location', label: 'Ort'},
      ],
    },
  });
  assert.equal(form.entry.url, source);
  assert.equal(form.pagination, 'auto');
  assert.equal(
    replayUrl(template, {query: 'backend developer', location: 'Berlin'}),
    'https://board.test/jobs/search?q=backend+developer&l=Berlin&sort=date',
  );
  assert.equal(
    replayUrl(template, {query: 'ops'}),
    'https://board.test/jobs/search?q=ops&sort=date',
    'empty placeholders drop their parameter',
  );
  assert.equal(
    recipeReplay(normalizeSourceRecipe({entry: {kind: 'discovery'}}), {query: 'x'}),
    null,
  );
  assert.deepEqual(recipeReplay(form, {query: 'ops', location: ''}).searches, [
    {term: null, url: source, answers: [{key: 'query', label: 'Stichwort', value: 'ops'}]},
  ]);
  assert.deepEqual(
    recipeReplay(termed, {query: 'Aday profiline uygun ilanlar', location: 'Berlin'}).searches.map(
      (s) => s.url,
    ),
    [
      'https://board.test/jobs/search?q=Compliance&l=Berlin&sort=date',
      'https://board.test/jobs/search?q=AI+Governance&l=Berlin&sort=date',
    ],
    'terms replace a descriptive source query',
  );
  assert.deepEqual(
    recipeReplay(
      normalizeSourceRecipe({entry: {kind: 'url_template', template: 'https://board.test/jobs'}}),
      {query: 'x'},
    ).searches,
    [{term: null, url: 'https://board.test/jobs'}],
  );
});

test('scan outcomes verify, tolerate barriers and mark a recipe stale after two failures', () => {
  const url = 'https://board.test/jobs/search?q=ops',
    replay = {
      kind: 'url_template',
      pagination: 'auto',
      searches: [
        {term: null, url},
        {term: 'risk', url: 'https://board.test/jobs/search?q=risk'},
      ],
    };
  const listing = [
    {
      input: {operation: 'scan_results', url: replay.searches[1].url},
      status: 'completed',
      items: [{url: 'a', discovery: {decision: 'listing'}}],
    },
  ];
  assert.equal(recipeRunOutcome(replay, listing), 'success');
  assert.equal(
    recipeRunOutcome(replay, [
      {
        input: {operation: 'scan_results', url},
        status: 'needs_agent',
        issue: {reason: 'access_barrier'},
        items: [],
      },
    ]),
    'neutral',
  );
  assert.equal(
    recipeRunOutcome(replay, [
      {
        input: {operation: 'scan_results', url: 'https://elsewhere.test'},
        status: 'completed',
        items: [],
      },
    ]),
    'neutral',
    'unrelated scans say nothing about the recipe',
  );
  assert.equal(
    recipeRunOutcome(replay, [
      {
        input: {operation: 'scan_results', url: url + '&start=20&vjk=abc'},
        status: 'completed',
        items: [{url: 'b', discovery: {decision: 'listing'}}],
      },
    ]),
    'success',
    'a later page or a site-added token is the same search',
  );
  assert.ok(replayMatches(replay, 'https://board.test/jobs/search?q=ops&page=5'));
  assert.ok(!replayMatches(replay, 'https://board.test/jobs/search?q=other'));
  assert.ok(!replayMatches(replay, 'https://board.test/jobs/view?q=ops'));
  assert.ok(
    !replayMatches(replay, 'https://board.test/jobs/search'),
    'a search missing the replayed parameter is not the replay',
  );
  const failed = [
    {
      input: {operation: 'scan_results', url},
      status: 'needs_agent',
      issue: {reason: 'no_listing_links'},
      items: [],
    },
  ];
  assert.equal(recipeRunOutcome(replay, failed), 'failure');
  assert.equal(
    recipeRunOutcome(replay, [
      {
        input: {operation: 'scan_results', url},
        status: 'completed',
        items: [],
        pages: [{url, candidates: 0, knownListings: 20}],
      },
    ]),
    'success',
    'a repeat scan whose listings were all already known still proves the replay',
  );
  const lead = 'https://redirect.test/l?to=job-1',
    unsure = [
      {
        input: {operation: 'scan_results', url},
        status: 'needs_agent',
        issue: {reason: 'pagination_uncertain'},
        items: [{url: lead, discovery: {decision: 'uncertain'}}],
      },
    ];
  const queued = {
    input: {operation: 'collect_details'},
    status: 'completed',
    items: [
      {
        url: lead,
        collected: true,
        pageKind: 'detail',
        assessment: {decision: 'mismatch', reason: 'location'},
      },
    ],
  };
  assert.equal(
    recipeRunOutcome(replay, [...unsure, queued]),
    'success',
    'listings read from the saved queue prove the scan that found them, even when its pagination stayed uncertain',
  );
  assert.equal(
    recipeRunOutcome(replay, [
      ...unsure,
      {...queued, items: [{...queued.items[0], url: 'https://other.test/job'}]},
    ]),
    'failure',
    'queued details from other searches prove nothing about this replay',
  );
  let state = advanceRecipeState({status: 'verified', successCount: 3, failCount: 0}, 'failure', {
    runId: 'r1',
    now: 1,
    reason: 'no_listing_links',
    url,
  });
  assert.equal(state.status, 'verified');
  assert.equal(state.failCount, 1);
  state = advanceRecipeState(state, 'failure', {
    runId: 'r2',
    now: 2,
    reason: 'no_listing_links',
    url,
  });
  assert.equal(state.status, 'stale');
  assert.equal(state.lastFailure.reason, 'no_listing_links');
  state = advanceRecipeState(state, 'success', {runId: 'r3', now: 3});
  assert.equal(state.status, 'verified');
  assert.equal(state.failCount, 0);
  assert.equal(state.successCount, 4);
  assert.equal(recipeStatus(null, null), 'none');
  assert.equal(recipeStatus({entry: {kind: 'discovery'}}, null), 'discovery');
  assert.equal(
    recipeSummary(
      {entry: {kind: 'url_template', template}},
      {status: 'verified', successCount: 2, failCount: 0},
    ).label,
    'Recipe verified',
  );
});

function fixture(t) {
  const store = new WorkspaceDatabase(':memory:');
  let now = 1_800_000_000_000;
  const db = new AutomationStore(store, {now: () => now});
  const a = db.create('housing', {
    goal: 'Find homes',
    criteria: {location: 'Berlin', budget: '2000', requirements: '2 rooms'},
    sources: [source],
  });
  // These tests step the clock past a 30-minute scan interval.
  db.saveSourcesInterval(a.id, 30);
  db.review(a.id);
  const launches = [],
    runtime = new WebTasks(db, {
      now: () => now,
      launch: async (run) => {
        launches.push(run);
        return {close: async () => {}};
      },
    });
  t.after(async () => {
    await runtime.close();
    store.close();
  });
  return {
    store,
    db,
    id: a.id,
    runtime,
    launches,
    advance: (minutes) => {
      now += minutes * 60000;
    },
  };
}
// A Jev fake: the replayed search lists two jobs on one page; any other board is empty.
// A results board with `pages` numbered pages behind `expected`; each page
// links two listings and the last one shows no further pagination.
// `leads` makes discovery mark every result link uncertain, like boards whose
// result links are redirects; details then read as individual listings.
function jevBrowser(expected, {listings = 2, pages = 1, leads = false} = {}) {
  const opened = [],
    pageUrl = (n) => (n === 1 ? expected : expected + '&start=' + (n - 1) * 10),
    pageNumber = (url) =>
      [...Array(pages).keys()].map((n) => n + 1).find((n) => pageUrl(n) === url);
  return {
    opened,
    browser: {
      hasPage: () => opened.length > 0,
      evaluateJev: async (_id, state, questions) => ({
        answers: Object.fromEntries(
          Object.entries(questions).map(([key, q]) => [
            key,
            answer(
              key === 'next'
                ? Object.keys(state.pagination ?? {}).length
                  ? '0'
                  : 'end'
                : key === 'fit'
                  ? 'possible'
                  : leads
                    ? 'uncertain'
                    : 'listing',
              q.criteria,
            ),
          ]),
        ),
      }),
      async call(_id, name, args) {
        const url = args.url ?? opened.at(-1);
        if (name === 'browser_navigate') opened.push(url);
        const n = pageNumber(url),
          view = (k) => expected.replace('search', 'view/' + k);
        const page = n
          ? {
              url,
              title: 'Results',
              text: `Jobs for you, page ${n}\nLink: Job A — ${view(n + 'a')}\nLink: Job B — ${view(n + 'b')}`,
              links: Array.from({length: listings}, (_, i) => ({
                url: view(n + ('ab'[i] ?? 'x' + i)),
                text: 'Job ' + n + ('ab'[i] ?? 'x' + i),
              })),
              pagination: n < pages ? [{text: 'Next', url: pageUrl(n + 1), kind: 'link'}] : [],
            }
          : url.includes('/view/')
            ? {
                url,
                title: 'Job detail',
                text: 'Individual opportunity. ' + 'Responsibilities and requirements. '.repeat(20),
                links: [],
                pagination: [],
              }
            : {url, title: 'Board', text: 'Nothing here', links: [], pagination: []};
        return {
          jevPage: page,
          pageContext: {url, tabId: 'owned'},
          content: [{type: 'text', text: 'Page URL: ' + url + '\n' + JSON.stringify(page)}],
        };
      },
    },
  };
}
const settleTask = async (flow, id, runId, first) => {
  let result = first,
    polls = 0;
  while (result.status === 'running') {
    if (++polls > 40) throw Error('task did not settle');
    result = await flow.call(id, runId, 'read_jev_task', {
      taskId: result.taskId ?? result.index?.taskId,
    });
  }
  return result;
};
// Marks every queued listing reviewed; the entries view returns the queue in parts.
const reviewQueue = async (flow, f, scan, url) => {
  for (let i = 0; i < 20; i++) {
    const queue = await flow.call(f.id, scan.id, 'get_scan_queue', {view: 'entries'});
    if (!queue.pendingUrls.length) return;
    f.db.saveScanProgress(
      f.id,
      scan.id,
      {pendingUrls: [], processedUrls: queue.pendingUrls, reason: 'Reviewed'},
      {url, text: ''},
    );
  }
  throw Error('queue did not empty');
};

test('a recipe check reuses listings the trial already proved at the replayed address', async (t) => {
  const f = fixture(t);
  f.db.enable(f.id);
  await f.runtime.tick();
  await settle();
  const trial = f.launches[0],
    expected = 'https://board.test/jobs/search?q=Find+homes&l=Berlin&sort=date',
    {browser, opened} = jevBrowser(expected, {pages: 3, leads: true});
  const flow = automationWorkflow({
    db: f.db,
    run: trial,
    signal: new AbortController().signal,
    browser,
    report: (...args) => f.runtime.report(...args),
  });
  // The agent scanned the board itself and read one of its links as a listing.
  const scan = await settleTask(
    flow,
    f.id,
    trial.id,
    await flow.call(f.id, trial.id, 'browser_jev_run', {operation: 'scan_results', url: expected}),
  );
  assert.equal(scan.confirmedListings, 0);
  assert.ok(scan.uncertainLinks >= 2);
  const lead = f.db.jevTasks.get(f.id, trial.taskId ?? trial.id, scan.taskId).items[0].url;
  await settleTask(
    flow,
    f.id,
    trial.id,
    await flow.call(f.id, trial.id, 'browser_jev_run', {
      operation: 'collect_details',
      urls: [lead],
    }),
  );
  const before = opened.length;
  const saved = await flow.call(f.id, trial.id, 'save_source_recipe', {
    entry: {kind: 'url_template', template},
    terms: ['Find homes'],
    pagination: 'url_param',
  });
  assert.equal(saved.status, 'verified');
  assert.equal(saved.reused, true);
  assert.equal(saved.listings, 1);
  assert.equal(saved.pages, 2);
  assert.equal(opened.length, before, 'no page is reopened for the check');
  assert.equal(f.db.sources(f.id)[0].recipeState.status, 'verified');
});

test('a recipe check proves redirect-style result links by reading a few details', async (t) => {
  const f = fixture(t);
  f.db.enable(f.id);
  await f.runtime.tick();
  await settle();
  const trial = f.launches[0],
    expected = 'https://board.test/jobs/search?q=Find+homes&l=Berlin&sort=date',
    {browser, opened} = jevBrowser(expected, {pages: 3, leads: true});
  const flow = automationWorkflow({
    db: f.db,
    run: trial,
    signal: new AbortController().signal,
    browser,
    report: (...args) => f.runtime.report(...args),
  });
  const saved = await flow.call(f.id, trial.id, 'save_source_recipe', {
    entry: {kind: 'url_template', template},
    terms: ['Find homes'],
    pagination: 'url_param',
  });
  assert.equal(saved.status, 'verified');
  assert.ok(saved.listings >= 1);
  assert.ok(saved.detailsTaskId);
  assert.match(saved.note, /reading details/);
  assert.equal(opened.filter((u) => u.includes('/view/')).length, 3, 'only three leads are read');
  assert.equal(opened.filter((u) => u.startsWith(expected)).length, 2, 'two result pages');
  assert.equal(f.db.sources(f.id)[0].recipeState.status, 'verified');
  const tasks = f.db.jevTasks.list(f.id, trial.taskId ?? trial.id),
    scanTask = tasks.find((t) => t.input.operation === 'scan_results'),
    detailTask = tasks.find((t) => t.input.operation === 'collect_details');
  assert.ok(scanTask.items.every((i) => i.discovery.decision === 'uncertain'));
  assert.ok(detailTask.items.some(jevListingItem));
  assert.equal(
    recipeRunOutcome(
      recipeReplay(f.db.sources(f.id)[0].recipe, {query: 'Find homes', location: 'Berlin'}),
      tasks.map((t) =>
        t.input.operation === 'collect_details'
          ? {...t, input: {...t.input, fromTaskId: scanTask.id}}
          : t,
      ),
    ),
    'success',
    'details linked to the replayed scan count as success',
  );
  assert.equal(
    recipeRunOutcome(
      recipeReplay(f.db.sources(f.id)[0].recipe, {query: 'Find homes', location: 'Berlin'}),
      [scanTask],
    ),
    'neutral',
    'uncertain leads without details prove nothing either way',
  );
});

test('a trial scan reads at most two result pages while a scan run keeps paging', async (t) => {
  const f = fixture(t);
  f.db.enable(f.id);
  await f.runtime.tick();
  await settle();
  const trial = f.launches[0],
    expected = 'https://board.test/jobs/search?q=Find+homes&l=Berlin&sort=date',
    {browser, opened} = jevBrowser(expected, {pages: 4});
  const flow = automationWorkflow({
    db: f.db,
    run: trial,
    signal: new AbortController().signal,
    browser,
    report: (...args) => f.runtime.report(...args),
  });
  const scanned = await settleTask(
    flow,
    f.id,
    trial.id,
    await flow.call(f.id, trial.id, 'browser_jev_run', {operation: 'scan_results', url: expected}),
  );
  assert.equal(scanned.status, 'completed');
  assert.equal(scanned.pageCount, 2);
  assert.equal(scanned.pageLimitReached, true);
  assert.match(scanned.next, /Page limit for this turn/);
  assert.equal(
    opened.filter((u) => u.startsWith(expected)).length,
    2,
    'the trial never opened a third page',
  );
  f.db.observe(f.id, trial.id, source, 'Listings');
  await flow.call(f.id, trial.id, 'finish_automation_run', {
    status: 'completed',
    summary: 'Access ok',
  });
  await f.runtime.finish(f.id, 'completed', 'Access ok', trial.workerId);
  await f.runtime.tick();
  f.advance(31);
  await f.runtime.tick();
  await settle();
  const scan = f.launches[1];
  assert.equal(scan.kind, 'run');
  const scanFlow = automationWorkflow({
    db: f.db,
    run: scan,
    signal: new AbortController().signal,
    browser,
    report: (...args) => f.runtime.report(...args),
  });
  const full = await settleTask(
    scanFlow,
    f.id,
    scan.id,
    await scanFlow.call(f.id, scan.id, 'browser_jev_run', {
      operation: 'scan_results',
      url: expected,
    }),
  );
  assert.equal(full.status, 'completed');
  assert.equal(full.pageCount, 4);
  assert.equal(full.pageLimitReached, undefined);
});

test('a trial agent saves a recipe that the app verifies with Jev before accepting it', async (t) => {
  const f = fixture(t);
  f.db.enable(f.id);
  await f.runtime.tick();
  await settle();
  const trial = f.launches[0];
  assert.equal(trial.kind, 'trial');
  const expected = 'https://board.test/jobs/search?q=Find+homes&l=Berlin&sort=date',
    {browser, opened} = jevBrowser(expected);
  const flow = automationWorkflow({
    db: f.db,
    run: trial,
    signal: new AbortController().signal,
    browser,
    report: (...args) => f.runtime.report(...args),
  });
  const context = await flow.call(f.id, trial.id, 'get_automation_context', {});
  assert.equal(context.assignedSource.recipeStatus, 'none');
  assert.equal(context.assignedSource.recipeReplay, null);
  await assert.rejects(
    flow.call(f.id, trial.id, 'save_source_recipe', {
      entry: {kind: 'url_template', template: 'https://board.test/other?q={query}'},
      terms: ['Find homes'],
    }),
    /could not be verified: no_listing_links/,
  );
  assert.equal(f.db.sources(f.id)[0].recipe, undefined, 'a failed check saves nothing');
  await assert.rejects(
    flow.call(f.id, trial.id, 'save_source_recipe', {entry: {kind: 'url_template', template}}),
    /no terms, so \{query\} would be the source scope "Find homes"/,
    'a {query} search without terms would search for the scope',
  );
  const saved = await flow.call(f.id, trial.id, 'save_source_recipe', {
    entry: {kind: 'url_template', template},
    terms: ['Find homes'],
    pagination: 'url_param',
  });
  assert.equal(saved.status, 'verified');
  assert.equal(saved.listings, 2);
  assert.equal(saved.url, expected);
  assert.ok(opened.includes(expected));
  const after = f.db.sources(f.id)[0];
  assert.equal(after.recipe.entry.template, template);
  assert.equal(after.recipeState.status, 'verified');
  assert.equal(after.recipeState.successCount, 1);
  assert.equal(
    sourceScanScope(f.db.get(f.id), source),
    sourceScanScope({...f.db.get(f.id), sourceSettings: {[source]: {}}}, source),
    'recipes never change the scan scope',
  );
  f.db.observe(f.id, trial.id, source, 'Listings');
  await flow.call(f.id, trial.id, 'finish_automation_run', {
    status: 'completed',
    summary: 'Recipe saved',
  });
  await f.runtime.finish(f.id, 'completed', 'Recipe saved', trial.workerId);
  await f.runtime.tick();
  assert.equal(f.db.sources(f.id)[0].trial.status, 'passed');
  assert.equal(f.db.sources(f.id)[0].recipeState.status, 'verified');
  f.advance(31);
  await f.runtime.tick();
  await settle();
  const scan = f.launches[1];
  assert.equal(scan.kind, 'run');
  const scanFlow = automationWorkflow({
    db: f.db,
    run: scan,
    signal: new AbortController().signal,
    browser,
    report: (...args) => f.runtime.report(...args),
  });
  const scanContext = await scanFlow.call(f.id, scan.id, 'get_automation_context', {});
  assert.equal(scanContext.assignedSource.recipeReplay.searches[0].url, expected);
  assert.match(scanContext.assignedSource.recipeGuidance, /Start with recipeReplay/);
});

test('a passed trial without a saved recipe leaves the source in discovery mode', async (t) => {
  const f = fixture(t);
  f.db.enable(f.id);
  await f.runtime.tick();
  await settle();
  const trial = f.launches[0];
  f.db.spendStep(f.id, trial.id);
  f.db.observe(f.id, trial.id, source, 'Listings');
  const flow = automationWorkflow({
    db: f.db,
    run: trial,
    signal: {aborted: false},
    browser: {},
    report: (...args) => f.runtime.report(...args),
  });
  await flow.call(f.id, trial.id, 'finish_automation_run', {
    status: 'completed',
    summary: 'Checked',
  });
  await f.runtime.finish(f.id, 'completed', 'Checked', trial.workerId);
  const after = f.db.sources(f.id)[0];
  assert.equal(after.trial.status, 'passed');
  assert.equal(after.recipe.entry.kind, 'discovery');
  assert.equal(after.recipeState.status, 'discovery');
  assert.equal(recipeSummary(after.recipe, after.recipeState).label, 'Discovery mode');
});

test('a trial reads the notes of an unverified recipe as claims to re-check', async (t) => {
  const f = fixture(t);
  f.db.saveSource(f.id, source, {
    recipe: {entry: {kind: 'url_template', template}, notes: 'Sort only Most relevant'},
  });
  f.db.enable(f.id);
  await f.runtime.tick();
  await settle();
  const trial = f.launches[0];
  assert.equal(trial.kind, 'trial');
  const flow = automationWorkflow({
    db: f.db,
    run: trial,
    signal: new AbortController().signal,
    browser: jevBrowser('https://board.test/jobs/search?q=Find+homes&l=Berlin&sort=date').browser,
    report: (...args) => f.runtime.report(...args),
  });
  const context = await flow.call(f.id, trial.id, 'get_automation_context', {});
  assert.equal(context.assignedSource.recipeStatus, 'candidate');
  assert.equal(context.assignedSource.recipeNotesUnverified, true);
  assert.match(context.assignedSource.recipeNotesGuidance, /unverified/);
  f.db.learnSourceRecipe(
    f.id,
    source,
    {entry: {kind: 'url_template', template}, notes: 'Sort only Most relevant'},
    {runId: trial.id, verified: true, listings: 2, pages: 1},
  );
  const verified = await flow.call(f.id, trial.id, 'get_automation_context', {});
  assert.equal(verified.assignedSource.recipeStatus, 'verified');
  assert.equal(
    verified.assignedSource.recipeNotesUnverified,
    undefined,
    'verified notes carry no warning',
  );
});

test('replayed scans verify or invalidate the recipe; a stale recipe sends the source back to a trial', async (t) => {
  const f = fixture(t);
  f.db.saveSource(f.id, source, {
    recipe: {entry: {kind: 'url_template', template}, terms: ['Find homes']},
  });
  assert.equal(f.db.sources(f.id)[0].recipeState.status, 'candidate');
  const trial = f.db.begin(f.id, 'trial');
  f.db.observe(f.id, trial.id, source, 'Listings');
  f.db.finish(f.id, trial.id, 'completed', 'Read');
  f.db.enable(f.id);
  const expected = 'https://board.test/jobs/search?q=Find+homes&l=Berlin&sort=date';
  const scanOnce = async (listings) => {
    await f.runtime.tick();
    await settle();
    const run = f.launches.at(-1);
    assert.equal(run.kind, 'run');
    const {browser} = jevBrowser(expected, {listings});
    const flow = automationWorkflow({
      db: f.db,
      run,
      signal: new AbortController().signal,
      browser,
      report: (...args) => f.runtime.report(...args),
    });
    const scan = await flow.call(f.id, run.id, 'browser_jev_run', {
      operation: 'scan_results',
      url: expected,
    });
    if (listings)
      await flow
        .call(f.id, run.id, 'browser_jev_run', {
          operation: 'collect_details',
          fromTaskId: scan.taskId,
        })
        .catch(() => {});
    f.runtime.report(f.id, run.id, 'completed', 'Scan ended');
    await f.runtime.finish(f.id, 'completed', 'Scan ended', run.workerId);
    await f.runtime.tick();
    f.advance(31);
    return f.db.sources(f.id)[0].recipeState;
  };
  let state = await scanOnce(2);
  assert.equal(state.status, 'verified');
  assert.equal(state.successCount, 1);
  state = await scanOnce(0);
  assert.equal(state.status, 'verified');
  assert.equal(state.failCount, 1);
  assert.equal(state.lastFailure.reason, 'no_listing_links');
  state = await scanOnce(0);
  assert.equal(state.status, 'stale');
  assert.equal(f.db.sources(f.id)[0].trial, null, 'a stale recipe forgets the trial');
  const context = f.db.sourceRecipe(f.id, source);
  assert.equal(context.replay, null, 'a stale recipe is not replayed');
  await f.runtime.tick();
  await settle();
  assert.equal(f.launches.at(-1).kind, 'trial', 'the next turn relearns the source');
});

test('relearning and settings carry recipes without touching scan state', async (t) => {
  const f = fixture(t);
  f.db.saveSource(f.id, source, {recipe: {entry: {kind: 'url_template', template}}});
  assert.equal(f.db.sources(f.id)[0].recipe.entry.template, template);
  assert.equal(f.db.sources(f.id)[0].recipeState.status, 'candidate');
  const trial = f.db.begin(f.id, 'trial');
  f.db.observe(f.id, trial.id, source, 'Listings');
  f.db.finish(f.id, trial.id, 'completed', 'Read');
  assert.equal(f.db.sources(f.id)[0].trial.status, 'passed');
  await f.runtime.relearnSource(f.id, source);
  const after = f.db.sources(f.id)[0];
  assert.equal(after.trial, null);
  assert.equal(after.recipeState.status, 'candidate');
  assert.equal(
    after.recipe.entry.template,
    template,
    'relearning keeps the saved recipe for comparison',
  );
  f.db.put({
    ...f.db.get(f.id),
    sourceState: {
      ...f.db.get(f.id).sourceState,
      [source]: {
        ...f.db.get(f.id).sourceState[source],
        recipeState: {status: 'verified', successCount: 3, failCount: 0},
      },
    },
  });
  f.db.saveSource(f.id, source, {
    recipe: {
      ...after.recipe,
      notes: 'Sorted by date',
      pagination: 'next_link',
      loginRequired: false,
    },
    mode: 'observe',
  });
  assert.equal(
    f.db.sources(f.id)[0].recipeState.successCount,
    3,
    'advisory recipe fields do not reset verification',
  );
  f.db.saveSource(f.id, source, {recipe: {...after.recipe, terms: ['ops']}});
  assert.equal(
    f.db.sources(f.id)[0].recipeState.status,
    'candidate',
    'a different search method needs a new check',
  );
  f.db.saveSource(f.id, source, {recipe: null});
  assert.equal(f.db.sources(f.id)[0].recipe, undefined);
  assert.equal(f.db.sources(f.id)[0].recipeState, null);
  const settings = f.db.save(f.id, {
    agentSettings: {
      provider: 'codex',
      model: 'default',
      trialModel: 'gpt-5-pro',
      permission: 'bypassPermissions',
      reasoning: 'default',
      network: null,
    },
  }).agentSettings;
  assert.equal(settings.trialModel, 'gpt-5-pro');
  assert.equal(
    f.db.save(f.id, {agentSettings: {...settings, trialModel: null}}).agentSettings.trialModel,
    null,
  );
});

test('a scan never rereads listings the workspace already holds or rejected under the same criteria', async (t) => {
  const f = fixture(t);
  f.db.enable(f.id);
  await f.runtime.tick();
  await settle();
  const trial = f.launches[0],
    expected = 'https://board.test/jobs/search?q=Find+homes&l=Berlin&sort=date',
    {browser, opened} = jevBrowser(expected);
  const view = (k) => expected.replace('search', 'view/' + k);
  f.db.spendStep(f.id, trial.id);
  f.db.observe(f.id, trial.id, source, 'Listings');
  const trialFlow = automationWorkflow({
    db: f.db,
    run: trial,
    signal: new AbortController().signal,
    browser,
    report: (...args) => f.runtime.report(...args),
  });
  await trialFlow.call(f.id, trial.id, 'finish_automation_run', {
    status: 'completed',
    summary: 'Access ok',
  });
  await f.runtime.finish(f.id, 'completed', 'Access ok', trial.workerId);
  await f.runtime.tick();
  f.advance(31);
  await f.runtime.tick();
  await settle();
  const scan = f.launches[1];
  assert.equal(scan.kind, 'run');
  const flow = automationWorkflow({
    db: f.db,
    run: scan,
    signal: new AbortController().signal,
    browser,
    report: (...args) => f.runtime.report(...args),
  });
  const first = await settleTask(
    flow,
    f.id,
    scan.id,
    await flow.call(f.id, scan.id, 'browser_jev_run', {operation: 'scan_results', url: expected}),
  );
  assert.equal(first.status, 'completed');
  assert.equal(first.lastPage.knownListings, 0);
  assert.deepEqual(
    (await flow.call(f.id, scan.id, 'get_scan_queue', {view: 'entries'})).pendingUrls,
    [view('1a'), view('1b')],
  );
  await flow.call(f.id, scan.id, 'record_automation_result', {
    key: view('1a'),
    url: view('1a'),
    title: 'Job 1a',
    summary: 'Observed full description in Berlin',
    score: 70,
  });
  f.db.rememberSeenListings(
    f.id,
    source,
    [view('1b') + '&utm_source=mail'],
    'Reviewed and rejected',
  );
  assert.deepEqual(
    f.db.knownListingUrls(f.id, scan.id, [view('1a'), view('1b'), view('9z')]),
    [view('1a'), view('1b')],
    'records and rejections count, tracking parameters do not matter',
  );
  const asked = browser.evaluateJev;
  let triage = 0;
  browser.evaluateJev = async (...args) => {
    if (Object.keys(args[2]).some((k) => /^(link|fit)\d/.test(k))) triage++;
    return asked(...args);
  };
  const second = await settleTask(
    flow,
    f.id,
    scan.id,
    await flow.call(f.id, scan.id, 'browser_jev_run', {operation: 'scan_results', url: expected}),
  );
  assert.equal(second.status, 'completed');
  assert.equal(second.lastPage.knownListings, 2);
  assert.equal(second.lastPage.candidates, 0);
  assert.equal(triage, 0, 'known listings are not sent to the model');
  assert.deepEqual(
    (await flow.call(f.id, scan.id, 'get_scan_queue', {view: 'entries'})).pendingUrls,
    [],
    'known listings are retired without a detail read',
  );
  assert.equal(opened.filter((u) => u.includes('/view/')).length, 0, 'no detail page was opened');
  const changed = f.store.db
    .prepare('SELECT 1 FROM scan_seen_listings WHERE workspace_id=? AND scope_key=?')
    .get(f.id, sourceScanScope({...f.db.get(f.id), criteria: {location: 'Hamburg'}}, source));
  assert.equal(changed, undefined, 'rejections are bound to the search scope that produced them');
  assert.ok(
    f.store.db
      .prepare('SELECT 1 FROM scan_seen_listings WHERE workspace_id=? AND scope_key=?')
      .get(f.id, sourceScanScope(f.db.get(f.id), source)),
  );
});

test('on a board the recipe orders newest-first, a repeat scan stops after two pages of known listings', async (t) => {
  const f = fixture(t);
  f.db.enable(f.id);
  await f.runtime.tick();
  await settle();
  const trial = f.launches[0],
    expected = 'https://board.test/jobs/search?q=Find+homes&l=Berlin&sort=date',
    {browser, opened} = jevBrowser(expected, {pages: 4});
  const view = (k) => expected.replace('search', 'view/' + k);
  const trialFlow = automationWorkflow({
    db: f.db,
    run: trial,
    signal: new AbortController().signal,
    browser,
    report: (...args) => f.runtime.report(...args),
  });
  const saved = await trialFlow.call(f.id, trial.id, 'save_source_recipe', {
    entry: {kind: 'url_template', template},
    terms: ['Find homes'],
    pagination: 'url_param',
    ordering: 'newest_first',
  });
  assert.equal(saved.status, 'verified');
  assert.equal(f.db.sources(f.id)[0].recipe.ordering, 'newest_first');
  f.db.observe(f.id, trial.id, source, 'Listings');
  await trialFlow.call(f.id, trial.id, 'finish_automation_run', {
    status: 'completed',
    summary: 'Recipe saved',
  });
  await f.runtime.finish(f.id, 'completed', 'Recipe saved', trial.workerId);
  await f.runtime.tick();
  f.advance(31);
  await f.runtime.tick();
  await settle();
  const first = f.launches[1];
  assert.equal(first.kind, 'run');
  assert.equal(f.db.run(first.id).scanPlan.mode, 'full');
  let flow = automationWorkflow({
    db: f.db,
    run: first,
    signal: new AbortController().signal,
    browser,
    report: (...args) => f.runtime.report(...args),
  });
  const full = await settleTask(
    flow,
    f.id,
    first.id,
    await flow.call(f.id, first.id, 'browser_jev_run', {operation: 'scan_results', url: expected}),
  );
  assert.equal(full.status, 'completed');
  assert.equal(full.pageCount, 4);
  assert.equal(full.knownBoundary, undefined, 'the first scan covers the whole board');
  // Every listing is reviewed and rejected: no records, so no record tasks compete for the worker.
  const all = [1, 2, 3, 4].flatMap((n) => ['a', 'b'].map((s) => view(n + s)));
  f.db.saveScanProgress(
    f.id,
    first.id,
    {pendingUrls: [], processedUrls: all, reason: 'Reviewed and rejected'},
    {url: expected + '&start=30', text: ''},
  );
  f.db.rememberSeenListings(f.id, source, all, 'Reviewed and rejected');
  f.db.spendStep(f.id, first.id);
  f.db.observe(f.id, first.id, expected + '&start=30', 'Last page');
  await flow.call(f.id, first.id, 'complete_scan_search', {completion: 'end'});
  await flow.call(f.id, first.id, 'finish_automation_run', {
    status: 'completed',
    summary: 'Board covered',
    scan: {
      complete: true,
      pendingUrls: [],
      reason: 'Board covered to its last page',
      evidenceUrl: expected + '&start=30',
      completion: 'end',
    },
  });
  await f.runtime.finish(f.id, 'completed', 'Board covered', first.workerId);
  await f.runtime.tick();
  const fullAt = f.db.sources(f.id)[0].scanState.lastFullScanAt;
  assert.ok(fullAt);
  f.advance(31);
  await f.runtime.tick();
  await settle();
  const repeat = f.launches[2];
  assert.equal(repeat.kind, 'run');
  assert.equal(repeat.recordId, null);
  assert.equal(f.db.run(repeat.id).scanPlan.mode, 'incremental');
  assert.equal(f.db.run(repeat.id).scanPlan.ordering, 'recipe');
  flow = automationWorkflow({
    db: f.db,
    run: repeat,
    signal: new AbortController().signal,
    browser,
    report: (...args) => f.runtime.report(...args),
  });
  opened.length = 0;
  const bounded = await settleTask(
    flow,
    f.id,
    repeat.id,
    await flow.call(f.id, repeat.id, 'browser_jev_run', {operation: 'scan_results', url: expected}),
  );
  assert.equal(bounded.status, 'completed');
  assert.equal(bounded.knownBoundary, true);
  assert.equal(bounded.pageCount, 2);
  assert.match(bounded.next, /Known boundary reached/);
  assert.equal(
    opened.filter((u) => u.startsWith(expected)).length,
    2,
    'the third and fourth pages were never opened',
  );
  assert.deepEqual(
    (await flow.call(f.id, repeat.id, 'get_scan_queue', {view: 'entries'})).pendingUrls,
    [],
  );
  f.db.spendStep(f.id, repeat.id);
  f.db.observe(f.id, repeat.id, expected + '&start=10', 'Known page');
  const completion = await flow.call(f.id, repeat.id, 'complete_scan_search', {
    completion: 'cutoff',
  });
  assert.ok(completion);
  await flow.call(f.id, repeat.id, 'finish_automation_run', {
    status: 'completed',
    summary: 'Only known listings remained',
    scan: {
      complete: true,
      pendingUrls: [],
      reason: 'Known boundary',
      evidenceUrl: expected + '&start=10',
      completion: 'cutoff',
    },
  });
  await f.runtime.finish(f.id, 'completed', 'Only known listings remained', repeat.workerId);
  const state = f.db.sources(f.id)[0].scanState;
  assert.equal(state.active, null);
  assert.equal(state.lastCompleted.completion, 'cutoff');
  assert.equal(
    state.lastFullScanAt,
    fullAt,
    'a known-boundary finish is not a full scan, so the weekly full scan stays scheduled',
  );
});

// A scan run after a trial that saved and verified the board's recipe.
async function scanAfterTrial(t, board) {
  const f = fixture(t);
  f.db.enable(f.id);
  await f.runtime.tick();
  await settle();
  const trial = f.launches[0],
    expected = 'https://board.test/jobs/search?q=Find+homes&l=Berlin&sort=date',
    {browser, opened} = jevBrowser(expected, board);
  const trialFlow = automationWorkflow({
    db: f.db,
    run: trial,
    signal: new AbortController().signal,
    browser,
    report: (...args) => f.runtime.report(...args),
  });
  const saved = await trialFlow.call(f.id, trial.id, 'save_source_recipe', {
    entry: {kind: 'url_template', template},
    terms: ['Find homes'],
    pagination: 'url_param',
  });
  assert.equal(saved.status, 'verified');
  f.db.observe(f.id, trial.id, source, 'Listings');
  await trialFlow.call(f.id, trial.id, 'finish_automation_run', {
    status: 'completed',
    summary: 'Recipe saved',
  });
  await f.runtime.finish(f.id, 'completed', 'Recipe saved', trial.workerId);
  await f.runtime.tick();
  f.advance(31);
  await f.runtime.tick();
  await settle();
  const scan = f.launches[1];
  assert.equal(scan.kind, 'run');
  const flow = automationWorkflow({
    db: f.db,
    run: scan,
    signal: new AbortController().signal,
    browser,
    report: (...args) => f.runtime.report(...args),
  });
  opened.length = 0;
  const capped = await settleTask(
    flow,
    f.id,
    scan.id,
    await flow.call(f.id, scan.id, 'browser_jev_run', {operation: 'scan_results', url: expected}),
  );
  return {f, scan, flow, opened, expected, capped};
}

test('a single search reads at most its 10-page limit and ends there', async (t) => {
  const {f, scan, flow, opened, expected, capped} = await scanAfterTrial(t, {pages: 11});
  assert.equal(f.db.run(scan.id).scanPlan.pageCap, SCAN_SEARCH_PAGES);
  assert.equal(capped.status, 'completed');
  assert.equal(capped.pageCapReached, true);
  assert.equal(capped.pageCount, 10);
  assert.match(capped.next, /Search limit reached/);
  assert.equal(
    opened.filter((u) => u.startsWith(expected)).length,
    10,
    'the eleventh page was never opened',
  );
  await reviewQueue(flow, f, scan, expected + '&start=10');
  assert.equal(
    f.db.run(scan.id).scanPlan.boundary?.pageCap,
    true,
    'queue updates keep the page-cap boundary',
  );
  f.db.spendStep(f.id, scan.id);
  f.db.observe(f.id, scan.id, expected + '&start=10', 'Second page');
  assert.ok(await flow.call(f.id, scan.id, 'complete_scan_search', {completion: 'end'}));
  await flow.call(f.id, scan.id, 'finish_automation_run', {
    status: 'completed',
    summary: 'First pages covered',
    scan: {
      complete: true,
      pendingUrls: [],
      reason: 'Page cap',
      evidenceUrl: expected + '&start=10',
      completion: 'end',
    },
  });
  await f.runtime.finish(f.id, 'completed', 'First pages covered', scan.workerId);
  const state = f.db.sources(f.id)[0].scanState;
  assert.equal(state.active, null);
  assert.equal(state.lastCompleted.completion, 'end');
  assert.ok(state.lastFullScanAt);
});

test('a search ends with the page that brings its new listings to 100', async (t) => {
  const {opened, expected, capped} = await scanAfterTrial(t, {pages: 6, listings: 40});
  assert.equal(capped.pageCapReached, true);
  assert.equal(capped.pageCount, 3, '40 + 40 + 40 new listings reach the limit on page 3');
  assert.equal(opened.filter((u) => u.startsWith(expected)).length, 3);
});

test('each recipe term is its own search: completing one opens the next with a fresh page cap', async (t) => {
  const f = fixture(t);
  f.db.enable(f.id);
  await f.runtime.tick();
  await settle();
  const ops = replayUrl(template, {query: 'ops', location: 'Berlin'}),
    dev = replayUrl(template, {query: 'dev', location: 'Berlin'});
  const boards = [jevBrowser(ops, {pages: 12}), jevBrowser(dev, {pages: 12})];
  let last = ops;
  const browser = {
    hasPage: () => true,
    evaluateJev: boards[0].browser.evaluateJev,
    async call(id, name, args) {
      const url = args.url ?? last;
      if (name === 'browser_navigate') last = url;
      return boards[url.startsWith(dev) ? 1 : 0].browser.call(id, name, {...args, url});
    },
  };
  const trial = f.launches[0],
    trialFlow = automationWorkflow({
      db: f.db,
      run: trial,
      signal: new AbortController().signal,
      browser,
      report: (...args) => f.runtime.report(...args),
    });
  assert.equal(
    (
      await trialFlow.call(f.id, trial.id, 'save_source_recipe', {
        entry: {kind: 'url_template', template},
        terms: ['ops', 'dev'],
        pagination: 'url_param',
      })
    ).status,
    'verified',
  );
  f.db.observe(f.id, trial.id, source, 'Listings');
  await trialFlow.call(f.id, trial.id, 'finish_automation_run', {
    status: 'completed',
    summary: 'Recipe saved',
  });
  await f.runtime.finish(f.id, 'completed', 'Recipe saved', trial.workerId);
  await f.runtime.tick();
  f.advance(31);
  await f.runtime.tick();
  await settle();
  const scan = f.launches[1],
    flow = automationWorkflow({
      db: f.db,
      run: scan,
      signal: new AbortController().signal,
      browser,
      report: (...args) => f.runtime.report(...args),
    });
  assert.deepEqual(
    f.db.run(scan.id).scan.work.searches.map((s) => [s.label, s.url, s.status]),
    [
      ['ops', ops, 'pending'],
      ['dev', dev, 'pending'],
    ],
  );
  const cover = async (url) => {
    const capped = await settleTask(
      flow,
      f.id,
      scan.id,
      await flow.call(f.id, scan.id, 'browser_jev_run', {operation: 'scan_results', url}),
    );
    assert.equal(capped.pageCapReached, true);
    assert.equal(capped.pageCount, 10, 'each search has its own 10-page limit');
    const queue = await flow.call(f.id, scan.id, 'get_scan_queue', {view: 'entries'});
    f.db.saveScanProgress(
      f.id,
      scan.id,
      {pendingUrls: [], processedUrls: queue.pendingUrls, reason: 'Reviewed'},
      {url: url + '&start=10', text: ''},
    );
    f.db.spendStep(f.id, scan.id);
    f.db.observe(f.id, scan.id, url + '&start=10', 'Second page');
    return flow.call(f.id, scan.id, 'complete_scan_search', {completion: 'end'});
  };
  const first = await cover(ops);
  assert.equal(first.activeSearchId, 'replay-2');
  assert.match(first.next, new RegExp(dev.replace(/[?.+]/g, '\\$&')));
  assert.equal(
    f.db.run(scan.id).scanPlan.boundary,
    null,
    'the finished search page cap does not end the next search',
  );
  await assert.rejects(
    flow.call(f.id, scan.id, 'finish_automation_run', {
      status: 'completed',
      summary: 'Only ops',
      scan: {
        complete: true,
        pendingUrls: [],
        reason: 'Page cap',
        evidenceUrl: ops + '&start=10',
        completion: 'end',
      },
    }),
    /Not all saved searches/,
  );
  const second = await cover(dev);
  assert.equal(second.next, undefined);
  // Pages beyond the page cap stay unread, so the agent reports a partial scan
  // without addresses and an unopened evidence page.
  await flow.call(f.id, scan.id, 'finish_automation_run', {
    status: 'completed',
    summary: 'Both terms covered',
    scan: {
      complete: false,
      pendingUrls: [],
      reason: 'Page cap',
      evidenceUrl: dev + '&start=90',
      completion: 'cutoff',
    },
  });
  await f.runtime.finish(f.id, 'completed', 'Both terms covered', scan.workerId);
  // The searches' verified ends decide; a wrong word from the agent is ignored.
  assert.equal(f.db.run(scan.id).scan.complete, true);
  assert.equal(f.db.run(scan.id).scan.completion, 'end');
  assert.equal(f.db.sources(f.id)[0].scanState.lastCompleted.completion, 'end');
});

test('a detail page with its own page counter does not move the search or lift its page cap', async (t) => {
  const f = fixture(t);
  f.db.enable(f.id);
  await f.runtime.tick();
  await settle();
  const expected = 'https://board.test/jobs/search?q=Find+homes&l=Berlin&sort=date',
    board = jevBrowser(expected, {pages: 16});
  // Company pages linked from results show "Page 1 of 9" like a results board.
  const browser = {
    ...board.browser,
    async call(id, name, args) {
      const result = await board.browser.call(id, name, args);
      const page = result.jevPage;
      if (!page.url.includes('/view/')) return result;
      const shown = {
        ...page,
        pagination: [{text: 'Page 1 of 9', url: null, kind: 'text', current: true}],
      };
      return {
        ...result,
        jevPage: shown,
        content: [{type: 'text', text: 'Page URL: ' + shown.url + '\n' + JSON.stringify(shown)}],
      };
    },
  };
  const trial = f.launches[0],
    trialFlow = automationWorkflow({
      db: f.db,
      run: trial,
      signal: new AbortController().signal,
      browser,
      report: (...args) => f.runtime.report(...args),
    });
  assert.equal(
    (
      await trialFlow.call(f.id, trial.id, 'save_source_recipe', {
        entry: {kind: 'url_template', template},
        terms: ['Find homes'],
        pagination: 'url_param',
      })
    ).status,
    'verified',
  );
  f.db.observe(f.id, trial.id, source, 'Listings');
  await trialFlow.call(f.id, trial.id, 'finish_automation_run', {
    status: 'completed',
    summary: 'Recipe saved',
  });
  await f.runtime.finish(f.id, 'completed', 'Recipe saved', trial.workerId);
  await f.runtime.tick();
  f.advance(31);
  await f.runtime.tick();
  await settle();
  const scan = f.launches[1],
    flow = automationWorkflow({
      db: f.db,
      run: scan,
      signal: new AbortController().signal,
      browser,
      report: (...args) => f.runtime.report(...args),
    });
  const capped = await settleTask(
    flow,
    f.id,
    scan.id,
    await flow.call(f.id, scan.id, 'browser_jev_run', {operation: 'scan_results', url: expected}),
  );
  assert.equal(capped.pageCapReached, true);
  assert.equal(f.db.run(scan.id).scanPlan.boundary?.pageCap, true, 'the cap is set');
  const position = f.db.run(scan.id).pageProgress;
  await settleTask(
    flow,
    f.id,
    scan.id,
    await flow.call(f.id, scan.id, 'browser_jev_run', {
      operation: 'collect_details',
      fromTaskId: capped.taskId,
    }),
  );
  assert.equal(
    f.db.run(scan.id).scanPlan.boundary?.pageCap,
    true,
    'reading details keeps the page cap',
  );
  assert.deepEqual(
    f.db.run(scan.id).pageProgress,
    position,
    'reading details keeps the search position',
  );
  const queue = await flow.call(f.id, scan.id, 'get_scan_queue', {view: 'entries'});
  assert.ok(
    !queue.pendingUrls.some(
      (u) =>
        u.includes('/view/') &&
        f.db.run(scan.id).scan.work?.searches?.some((s) => s.pageProgress?.url === u),
    ),
    'a detail page is not a results page of the search',
  );
  await reviewQueue(flow, f, scan, expected + '&start=10');
  f.db.spendStep(f.id, scan.id);
  f.db.observe(f.id, scan.id, expected + '&start=10', 'Second page');
  assert.ok(await flow.call(f.id, scan.id, 'complete_scan_search', {completion: 'end'}));
});

test('a saved single-search scan gains the recipe searches it is missing', () => {
  const searches = [
    {term: 'a', url: 'https://b.test/s?q=a'},
    {term: 'b', url: 'https://b.test/s?q=b'},
  ];
  assert.equal(
    replayScanWork({pendingUrls: ['x']}, [searches[0]]).work,
    undefined,
    'one search needs no split',
  );
  const legacy = replayScanWork({complete: false, pendingUrls: ['https://b.test/job/1']}, searches);
  assert.deepEqual(
    legacy.work.searches.map((s) => [s.id, s.pendingUrls.length]),
    [
      ['replay-1', 1],
      ['replay-2', 0],
    ],
  );
  assert.equal(legacy.work.activeSearchId, 'replay-1');
  const stuck = {
    complete: false,
    pendingUrls: [],
    work: {
      activeSearchId: 'default',
      searches: [
        {
          id: 'default',
          label: 'Source scan',
          status: 'completed',
          completion: 'end',
          pendingUrls: [],
          processedUrls: ['p'],
          pageProgress: null,
          plan: null,
        },
      ],
    },
  };
  const resumed = replayScanWork(stuck, searches);
  assert.deepEqual(
    resumed.work.searches.map((s) => [s.id, s.status]),
    [
      ['default', 'completed'],
      ['replay-1', 'pending'],
      ['replay-2', 'pending'],
    ],
  );
  assert.equal(
    resumed.work.activeSearchId,
    'replay-1',
    'a completed single search no longer blocks the remaining terms',
  );
  assert.deepEqual(
    replayScanWork(resumed, searches).work.searches.length,
    3,
    'held searches are not added twice',
  );
});

test('a changed search method restarts the results pages but keeps queued listings', async (t) => {
  const f = fixture(t);
  f.db.saveSource(f.id, source, {
    recipe: {entry: {kind: 'url_template', template}, pagination: 'url_param'},
  });
  const results = replayUrl(template, {query: 'Find homes', location: 'Berlin'}),
    oldPage = results + '&start=650',
    details = ['https://board.test/jobs/view/1', 'https://board.test/jobs/view/2'];
  const plan = {
    id: 'plan',
    scopeKey: sourceScanScope(f.db.get(f.id), source),
    mode: 'full',
    startedAt: 1,
    checkpoint: {url: oldPage, pendingUrls: [...details, oldPage], at: 2},
    order: {url: oldPage},
    boundary: null,
    pageCap: 30,
  };
  const scan = {
    pendingUrls: [...details, oldPage],
    work: {
      activeSearchId: 'default',
      searches: [
        {
          id: 'default',
          label: 'Source scan',
          status: 'pending',
          pendingUrls: [...details, oldPage],
          processedUrls: [],
          pageProgress: {url: oldPage, currentPage: 27},
          plan,
        },
      ],
    },
  };
  const a = f.db.get(f.id);
  f.db.put({
    ...a,
    sourceState: {
      ...a.sourceState,
      [source]: {
        ...a.sourceState?.[source],
        pageProgress: {url: oldPage, currentPage: 27},
        observedPage: {url: oldPage, currentPage: 27},
        scan,
        scanState: {scopeKey: plan.scopeKey, active: plan},
      },
    },
  });
  const queue = f.db.store.workspaces.tasks,
    task = queue.enqueue(f.id, {
      operation: 'run',
      sourceUrl: source,
      lockKey: 'workspace',
      capability: 'browser.observe',
      scan,
      scanPlan: plan,
    });
  f.db.saveSource(f.id, source, {
    recipe: {
      entry: {kind: 'url_template', template},
      pagination: 'next_link',
      notes: 'Sorted by date',
    },
  });
  let state = f.db.get(f.id).sourceState[source];
  assert.equal(state.pageProgress.currentPage, 27, 'advisory fields leave the scan position alone');
  const guest = 'https://board.test/api/search?q={query}&l={location}';
  f.db.saveSource(f.id, source, {
    recipe: {entry: {kind: 'url_template', template: guest}, pagination: 'url_param'},
  });
  state = f.db.get(f.id).sourceState[source];
  assert.equal(state.recipeState.status, 'candidate');
  assert.equal(state.pageProgress, null);
  assert.equal(state.observedPage, null);
  assert.deepEqual(
    state.scan.pendingUrls,
    details,
    'queued listings stay, the old results page leaves',
  );
  assert.deepEqual(state.scan.work.searches[0].pendingUrls, details);
  assert.equal(state.scan.work.searches[0].pageProgress, null);
  assert.equal(
    state.scanState.active.checkpoint,
    undefined,
    'the next turn starts the new recipe at its first page',
  );
  assert.equal(state.scanState.active.mode, 'full');
  assert.equal(state.scanState.active.pageCap, 30);
  assert.equal(state.scanState.active.order, null);
  const pending = queue.get(f.id, task.id);
  assert.deepEqual(pending.scan.pendingUrls, details);
  assert.equal(pending.scanPlan.checkpoint, undefined);
  assert.equal(pending.scan.work.searches[0].plan.checkpoint, undefined);
  f.db.learnSourceRecipe(
    f.id,
    source,
    {
      entry: {kind: 'search_form', url: source, fields: [{key: 'query', label: 'Suche'}]},
      pagination: 'auto',
    },
    {runId: 'run-learn', verified: true, listings: 2, pages: 1},
  );
  state = f.db.get(f.id).sourceState[source];
  assert.equal(state.recipeState.status, 'verified');
  assert.deepEqual(state.scan.pendingUrls, details, 'agent learning follows the same rule');
});
