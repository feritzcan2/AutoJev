import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {automationWorkflow} from '../app/automation/worker.mjs';
import {cardCollector, clearCardDetails} from '../app/sources/card-collector.mjs';
import {prepareCollection, collectorPageReady} from '../app/sources/collector-worker.mjs';
import {continueSourceRun, unreportedSourceRun} from '../app/automation/recovery.mjs';
import {sourceActivity} from '../app/sources/source-activity.mjs';
import {recordUrlKey} from '../app/records/identity.mjs';
import linkedin, {
  linkedInSearchUrl,
  linkedInSignedInSearch,
  readLinkedInPosting,
  collectLinkedInPosting,
  collectLinkedInResults,
} from '../app/site-extensions/linkedin.mjs';
import {readSiteExtension} from '../app/site-extensions/index.mjs';

const longText = 'POSTING_IN_BROWSER Build reliable APIs. '.repeat(10);
// A signed-in results page as the page reader leaves it: marked listing links
// with the fields the site's results reader found.
const signedInPage = (url, ids) => ({
  url,
  siteExtension: 'linkedin',
  reading: {readiness: {loading: false}},
  links: [
    {text: 'Feed', url: 'https://www.linkedin.com/feed/', listing: false},
    ...ids.map((id) => ({
      id,
      url: `https://www.linkedin.com/jobs/view/${id}/`,
      text: 'Engineer ' + id,
      title: 'Engineer ' + id,
      company: 'Acme',
      location: 'Berlin',
      listing: true,
    })),
  ],
  pagination: [{text: '1', url, current: true}],
});
// A synthetic signed-in LinkedIn in the browser: a results page of `cards`
// postings, and each posting's page with its listing text (posting(url)).
// pane(url) answers a pane read on the results page (none by default).
function fakeLinkedIn({cards = 3, posting = null, pane = null} = {}) {
  const opened = [],
    clicked = [];
  const call = async (_id, name, args) => {
    if (name === 'browser_read_pane') {
      clicked.push(args.url);
      return pane?.(args.url) ?? {status: 'unsupported'};
    }
    if (name === 'browser_navigate') opened.push(args.url);
    const url = args.url ?? opened.at(-1);
    if (url.includes('/jobs/search-results/'))
      return {
        jevPage: signedInPage(
          url,
          Array.from({length: cards}, (_, i) => String(4200000001 + i)),
        ),
      };
    return {
      jevPage: posting?.(url) ?? {
        url,
        reading: {readiness: {loading: false}},
        listing: {
          text: 'Backend role ' + longText,
          fields: {company: 'Acme'},
          title: 'Staff Engineer',
        },
      },
    };
  };
  return {call, opened, clicked};
}

test('a card collector reads only wanted listings once, drops removed ones and lists unreadable ones', async () => {
  clearCardDetails();
  const reads = [],
    url = (k) => 'https://cards.test/job/' + k;
  const collector = cardCollector({
    templateId: 'job-search',
    searchUrl: (u) => u,
    readCards: async (u) => ({
      url: u,
      jobs: ['a', 'b', 'c', 'd'].map((k) => ({url: url(k), title: k})),
      page: 1,
      totalPages: null,
      nextUrl: null,
      complete: true,
    }),
    readListing: async (u) => {
      reads.push(u);
      if (u === url('c')) throw Object.assign(Error('Removed'), {status: 410});
      if (u === url('d')) throw Error('Broken markup');
      return {url: u, title: 'Role', description: 'Text of ' + u};
    },
    detail: (job) => job,
  });
  assert.equal(collector.cards, true);
  const wanted = (urls) => urls.filter((u) => u !== url('a'));
  const steps = [];
  const page = await collector.readPage('https://cards.test/search', {
    wanted,
    progress: (step) => steps.push(`${step.done + 1}/${step.total} ${step.title}`),
  });
  assert.deepEqual(steps, ['1/3 b', '2/3 c', '3/3 d'], 'each wanted listing reports its turn');
  assert.deepEqual(
    page.jobs.map((j) => [j.url, Boolean(j.description)]),
    [
      [url('a'), false],
      [url('b'), true],
    ],
    'a known card is not read; a removed listing is dropped',
  );
  assert.deepEqual(
    page.unavailable.map((x) => x.url),
    [url('d')],
  );
  await collector.readPage('https://cards.test/search', {wanted});
  assert.equal(reads.filter((u) => u === url('b')).length, 1, 'a read listing is kept in RAM');
  const waiting = cardCollector({
    templateId: 'job-search',
    searchUrl: (u) => u,
    readCards: async (u) => ({url: u, jobs: [{url: url('e'), title: 'e'}], page: 1}),
    readListing: async () => {
      throw Object.assign(Error('Site wait'), {code: 'SITE_WAIT'});
    },
    detail: (job) => job,
  });
  await assert.rejects(
    waiting.readPage('https://cards.test/search'),
    (e) => e.code === 'SITE_WAIT',
    'a site wait stops the page instead of skipping listings',
  );
});

test('a LinkedIn search opens as the signed-in results page with its filters', () => {
  const saved = (query) => 'https://www.linkedin.com/jobs/search/?' + query;
  assert.equal(
    linkedInSignedInSearch(
      saved('keywords=Backend&location=Germany&f_WT=2&f_TPR=r604800&start=25'),
    ),
    'https://www.linkedin.com/jobs/search-results/?keywords=Backend+remote&geoId=101282230&f_TPR=r604800&start=25',
    'the location becomes its geoId and the work mode a keyword',
  );
  assert.equal(
    linkedInSignedInSearch(
      'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=Go&location=Worldwide&f_WT=2,3&sortBy=DD',
    ),
    'https://www.linkedin.com/jobs/search-results/?keywords=Go+remote+hybrid&geoId=92000000',
    'a guest search saved before 2026-10-19 opens the same way; the sort is dropped',
  );
  assert.equal(
    linkedInSignedInSearch(saved('keywords=Go&location=Berlin&geoId=106967730')),
    'https://www.linkedin.com/jobs/search-results/?keywords=Go&geoId=106967730',
    'a saved geoId wins',
  );
  assert.equal(
    linkedInSignedInSearch(saved('keywords=Go&location=Berlin%2C+Germany')),
    'https://www.linkedin.com/jobs/search-results/?keywords=Go&geoId=101282230',
    'a city searches its country',
  );
  assert.throws(
    () => linkedInSignedInSearch(saved('keywords=Go&location=Atlantis')),
    /only as a geoId.*Atlantis/,
  );
  for (const location of ['Netherlands', 'the netherlands', 'Amsterdam, Netherlands'])
    assert.equal(
      new URL(
        linkedInSignedInSearch(saved('keywords=Go&location=' + encodeURIComponent(location))),
      ).searchParams.get('geoId'),
      '102890719',
      location,
    );
  assert.equal(
    new URL(
      linkedInSignedInSearch(saved('keywords=Go&location=Z%C3%BCrich%2C+Switzerland')),
    ).searchParams.get('geoId'),
    '106693272',
  );
  assert.throws(
    () => linkedInSignedInSearch(saved('keywords=Go&location=New+Jersey')),
    /no known one/,
    'a place is not guessed from a word it shares with a country',
  );
  assert.equal(
    new URL(linkedInSearchUrl(saved('keywords=Go&start=40'))).searchParams.get('start'),
    null,
    'a saved search starts at its first page',
  );
  assert.throws(() => linkedInSearchUrl('https://www.linkedin.com/jobs/'), /search recipe/);
});

const evaluate = async (state, questions) => ({
  answers: Object.fromEntries(
    Object.entries(questions).map(([name, q]) => {
      const keys = Object.keys(q.criteria),
        choice =
          name === 'fit' && keys.includes('possible')
            ? 'possible'
            : name === 'support' && keys.includes('supported')
              ? 'supported'
              : keys.find((k) => k !== 'irrelevant');
      return [
        name,
        {
          choice,
          confidence: 1,
          probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? 1 : 0])),
        },
      ];
    }),
  ),
  usage: {input_tokens: 5, output_tokens: 1},
});
function fixture(t, {browserCall = null, site = fakeLinkedIn(), decisions = 'jev'} = {}) {
  clearCardDetails();
  const core = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(core),
    source = 'https://www.linkedin.com/jobs/';
  t.after(() => core.close());
  const a = db.create('job-search', {
    goal: 'backend',
    criteria: {preferences: 'Germany'},
    sources: [source],
    agentSettings: {provider: 'codex', decisions},
  });
  db.saveSource(a.id, source, {
    recipe: {
      entry: {
        kind: 'url_template',
        template: 'https://www.linkedin.com/jobs/search/?keywords={query}&location=Germany&f_WT=2',
      },
      terms: ['Backend'],
      pagination: 'url_param',
    },
  });
  db.review(a.id);
  db.skipTrial(a.id);
  db.enable(a.id);
  const task = core.workspaces.tasks.enqueue(a.id, {
      sourceUrl: source,
      operation: 'scan',
      sources: [source],
      lockKey: 'source:' + source,
    }),
    run = db.begin(a.id, {kind: 'run', taskId: task.id});
  prepareCollection(db, run, db.get(a.id));
  // The test does not wait out the real pacing.
  db.siteAccess.pace = () => 0;
  const flow = automationWorkflow({
    db,
    run: db.run(run.id),
    signal: new AbortController().signal,
    browser: {
      evaluateJev: (_id, state, questions) => evaluate(state, questions),
      hasPage: () => false,
      call: browserCall ?? site.call,
    },
    report: (...args) => db.finish(...args),
  });
  return {
    db,
    id: a.id,
    runId: run.id,
    site,
    flow,
    call: (name, args = {}) => flow.call(a.id, run.id, name, args),
  };
}

test('the app reads a card page and its postings before the agent; the agent call reads nothing', async (t) => {
  const f = fixture(t);
  assert.equal(collectorPageReady(f.db, f.runId), false);
  await f.flow.prefetchCollector();
  assert.equal(collectorPageReady(f.db, f.runId), true);
  assert.equal(f.site.opened.length, 4, 'one result page and three postings');
  const before = f.site.opened.length,
    result = await f.call('collect_source_page');
  assert.ok(result.taskId, JSON.stringify(result).slice(0, 300));
  assert.equal(f.site.opened.length, before, 'the agent call does not read the site');
  const task = f.db.jevTasks.get(f.id, f.db.run(f.runId).taskId, result.taskId);
  assert.equal(task.items.length, 3);
  assert.ok(task.items.every((i) => i.collected && i.detailComplete));
});

test('without a ready page the agent ends its turn and resumes at once after the app reads it', async (t) => {
  const f = fixture(t);
  const result = await f.call('collect_source_page');
  assert.equal(result.status, 'background_read');
  assert.match(result.next, /End this turn now/);
  assert.equal(f.site.opened.length, 0, 'the agent call does not read the site');
  assert.equal(f.db.run(f.runId).collectorReading, true);
  assert.equal(continueSourceRun(f.db, f.id, f.runId), null, 'no idle nudge');
  const outcome = unreportedSourceRun(f.db, f.id, f.runId, 'idle', 1000);
  assert.equal(outcome.status, 'interrupted');
  assert.deepEqual(f.db.run(f.runId).recovery, {
    reason: 'collector_read',
    attempt: 0,
    readyAt: 1000,
  });
});

test('a site wait parks the card source instead of sending the agent away', async (t) => {
  const f = fixture(t);
  f.db.siteAccess.block('https://www.linkedin.com/', 'rate_limit');
  const result = await f.call('collect_source_page');
  assert.notEqual(result.status, 'background_read');
  assert.equal(f.db.run(f.runId).status, 'blocked');
  assert.equal(f.db.run(f.runId).siteWait.reason, 'rate_limit');
  assert.equal(f.site.opened.length, 0);
});

test('with agent decisions the agent chooses from the cards which postings are read', async (t) => {
  const site = fakeLinkedIn({cards: 4}),
    f = fixture(t, {site, decisions: 'agent'});
  await f.flow.prefetchCollector();
  assert.equal(site.opened.length, 1, 'only the results page opens before the choice');
  assert.equal(collectorPageReady(f.db, f.runId), true, 'the cards wait for the agent');
  const offer = await f.call('collect_source_page');
  assert.equal(offer.status, 'cards_ready');
  assert.deepEqual(offer.cardSelection.cards[0], {
    item: 1,
    title: 'Engineer 4200000001',
    company: 'Acme',
    location: 'Berlin',
  });
  assert.equal(offer.cardSelection.cards.length, 4);
  assert.equal(site.opened.length, 1, 'offering the cards reads nothing');
  await assert.rejects(
    f.call('collect_source_page', {selectionId: 'wrong', selected: [1]}),
    new RegExp(offer.cardSelection.selectionId),
  );
  const answer = await f.call('collect_source_page', {
    selectionId: offer.cardSelection.selectionId,
    selected: [1, 3],
    review: [{item: 2, decision: 'reject', reason: 'A sales role, not engineering.'}],
  });
  assert.deepEqual(answer.cardsChosen, {read: 2, rejected: 1, skipped: 1});
  assert.equal(answer.status, 'background_read', 'the chosen postings are read between turns');
  await f.flow.prefetchCollector();
  assert.deepEqual(site.opened.slice(1), [
    'https://www.linkedin.com/jobs/view/4200000001/',
    'https://www.linkedin.com/jobs/view/4200000003/',
  ]);
  const batch = await f.call('collect_source_page'),
    task = f.db.jevTasks.get(f.id, f.db.run(f.runId).taskId, batch.taskId);
  assert.deepEqual(
    task.items.map((item) => item.url),
    [
      'https://www.linkedin.com/jobs/view/4200000001/',
      'https://www.linkedin.com/jobs/view/4200000003/',
    ],
  );
  const run = f.db.run(f.runId);
  assert.equal(run.scan.reviewStats.agentRejected, 1);
  assert.deepEqual(
    f.db.seenListingUrls(f.id, run.sourceUrl, [
      'https://www.linkedin.com/jobs/view/4200000002/',
      'https://www.linkedin.com/jobs/view/4200000004/',
    ]),
    ['https://www.linkedin.com/jobs/view/4200000002/'],
    'a rejected card is not offered again; a card left out is, in a later round',
  );
});

test('cards that show no title are read without asking the agent', async (t) => {
  const site = fakeLinkedIn({cards: 2}),
    call = async (id, name, args) => {
      const result = await site.call(id, name, args);
      if (result?.jevPage?.links)
        for (const link of result.jevPage.links) if (link.listing) link.title = '';
      return result;
    },
    f = fixture(t, {site, browserCall: call, decisions: 'agent'});
  await f.flow.prefetchCollector();
  assert.equal(site.opened.length, 3, 'the results page and both postings');
  const batch = await f.call('collect_source_page');
  assert.ok(batch.taskId, JSON.stringify(batch).slice(0, 300));
});

test('the LinkedIn posting reader needs a title and a real description', () => {
  assert.equal(readLinkedInPosting({title: 'Role', description: 'Sign in to view'}), null);
  assert.equal(readLinkedInPosting({title: '', description: longText}), null);
  const job = readLinkedInPosting({
    title: 'Staff Engineer',
    company: 'Acme',
    location: 'Berlin',
    description: longText,
    closed: true,
  });
  assert.equal(job.company, 'Acme');
  assert.equal(job.closed, true);
  assert.equal(
    readLinkedInPosting({title: 'Role', description: longText + '\n\n... more'}).description,
    longText.trim(),
    'the expand button is not part of the description',
  );
});

test('the LinkedIn posting reader reads the signed-in layout without named classes', () => {
  const about = {
    innerText: 'Build 𝐫𝐞𝐥𝐢𝐚𝐛𝐥𝐞 APIs.\n\n\n\n\nKafka.',
    getAttribute: () => 'JobDetails_AboutTheJob_4478132255',
  };
  const saved = {document: globalThis.document, location: globalThis.location};
  globalThis.location = {href: 'https://www.linkedin.com/jobs/view/4478132255/'};
  globalThis.document = {
    title: '𝐒𝐭𝐚𝐟𝐟 𝐄𝐧𝐠𝐢𝐧𝐞𝐞𝐫 - Berlin | Xcede | LinkedIn',
    body: {innerText: ''},
    querySelector: (selector) =>
      selector.startsWith('[componentkey^="JobDetails_AboutTheJob_"]') ? about : null,
  };
  try {
    assert.deepEqual(collectLinkedInPosting(), {
      url: 'https://www.linkedin.com/jobs/view/4478132255/',
      key: '4478132255',
      title: 'Staff Engineer - Berlin',
      company: 'Xcede',
      location: '',
      description: 'Build reliable APIs.\n\nKafka.',
      closed: false,
      people: [],
    });
    globalThis.document.title = 'DevOps Engineer | 150k € all-in! | Acme Group | LinkedIn';
    assert.deepEqual(
      [collectLinkedInPosting().title, collectLinkedInPosting().company],
      ['DevOps Engineer | 150k € all-in!', 'Acme Group'],
    );
    globalThis.document.title = 'Sign in | LinkedIn';
    assert.equal(collectLinkedInPosting().title, '', 'a tab title without a company is no posting');
  } finally {
    Object.assign(globalThis, saved);
  }
});

test('a site posting reader gives an opened posting its listing text', async () => {
  const url = 'https://www.linkedin.com/jobs/view/staff-engineer-at-acme-4100000000/';
  const slot = {
    page: {
      evaluate: async (fn) =>
        fn === linkedin.dom.listing.collect
          ? {
              url,
              title: 'Staff Engineer',
              company: 'Acme',
              location: 'Berlin',
              description: longText,
            }
          : null,
    },
  };
  const read = await readSiteExtension(slot, {url, text: 'chrome and posting'});
  assert.match(read.siteListing.text, /Staff Engineer @ Acme/);
  assert.match(read.siteListing.text, /POSTING_IN_BROWSER/);
  assert.equal(read.siteListing.fields.company, 'Acme');
  const other = await readSiteExtension(
    {page: {evaluate: async () => ({url: url + 'x', title: 'T', description: longText})}},
    {url, text: ''},
  );
  assert.equal(other.siteListing, undefined, 'a read across a redirect is dropped');
});

test('a card collector reads its listings through a reader the app supplies', async () => {
  clearCardDetails();
  const collector = cardCollector({
    templateId: 'job-search',
    searchUrl: (u) => u,
    readCards: async (u) => ({url: u, jobs: [{url: 'https://cards.test/job/x', title: 'x'}]}),
    readListing: async () => {
      throw Error('The HTTP reader is not used');
    },
    listingIn: 'browser',
    detail: (job) => job,
  });
  assert.equal(collector.listingIn, 'browser');
  await assert.rejects(
    collector.readDetail('https://cards.test/job/y'),
    /read in the browser/,
    'without the browser a listing is not read over HTTP',
  );
  const page = await collector.readPage('https://cards.test/s', {
    readListing: async (u) => ({url: u, description: 'from the browser'}),
  });
  assert.equal(page.jobs[0].description, 'from the browser');
  assert.equal(collector.hasDetail('https://cards.test/job/x'), true);
});

test('LinkedIn results pages and postings open in the signed-in browser before the agent', async (t) => {
  const f = fixture(t);
  await f.flow.prefetchCollector();
  assert.equal(
    f.site.opened[0],
    'https://www.linkedin.com/jobs/search-results/?keywords=Backend+remote&geoId=101282230',
    'the search opens signed in with its location and work mode',
  );
  assert.deepEqual(f.site.opened.slice(1), [
    'https://www.linkedin.com/jobs/view/4200000001/',
    'https://www.linkedin.com/jobs/view/4200000002/',
    'https://www.linkedin.com/jobs/view/4200000003/',
  ]);
  assert.equal(
    sourceActivity(f.runId).step,
    'agent',
    'once the batch is ready the Sources page shows the agent at work',
  );
  const task = f.db.jevTasks.list(f.id, f.db.run(f.runId).taskId).at(-1);
  assert.deepEqual(
    task.items.map((item) => item.title),
    ['Staff Engineer', 'Staff Engineer', 'Staff Engineer'],
    'the posting names the listing',
  );
  assert.equal(
    f.db.db
      .prepare("SELECT count(*) AS n FROM site_requests WHERE site='linkedin.com browser'")
      .get().n,
    4,
    'results pages and postings share the browser budget',
  );
  assert.equal(f.db.sources(f.id).find((s) => s.url.includes('linkedin')).requests.budget.used, 4);
  assert.equal(collectorPageReady(f.db, f.runId), true);
});

test('LinkedIn listings are read from the results pane; a card the pane does not show opens on its own page', async (t) => {
  const site = fakeLinkedIn({
    pane: (url) =>
      url.includes('4200000002')
        ? {status: 'not_shown'}
        : {
            status: 'read',
            listing: {
              text: 'Pane role ' + longText,
              fields: {company: 'Pane Co'},
              title: 'Pane Role',
            },
          },
  });
  const f = fixture(t, {site});
  await f.flow.prefetchCollector();
  assert.deepEqual(site.clicked, [
    'https://www.linkedin.com/jobs/view/4200000001/',
    'https://www.linkedin.com/jobs/view/4200000002/',
    'https://www.linkedin.com/jobs/view/4200000003/',
  ]);
  assert.deepEqual(
    site.opened.slice(1),
    ['https://www.linkedin.com/jobs/view/4200000002/'],
    'only the listing the pane did not show opens, after the pane reads',
  );
  const task = f.db.jevTasks.list(f.id, f.db.run(f.runId).taskId).at(-1);
  assert.deepEqual(
    task.items.map((item) => item.title),
    ['Pane Role', 'Staff Engineer', 'Pane Role'],
  );
  const count = (key) =>
    f.db.db.prepare('SELECT count(*) AS n FROM site_requests WHERE site=?').get(key).n;
  assert.equal(count('linkedin.com pane'), 3, 'card clicks keep their own budget');
  assert.equal(count('linkedin.com browser'), 2, 'the results page and one posting');
});

test('the hiring team a listing shows becomes listed contacts of its new record', async (t) => {
  const people = [
    {
      name: 'Evgenia Recruiter',
      profileUrl: 'https://www.linkedin.com/in/evgenia-r/',
      headline: 'Senior Recruiter',
      hiringTeam: true,
      insight: '2nd-degree connection',
    },
    {
      name: 'Bertan Engineer',
      profileUrl: 'https://www.linkedin.com/in/bertan-e/',
      headline: 'Senior Software Engineer',
      hiringTeam: false,
      insight: 'School alum from Example University',
    },
  ];
  const site = fakeLinkedIn({
    cards: 1,
    pane: () => ({
      status: 'read',
      listing: {text: 'Pane role ' + longText, fields: {}, title: 'Pane Role', people},
    }),
  });
  const f = fixture(t, {site});
  await f.flow.prefetchCollector();
  await f.call('collect_source_page');
  const url = 'https://www.linkedin.com/jobs/view/4200000001/',
    save = (summary) =>
      f.call('record_automation_result', {
        url,
        title: 'Pane Role',
        summary,
        score: 80,
        eligibility: 'unverified',
      });
  await save('Fits');
  const item = f.db.results(f.id).find((r) => r.url === url),
    entry = f.db.get(f.id).recordContacts.find((e) => e.recordId === item.id);
  assert.deepEqual(
    entry.contacts.map((c) => [c.name, c.relation, c.state, c.profileUrl]),
    [
      ['Evgenia Recruiter', 'hiring_team', 'listed', 'https://www.linkedin.com/in/evgenia-r/'],
      ['Bertan Engineer', 'suggested', 'listed', 'https://www.linkedin.com/in/bertan-e/'],
    ],
  );
  assert.match(entry.contacts[1].reason, /School alum/);
  assert.equal(entry.state, undefined, 'no contact search ran');
  f.db.put({...f.db.get(f.id), recordContacts: []});
  await save('Fits again');
  assert.deepEqual(f.db.get(f.id).recordContacts, [], 'a record saved again keeps its removal');
});

test('the LinkedIn posting reader keeps the people the posting shows', () => {
  const job = readLinkedInPosting({
    title: 'Role',
    description: longText,
    people: [
      {
        name: 'Jane',
        profileUrl: 'https://www.linkedin.com/in/jane/',
        headline: 'Recruiter',
        degree: '2nd',
        insight: '',
        hiringTeam: true,
      },
      {name: '', profileUrl: 'https://www.linkedin.com/in/x/'},
    ],
  });
  assert.deepEqual(job.people, [
    {
      name: 'Jane',
      profileUrl: 'https://www.linkedin.com/in/jane/',
      headline: 'Recruiter',
      hiringTeam: true,
      insight: '2nd-degree connection',
    },
  ]);
  const saved = {document: globalThis.document, location: globalThis.location};
  const node = (innerText, parentElement, extra = {}) => ({innerText, parentElement, ...extra});
  const section = node('People you can reach out to\nMeet the hiring team\nJane Doe', null),
    team = node('Meet the hiring team\nJane Doe\n• 2nd\nRecruiter at Acme\nMessage', section),
    other = node('Bob Roe\n• 3rd+\nEngineer at Acme\nSchool alum from Example U', section);
  const links = [
    node('Jane Doe\n• 2nd\nRecruiter at Acme', team, {
      href: 'https://www.linkedin.com/in/jane-doe/?trk=x',
    }),
    node('', team, {href: 'https://www.linkedin.com/in/jane-doe/'}),
    node('Bob Roe\n• 3rd+\nEngineer at Acme\nSchool alum from Example U', other, {
      href: 'https://www.linkedin.com/in/bob-roe/',
    }),
  ];
  section.querySelectorAll = () => links;
  globalThis.location = {href: 'https://www.linkedin.com/jobs/search-results/?currentJobId=1'};
  globalThis.document = {
    title: 'Role | Acme | LinkedIn',
    body: {innerText: ''},
    querySelector: (selector) =>
      selector.startsWith('[componentkey^="JobDetailsPeopleWhoCanHelpSlot_"]') ? section : null,
  };
  try {
    assert.deepEqual(collectLinkedInPosting().people, [
      {
        name: 'Jane Doe',
        profileUrl: 'https://www.linkedin.com/in/jane-doe/',
        degree: '2nd',
        headline: 'Recruiter at Acme',
        insight: '',
        hiringTeam: true,
      },
      {
        name: 'Bob Roe',
        profileUrl: 'https://www.linkedin.com/in/bob-roe/',
        degree: '3rd+',
        headline: 'Engineer at Acme',
        insight: 'School alum from Example U',
        hiringTeam: false,
      },
    ]);
  } finally {
    Object.assign(globalThis, saved);
  }
});

test('a click that leaves the results page ends pane reads for that page', async (t) => {
  const site = fakeLinkedIn({pane: () => ({status: 'left_results'})});
  const f = fixture(t, {site});
  await f.flow.prefetchCollector();
  assert.equal(site.clicked.length, 1);
  assert.equal(site.opened.length, 4, 'the other listings open on their own pages');
});

test('a posting that opens as a login prompt stays out of the batch', async (t) => {
  const f = fixture(t, {
    site: fakeLinkedIn({
      posting: (url) => ({url, reading: {readiness: {loading: false}}}),
    }),
  });
  await f.flow.prefetchCollector();
  const run = f.db.run(f.runId),
    task = f.db.jevTasks.list(f.id, run.taskId).at(-1);
  assert.equal(task.items.length, 0);
  assert.equal(task.unavailable.length, 3);
  assert.match(task.unavailable[0].message, /no listing text/);
});

test('a posting that redirects to a sign-in page says the browser may need to sign in', async (t) => {
  const f = fixture(t, {
    site: fakeLinkedIn({
      posting: () => ({url: 'https://www.linkedin.com/', reading: {readiness: {loading: false}}}),
    }),
  });
  await f.flow.prefetchCollector();
  const task = f.db.jevTasks.list(f.id, f.db.run(f.runId).taskId).at(-1);
  assert.equal(task.items.length, 0);
  assert.match(task.unavailable[0].message, /may need to sign in/);
});

test('a results page that lands on the sign-in page is a reported error, not an empty search', async (t) => {
  const f = fixture(t, {
    browserCall: async () => ({
      jevPage: {
        url: 'https://www.linkedin.com/authwall',
        reading: {readiness: {loading: false}},
      },
    }),
  });
  await f.flow.prefetchCollector();
  assert.match(f.db.run(f.runId).collectorError, /may need to sign in/);
  assert.equal(collectorPageReady(f.db, f.runId), false);
});

test('the signed-in results reader takes job IDs from list items and links and ends a short search', () => {
  const card = (id, lines) => ({
    getAttribute: (name) => (name === 'data-occludable-job-id' ? id : null),
    innerText: lines.join('\n'),
    querySelector: () => null,
  });
  const saved = {document: globalThis.document, location: globalThis.location};
  globalThis.location = {
    pathname: '/jobs/search/',
    href: 'https://www.linkedin.com/jobs/search/?keywords=Backend&start=25',
  };
  globalThis.document = {
    body: {innerText: ''},
    querySelector: () => null,
    querySelectorAll: (selector) =>
      selector.includes('data-occludable-job-id')
        ? [
            card('4300000001', ['𝐒𝐭𝐚𝐟𝐟 Engineer', 'Acme', 'Berlin (Remote)']),
            card('4300000002', []),
          ]
        : selector.includes('componentkey')
          ? [
              {
                getAttribute: () => 'job-card-component-ref-4300000003',
                parentElement: null,
                querySelector: () => null,
                innerText:
                  'Lead Developer (Verified job)\nLead Developer\n\nVALUE AG\n\nGermany (Remote)\n\nPosted 6 days ago',
              },
            ]
          : [],
  };
  try {
    const raw = collectLinkedInResults();
    assert.deepEqual(
      raw.jobs.find((job) => job.id === '4300000001'),
      {
        id: '4300000001',
        title: 'Staff Engineer',
        company: 'Acme',
        location: 'Berlin (Remote)',
      },
    );
    assert.deepEqual(
      raw.jobs.find((job) => job.id === '4300000003'),
      {
        id: '4300000003',
        title: 'Lead Developer',
        company: 'VALUE AG',
        location: 'Germany (Remote)',
      },
      'the 2026 card layout names the job in its component key',
    );
    assert.equal(
      raw.jobs.find((job) => job.id === '4300000002').title,
      '',
      'a card not rendered yet still gives its ID',
    );
    const read = linkedin.dom.results(raw);
    assert.deepEqual(read.listings.map((l) => l.url).sort(), [
      'https://www.linkedin.com/jobs/view/4300000001/',
      'https://www.linkedin.com/jobs/view/4300000002/',
      'https://www.linkedin.com/jobs/view/4300000003/',
    ]);
    assert.equal(read.pagination.length, 1, 'fewer than a full page has no next page');
    assert.equal(
      linkedin.dom.results({...raw, jobs: []}),
      null,
      'no cards and no empty-result notice is no reading',
    );
    assert.deepEqual(linkedin.dom.results({...raw, jobs: [], noResults: true}).listings, []);
    globalThis.location = {
      pathname: '/jobs/view/1/',
      href: 'https://www.linkedin.com/jobs/view/1/',
    };
    assert.equal(collectLinkedInResults(), null);
  } finally {
    Object.assign(globalThis, saved);
  }
  const search = 'https://www.linkedin.com/jobs/search/?keywords=Backend&location=Germany&start=25';
  const ids = Array.from({length: 25}, (_, i) => String(4400000000 + i));
  const cards = linkedin.collector.cardsInBrowser.read(signedInPage('x', ids), search);
  assert.equal(cards.page, 2);
  assert.equal(
    cards.nextUrl,
    'https://www.linkedin.com/jobs/search/?keywords=Backend&location=Germany&start=50',
    'the search search continues after these cards',
  );
  assert.equal(cards.jobs.length, 25);
  const last = linkedin.collector.cardsInBrowser.read(signedInPage('x', ids.slice(0, 4)), search);
  assert.equal(last.complete, true, 'a short page ends the search');
  assert.equal(linkedin.collector.cardsInBrowser.read({links: []}, search), null);
});

test('one LinkedIn posting under any address is one record key', () => {
  for (const url of [
    'https://de.linkedin.com/jobs/view/staff-engineer-at-acme-4478132255?trk=x',
    'https://www.linkedin.com/jobs/view/4478132255/',
    'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4478132255',
  ])
    assert.equal(recordUrlKey(url), 'https://www.linkedin.com/jobs/view/4478132255', url);
  assert.equal(recordUrlKey('https://example.test/job/7/'), 'https://example.test/job/7');
});
