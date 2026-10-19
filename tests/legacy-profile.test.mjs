import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {EARLIER_PROFILE_DOCUMENT} from '../app/automation/legacy-profile.mjs';
import {workspaceDirectory} from '../app/workspaces/paths.mjs';
import {loadScoringDocuments} from '../app/scoring/profile.mjs';
import {planInput} from '../app/templates/catalog.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'legacy-profile-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const core = new WorkspaceDatabase(path.join(directory, 'state.sqlite'));
  t.after(() => core.close());
  const db = new AutomationStore(core),
    a = db.create('job-search', {goal: 'Find backend work', criteria: {preferences: 'Backend'}}),
    root = workspaceDirectory(core.directory, core.workspaces.get(a.id)),
    cv = path.join(root, 'documents/import/CV.txt');
  await mkdir(path.dirname(cv), {recursive: true});
  await writeFile(cv, 'Synthetic CV: nine years of backend work.');
  const saved = db.get(a.id);
  db.put({
    ...saved,
    criteria: {...saved.criteria, constraints: 'Only Berlin or remote Germany.'},
    referenceData: {
      profile: {
        facts: 'Synthetic summary of the earlier profile.',
        learnedFacts: {notice_period: {value: '2 months'}, empty: {value: ''}},
        cvPath: cv,
      },
      applicationPolicy: {acceptPrivacy: true},
      previousTasks: [{id: 'old'}],
    },
    planDraft: {
      baseRevision: saved.revision,
      runId: 'old-chat',
      updatedAt: 1,
      plan: {
        title: saved.title,
        goal: saved.goal,
        criteria: {preferences: 'Backend', constraints: 'Draft requirement.'},
        instructions: '',
        facts: '',
      },
    },
  });
  return {core, id: a.id, root};
}

test('an imported profile becomes documents and its retired field joins the instructions', async (t) => {
  const {core, id, root} = await fixture(t);
  // The conversion runs when the store opens.
  const db = new AutomationStore(core),
    a = db.get(id);
  assert.equal(a.referenceData, undefined);
  assert.equal(Object.hasOwn(a.criteria, 'constraints'), false);
  assert.match(
    a.instructions,
    /Hard requirements \(moved from a replaced field\): Only Berlin or remote Germany\./,
  );
  assert.equal(Object.hasOwn(a.planDraft.plan.criteria, 'constraints'), false);
  assert.match(a.planDraft.plan.instructions, /Draft requirement\./);
  assert.doesNotThrow(() => planInput(db.template(a.templateId), {criteria: a.criteria}, a));
  assert.deepEqual(db.userDocuments(id), [EARLIER_PROFILE_DOCUMENT, 'documents/import/CV.txt']);
  const earlier = await readFile(path.join(root, EARLIER_PROFILE_DOCUMENT), 'utf8');
  assert.match(earlier, /Synthetic summary of the earlier profile\./);
  assert.match(earlier, /- notice_period: 2 months/);
  assert.doesNotMatch(earlier, /- empty:/);
  const documents = await loadScoringDocuments(db, id);
  assert.match(documents.text, /Synthetic summary/);
  assert.match(documents.text, /nine years of backend work/);
  assert.equal(documents.unavailable, undefined);
});

test('the conversion runs once and keeps a document the user changed', async (t) => {
  const {core, id, root} = await fixture(t);
  const first = new AutomationStore(core),
    messages = first.messages(id).length;
  await writeFile(path.join(root, EARLIER_PROFILE_DOCUMENT), 'Edited by the user.');
  const again = new AutomationStore(core);
  assert.equal(again.messages(id).length, messages);
  assert.equal(
    await readFile(path.join(root, EARLIER_PROFILE_DOCUMENT), 'utf8'),
    'Edited by the user.',
  );
});

test('a workspace without old data is left unchanged', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'legacy-profile-none-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const core = new WorkspaceDatabase(path.join(directory, 'state.sqlite'));
  t.after(() => core.close());
  const a = new AutomationStore(core).create('job-search', {goal: 'Find work'}),
    before = JSON.stringify(new AutomationStore(core).get(a.id));
  assert.equal(JSON.stringify(new AutomationStore(core).get(a.id)), before);
  assert.deepEqual(new AutomationStore(core).userDocuments(a.id), []);
});
