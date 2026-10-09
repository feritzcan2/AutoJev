import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {sourceScanScope} from '../app/sources/scan.mjs';

test('opening schema 34 data folds job-search scoring weights into the rubric and keeps saved scans', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'scoring-criteria-upgrade-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const file = path.join(directory, 'state.sqlite'),
    url = 'https://jobs.test/search',
    detail = url + '/seen';
  let core = new WorkspaceDatabase(file),
    db = new AutomationStore(core);
  t.after(() => core.close());
  const a = db.create('job-search', {
    goal: 'Find work',
    criteria: {preferences: 'Remote', ranking: 'Security work first.'},
    sources: [url],
  });
  db.review(a.id);
  db.skipTrial(a.id);
  db.enable(a.id);
  const task = core.workspaces.tasks.enqueue(a.id, {
    operation: 'scan',
    sourceUrl: url,
    sources: [url],
    lockKey: 'source:' + url,
  });
  const run = db.begin(a.id, {kind: 'run', taskId: task.id});
  db.rememberSeenListings(a.id, url, [detail], 'Rejected under the same criteria');
  db.finish(a.id, run.id, 'interrupted', 'App closed');
  // Reproduce schema 34: weights were criteria fields and scan scopes included them.
  const weights = {
    weight_technical: '70',
    weight_experience: '10',
    weight_role: '10',
    weight_preferences: '10',
  };
  const saved = db.get(a.id),
    scope = sourceScanScope(saved, url),
    oldScope = sourceScanScope({...saved, criteria: {...saved.criteria, ...weights}}, url);
  for (const table of ['automations', 'automation_runs', 'workspace_tasks'])
    for (const row of core.db.prepare(`SELECT id,data FROM ${table}`).all()) {
      const value = JSON.parse(row.data.replaceAll(scope, oldScope));
      if (table === 'automations') {
        value.criteria = {...value.criteria, ...weights};
        value.planDraft = {
          plan: {criteria: {...value.criteria, weight_role: '20'}},
          baseRevision: value.revision,
        };
      }
      core.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(value), row.id);
    }
  core.db.prepare('UPDATE scan_seen_listings SET scope_key=?').run(oldScope);
  core.db.exec('PRAGMA user_version=34');
  core.close();
  core = new WorkspaceDatabase(file);
  db = new AutomationStore(core);

  const upgraded = db.get(a.id),
    current = sourceScanScope(upgraded, url);
  assert.deepEqual(upgraded.criteria, {
    preferences: 'Remote',
    ranking:
      'Security work first.\n\nAğırlıklar: teknik yetkinlik %70, deneyim %10, rol %10, tercihler %10.',
  });
  assert.equal(upgraded.planDraft.plan.criteria.weight_role, undefined);
  assert.match(upgraded.planDraft.plan.criteria.ranking, /rol %20/);
  assert.equal(upgraded.sourceState[url].scanState.scopeKey, current);
  assert.equal(db.run(run.id).scanPlan.scopeKey, current);
  const nextTask = core.workspaces.tasks.enqueue(a.id, {
    operation: 'scan',
    sourceUrl: url,
    sources: [url],
    lockKey: 'source:' + url,
  });
  const next = db.begin(a.id, {kind: 'run', taskId: nextTask.id});
  assert.equal(
    next.scanPlan.id,
    db.run(run.id).scanPlan.id,
    'the interrupted scan resumes instead of starting over',
  );
  assert.deepEqual(
    db.knownListingUrls(a.id, next.id, [detail]),
    [detail],
    'rejected listings stay known',
  );
  db.finish(a.id, next.id, 'interrupted', 'Restart');
  assert.equal(
    db.save(a.id, {mode: 'observe'}).revision,
    upgraded.revision,
    'saving settings keeps the folded criteria valid',
  );
});
