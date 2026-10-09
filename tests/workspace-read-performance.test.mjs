import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {taskSnapshot} from '../app/automation-snapshot.mjs';
import {SourceAccessRecovery} from '../app/source-access-recovery.mjs';
import {WebTasks} from '../app/web-template.mjs';

function fixture(t) {
  const core = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(core);
  t.after(() => core.close());
  const a = db.create('custom', {
    sources: ['https://board.test/search?q=one', 'https://other.test/listings/'],
  });
  return {core, db, a, id: a.id, queue: core.workspaces.tasks};
}

test('snapshot shares batch score provenance only for that read and keeps old task metadata', (t) => {
  const {core, db, a, id, queue} = fixture(t),
    recordIds = Array.from({length: 12}, (_, n) => 'record-' + n);
  const run = {
    id: 'score-run',
    automationId: id,
    taskId: 'old-score-task',
    kind: 'run',
    recordOperation: 'score',
    status: 'completed',
  };
  db.putRun(run);
  queue.put({
    id: run.taskId,
    workspaceId: id,
    state: 'interrupted',
    recordOperation: 'score',
    recordIds,
    request: {revision: a.revision},
    scan: {pendingUrls: ['https://board.test/next']},
  });
  for (const recordId of recordIds)
    db.putResult({
      id: recordId,
      automationId: id,
      key: recordId,
      url: 'https://board.test/listing/' + recordId,
      title: recordId,
      status: 'found',
      trial: false,
      assessment: {runId: run.id, revision: a.revision},
    });
  for (let n = 0; n < 120; n++)
    queue.put({id: 'history-' + n, workspaceId: id, state: 'completed', operation: 'scan'});
  let runReads = 0,
    historyReads = 0,
    planReads = 0;
  for (const [method, count] of [
    ['run', () => runReads++],
    ['runs', () => historyReads++],
    ['get', () => planReads++],
  ]) {
    const original = db[method];
    db[method] = function (...args) {
      count();
      return original.apply(this, args);
    };
  }
  const snapshot = db.snapshot(id);
  assert.ok(snapshot.results.every((r) => r.recordAction.scoringComplete));
  assert.equal(snapshot.tasks.length, 100);
  assert.ok(!snapshot.tasks.some((t) => t.id === run.taskId));
  assert.equal(runReads, 1, 'A shared scoring run is loaded once, not once per result');
  assert.equal(historyReads, 1, 'Sources and history share the recent runs');
  assert.equal(planReads, 1, 'The full workspace plan is read once');
  core.db.exec('SAVEPOINT score_change');
  db.putRun({...run, taskId: 'different-task'});
  assert.ok(
    db.snapshot(id).results.every((r) => !r.recordAction.scoringComplete),
    'The next read observes a write',
  );
  core.db.exec('ROLLBACK TO score_change; RELEASE score_change');
  assert.ok(
    db.snapshot(id).results.every((r) => r.recordAction.scoringComplete),
    'No cached state leaks out of a rollback',
  );
});

test('recent run lookup retains older active workers, ordering and workspace isolation', (t) => {
  const {db, id} = fixture(t),
    other = db.create('custom');
  db.putRun({
    id: 'old-active',
    automationId: id,
    status: 'running',
    kind: 'run',
    observations: [{url: 'https://board.test/detail', text: 'Temporary text'}],
  });
  for (let n = 0; n < 45; n++)
    db.putRun({id: 'run-' + n, automationId: id, status: 'completed', kind: 'interview'});
  db.putRun({id: 'foreign-active', automationId: other.id, status: 'running', kind: 'run'});
  const full = db.runs(id),
    summary = db.runs(id, {summary: true});
  assert.deepEqual(
    full.map((r) => r.id),
    [...Array.from({length: 30}, (_, n) => 'run-' + (44 - n)), 'old-active'],
  );
  assert.deepEqual(
    summary.map((r) => r.id),
    full.map((r) => r.id),
  );
  assert.deepEqual(summary.at(-1).observations, [{url: 'https://board.test/detail'}]);
  db.putRun({...db.run('old-active'), status: 'completed'});
  assert.equal(db.runs(id).length, 30);
});

test('task projections omit checkpoints before returning rows and resume reads retain full state', (t) => {
  const {core, db, id, queue} = fixture(t),
    other = db.create('custom');
  const large = 'Synthetic checkpoint '.repeat(12000),
    checkpoint = {
      scan: {pendingUrls: ['https://board.test/pending']},
      scanPlan: {checkpoint: large},
      continuation: {resume: true, metadata: large},
    };
  for (let n = 0; n < 25; n++)
    queue.put({id: 'finished-' + n, workspaceId: id, state: 'completed', ...checkpoint});
  for (const [n, flag] of [
    'resumeSourceAfterAnswer',
    'resumeRecordAfterAnswer',
    'resumeRecordAfterVerification',
  ].entries())
    queue.put({id: 'resume-' + n, workspaceId: id, state: 'blocked', [flag]: true, ...checkpoint});
  queue.put({
    id: 'foreign',
    workspaceId: other.id,
    state: 'blocked',
    resumeSourceAfterAnswer: true,
    ...checkpoint,
  });
  let returned = [];
  const prepare = core.db.prepare.bind(core.db);
  core.db.prepare = function (sql) {
    const statement = prepare(sql);
    if (/SELECT json_remove\(data/.test(sql) && sql.includes('FROM workspace_tasks')) {
      const all = statement.all.bind(statement);
      statement.all = (...args) => {
        const rows = all(...args);
        returned = rows;
        return rows;
      };
    }
    return statement;
  };
  const summaries = queue.list(id, {summary: true});
  assert.deepEqual(summaries, queue.list(id).map(taskSnapshot));
  assert.ok(
    returned.length > 0 && returned.every((row) => row.data.length < 500),
    'Large checkpoints never cross the SQLite/JS boundary for summaries',
  );
  assert.deepEqual(
    queue.list(id, {summary: true, states: ['blocked'], limit: 2}).map((t) => t.id),
    ['resume-2', 'resume-1'],
  );
  assert.deepEqual(queue.list(id, {summary: true, states: []}), []);
  const resuming = queue.resumptions(id);
  assert.deepEqual(
    resuming.map((t) => t.id),
    ['resume-0', 'resume-1', 'resume-2'],
  );
  for (const task of resuming) assert.deepEqual(task.scanPlan, checkpoint.scanPlan);
  core.db.exec('SAVEPOINT resume_change');
  queue.put({...resuming[0], resumeSourceAfterAnswer: false});
  assert.equal(queue.resumptions(id).length, 2);
  core.db.exec('ROLLBACK TO resume_change; RELEASE resume_change');
  assert.equal(queue.resumptions(id).length, 3);
});

test('source recovery inspection reads a workspace once when no recovery changes it', (t) => {
  const {db, id} = fixture(t),
    original = db.get;
  let reads = 0;
  db.get = function (...args) {
    reads++;
    return original.apply(this, args);
  };
  new SourceAccessRecovery({db, slots: () => [], now: Date.now}).tick(id);
  assert.equal(reads, 1);
});

test('idle scheduler ticks do not materialize completed task history', async (t) => {
  const {db, id, queue} = fixture(t);
  for (let n = 0; n < 40; n++)
    queue.put({
      id: 'history-' + n,
      workspaceId: id,
      state: 'completed',
      scanPlan: {checkpoint: 'Synthetic checkpoint '.repeat(1000)},
    });
  const runtime = new WebTasks(db, {
    browserReady: () => true,
    launch: async () => {
      throw Error('No work should launch');
    },
  });
  try {
    const list = queue.list.bind(queue);
    queue.list = (owner, options = {}) => {
      assert.ok(
        options.states || options.batchId || options.summary,
        'A tick must select eligible tasks or lightweight metadata',
      );
      return list(owner, options);
    };
    await runtime.tick();
    await runtime.tick();
    assert.equal(runtime.active.size, 0);
  } finally {
    await runtime.close();
  }
});

test('read indexes are added to existing stores without changing persisted payloads', (t) => {
  const {core, db, id, queue} = fixture(t);
  db.putRun({
    id: 'old',
    automationId: id,
    status: 'blocked',
    kind: 'run',
    sourceUrl: 'https://board.test/search?q=one',
  });
  queue.put({id: 'waiting', workspaceId: id, state: 'blocked', resumeSourceAfterAnswer: true});
  const tables = ['automation_runs', 'workspace_tasks'],
    before = tables.map((name) => core.db.prepare(`SELECT data FROM ${name}`).all());
  for (const name of [
    'automation_runs_status',
    'automation_runs_source_history',
    'workspace_tasks_resume',
  ])
    core.db.exec('DROP INDEX ' + name);
  const reopened = new AutomationStore(core);
  new queue.constructor(core.workspaces);
  for (const name of [
    'automation_runs_status',
    'automation_runs_source_history',
    'workspace_tasks_resume',
  ])
    assert.ok(
      core.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name),
    );
  assert.deepEqual(
    tables.map((name) => core.db.prepare(`SELECT data FROM ${name}`).all()),
    before,
  );
  assert.equal(reopened.sources(id)[0].lastRun.id, 'old');
});
