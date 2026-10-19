import {unknownScorecard} from './helpers/scorecard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {listingDescription, readListingDescription} from '../app/records/description.mjs';

const source = 'https://jobs.example.test/jobs';
const detail = 'https://jobs.example.test/jobs/view/synthetic-data-role-42/';
const text = 'Synthetic data role\ncompany: Example Ltd\n\nBuild pipelines in a small team.';
const assessment = {
  status: 'scored',
  scorecard: unknownScorecard(),
  score: 70,
  summary: 'Relevant work.',
  evidenceUrl: detail,
  evidence: 'Role and team size.',
  strengths: [],
  gaps: [],
  uncertainties: [],
};

function fixture(t) {
  const core = new WorkspaceDatabase(':memory:');
  t.after(() => core.close());
  const db = new AutomationStore(core);
  const a = db.create('job-search', {
    goal: 'Data roles',
    criteria: {preferences: 'Remote', ranking: 'Compare role and skills'},
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
  const record = (patch = {}) =>
    db.record(a.id, run.id, {
      url: detail,
      title: 'Synthetic data role',
      summary: 'Short',
      assessment,
      ...patch,
    });
  return {core, db, id: a.id, run, record};
}

test('a saved record keeps the listing text its scan read, outside the record JSON', (t) => {
  const f = fixture(t);
  f.db.observe(f.id, f.run.id, detail, text);
  const saved = f.record();
  const description = listingDescription(f.db, f.id, saved.id);
  assert.equal(description.text, text);
  assert.equal(description.url, detail);
  assert.equal(typeof description.readAt, 'number');
  assert.equal(f.db.result(f.id, saved.id).description, undefined);
  assert.ok(!JSON.stringify(f.db.snapshot(f.id).results).includes('Build pipelines'));
});

test('a record without read listing text has no description instead of an empty one', (t) => {
  const f = fixture(t);
  const saved = f.record();
  assert.equal(listingDescription(f.db, f.id, saved.id), null);
});

test('a newer read replaces the saved description and deleting the record removes it', (t) => {
  const f = fixture(t);
  f.db.observe(f.id, f.run.id, detail, text);
  const saved = f.record();
  f.db.observe(f.id, f.run.id, detail, text + '\nUpdated.');
  f.record({summary: 'Again'});
  assert.match(listingDescription(f.db, f.id, saved.id).text, /Updated\.$/);
  f.core.db.prepare('DELETE FROM workspace_records WHERE id=?').run(saved.id);
  assert.equal(
    f.core.db.prepare('SELECT count(*) AS n FROM workspace_record_descriptions').get().n,
    0,
  );
});

test('reading again reports a site without its own reader instead of saving nothing', async (t) => {
  const f = fixture(t);
  const saved = f.record();
  await assert.rejects(readListingDescription(f.db, f.id, saved.id), /only be read in the browser/);
  assert.equal(listingDescription(f.db, f.id, saved.id), null);
});
