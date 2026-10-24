import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  createScanFailureReporter,
  reportableScanFailure,
  scanFailureEvent,
  scrubText,
} from '../app/system/scan-failure-report.mjs';
import {diagnosticsSetting} from '../app/system/diagnostics.mjs';

const source = 'https://catalog.test/search?query=example';
function fixture(t, task = {}) {
  const core = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(core);
  t.after(() => core.close());
  const criteria = Object.fromEntries(
    db
      .template('custom')
      .fields.filter((f) => f.required)
      .map((f) => [f.id, 'Synthetic criterion']),
  );
  const a = db.create('custom', {
    goal: 'Find suitable records',
    criteria: {...criteria, save_score_threshold: '60'},
    sources: [source],
  });
  db.review(a.id);
  const queued = core.workspaces.tasks.enqueue(a.id, {
    operation: 'scan',
    capability: 'browser.observe',
    sourceUrl: source,
    sources: [source],
    lockKey: 'source:' + source,
    ...task,
  });
  const reported = [];
  db.scanFailed = (run) => reported.push(run);
  const run = db.begin(a.id, {kind: 'run', taskId: queued.id});
  return {db, id: a.id, run, reported};
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a scan that ends blocked is reported once after the run is saved', async (t) => {
  const f = fixture(t);
  f.db.putRun({...f.db.run(f.run.id), stop: {kind: 'access', evidence: 'site_wait'}});
  f.db.finish(f.id, f.run.id, 'blocked', 'Verification page; retry scheduled.');
  const finished = f.db.run(f.run.id);
  f.db.putRun({...finished, summary: 'Updated after finishing'});
  await settle();
  assert.equal(f.reported.length, 1);
  assert.equal(f.reported[0].id, f.run.id);
  assert.equal(f.reported[0].status, 'blocked');
});

test('interrupted scans are not reported', async (t) => {
  const done = fixture(t);
  done.db.finish(done.id, done.run.id, 'interrupted', 'The app closed.');
  await settle();
  assert.deepEqual(done.reported, []);
});

test('a trial over several sources is reported without a single site', () => {
  const trial = {
    id: 'trial-1',
    kind: 'trial',
    status: 'failed',
    sources: [source, 'https://other.test/jobs'],
    summary: 'The engine response timed out.',
    finishedAt: 1792700000000,
  };
  assert.equal(reportableScanFailure(trial, 'running'), true);
  assert.equal(reportableScanFailure({...trial, sources: []}, 'running'), false);
  assert.equal(reportableScanFailure({...trial, recordId: 'r1'}, 'running'), false);
  const event = scanFailureEvent(
    {...trial, status: 'blocked', stop: {kind: 'technical', evidence: 'site_wait'}},
    {release: '1.0.0', environment: 'production'},
  );
  assert.equal(event.tags.site, 'multiple_sources');
  assert.equal(event.tags.kind, 'trial');
  assert.equal(event.message.formatted, 'scan blocked (technical) multiple_sources: site_wait');
});

test('a failure rolled back by its transaction is not reported', async (t) => {
  const f = fixture(t);
  assert.throws(() =>
    f.db.store.workspaces.tasks.atomic(() => {
      f.db.putRun({...f.db.run(f.run.id), status: 'failed', finishedAt: Date.now()});
      throw Error('rolled back');
    }),
  );
  await settle();
  assert.deepEqual(f.reported, []);
});

test('the event keeps app codes and the site host but no personal or page details', () => {
  const event = scanFailureEvent(
    {
      id: 'run-1',
      kind: 'run',
      status: 'blocked',
      sourceUrl: 'https://www.catalog.test/jobs/',
      startedAt: 1000,
      finishedAt: 4000,
      summary:
        'Opening https://www.catalog.test/jobs?q=Staff+Engineer&l=Berlin redirected; mail me at person@example.com or +49 172 7015066 (tab 0C1AD1376E549D5003D1CAF6F48D0F50).',
      stop: {
        kind: 'access',
        evidence: 'The checkbox did not become clickable. (checkbox_not_ready)',
      },
      conversation: {provider: 'claude', settings: {model: 'haiku'}},
      scanStats: {searches: 2, saved: 0, note: 'ignored'},
      observations: [{url: 'https://www.catalog.test/jobs/1', evidence: 'Full page text'}],
    },
    {release: '0.1.11', environment: 'development'},
  );
  assert.deepEqual(event.fingerprint, [
    'jobloop-scan',
    'www.catalog.test',
    'blocked',
    'access',
    'checkbox_not_ready',
  ]);
  assert.equal(event.tags.model, 'haiku');
  assert.deepEqual(event.extra.scanStats, {searches: 2, saved: 0});
  assert.equal(event.extra.durationMs, 3000);
  const sent = JSON.stringify(event);
  for (const secret of [
    'Staff+Engineer',
    'person@example.com',
    '7015066',
    '0C1AD1376E',
    'Full page text',
  ])
    assert.equal(sent.includes(secret), false, secret);
  assert.match(event.extra.summary, /www\.catalog\.test\/…/);
});

test('scrubText bounds the text', () => {
  assert.equal(scrubText('x'.repeat(1000)).length, 400);
  assert.equal(scrubText(null), '');
});

test('scrubText drops quoted text but keeps apostrophes', () => {
  assert.equal(
    scrubText('Pick "Springfield, Example" under “Select a location” in the site’s tab.'),
    'Pick "…" under "…" in the site’s tab.',
  );
  assert.equal(scrubText("The site's search ignores it."), "The site's search ignores it.");
});

test('a failure with a quoted location groups with the same failure elsewhere', () => {
  const event = (place) =>
    scanFailureEvent(
      {
        id: 'run-1',
        kind: 'trial',
        status: 'blocked',
        sourceUrl: source,
        summary: `Pick "${place}" under "Select a location" and send the search again.`,
      },
      {release: '0.1.20', environment: 'production'},
    );
  const first = event('Springfield, Example'),
    second = event('Shelbyville, Example');
  assert.deepEqual(first.fingerprint, second.fingerprint);
  assert.equal(JSON.stringify(first).includes('Springfield'), false);
});

test('the reporter tags the event with the anonymous install id', async () => {
  const bodies = [];
  const report = createScanFailureReporter({
    dsn: 'https://publickey@o1.ingest.example.test/42',
    release: '0.1.20',
    environment: 'production',
    installId: async () => 'install-1',
    fetch: async (url, init) => {
      bodies.push(init.body);
      return {ok: true};
    },
  });
  await report({id: 'run-1', kind: 'run', status: 'failed', sourceUrl: source, summary: 'x'});
  const event = JSON.parse(bodies[0].split('\n')[2]);
  assert.equal(event.tags.install_id, 'install-1');
  const failing = createScanFailureReporter({
    dsn: 'https://publickey@o1.ingest.example.test/42',
    release: '0.1.20',
    environment: 'production',
    installId: async () => {
      throw Error('disk full');
    },
    fetch: async (url, init) => {
      bodies.push(init.body);
      return {ok: true};
    },
  });
  await failing({id: 'run-2', kind: 'run', status: 'failed', sourceUrl: source, summary: 'x'});
  assert.equal(JSON.parse(bodies[1].split('\n')[2]).tags.install_id, undefined);
});

test('the reporter posts one envelope per run and swallows network errors', async () => {
  const calls = [];
  const report = createScanFailureReporter({
    dsn: 'https://publickey@o1.ingest.example.test/42',
    release: '0.1.11',
    environment: 'development',
    fetch: async (url, init) => {
      calls.push({url, init});
      throw Error('offline');
    },
  });
  const run = {id: 'run-1', kind: 'run', status: 'failed', sourceUrl: source, summary: 'x'};
  await report(run);
  await report(run);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://o1.ingest.example.test/api/42/envelope/');
  assert.match(calls[0].init.headers['X-Sentry-Auth'], /sentry_key=publickey/);
  const [header, item, event] = calls[0].init.body.split('\n').map((line) => JSON.parse(line));
  assert.equal(header.event_id, event.event_id);
  assert.equal(item.type, 'event');
  assert.equal(event.release, '0.1.11');
});

test('scan reports are on by default and stay off once turned off', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'jobloop-scan-reports-')),
    file = join(directory, 'scan-reports.json');
  t.after(() => rm(directory, {recursive: true, force: true}));
  const setting = diagnosticsSetting(file);
  assert.deepEqual(setting.status(), {enabled: true});
  const calls = [];
  const report = createScanFailureReporter({
    dsn: 'https://publickey@o1.ingest.example.test/42',
    release: '0.1.11',
    environment: 'development',
    enabled: setting.enabled,
    fetch: async (url) => calls.push(url),
  });
  assert.deepEqual(await setting.set(false), {enabled: false});
  await report({id: 'run-1', kind: 'run', status: 'failed', sourceUrl: source});
  assert.equal(calls.length, 0);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {sendScanFailures: false});
  assert.deepEqual(diagnosticsSetting(file).status(), {enabled: false});
  await setting.set(true);
  await report({id: 'run-1', kind: 'run', status: 'failed', sourceUrl: source});
  assert.equal(calls.length, 1);
});

test('failures the app ended without a stop reason group across sites by their summary', () => {
  const event = (sourceUrl) =>
    scanFailureEvent(
      {
        id: 'run-1',
        kind: 'run',
        status: 'failed',
        sourceUrl,
        summary:
          'The task message did not reach the agent; it stayed in the agent terminal without being submitted.',
      },
      {release: '0.1.12', environment: 'production'},
    );
  const first = event('https://first.test/jobs'),
    second = event('https://second.test/search');
  assert.deepEqual(first.fingerprint, second.fingerprint);
  assert.equal(first.tags.code, 'the task message did not reach the agent');
  assert.equal(first.message.formatted, 'scan failed: the task message did not reach the agent');
  assert.equal(first.tags.site, 'first.test');
  const sentence = scanFailureEvent(
    {
      id: 'run-2',
      kind: 'run',
      status: 'blocked',
      sourceUrl: 'https://first.test/jobs',
      summary: 'Page 3 of https://first.test/jobs?page=3 did not load.',
    },
    {release: '0.1.12', environment: 'production'},
  );
  assert.equal(sentence.tags.code, 'page # of did not load');
});

test('an undelivered task message reports the scrubbed end of the agent screen', () => {
  const event = scanFailureEvent(
    {
      id: 'run-1',
      kind: 'run',
      status: 'failed',
      sourceUrl: source,
      summary: 'The task message did not reach the agent.',
      deliveryFailure: {
        state: 'Some(Stalled)',
        screen: [
          'Earlier output with person@example.com',
          '╭──────────────────────────╮',
          '│ Do you trust the files in this folder? │',
          '│ 1. Yes, proceed          │',
          '╰──────────────────────────╯',
          ' Enter to confirm · Esc to exit',
        ].join('\n'),
      },
    },
    {release: '0.1.12', environment: 'production'},
  );
  assert.equal(event.extra.deliveryFailure.state, 'Some(Stalled)');
  assert.equal(
    event.extra.deliveryFailure.screen,
    'Do you trust the files in this folder? | 1. Yes, proceed | Enter to confirm · Esc to exit',
  );
  assert.equal(JSON.stringify(event).includes('person@example.com'), false);
});
