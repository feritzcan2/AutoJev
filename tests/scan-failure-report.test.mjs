import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {
  createScanFailureReporter,
  scanFailureEvent,
  scrubText,
} from '../app/system/scan-failure-report.mjs';

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
