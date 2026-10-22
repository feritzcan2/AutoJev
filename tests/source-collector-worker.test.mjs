import test from 'node:test';
import assert from 'node:assert/strict';
import {fork, spawn} from 'node:child_process';
import {once} from 'node:events';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {WebTasks} from '../app/automation/web-template.mjs';
import {automationWorkflow} from '../app/automation/worker.mjs';
import {automationPrompt} from '../app/automation/prompts.mjs';
import {
  prepareCollection,
  saveCollectionPage,
  collectSourcePage,
} from '../app/sources/collector-worker.mjs';
import {parseHimalayasPage} from '../app/site-extensions/himalayas/api.mjs';
import {SCAN_SEARCH_PAGES} from '../app/sources/recipe.mjs';
import {sourceTrialReady} from '../app/sources/trial.mjs';
import {
  readCollectorCliPage,
  readCollectorCliDetail,
} from '../app/site-extensions/himalayas/cli-client.mjs';

const source = 'https://himalayas.app/',
  // --import takes a URL; a bare C:\ path is rejected on Windows.
  fixtureModule = new URL('./fixtures/himalayas-cli-fetch.mjs', import.meta.url).href;
const url = (id) => `https://himalayas.app/companies/synthetic/jobs/${id}`;
const jobs = [
  {
    guid: url('good'),
    title: 'Backend engineer',
    companyName: 'Synthetic Co',
    locationRestrictions: Array.from({length: 200}, (_, i) => `Synthetic country ${i}`),
    description: '<p>RAM_ONLY_DESCRIPTION_9724 backend role.</p>',
    excerpt: 'Synthetic summary',
  },
  {
    guid: url('reject'),
    title: 'Dentist',
    description: '<p>DENTIST_MARKER. Dentistry licence mandatory.</p>',
    excerpt: 'Unrelated role',
  },
  {
    guid: url('uncertain'),
    title: 'Platform engineer',
    description: '<p>UNCERTAIN_MARKER. Platform responsibilities; location unclear.</p>',
    excerpt: 'Platform role',
  },
];
// Listing URLs whose full text Jev assessed.
const detailReads = [];
const evaluate = async (state, questions) => ({
  answers: Object.fromEntries(
    Object.entries(questions).map(([name, q]) => {
      const text = JSON.stringify(state);
      if (name === 'fit' && state.listing) detailReads.push(state.listing.url);
      const card = /^fit\d+$/.test(name) && state.links?.['link' + name.slice(3)];
      let choice = card
        ? card.context.includes('CARD_CONFLICT_MARKER')
          ? 'hard_constraint'
          : 'keep'
        : name === 'fit'
          ? text.includes('DENTIST_MARKER')
            ? 'mismatch'
            : text.includes('IMAGE_ONLY_MARKER')
              ? 'incomplete'
              : text.includes('UNCERTAIN_MARKER')
                ? 'uncertain'
                : 'possible'
          : name === 'support'
            ? 'supported'
            : name === 'exclusion'
              ? 'unrelated_role'
              : Object.keys(q.criteria).find((k) => k !== 'irrelevant');
      return [
        name,
        {
          choice,
          confidence: 1,
          probabilities: Object.fromEntries(
            Object.keys(q.criteria).map((k) => [k, k === choice ? 1 : 0]),
          ),
        },
      ];
    }),
  ),
  usage: {input_tokens: 10, output_tokens: 2},
});
function fixture(
  t,
  {
    readPage,
    readDetail = async () => {
      throw Error('Synthetic detail unavailable');
    },
    terms,
    ordering,
    saveScoreThreshold,
    decisions = 'jev',
  } = {},
) {
  const core = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(core);
  t.after(() => core.close());
  const a = db.create('job-search', {
    goal: 'backend',
    criteria: {
      preferences: 'Germany',
      ...(saveScoreThreshold ? {save_score_threshold: saveScoreThreshold} : {}),
    },
    sources: [source],
  });
  db.save(a.id, {agentSettings: {provider: 'codex', decisions}});
  if (terms)
    db.saveSource(a.id, source, {
      recipe: {
        entry: {kind: 'url_template', template: 'https://himalayas.app/jobs/api/search?q={query}'},
        terms,
        pagination: 'url_param',
        ...(ordering ? {ordering} : {}),
      },
    });
  db.review(a.id);
  const task = core.workspaces.tasks.enqueue(a.id, {
      sourceUrl: source,
      operation: 'scan',
      sources: [source],
      lockKey: 'source:' + source,
    }),
    run = db.begin(a.id, {kind: 'run', taskId: task.id});
  prepareCollection(db, run, db.get(a.id));
  let reads = 0,
    browserCalls = 0;
  const reader = async (value) => {
    reads++;
    return readPage
      ? readPage(value)
      : parseHimalayasPage(value, {
          jobs:
            new URL(value).searchParams.get('page') === '2'
              ? [{...jobs[0], guid: url('second')}]
              : jobs,
          offset: new URL(value).searchParams.get('page') === '2' ? 20 : 0,
          limit: 20,
          totalCount: 21,
        });
  };
  const makeFlow = (store = db, signal = new AbortController().signal, runId = run.id) =>
    automationWorkflow({
      db: store,
      run: store.run(runId),
      signal,
      collectorReadPage: reader,
      collectorReadDetail: readDetail,
      browser: {
        evaluateJev: (_id, state, questions) => {
          if (decisions === 'agent') throw Error('No model may be asked with agent decisions.');
          return evaluate(state, questions);
        },
        hasPage: () => false,
        call: () => {
          browserCalls++;
          throw Error('No browser read');
        },
      },
      report: (...args) => store.finish(...args),
    });
  const flow = makeFlow();
  return {
    core,
    db,
    id: a.id,
    run: db.run(run.id),
    flow,
    makeFlow,
    reads: () => reads,
    browserCalls: () => browserCalls,
    call: (name, args = {}) => flow.call(a.id, run.id, name, args),
  };
}
// Ends this round and starts the source's next one as a new task.
function nextRound(f) {
  f.db.finish(f.id, f.run.id, 'completed', 'Round done');
  f.core.workspaces.tasks.finish(f.id, f.run.taskId, 'completed', 'Round done');
  const task = f.core.workspaces.tasks.enqueue(f.id, {
      sourceUrl: source,
      operation: 'scan',
      sources: [source],
      lockKey: 'source:' + source,
    }),
    run = f.db.begin(f.id, {kind: 'run', taskId: task.id});
  prepareCollection(f.db, run, f.db.get(f.id));
  const flow = f.makeFlow(f.db, undefined, run.id);
  return {
    ...f,
    run: f.db.run(run.id),
    call: (name, args = {}) => flow.call(f.id, run.id, name, args),
  };
}
const helper = (f, receipt) => f.db.jevTasks.get(f.id, f.run.taskId, receipt.taskId);
async function save(f, item, score = 42) {
  return f.call('record_automation_result', {
    url: item.url,
    title: item.title,
    summary: 'Reviewed synthetic detail',
    score,
    eligibility: 'unverified',
  });
}
async function review(f, receipt, decisions = []) {
  const task = helper(f, receipt);
  return f.call('browser_run_task', {
    taskId: task.id,
    reviewedBatchId: task.batch.id,
    review: decisions,
  });
}
async function handle(f, receipt) {
  const task = helper(f, receipt);
  for (const item of task.items) if (item.assessment?.decision !== 'mismatch') await save(f, item);
  if (task.batch) await review(f, receipt);
}
function restart(f) {
  const db = new AutomationStore(f.core);
  prepareCollection(db, db.run(f.run.id), db.get(f.id));
  const flow = f.makeFlow(db);
  return {...f, db, call: (name, args = {}) => flow.call(f.id, f.run.id, name, args)};
}

test('CLI pages enter Jev triage, the agent scores retained items, and review gates page advancement', async (t) => {
  const f = fixture(t),
    first = await f.call('collect_source_page');
  assert.equal(f.db.results(f.id).length, 0);
  assert.equal(f.reads(), 1);
  assert.equal(helper(f, first).items.length, 3);
  assert.ok(
    helper(f, first).items.every((i) => i.assessment),
    JSON.stringify(first),
  );
  assert.deepEqual(
    helper(f, first).items.map((i) => i.assessment.decision),
    ['possible', 'mismatch', 'uncertain'],
  );
  await f.call('collect_source_page');
  assert.equal(f.reads(), 1);
  await assert.rejects(
    f.call('finish_automation_run', {status: 'completed', summary: 'Premature'}),
    /not finished/,
  );
  await assert.rejects(
    f.call('browser_run_task', {operation: 'scan_results', url: source}),
    /collect_source_page/,
  );
  const good = helper(f, first).items[0];
  const brief = await f.call('read_listing_brief', {evidenceId: good.evidenceId});
  assert.match(JSON.stringify(brief), /RAM_ONLY_DESCRIPTION_9724/);
  await assert.rejects(
    f.call('record_automation_result', {
      url: good.url,
      title: good.title,
      summary: 'Missing score',
    }),
    /scoring/,
  );
  await assert.rejects(save(f, helper(f, first).items[1]), /mismatch/);
  await assert.rejects(save(f, good, null), /was read/);
  await save(f, good);
  const stored = f.db.results(f.id)[0];
  assert.equal(stored.assessment.score, 42);
  assert.equal(stored.cells.location.length, 2000);
  assert.ok(stored.cells.location.endsWith('…'));
  const evidence = f.db.jevTasks.fullEvidence(f.id, f.run.taskId, good.evidenceId);
  assert.ok(evidence.text.includes('Synthetic country 199'));
  assert.ok(evidence.listing, 'API text is the listing itself; the brief needs no Jev filter');
  await assert.rejects(review(f, first), /Review not complete/);
  await save(f, helper(f, first).items[2]);
  const acknowledged = await review(f, first);
  assert.equal(acknowledged.acknowledged.status, 'completed');
  const second = acknowledged.next;
  assert.equal(f.reads(), 2, 'the finished review fetched the next page in the same call');
  assert.equal(helper(f, second).id, (await f.call('collect_source_page')).taskId);
  assert.equal(f.reads(), 2);
  await handle(f, second);
  assert.throws(() => f.db.jevTasks.fullEvidence(f.id, f.run.taskId, good.evidenceId), /expired/);
  const done = await f.call('collect_source_page');
  assert.equal(done.complete, true);
  assert.deepEqual(done.progress, {
    collected: 4,
    jevRejected: 1,
    agentRejected: 0,
    saved: 3,
    pending: 0,
  });
  assert.equal(f.db.results(f.id).length, 3);
  assert.equal(f.browserCalls(), 0);
  assert.ok(
    !JSON.stringify(f.core.db.prepare('SELECT data FROM workspace_records').all()).includes(
      'RAM_ONLY_DESCRIPTION',
    ),
  );
  assert.ok(
    !JSON.stringify(f.core.db.prepare('SELECT data FROM automation_runs').all()).includes(
      'RAM_ONLY_DESCRIPTION',
    ),
  );
  await f.call('finish_automation_run', {
    status: 'completed',
    summary: 'CLI, Jev and agent finished',
    scan: done.scan,
  });
  assert.equal(f.db.run(f.run.id).status, 'completed');
  assert.match(
    f.db.get(f.id).sourceState[source].scan.reason,
    /Collected: 4.*Rejected by Jev: 1.*Saved: 3/,
  );
});

test('with agent decisions CLI pages reach review unjudged and the agent decides every listing', async (t) => {
  const f = fixture(t, {decisions: 'agent'}),
    first = await f.call('collect_source_page');
  const items = helper(f, first).items;
  assert.deepEqual(
    items.map((i) => i.assessment.decision),
    ['uncertain', 'uncertain', 'uncertain'],
  );
  assert.match(first.next, /No listing is judged before you/);
  await save(f, items[0]);
  await save(f, items[2]);
  await assert.rejects(review(f, first), /Review not complete/);
  const acknowledged = await review(f, first, [
    {item: 2, decision: 'reject', reason: 'Not a backend role.'},
  ]);
  assert.equal(acknowledged.acknowledged.status, 'completed');
  await handle(f, acknowledged.next);
  const done = await f.call('collect_source_page');
  assert.equal(done.complete, true);
  assert.equal(done.progress.jevRejected, 0);
  assert.equal(done.progress.agentRejected, 1);
  assert.equal(f.browserCalls(), 0);
});

test('legacy unscored CLI records are reviewed in place and confirmed exclusions are retained as dismissed', async (t) => {
  const f = fixture(t);
  for (const [i, job] of jobs.entries())
    f.db.putResult({
      id: 'legacy-' + i,
      automationId: f.id,
      key: job.guid,
      url: job.guid,
      title: job.title,
      summary: 'Legacy import',
      status: 'found',
      collectedBy: 'himalayas',
      sourceUrl: source,
      trial: false,
      cells: {},
      createdAt: 1,
    });
  const first = await f.call('collect_source_page');
  await assert.rejects(review(f, first), /Review not complete/);
  await handle(f, first);
  const records = f.db.results(f.id);
  assert.equal(records.length, 3);
  assert.equal(records.find((r) => r.id === 'legacy-0').assessment.score, 42);
  assert.equal(records.find((r) => r.id === 'legacy-1').status, 'dismissed');
  assert.match(
    records.find((r) => r.id === 'legacy-1').collectorRejection.reason,
    /unrelated_role/,
  );
});

test('minimum save score excludes CLI findings, allows batch review, and survives restart without raw evidence', async (t) => {
  const f = fixture(t, {saveScoreThreshold: '60'}),
    first = await f.call('collect_source_page');
  const items = helper(f, first).items;
  const skipped = await save(f, items[0], 59);
  assert.equal(skipped.skipped, true);
  await save(f, items[2], 60);
  await review(f, first);
  assert.equal(f.db.run(f.run.id).scan.reviewStats.agentRejected, 1);
  assert.equal(f.db.run(f.run.id).scan.reviewStats.saved, 1);
  const db = new AutomationStore(f.core);
  prepareCollection(db, db.run(f.run.id), db.get(f.id));
  // The acknowledgement already fetched page two; restart refetches that page.
  const flow = f.makeFlow(db),
    second = await flow.call(f.id, f.run.id, 'collect_source_page', {}),
    task = db.jevTasks.get(f.id, f.run.taskId, second.taskId);
  assert.equal(task.items.length, 1);
  await flow.call(f.id, f.run.id, 'record_automation_result', {
    url: task.items[0].url,
    title: 'Synthetic',
    summary: 'Below threshold',
    score: 20,
  });
  await flow.call(f.id, f.run.id, 'browser_run_task', {
    taskId: task.id,
    reviewedBatchId: task.batch.id,
  });
  const done = await flow.call(f.id, f.run.id, 'collect_source_page', {});
  assert.equal(done.complete, true);
  assert.deepEqual(done.progress, {
    collected: 4,
    jevRejected: 1,
    agentRejected: 2,
    saved: 1,
    pending: 0,
  });
  assert.equal(db.results(f.id).length, 1);
  assert.equal(db.jevTasks.bodies.size, 0);
});

test('restart refetches the unfinished page without rescoring saved items or persisting raw bodies', async (t) => {
  const f = fixture(t),
    first = await f.call('collect_source_page');
  await save(f, helper(f, first).items[0]);
  const db = new AutomationStore(f.core);
  prepareCollection(db, db.run(f.run.id), db.get(f.id));
  assert.equal(db.jevTasks.bodies.size, 0);
  const flow = f.makeFlow(db),
    receipt = await flow.call(f.id, f.run.id, 'collect_source_page', {});
  assert.equal(f.reads(), 2);
  assert.deepEqual(
    db.jevTasks.get(f.id, f.run.taskId, receipt.taskId).items.map((i) => i.url),
    [url('reject'), url('uncertain')],
  );
  assert.equal(db.results(f.id).length, 1);
  assert.equal(db.run(f.run.id).scan.reviewStats.collected, 3);
});

test('changed API pages recover missing details by identity after restart and keep bodies in RAM', async (t) => {
  let changed = false;
  const reads = [];
  const f = fixture(t, {
    readPage: (value) =>
      parseHimalayasPage(value, {
        jobs: changed ? [jobs[0]] : jobs,
        offset: 0,
        limit: 20,
        totalCount: 3,
      }),
    readDetail: async (value) => {
      reads.push(value);
      return parseHimalayasPage(source, {
        jobs: [jobs.find((j) => j.guid === value)],
        offset: 0,
        limit: 20,
        totalCount: 1,
      }).jobs[0];
    },
  });
  await f.call('collect_source_page');
  changed = true;
  const resumed = restart(f),
    receipt = await resumed.call('collect_source_page');
  assert.deepEqual(reads.sort(), [url('reject'), url('uncertain')].sort());
  assert.equal(helper(resumed, receipt).items.length, 3);
  assert.equal(resumed.db.run(f.run.id).scan.reviewStats.collected, 3);
  await handle(resumed, receipt);
  const done = await resumed.call('collect_source_page');
  assert.equal(done.complete, true);
  assert.deepEqual(done.progress, {
    collected: 3,
    jevRejected: 1,
    agentRejected: 0,
    saved: 2,
    pending: 0,
  });
  assert.ok(
    !JSON.stringify(f.core.db.prepare('SELECT data FROM automation_runs').all()).includes(
      'RAM_ONLY_DESCRIPTION',
    ),
  );
});

test('an unavailable detail does not block other pages, a moved listing is recovered, and unresolved URLs survive restart', async (t) => {
  let changed = false,
    recovered = false;
  const reads = [];
  const f = fixture(t, {
    readPage: (value) => {
      const second = new URL(value).searchParams.get('page') === '2';
      return parseHimalayasPage(value, {
        jobs: second ? [jobs[2]] : changed ? [jobs[0]] : jobs,
        offset: second ? 20 : 0,
        limit: 20,
        totalCount: 21,
      });
    },
    readDetail: async (value) => {
      reads.push(value);
      if (!recovered) throw Error('HTTP 503');
      return parseHimalayasPage(source, {
        jobs: [jobs.find((j) => j.guid === value)],
        offset: 0,
        limit: 20,
        totalCount: 1,
      }).jobs[0];
    },
  });
  await f.call('collect_source_page');
  changed = true;
  const resumed = restart(f);
  const first = await resumed.call('collect_source_page');
  assert.equal(helper(resumed, first).items.length, 1);
  await handle(resumed, first);
  assert.equal(resumed.db.run(f.run.id).scan.pendingUrls.length, 2);
  const second = await resumed.call('collect_source_page');
  assert.equal(helper(resumed, second).items[0].url, url('uncertain'));
  await handle(resumed, second);
  // The unreadable listing does not hold the source: the round ends and the
  // next round reads it again first.
  const end = await resumed.call('collect_source_page');
  assert.equal(end.complete, true);
  assert.deepEqual(end.unread.urls, [url('reject')]);
  assert.match(end.unread.note, /not rejected/);
  assert.equal(reads.length, 2);
  assert.equal(resumed.db.run(f.run.id).scan.reviewStats.collected, 3);
  assert.equal(resumed.db.results(f.id).length, 2);
  assert.deepEqual(resumed.db.get(f.id).sourceState[source].carriedListings, {
    [url('reject')]: 1,
  });
  recovered = true;
  const again = nextRound(resumed);
  assert.deepEqual(again.db.run(again.run.id).scan.pendingUrls, [url('reject')]);
  assert.deepEqual(again.db.get(f.id).sourceState[source].carriedListings, {});
  let result = await again.call('collect_source_page');
  for (let i = 0; i < 6 && !result.complete; i++) {
    await handle(again, result);
    result = await again.call('collect_source_page');
  }
  assert.equal(result.complete, true);
  assert.equal(result.unread, undefined);
  assert.ok(reads.includes(url('reject')) && reads.length > 2);
});

test('a listing that stays unreadable is tried for three rounds and then dropped', async (t) => {
  let f = fixture(t, {
    readPage: (value) =>
      parseHimalayasPage(value, {jobs: [jobs[0]], offset: 0, limit: 20, totalCount: 1}),
  });
  f.db.persistScan(f.id, {
    ...f.db.run(f.run.id),
    scan: {...f.db.run(f.run.id).scan, pendingUrls: [url('gone')]},
  });
  const notes = [];
  for (let round = 1; round <= 3; round++) {
    let result = await f.call('collect_source_page');
    for (let i = 0; i < 6 && !result.complete; i++) {
      await handle(f, result);
      result = await f.call('collect_source_page');
    }
    assert.deepEqual(result.unread.urls, [url('gone')]);
    notes.push(result.unread.note);
    if (round < 3) f = nextRound(f);
  }
  assert.match(notes[0], /next round reads 1 of them again/);
  assert.match(notes[2], /stayed unreadable for 3 rounds/);
  assert.deepEqual(f.db.get(f.id).sourceState[source].carriedListings, {});
});

test('a listing the site reports gone (410) leaves the queue instead of stopping the scan', async (t) => {
  let changed = false;
  const reads = [];
  const f = fixture(t, {
    readPage: (value) => {
      const second = new URL(value).searchParams.get('page') === '2';
      return parseHimalayasPage(value, {
        jobs: second ? [jobs[2]] : changed ? [jobs[0]] : jobs,
        offset: second ? 20 : 0,
        limit: 20,
        totalCount: 21,
      });
    },
    readDetail: async (value) => {
      reads.push(value);
      throw Object.assign(Error('HTTP 410'), {status: 410});
    },
  });
  await f.call('collect_source_page');
  changed = true;
  const resumed = restart(f);
  let result = await resumed.call('collect_source_page');
  for (let i = 0; i < 6 && !result.complete; i++) {
    assert.notEqual(
      result.issue?.reason,
      'collector_details_unavailable',
      'a removed listing is not an unreadable one',
    );
    await handle(resumed, result);
    result = await resumed.call('collect_source_page');
  }
  assert.equal(result.complete, true);
  const run = resumed.db.run(f.run.id);
  assert.deepEqual(run.scan.pendingUrls, []);
  assert.ok(run.scan.work.searches.some((s) => s.processedUrls.includes(url('reject'))));
  assert.ok(reads.length >= 1);
});

test('a listing Jev cannot assess stays pending without holding its page', async (t) => {
  const image = {guid: url('image'), title: 'Werkstudent', description: '<p>IMAGE_ONLY_MARKER</p>'};
  const f = fixture(t, {
    readPage: (value) => {
      const second = new URL(value).searchParams.get('page') === '2';
      return parseHimalayasPage(value, {
        jobs: second ? [{...jobs[0], guid: url('second')}] : [jobs[0], image],
        offset: second ? 20 : 0,
        limit: 20,
        totalCount: 21,
      });
    },
  });
  const first = await f.call('collect_source_page'),
    task = helper(f, first);
  assert.ok(task.items.find((i) => i.url === url('image')).error);
  await save(
    f,
    task.items.find((i) => i.url === url('good')),
  );
  await review(f, first);
  const second = await f.call('collect_source_page');
  assert.notEqual(second.taskId, first.taskId, 'the next page is fetched');
  await handle(f, second);
  const end = await f.call('collect_source_page');
  assert.equal(end.complete, true);
  assert.deepEqual(end.unread.urls, [url('image')]);
});

test('a page holding only an unreadable listing is read on, and that listing is not re-read per page', async (t) => {
  const image = {guid: url('image'), title: 'Werkstudent', description: '<p>IMAGE_ONLY_MARKER</p>'};
  const page = (value, list, offset) =>
    parseHimalayasPage(value, {jobs: list, offset, limit: 20, totalCount: 41});
  let detailReads = 0;
  const f = fixture(t, {
    readPage: (value) => {
      const n = new URL(value).searchParams.get('page') ?? '1';
      return n === '1'
        ? page(value, [image], 0)
        : page(value, [{...jobs[0], guid: url(`p${n}`)}], n === '2' ? 20 : 40);
    },
    readDetail: async () => {
      detailReads++;
      return page('https://himalayas.app/jobs/api/search?page=1', [image], 0).jobs[0];
    },
  });
  const first = await f.call('collect_source_page');
  assert.equal(f.reads(), 2, 'the unreadable-only page is read on in the same call');
  assert.deepEqual(
    helper(f, first).items.map((i) => i.url),
    [url('p2')],
  );
  await handle(f, first);
  await handle(f, await f.call('collect_source_page'));
  const end = await f.call('collect_source_page');
  assert.equal(end.complete, true);
  assert.deepEqual(end.unread.urls, [url('image')]);
  assert.equal(detailReads, 0, 'the unreadable listing is not re-read on later pages');
});

test('cancellation during missing-detail recovery preserves every pending address', async (t) => {
  let changed = false,
    entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const f = fixture(t, {
    readPage: (value) =>
      parseHimalayasPage(value, {
        jobs: changed ? [jobs[0]] : jobs,
        offset: 0,
        limit: 20,
        totalCount: 3,
      }),
    readDetail: async (_url, {signal}) => {
      entered();
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {once: true}),
      );
    },
  });
  await f.call('collect_source_page');
  changed = true;
  const db = new AutomationStore(f.core),
    controller = new AbortController();
  const pending = f.makeFlow(db, controller.signal).call(f.id, f.run.id, 'collect_source_page', {});
  await started;
  controller.abort();
  await assert.rejects(pending);
  assert.equal(db.run(f.run.id).scan.pendingUrls.length, 3);
  assert.equal(db.jevTasks.bodies.size, 0);
});

test('all recipe searches must finish, including empty results, before completion', async (t) => {
  const f = fixture(t, {
    terms: ['backend', 'platform'],
    readPage: (value) => parseHimalayasPage(value, {jobs: [], offset: 0, limit: 20, totalCount: 0}),
  });
  // Empty pages need no review, so one call reads both searches to their end.
  const done = await f.call('collect_source_page');
  assert.equal(done.complete, true);
  assert.equal(f.reads(), 2);
});

// Pages whose listings are all already known: none reaches review.
const knownPages = (total) => (value) => {
  const page = Number(new URL(value).searchParams.get('page')),
    next = new URL(value);
  next.searchParams.set('page', String(page + 1));
  return {
    url: value,
    jobs: [],
    page,
    totalPages: total,
    nextUrl: page < total ? next.href : null,
    complete: page >= total,
  };
};

test('pages without new listings are read on within one bounded call', async (t) => {
  const terms = ['backend', 'platform', 'staff', 'lead', 'cloud'],
    f = fixture(t, {terms, readPage: knownPages(25)});
  const first = await f.call('collect_source_page');
  assert.equal(f.reads(), 20);
  assert.equal(f.db.run(f.run.id).scan.complete, false);
  assert.match(first.next, /no new listings.*collect_source_page again/);
  assert.equal((await f.call('collect_source_page')).complete, true);
  assert.equal(f.reads(), terms.length * SCAN_SEARCH_PAGES, 'each search reads its page cap');
});

test('a single collector search closed by its page budget finishes completed', async (t) => {
  const f = fixture(t, {terms: ['backend'], readPage: knownPages(40)});
  await f.call('collect_source_page');
  assert.equal((await f.call('collect_source_page')).complete, true);
  assert.equal(f.reads(), SCAN_SEARCH_PAGES);
  await f.call('finish_automation_run', {status: 'completed', summary: 'Page budget read'});
  assert.equal(f.db.run(f.run.id).status, 'completed');
});

test('HTTP errors and cancellation leave checkpoints incomplete, with no production records', async (t) => {
  const f = fixture(t, {
    readPage: () => {
      throw Error('HTTP 403');
    },
  });
  await assert.rejects(f.call('collect_source_page'), /403/);
  assert.equal(f.db.run(f.run.id).scan.complete, false);
  assert.equal(f.db.results(f.id).length, 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    collectSourcePage(f.db, f.run.id, {
      signal: controller.signal,
      readPage: async (value) =>
        parseHimalayasPage(value, {jobs, offset: 0, limit: 20, totalCount: 3}),
    }),
  );
  assert.equal(f.db.jevTasks.bodies.size, 0);
  await f.call('finish_automation_run', {status: 'failed', summary: 'API returned HTTP 403'});
  assert.equal(f.db.run(f.run.id).status, 'failed');
  assert.equal(
    f.db.run(f.run.id).scan.pendingUrls.length,
    0,
    'API addresses never become pending listing URLs',
  );
});

test('scheduled Himalayas starts an agent without a browser trial, and stopping releases its task', async (t) => {
  const core = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(core),
    a = db.create('job-search', {
      goal: 'backend',
      criteria: {preferences: 'Germany'},
      sources: [source, 'https://other.test/jobs'],
    });
  db.saveSource(a.id, source, {
    recipe: {...db.get(a.id).sourceSettings[source].recipe, terms: ['backend']},
  });
  db.review(a.id);
  db.enable(a.id);
  let agents = 0,
    closed = false,
    launched;
  const runtime = new WebTasks(db, {
    browserReady: () => false,
    launch: async (run) => {
      agents++;
      launched = run;
      return {
        close: async () => {
          closed = true;
        },
      };
    },
  });
  t.after(async () => {
    await runtime.close();
    core.close();
  });
  await runtime.tick();
  await new Promise(setImmediate);
  assert.equal(agents, 1);
  assert.equal(launched.collector, 'himalayas');
  assert.equal(launched.kind, 'run');
  assert.match(automationPrompt(launched), /collect_source_page/);
  assert.equal(db.results(a.id).length, 0);
  await runtime.stopSource(a.id, source);
  assert.ok(closed);
  assert.equal(runtime.slots(a.id).length, 0);
});

test('a collector whose {query} search has no terms chooses them in a trial before it scans', async (t) => {
  const core = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(core),
    a = db.create('job-search', {
      goal: 'backend',
      criteria: {preferences: 'Germany'},
      sources: [source],
    });
  db.review(a.id);
  db.enable(a.id);
  const runtime = new WebTasks(db, {
    browserReady: () => false,
    launch: async () => ({close: async () => {}}),
  });
  t.after(async () => {
    await runtime.close();
    core.close();
  });
  assert.equal(db.sources(a.id)[0].trialReady, false);
  await runtime.tick();
  await new Promise(setImmediate);
  assert.deepEqual(
    runtime.queue.list(a.id).map((task) => task.operation),
    ['trial'],
    'no scan searches for the source scope; the trial agent chooses the terms',
  );
  const saved = db.get(a.id),
    recipe = saved.sourceSettings[source].recipe;
  assert.equal(
    sourceTrialReady(
      {...saved, sourceSettings: {[source]: {recipe: {...recipe, terms: ['backend']}}}},
      source,
      {siteSearch: true},
    ),
    true,
    'with its terms the source scans',
  );
});

test('CLI page transport uses a real child process and exits after one page', async () => {
  const page = await readCollectorCliPage('https://himalayas.app/jobs/api/search?q=backend', {
    forkProcess: (file, args, options) =>
      fork(file, args, {...options, execArgv: ['--import', fixtureModule]}),
  });
  assert.equal(page.jobs.length, 1);
  assert.ok(page.nextUrl);
  assert.equal(page.complete, false);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readCollectorCliPage('https://himalayas.app/', {signal: controller.signal}));
  const detail = await readCollectorCliDetail(url('detail'), {
    forkProcess: (file, args, options) =>
      fork(file, args, {...options, execArgv: ['--import', fixtureModule]}),
  });
  assert.equal(detail.url, url('detail'));
  assert.match(detail.description, /Short but complete/);
});

test('unresolved details in one search do not block other searches or create duplicate counters', async (t) => {
  let changed = false;
  const f = fixture(t, {
    terms: ['backend', 'platform'],
    readPage: (value) => {
      const other = new URL(value).searchParams.get('q') === 'platform';
      return parseHimalayasPage(value, {
        jobs: other ? [jobs[2]] : changed ? [jobs[0]] : [jobs[0], jobs[2]],
        offset: 0,
        limit: 20,
        totalCount: 2,
      });
    },
  });
  await f.call('collect_source_page');
  changed = true;
  const resumed = restart(f);
  const first = await resumed.call('collect_source_page');
  await handle(resumed, first);
  const second = await resumed.call('collect_source_page');
  await handle(resumed, second);
  const done = await resumed.call('collect_source_page');
  assert.equal(done.complete, true);
  assert.deepEqual(done.progress, {
    collected: 2,
    jevRejected: 0,
    agentRejected: 0,
    saved: 2,
    pending: 0,
  });
});

test('cancelling an active CLI request terminates its child', async () => {
  const controller = new AbortController();
  let child;
  const request = readCollectorCliPage('https://himalayas.app/jobs/api/search?q=backend', {
    signal: controller.signal,
    forkProcess: (file, args, options) => {
      child = fork(file, args, {
        ...options,
        execArgv: ['--import', fixtureModule],
        env: {...options.env, JOBLOOP_TEST_COLLECT_WAIT: '1'},
      });
      return child;
    },
  });
  await once(child, 'spawn');
  controller.abort();
  await assert.rejects(request);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test('a continuation reports the finished scan, and the next task skips reviewed listings', async (t) => {
  const f = fixture(t);
  await handle(f, await f.call('collect_source_page'));
  await handle(f, await f.call('collect_source_page'));
  assert.equal((await f.call('collect_source_page')).complete, true);
  const reads = f.reads(),
    before = f.db.results(f.id).length;
  // The turn ended before the report: the task's next run starts with the
  // finished scan and no page of its own, and collector runs have no browser.
  f.db.putRun({...f.db.run(f.run.id), navigation: null, observations: []});
  prepareCollection(f.db, f.db.run(f.run.id), f.db.get(f.id));
  assert.equal((await f.call('collect_source_page')).complete, true);
  assert.equal(f.reads(), reads);
  await f.call('finish_automation_run', {status: 'completed', summary: 'All pages reviewed'});
  assert.equal(f.db.run(f.run.id).status, 'completed');
  const task = f.core.workspaces.tasks.enqueue(f.id, {
      sourceUrl: source,
      operation: 'scan',
      sources: [source],
      lockKey: 'source:' + source,
    }),
    run = f.db.begin(f.id, {kind: 'run', taskId: task.id});
  prepareCollection(f.db, run, f.db.get(f.id));
  const again = await f.makeFlow(f.db, undefined, run.id).call(f.id, run.id, 'collect_source_page');
  assert.equal(again.complete, true);
  assert.equal(f.reads(), reads + 2);
  assert.equal(f.db.results(f.id).length, before);
});

test('opaque pagination cycles fail without certifying completion', async (t) => {
  const f = fixture(t, {
    terms: ['backend'],
    readPage: (value) => ({
      ...parseHimalayasPage(value, {jobs: [], offset: 0, limit: 20, totalCount: 0}),
      complete: false,
      nextUrl: value,
    }),
  });
  await assert.rejects(f.call('collect_source_page'), /returned the same page/);
  assert.equal(f.reads(), 1);
  assert.equal(f.db.run(f.run.id).scan.complete, false);
});

test('an empty first page without search terms asks for terms; a saved recipe restarts the collection', async (t) => {
  const f = fixture(t, {
    readPage: (value) =>
      parseHimalayasPage(
        value,
        new URL(value).searchParams.get('q') === 'platform'
          ? {jobs, offset: 0, limit: 20, totalCount: jobs.length}
          : {jobs: [], offset: 0, limit: 20, totalCount: 0},
      ),
  });
  await assert.rejects(
    f.call('collect_source_page'),
    /no search terms, so \{query\} was filled with the source query "Current listings matching.*save_source_recipe/s,
  );
  assert.equal(f.db.run(f.run.id).scan.complete, false, 'an empty page is not a finished scan');
  const recipe = (terms) => ({
    entry: {kind: 'url_template', template: 'https://himalayas.app/jobs/api/search?q={query}'},
    terms,
    pagination: 'url_param',
    loginRequired: false,
  });
  await assert.rejects(
    f.call('save_source_recipe', recipe(['nothing'])),
    /could not be verified: the first page has no listings/,
  );
  const saved = await f.call('save_source_recipe', recipe(['platform']));
  assert.equal(saved.status, 'verified');
  assert.equal(saved.listings, jobs.length);
  assert.match(saved.next, /collect_source_page/);
  assert.deepEqual(
    f.db.run(f.run.id).scan.work.searches.map((s) => new URL(s.url).searchParams.get('q')),
    ['platform'],
    'the running collection uses the saved terms',
  );
  const receipt = await f.call('collect_source_page');
  assert.ok(receipt.taskId);
  assert.equal(f.browserCalls(), 0, 'the recipe was checked through the API, not a browser');
});

test('standalone CLI still emits NDJSON and exit 2 for an incomplete page budget', async () => {
  const child = spawn(
    process.execPath,
    [
      '--import',
      fixtureModule,
      'app/site-extensions/himalayas/cli.mjs',
      '--source',
      'himalayas',
      '--query',
      'backend',
      '--max-pages',
      '1',
    ],
    {stdio: ['ignore', 'pipe', 'pipe']},
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (data) => {
    stdout += data;
  });
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 2, stderr);
  const lines = stdout.trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].page.jobs.length, 1);
  assert.equal(lines[1].result.complete, false);
});

test('a collector card with a confident conflict is rejected without reading its full text', async (t) => {
  const conflict = {
    guid: url('us-only'),
    title: 'Staff backend engineer',
    companyName: 'Synthetic Co',
    locationRestrictions: ['CARD_CONFLICT_MARKER'],
    description: '<p>Backend role for residents only.</p>',
  };
  const f = fixture(t, {
    terms: ['backend'],
    readPage: (value) =>
      parseHimalayasPage(value, {jobs: [jobs[0], conflict], offset: 0, limit: 20, totalCount: 2}),
  });
  detailReads.length = 0;
  const receipt = await f.call('collect_source_page'),
    items = helper(f, receipt).items;
  const rejected = items.find((i) => i.url === conflict.guid);
  assert.equal(rejected.assessment.decision, 'mismatch');
  assert.deepEqual(
    [rejected.assessment.exclusion.basis, rejected.assessment.exclusion.reason],
    ['card', 'hard_constraint'],
  );
  assert.deepEqual(detailReads, [jobs[0].guid], 'only the kept card got a full read');
  await handle(f, receipt);
  assert.equal(f.db.run(f.run.id).scan.reviewStats.jevRejected, 1);
  assert.deepEqual(f.db.knownListingUrls(f.id, f.run.id, [conflict.guid]), [conflict.guid]);
  assert.deepEqual(
    f.db
      .run(f.run.id)
      .scan.work.searches.flatMap((s) => s.excluded ?? [])
      .map((e) => [e.url, e.stage]),
    [[conflict.guid, 'card']],
    'the Sources page shows it as excluded on the card',
  );
});

test('a collector search ends with the page that brings its new listings to 100', async (t) => {
  const listing = (page, i) => ({
    guid: url(`new-${page}-${i}`),
    title: 'Backend engineer',
    description: '<p>Backend role.</p>',
  });
  const f = fixture(t, {
    terms: ['backend'],
    readPage: (value) => {
      const page = Number(new URL(value).searchParams.get('page') ?? 1);
      return parseHimalayasPage(value, {
        jobs: Array.from({length: 20}, (_, i) => listing(page, i)),
        offset: (page - 1) * 20,
        limit: 20,
        totalCount: 400,
      });
    },
  });
  let receipt = await f.call('collect_source_page');
  for (let i = 0; i < 10 && !receipt.complete; i++) {
    await handle(f, receipt);
    receipt = await f.call('collect_source_page');
  }
  assert.equal(receipt.complete, true);
  assert.equal(f.reads(), 5, 'five pages of 20 new listings reach the limit');
});

test('a newest-first collector reads its page budget and stops after two pages of known listings', async (t) => {
  const budget = fixture(t, {
    terms: ['backend'],
    ordering: 'newest_first',
    readPage: knownPages(40),
  });
  await budget.call('collect_source_page');
  assert.equal((await budget.call('collect_source_page')).complete, true);
  assert.equal(
    budget.reads(),
    SCAN_SEARCH_PAGES,
    'the first scan of a newest-first feed keeps the page limit',
  );

  const listing = (page) => ({
    guid: url('page-' + page),
    title: 'Backend engineer',
    description: '<p>Backend role.</p>',
  });
  const f = fixture(t, {
    terms: ['backend'],
    ordering: 'newest_first',
    readPage: (value) => {
      const page = Number(new URL(value).searchParams.get('page') ?? 1);
      return parseHimalayasPage(value, {
        jobs: [listing(page)],
        offset: (page - 1) * 20,
        limit: 20,
        totalCount: 500,
      });
    },
  });
  f.db.rememberSeenListings(
    f.id,
    source,
    Array.from({length: 25}, (_, i) => listing(i + 1).guid),
    'Seen in an earlier scan',
  );
  assert.equal((await f.call('collect_source_page')).complete, true);
  assert.equal(f.reads(), 2, 'new listings come first, so known pages end the search');
});
