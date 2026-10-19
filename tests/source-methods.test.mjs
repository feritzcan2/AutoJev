import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {jobSearchSources} from '../app/templates/job-search/sources.mjs';
import {sourceScanScope} from '../app/sources/scan.mjs';
import {automationTaskContext} from '../app/automation/task-context.mjs';
import {automationPrompt} from '../app/automation/prompts.mjs';
import {reusableTemplate, automationTemplate} from '../app/templates/catalog.mjs';

function fixture(t) {
  const core = new WorkspaceDatabase(':memory:');
  t.after(() => core.close());
  const db = new AutomationStore(core),
    a = db.create('job-search', {
      sources: [],
      goal: 'Find developer roles',
      criteria: {preferences: 'Berlin', ranking: 'Role and location, 0–100'},
    });
  return {core, db, id: a.id};
}
function beginTrial(db, id, url) {
  const task = db.store.workspaces.tasks.enqueue(id, {
    operation: 'trial',
    sourceUrl: url,
    sources: [url],
    lockKey: 'source:' + url,
  });
  return db.begin(id, {kind: 'trial', taskId: task.id});
}
const freehire = jobSearchSources.find((s) => s.url === 'https://freehire.me/');
test('browser sources keep their agent prompt while Himalayas has a native collection method', () => {
  for (const source of jobSearchSources) {
    assert.equal(source.tool, undefined);
    assert.equal(source.skill, undefined);
    if (source.name !== 'Himalayas')
      assert.doesNotMatch(source.instructions ?? '', /CLI|sourceRead|assignedSource\.cli/);
  }
  for (const kind of ['trial', 'run']) {
    const prompt = automationPrompt({kind, sourceUrl: freehire.url});
    assert.doesNotMatch(prompt, /CLI|sourceRead|assignedSource\.cli/);
    assert.match(prompt, /Jev delegation is available/);
  }
});
test('source and skill are independent workspace copies, used by the agent and removable without deleting records', (t) => {
  const {db, core, id} = fixture(t),
    other = db.create('job-search', {sources: []}),
    entry = {...structuredClone(freehire), skill: 'Shared skill'};
  db.addSource(id, entry);
  db.addSource(other.id, entry);
  const original = db.sources(id)[0];
  assert.equal(original.skill, 'Shared skill');
  entry.name = 'Changed input name';
  entry.instructions = 'Changed input method';
  entry.skill = 'Changed input skill';
  assert.equal(db.sources(id)[0].skill, original.skill);
  assert.equal(db.sources(id)[0].instructions, original.instructions);
  db.saveSource(id, entry.url, {
    name: 'My copy',
    instructions: 'My local method',
    skill: 'My edited skill',
  });
  assert.equal(db.sources(other.id)[0].skill, original.skill);
  assert.equal(db.sources(id)[0].skill, 'My edited skill');
  const exported = reusableTemplate({
    ...automationTemplate('job-search'),
    defaultSources: db.sources(id),
  });
  assert.equal(exported.defaultSources[0].skill, 'My edited skill');
  db.review(id);
  const run = beginTrial(db, id, entry.url),
    context = automationTaskContext(db, id, run);
  assert.equal(context.assignedSource.skill, 'My edited skill');
  assert.equal(context.assignedSource.cli, undefined);
  assert.equal(context.assignedSource.tool, undefined);
  assert.throws(() => db.removeSource(id, entry.url), /running/);
  const record = db.record(id, run.id, {
    url: 'https://employer.test/job/1',
    title: 'Synthetic job',
    summary: 'Saved finding',
  });
  db.finish(id, run.id, 'interrupted', 'Done');
  const pending = core.workspaces.tasks.enqueue(id, {
    operation: 'trial',
    sourceUrl: entry.url,
    sources: [entry.url],
    lockKey: 'source:' + entry.url,
  });
  db.removeSource(id, entry.url);
  assert.equal(db.sources(id).length, 0);
  assert.equal(db.get(id).sourceSettings[entry.url], undefined);
  assert.equal(db.result(id, record.id).title, 'Synthetic job');
  assert.equal(core.workspaces.tasks.get(id, pending.id).state, 'cancelled');
  assert.equal(db.sources(other.id).length, 1);
});
test('method changes invalidate only the source trial and scope', (t) => {
  const {db, id} = fixture(t);
  for (const source of [freehire, jobSearchSources[0]]) db.addSource(id, source);
  const a = db.get(id);
  db.put({
    ...a,
    sourceState: Object.fromEntries(
      a.sources.map((url) => [
        url,
        {trial: {status: 'passed', runId: 'old'}, scan: {pendingUrls: ['https://jobs.test/1']}},
      ]),
    ),
  });
  const before = db.get(id),
    other = before.sources[1],
    oldScope = sourceScanScope(before, freehire.url);
  db.saveSource(id, freehire.url, {
    instructions: 'Use a different query strategy',
    skill: 'Read this local skill',
  });
  assert.notEqual(sourceScanScope(db.get(id), freehire.url), oldScope);
  assert.equal(db.get(id).sourceState[freehire.url].trial, null);
  assert.deepEqual(db.get(id).sourceState[other], before.sourceState[other]);
  db.review(id);
  const run = beginTrial(db, id, freehire.url);
  const context = automationTaskContext(db, id, run);
  assert.equal(context.assignedSource.instructions, 'Use a different query strategy');
  assert.equal(context.assignedSource.skill, 'Read this local skill');
});
test('re-adding a starting source from an empty form restores its template recipe and instructions', (t) => {
  const {db, id} = fixture(t),
    linkedin = jobSearchSources.find((s) => s.url === 'https://www.linkedin.com/jobs/');
  db.addSource(id, {
    url: linkedin.url,
    name: 'LinkedIn',
    query: 'Senior Backend Engineer',
    instructions: '',
    recipe: null,
    mode: 'observe',
    intervalMinutes: 60,
  });
  const source = db.sources(id).find((s) => s.url === linkedin.url);
  assert.deepEqual(source.recipe, linkedin.recipe);
  assert.equal(source.instructions, linkedin.instructions);
  assert.equal(source.query, 'Senior Backend Engineer');
  db.removeSource(id, linkedin.url);
  db.addSource(id, {url: linkedin.url, name: 'LinkedIn', instructions: 'Mine', recipe: null});
  assert.equal(db.sources(id).find((s) => s.url === linkedin.url).instructions, 'Mine');
});
test('another address on a starting source site gets that source template settings', (t) => {
  const {db, id} = fixture(t),
    linkedin = jobSearchSources.find((s) => s.url === 'https://www.linkedin.com/jobs/'),
    search = 'https://linkedin.com/jobs/search?keywords=engineer&location=Berlin';
  db.addSource(id, {url: search, name: 'LinkedIn search', instructions: '', recipe: null});
  const added = db.sources(id).find((s) => s.url === search);
  assert.deepEqual(added.recipe, linkedin.recipe);
  assert.equal(added.instructions, linkedin.instructions);
  assert.equal(added.name, 'LinkedIn search');
  // Country hosts stay distinct; an unknown site gets nothing.
  db.saveSources(id, [
    ...db.get(id).sources,
    'https://uk.indeed.com/',
    'https://eg.indeed.com/',
    'https://jobs.example.test/',
  ]);
  const sources = db.sources(id);
  assert.equal(
    sources.find((s) => s.url === 'https://uk.indeed.com/').recipe.entry.template,
    'https://uk.indeed.com/jobs?q={query}&l={location}&sort=date',
  );
  assert.equal(sources.find((s) => s.url === 'https://eg.indeed.com/').recipe, undefined);
  assert.equal(sources.find((s) => s.url === 'https://jobs.example.test/').recipe, undefined);
});
