import test from 'node:test';
import assert from 'node:assert/strict';
import {fork, spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
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
import {
  readCollectorCliPage,
  readCollectorCliDetail,
} from '../app/site-extensions/himalayas/cli-client.mjs';

const source = 'https://himalayas.app/',
  fixtureModule = fileURLToPath(new URL('./fixtures/himalayas-cli-fetch.mjs', import.meta.url));
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
const evaluate = async (state, questions) => ({
  answers: Object.fromEntries(
    Object.entries(questions).map(([name, q]) => {
      const text = JSON.stringify(state);
      let choice =
        name === 'fit'
          ? text.includes('DENTIST_MARKER')
            ? 'mismatch'
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
    saveScoreThreshold,
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
  if (terms)
    db.saveSource(a.id, source, {
      recipe: {
        entry: {kind: 'url_template', template: 'https://himalayas.app/jobs/api/search?q={query}'},
        terms,
        pagination: 'url_param',
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
  const makeFlow = (store = db, signal = new AbortController().signal) =>
    automationWorkflow({
      db: store,
      run: store.run(run.id),
      signal,
      collectorReadPage: reader,
      collectorReadDetail: readDetail,
      browser: {
        evaluateJev: (_id, state, questions) => evaluate(state, questions),
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
  return f.call('browser_jev_run', {
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
  assert.equal(f.db.results(f.id, {all: true}).length, 0);
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
    /bitmedi/,
  );
  await assert.rejects(
    f.call('browser_jev_run', {operation: 'scan_results', url: source}),
    /collect_source_page/,
  );
  const good = helper(f, first).items[0];
  const brief = await f.call('read_jev_brief', {evidenceId: good.evidenceId});
  assert.match(JSON.stringify(brief), /RAM_ONLY_DESCRIPTION_9724/);
  await assert.rejects(
    f.call('record_automation_result', {
      url: good.url,
      title: good.title,
      summary: 'Missing score',
    }),
    /puanlama/,
  );
  await assert.rejects(save(f, helper(f, first).items[1]), /uyumsuz/);
  await save(f, good);
  const stored = f.db.results(f.id)[0];
  assert.equal(stored.assessment.score, 42);
  assert.equal(stored.cells.location.length, 2000);
  assert.ok(stored.cells.location.endsWith('…'));
  assert.ok(
    f.db.jevTasks
      .fullEvidence(f.id, f.run.taskId, good.evidenceId)
      .text.includes('Synthetic country 199'),
  );
  await assert.rejects(review(f, first), /İnceleme tamamlanmadı/);
  await save(f, helper(f, first).items[2]);
  await review(f, first);
  const second = await f.call('collect_source_page');
  assert.equal(f.reads(), 2);
  await handle(f, second);
  assert.throws(
    () => f.db.jevTasks.fullEvidence(f.id, f.run.taskId, good.evidenceId),
    /süresi doldu/,
  );
  const done = await f.call('collect_source_page');
  assert.equal(done.complete, true);
  assert.deepEqual(done.progress, {
    collected: 4,
    jevRejected: 1,
    agentRejected: 0,
    saved: 3,
    pending: 0,
  });
  assert.equal(f.db.results(f.id, {all: true}).length, 3);
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
    /Toplanan: 4.*Jev eledi: 1.*Kaydedilen: 3/,
  );
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
  await assert.rejects(review(f, first), /İnceleme tamamlanmadı/);
  await handle(f, first);
  const records = f.db.results(f.id, {all: true});
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
  const flow = f.makeFlow(db),
    resumed = await flow.call(f.id, f.run.id, 'collect_source_page', {});
  assert.equal(db.jevTasks.get(f.id, f.run.taskId, resumed.taskId).items.length, 0);
  const second = await flow.call(f.id, f.run.id, 'collect_source_page', {}),
    task = db.jevTasks.get(f.id, f.run.taskId, second.taskId);
  await flow.call(f.id, f.run.id, 'record_automation_result', {
    url: task.items[0].url,
    title: 'Synthetic',
    summary: 'Below threshold',
    score: 20,
  });
  await flow.call(f.id, f.run.id, 'browser_jev_run', {
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
  assert.equal(db.results(f.id, {all: true}).length, 1);
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
  assert.equal(db.results(f.id, {all: true}).length, 1);
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
  const end = await resumed.call('collect_source_page');
  assert.equal(end.complete, false);
  assert.deepEqual(end.issue.urls, [url('reject')]);
  assert.equal(reads.length, 2);
  await resumed.call('collect_source_page');
  assert.equal(reads.length, 2, 'Do not retry unchanged failures within the run');
  assert.equal(resumed.db.run(f.run.id).scan.reviewStats.collected, 3);
  assert.equal(resumed.db.results(f.id).length, 2);
  recovered = true;
  const again = restart(resumed),
    detail = await again.call('collect_source_page');
  await handle(again, detail);
  const done = await again.call('collect_source_page');
  assert.equal(done.complete, true);
  assert.equal(done.progress.jevRejected, 1);
  assert.equal(done.progress.collected, 3);
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
  await f.call('collect_source_page');
  assert.equal(f.db.run(f.run.id).scan.complete, false);
  await f.call('collect_source_page');
  assert.equal(f.db.run(f.run.id).scan.complete, false);
  const done = await f.call('collect_source_page');
  assert.equal(done.complete, true);
  assert.equal(f.reads(), 2);
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

test('reviewed duplicates and confirmed exclusions do not return in the next scan', async (t) => {
  const f = fixture(t),
    first = await f.call('collect_source_page');
  await handle(f, first);
  const second = await f.call('collect_source_page');
  await handle(f, second);
  await f.call('collect_source_page');
  const before = f.db.results(f.id, {all: true}).length;
  prepareCollection(f.db, f.db.run(f.run.id), f.db.get(f.id));
  const again = await f.call('collect_source_page');
  assert.equal(helper(f, again).items.length, 0);
  assert.equal(f.db.results(f.id, {all: true}).length, before);
});

test('opaque pagination cycles fail without certifying completion', async (t) => {
  const f = fixture(t, {
    readPage: (value) => ({
      ...parseHimalayasPage(value, {jobs: [], offset: 0, limit: 20, totalCount: 0}),
      complete: false,
      nextUrl: value,
    }),
  });
  await f.call('collect_source_page');
  await assert.rejects(f.call('collect_source_page'), /aynı sayfaya/);
  assert.equal(f.db.run(f.run.id).scan.complete, false);
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
