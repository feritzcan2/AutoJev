import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {automationWorkflow} from '../app/automation/worker.mjs';
import {reviewJevBatch} from '../app/jev/review.mjs';
import {JEV_CLASSIFICATION_VERSION} from '../app/jev/triage.mjs';
import {saveRecordScore} from '../app/scoring/record-scoring.mjs';
import {queueProfileUpdate} from '../app/automation/profile-updates.mjs';

const source = 'https://catalog.test/search?query=example';
const finding = (url, score) => ({
  url,
  title: 'Synthetic finding',
  summary: 'Observed details',
  score,
});
function fixture(t, template = 'custom', threshold = '60') {
  const core = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(core);
  t.after(() => core.close());
  const criteria = Object.fromEntries(
    db
      .template(template)
      .fields.filter((f) => f.required)
      .map((f) => [f.id, 'Synthetic criterion']),
  );
  const a = db.create(template, {
    goal: 'Find suitable records',
    criteria: {...criteria, save_score_threshold: threshold},
    sources: [source],
  });
  db.review(a.id);
  const task = core.workspaces.tasks.enqueue(a.id, {
    operation: 'scan',
    capability: 'browser.observe',
    sourceUrl: source,
    sources: [source],
    lockKey: 'source:' + source,
  });
  const run = db.begin(a.id, {kind: 'run', taskId: task.id});
  const flow = automationWorkflow({db, run, signal: new AbortController().signal, browser: {}});
  return {core, db, id: a.id, run, call: (name, args) => flow.call(a.id, run.id, name, args)};
}

for (const template of ['job-search', 'housing', 'appointment', 'custom'])
  test(`${template}: only new scores strictly below the save threshold are excluded`, async (t) => {
    const f = fixture(t, template),
      urls = [
        'https://first.test/item/a',
        'https://second.test/?entry=42',
        'https://third.test/opaque-token/',
        'https://fourth.test/angebot/one?lang=de',
      ];
    for (const [index, score] of [59, 60, 61, null].entries()) {
      const receipt = await f.call('record_automation_result', finding(urls[index], score));
      if (score === 59) {
        assert.equal(receipt.saved, false);
        assert.equal(receipt.skipped, true);
        assert.equal(receipt.id, undefined);
        assert.equal(receipt.score, 59);
        assert.equal(receipt.saveThreshold, 60);
      } else {
        assert.ok(receipt.id);
        assert.equal(receipt.assessment.score, score);
      }
    }
    assert.equal(f.db.results(f.id).length, 3);
    assert.deepEqual(f.db.seenListingUrls(f.id, source, urls), [urls[0]]);
    assert.deepEqual(f.db.seenListingUrls(f.id, 'https://other-source.test/', urls), []);
    const other = f.db.create('custom', {goal: 'Other workspace', sources: [source]});
    assert.deepEqual(f.db.seenListingUrls(other.id, source, urls), []);
    // Exclusions are scoped to the criteria; a changed minimum reconsiders them.
    f.db.put({
      ...f.db.get(f.id),
      criteria: {...f.db.get(f.id).criteria, save_score_threshold: '50'},
    });
    assert.deepEqual(f.db.seenListingUrls(f.id, source, urls), []);
  });

test('mixed and entirely skipped batches count saved records correctly and retire the pending queue', async (t) => {
  const f = fixture(t),
    low = 'https://catalog.test/low',
    equal = 'https://catalog.test/equal',
    later = 'https://catalog.test/later';
  f.db.observe(f.id, f.run.id, source, 'Results', [low, equal, later]);
  f.db.saveScanProgress(f.id, f.run.id, {
    pendingUrls: [low, equal, later],
    processedUrls: [],
    reason: 'Found three results',
  });
  const result = await f.call('record_automation_results', {
    records: [
      finding(low, 12),
      finding(equal, 60),
      {url: 'https://catalog.test/invalid', title: 'Missing summary', score: 80},
    ],
  });
  assert.equal(result.saved, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.skippedRecords[0].index, 0);
  assert.equal(result.failed[0].index, 2);
  assert.deepEqual(f.db.scanQueue(f.id, f.run.id).pendingUrls, [later]);
  const skipped = await f.call('record_automation_results', {records: [finding(later, 0)]});
  assert.equal(skipped.saved, 0);
  assert.equal(skipped.skipped, 1);
  assert.deepEqual(skipped.records, []);
  assert.equal(f.db.scanQueue(f.id, f.run.id).total, 0);
  assert.equal(f.db.results(f.id).length, 1);
});

test('review accepts score exclusions without saving fake records or skipping incomplete details', async (t) => {
  const f = fixture(t),
    url = 'https://catalog.test/detail?record=15',
    scope = f.run.taskId;
  const task = f.db.jevTasks.create(f.id, scope, {operation: 'collect_details'}),
    evidence = f.db.jevTasks.evidence(task, {url, text: 'Complete short detail.'});
  Object.assign(task, {
    searchId: f.db.run(f.run.id).scan?.work?.activeSearchId ?? 'default',
    classificationVersion: JEV_CLASSIFICATION_VERSION,
    batch: {id: 'batch', urls: [url]},
    items: [
      {
        url,
        collected: true,
        detailComplete: true,
        evidenceId: evidence.id,
        assessment: {decision: 'possible', confidence: 1},
      },
    ],
  });
  f.db.jevTasks.save(task);
  assert.throws(
    () => reviewJevBatch(f.db, f.id, f.run.id, task.id, 'batch'),
    /Review not complete/,
  );
  await f.call('record_automation_result', finding(url, 59));
  assert.deepEqual(reviewJevBatch(f.db, f.id, f.run.id, task.id, 'batch'), []);
  task.items[0].error = 'page_not_ready';
  f.db.jevTasks.save(task);
  assert.throws(() => reviewJevBatch(f.db, f.id, f.run.id, task.id, 'batch'), /missing listing/);
});

test('a listing read in the task is scored, not saved unscored; an unread one may be', async (t) => {
  const f = fixture(t),
    read = 'https://catalog.test/detail?record=16',
    unread = 'https://catalog.test/detail?record=17';
  const task = f.db.jevTasks.create(f.id, f.run.taskId, {operation: 'collect_details'}),
    evidence = f.db.jevTasks.evidence(task, {url: read, text: 'Complete short detail.'});
  task.items = [
    {url: read, collected: true, detailComplete: true, evidenceId: evidence.id},
    {url: unread, detailComplete: false, error: 'page_not_ready'},
  ];
  f.db.jevTasks.save(task);
  const result = await f.call('record_automation_results', {
    records: [finding(read, null), finding(unread, null)],
  });
  assert.equal(result.saved, 1);
  assert.equal(result.failed[0].index, 0);
  assert.match(result.failed[0].error, /was read in this task.*reject it in its review batch/);
  assert.equal(f.db.results(f.id)[0].url, unread);
  assert.equal(f.db.results(f.id)[0].assessment.status, 'unavailable');
});

test('empty or zero thresholds keep low scores and invalid assessments cannot become exclusions', async (t) => {
  for (const threshold of ['', '0']) {
    const f = fixture(t, 'custom', threshold),
      url = 'https://catalog.test/zero';
    const saved = await f.call('record_automation_result', finding(url, 0));
    assert.ok(saved.id);
  }
  const f = fixture(t);
  for (const score of [undefined, -1, 101, 59.5])
    await assert.rejects(
      f.call('record_automation_result', finding('https://catalog.test/invalid', score)),
    );
  assert.equal(f.db.results(f.id).length, 0);
  assert.deepEqual(f.db.seenListingUrls(f.id, source, ['https://catalog.test/invalid']), []);
});

test('rediscovery and manual rescoring keep existing records below the minimum', async (t) => {
  const f = fixture(t),
    url = 'https://catalog.test/existing',
    saved = await f.call('record_automation_result', finding(url, 85));
  const updated = await f.call('record_automation_result', finding(url, 20));
  assert.equal(updated.id, saved.id);
  assert.equal(updated.assessment.score, 20);
  const task = f.core.workspaces.tasks.enqueue(f.id, {
    operation: 'record-score',
    capability: 'browser.evaluate',
    recordId: saved.id,
    recordOperation: 'score',
    lockKey: 'record:' + saved.id,
    request: {manual: true, revision: f.db.get(f.id).revision},
  });
  const worker = f.core.workspaces.workers.add(f.id),
    run = f.db.begin(f.id, {kind: 'run', taskId: task.id}, worker.id);
  assert.equal(saveRecordScore(f.db, f.id, run.id, {score: 10}).id, saved.id);
  assert.equal(f.db.result(f.id, saved.id).assessment.score, 10);
  assert.equal(f.db.result(f.id, saved.id).status, 'found');
});

test('changing the minimum during a scan preserves workers, revisions and checkpoints and affects the next write', async (t) => {
  const f = fixture(t),
    before = f.db.get(f.id),
    run = f.db.run(f.run.id),
    task = f.core.workspaces.tasks.get(f.id, f.run.taskId);
  f.db.setSaveScoreThreshold(f.id, '80', {expectedValue: '60'});
  const after = f.db.get(f.id);
  for (const key of ['revision', 'reviewedRevision', 'status', 'sourceState', 'trial', 'questions'])
    assert.deepEqual(after[key], before[key], key);
  assert.deepEqual(f.db.run(f.run.id), run);
  assert.deepEqual(f.core.workspaces.tasks.get(f.id, f.run.taskId), task);
  const skipped = await f.call(
    'record_automation_result',
    finding('https://catalog.test/live-1', 79),
  );
  assert.equal(skipped.skipped, true);
  f.db.setSaveScoreThreshold(f.id, '50', {expectedValue: '80'});
  const saved = await f.call(
    'record_automation_result',
    finding('https://catalog.test/live-2', 79),
  );
  assert.ok(saved.id);
  assert.equal(f.db.run(f.run.id).status, 'running');
  assert.equal(saved.assessment.revision, before.revision);
  assert.throws(() => f.db.setSaveScoreThreshold(f.id, '90', {expectedValue: '80'}), /changed/);
  for (const value of ['101', '-1', '60.5', true, {}])
    assert.throws(() => f.db.setSaveScoreThreshold(f.id, value));
  assert.equal(f.db.get(f.id).criteria.save_score_threshold, '50');
});

test('live minimum updates stay workspace-scoped and pending profile saves cannot undo them', (t) => {
  const f = fixture(t),
    other = f.db.create('custom', {goal: 'Other', criteria: {save_score_threshold: '20'}}),
    a = f.db.get(f.id);
  f.db.put({
    ...a,
    planDraft: {
      baseRevision: a.revision,
      plan: {goal: 'Draft goal', criteria: {ranking: 'Draft rubric', save_score_threshold: '30'}},
    },
    profileUpdate: {
      baseRevision: a.revision,
      plan: {
        goal: 'Pending goal',
        criteria: {ranking: 'Pending rubric', save_score_threshold: '40'},
      },
    },
  });
  f.db.setSaveScoreThreshold(f.id, '75');
  const updated = f.db.get(f.id);
  assert.equal(updated.planDraft.plan.criteria.save_score_threshold, '75');
  assert.equal(updated.profileUpdate.plan.criteria.save_score_threshold, '75');
  assert.equal(updated.planDraft.plan.criteria.ranking, 'Draft rubric');
  assert.equal(updated.profileUpdate.plan.goal, 'Pending goal');
  assert.equal(f.db.get(other.id).criteria.save_score_threshold, '20');
  queueProfileUpdate(f.db, f.id, {
    criteria: {
      outcome: 'Synthetic',
      rules: 'Synthetic',
      completion: 'Synthetic',
      ranking: 'New rubric',
    },
  });
  assert.equal(f.db.get(f.id).profileUpdate.plan.criteria.save_score_threshold, '75');
});
