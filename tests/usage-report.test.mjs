import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {diagnosticsSetting, sentryTransport} from '../app/system/diagnostics.mjs';
import {startUsageReporting, usageCounts} from '../app/system/usage-report.mjs';

const DAY = 86400000;
function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE automations(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE automation_runs(id TEXT PRIMARY KEY,automation_id TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE workspace_records(id TEXT PRIMARY KEY,data TEXT NOT NULL);`);
  db.prepare('INSERT INTO automations VALUES(?,?)').run(
    'w',
    JSON.stringify({title: 'Private title', sources: ['https://a.test/', 'https://b.test/']}),
  );
  let n = 0;
  const run = (data) =>
    db
      .prepare('INSERT INTO automation_runs VALUES(?,?,?)')
      .run(`r${++n}`, 'w', JSON.stringify(data));
  run({kind: 'run', status: 'completed', finishedAt: 5 * DAY, conversation: {provider: 'claude'}});
  run({kind: 'run', status: 'blocked', finishedAt: 5 * DAY, summary: 'Private summary'});
  run({kind: 'run', recordOperation: 'execute', status: 'completed', finishedAt: 5 * DAY});
  run({
    kind: 'run',
    recordOperation: 'execute',
    status: 'blocked',
    finishedAt: 5 * DAY,
    blocker: {category: 'needs_answer', reason: 'Private reason'},
  });
  run({kind: 'trial', status: 'failed', finishedAt: 5 * DAY, conversation: {provider: 'codex'}});
  run({kind: 'run', status: 'completed', finishedAt: 2 * DAY});
  run({kind: 'run', status: 'running', finishedAt: null});
  db.prepare('INSERT INTO workspace_records VALUES(?,?)').run(
    'a',
    JSON.stringify({title: 'Private record', createdAt: 5 * DAY}),
  );
  db.prepare('INSERT INTO workspace_records VALUES(?,?)').run(
    'b',
    JSON.stringify({createdAt: 1 * DAY}),
  );
  return db;
}
async function settingFile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'jobloop-usage-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return join(directory, 'scan-reports.json');
}

test('usage counts cover only the window and hold no text from the data', () => {
  const counts = usageCounts(database(), 4 * DAY, 6 * DAY);
  assert.deepEqual(counts, {
    scan_completed: 1,
    scan_blocked: 1,
    scan_total: 2,
    execute_completed: 1,
    execute_blocked: 1,
    execute_blocker_needs_answer: 1,
    execute_total: 2,
    trial_failed: 1,
    trial_total: 1,
    records_found: 1,
    workspaces: 1,
    sources: 2,
    records: 2,
    providers: 'claude,codex',
  });
});

test('a session starts and ends with the anonymous install id, and the daily report sends once a day', async (t) => {
  const file = await settingFile(t),
    setting = diagnosticsSetting(file),
    sent = [];
  let clock = 6 * DAY;
  const usage = startUsageReporting({
    db: database(),
    setting,
    send: async (items) => {
      sent.push(...items);
      return true;
    },
    release: '0.1.13',
    environment: 'production',
    system: {os: 'darwin'},
    now: () => clock,
  });
  await usage.start();
  usage.failure();
  clock += 3600000;
  await usage.tick();
  await usage.stop();
  assert.deepEqual(
    sent.map((item) => item.type),
    ['session', 'log', 'session'],
  );
  const [start, log, end] = sent.map((item) => item.payload),
    id = JSON.parse(await readFile(file, 'utf8')).installId;
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(start.did, id);
  assert.equal(start.init, true);
  assert.equal(start.status, 'ok');
  assert.deepEqual(start.attrs, {release: '0.1.13', environment: 'production'});
  assert.equal(end.sid, start.sid);
  assert.equal(end.init, false);
  assert.equal(end.status, 'exited');
  assert.equal(end.errors, 1);
  assert.equal(end.duration, 3600);
  const attributes = log.items[0].attributes;
  assert.equal(log.items[0].body, 'usage.daily');
  assert.deepEqual(attributes.scan_total, {value: 2, type: 'integer'});
  assert.deepEqual(attributes.window_hours, {value: 24, type: 'integer'});
  assert.deepEqual(attributes.install_id, {value: id, type: 'string'});
  assert.deepEqual(attributes.os, {value: 'darwin', type: 'string'});
  assert.equal(JSON.stringify(sent).includes('Private'), false);
  clock += DAY;
  await usage.tick();
  assert.equal(sent.length, 4);
  // The previous report went out at start, 25 hours earlier.
  assert.deepEqual(sent[3].payload.items[0].attributes.window_hours, {value: 25, type: 'integer'});
});

test('nothing is sent while diagnostics are off and a failed send is retried', async (t) => {
  const setting = diagnosticsSetting(await settingFile(t)),
    sent = [];
  let accept = false;
  const usage = startUsageReporting({
    db: database(),
    setting,
    send: async (items) => {
      sent.push(...items);
      return accept;
    },
    release: '0.1.13',
    environment: 'production',
    now: () => 6 * DAY,
  });
  await setting.set(false);
  await usage.start();
  await usage.stop();
  assert.deepEqual(sent, []);
  await setting.set(true);
  await usage.tick();
  await usage.tick();
  assert.equal(sent.length, 2);
  accept = true;
  await usage.tick();
  await usage.tick();
  assert.equal(sent.length, 3);
  assert.equal(setting.usageReportedAt(), 6 * DAY);
});

test('the transport posts one envelope and reports whether Sentry accepted it', async () => {
  const calls = [];
  const send = sentryTransport({
    dsn: 'https://publickey@o1.ingest.example.test/42',
    release: '0.1.13',
    fetch: async (url, init) => {
      calls.push({url, init});
      return {ok: calls.length === 1};
    },
  });
  assert.equal(await send([{type: 'session', payload: {sid: 's'}}]), true);
  assert.equal(await send([{type: 'session', payload: {sid: 's'}}]), false);
  assert.equal(calls[0].url, 'https://o1.ingest.example.test/api/42/envelope/');
  const lines = calls[0].init.body.split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.slice(1), [{type: 'session'}, {sid: 's'}]);
  assert.equal(
    await sentryTransport({
      dsn: 'https://k@o1.ingest.example.test/42',
      release: '0.1.13',
      fetch: async () => {
        throw Error('offline');
      },
    })([]),
    false,
  );
});

test('automated runs send nothing even with reports on', async (t) => {
  const setting = diagnosticsSetting(await settingFile(t), {off: true}),
    sent = [];
  assert.deepEqual(setting.status(), {enabled: false});
  const usage = startUsageReporting({
    db: database(),
    setting,
    send: async (items) => sent.push(...items),
    release: '0.1.13',
    environment: 'production',
  });
  await usage.start();
  await usage.stop();
  assert.deepEqual(sent, []);
});
