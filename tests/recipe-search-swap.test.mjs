import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';

const source = 'https://jobs.example.test/';
const recipe = (terms) => ({
  entry: {kind: 'url_template', template: 'https://jobs.example.test/search?q={query}'},
  pagination: 'url_param',
  terms,
});
const labels = (scan) => scan.work.searches.map((s) => s.label);

function scan(t) {
  const core = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(core);
  t.after(() => core.close());
  const a = db.create('job-search', {
    goal: 'backend',
    criteria: {preferences: 'Germany'},
    sources: [source],
  });
  db.saveSource(a.id, source, {recipe: recipe(['Compliance', 'Privacy', 'Risk'])});
  db.review(a.id);
  const task = core.workspaces.tasks.enqueue(a.id, {
      sourceUrl: source,
      operation: 'scan',
      sources: [source],
      lockKey: 'source:' + source,
    }),
    run = db.begin(a.id, {kind: 'run', taskId: task.id});
  return {core, db, id: a.id, task, run};
}

test('a recipe learned mid-scan replaces the old searches the agent has not started', (t) => {
  const {core, db, id, task, run} = scan(t);
  assert.deepEqual(labels(db.run(run.id).scan), ['Compliance', 'Privacy', 'Risk']);
  db.learnSourceRecipe(id, source, recipe(['operations', 'finance']), {
    runId: run.id,
    verified: true,
  });
  const current = db.run(run.id).scan;
  assert.deepEqual(
    labels(current),
    ['Compliance', 'operations', 'finance'],
    'the active search stays until the agent completes it',
  );
  assert.equal(current.work.activeSearchId, 'replay-1');
  assert.deepEqual(labels(core.workspaces.tasks.get(id, task.id).scan), labels(current));
});

test('a retried scan drops the old recipe searches but keeps their queued listings', (t) => {
  const {core, db, id, task, run} = scan(t);
  const queued = db.run(run.id).scan;
  queued.work.searches[1].pendingUrls = ['https://jobs.example.test/job/1'];
  queued.work.searches[0].status = 'completed';
  queued.work.activeSearchId = 'replay-2';
  db.persistScan(id, {...db.run(run.id), scan: queued});
  db.finish(id, run.id, 'blocked', 'Eski aramalar bekliyor.');
  assert.equal(core.workspaces.tasks.get(id, task.id).state, 'blocked');
  db.saveSource(id, source, {recipe: recipe(['operations', 'finance'])});
  const kept = core.workspaces.tasks.get(id, task.id).scan;
  assert.deepEqual(labels(kept), ['Compliance', 'Privacy'], 'Risk had nothing queued');
  assert.deepEqual(kept.pendingUrls, ['https://jobs.example.test/job/1']);
  assert.deepEqual(labels(db.get(id).sourceState[source].scan), labels(kept));
});
