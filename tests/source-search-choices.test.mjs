import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {WebTasks} from '../app/automation/web-template.mjs';
import {automationTaskContext} from '../app/automation/task-context.mjs';
import {automationWorkflow} from '../app/automation/worker.mjs';

const dice = 'https://www.dice.com/',
  other = 'https://other.test/jobs';

async function fixture(t) {
  const core = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(core),
    a = db.create('job-search', {
      goal: 'backend',
      criteria: {preferences: 'Remote staff backend roles', country: 'US'},
      sources: [other],
    });
  db.review(a.id);
  const runtime = new WebTasks(db, {
    launch: async () => ({close: async () => {}, message: async () => {}}),
  });
  t.after(async () => {
    await runtime.close();
    core.close();
  });
  const chat = await runtime.message(a.id, 'Set up the sources.'),
    flow = automationWorkflow({db, run: chat, signal: {aborted: false}, browser: {}}),
    saved = db.get(a.id);
  const plan = (input) =>
    flow.call(a.id, chat.id, 'save_automation_plan', {
      title: saved.title,
      goal: saved.goal,
      criteria: Object.entries(saved.criteria).map(([key, value]) => ({key, value})),
      instructions: saved.instructions,
      facts: saved.facts,
      ...input,
    });
  return {db, id: a.id, chat, plan};
}

test('the setup agent chooses search terms and filters of extension sources in the source draft', async (t) => {
  const {db, id, chat, plan} = await fixture(t);
  await plan({
    addSources: [dice],
    sourceSearches: [
      {
        url: dice,
        terms: ['Staff Backend Engineer', 'Principal Engineer'],
        filters: [
          {param: 'filters.workplaceTypes', value: 'Remote'},
          {param: 'filters.postedDate', value: 'THREE'},
        ],
      },
    ],
  });
  const draft = db.get(id).sourceDraft;
  assert.deepEqual(draft.sources, [other, dice]);
  assert.deepEqual(
    draft.searches[dice].filters.map((f) => f.label),
    ['Workplace: Remote', 'Posted: Last 3 days'],
  );
  assert.equal(db.get(id).sourceSettings[dice], undefined, 'nothing applies before the user does');

  const options = automationTaskContext(db, id, chat, {section: 'profile'}).sourceSearch;
  assert.deepEqual(
    options.map((o) => o.url),
    [dice],
    'only sources whose extension knows the search are listed',
  );
  assert.deepEqual(options[0].terms, ['Staff Backend Engineer', 'Principal Engineer']);
  assert.equal(
    options[0].filters.find((f) => f.param === 'filters.workplaceTypes').current,
    'Remote',
  );
  assert.ok(
    options[0].filters.every((f) => f.values),
    'free-text filters are not offered',
  );

  await assert.rejects(
    plan({
      sourceSearches: [
        {url: dice, filters: [{param: 'filters.workplaceTypes', value: 'Anywhere'}]},
      ],
    }),
    /accepts Remote, On-Site, Hybrid/,
  );
  await assert.rejects(
    plan({sourceSearches: [{url: dice, filters: [{param: 'sort', value: 'date'}]}]}),
    /not a choosable filter/,
  );
  await assert.rejects(
    plan({sourceSearches: [{url: 'https://www.dice.com/jobs', terms: ['x']}]}),
    /Not a saved or suggested source/,
  );
  await assert.rejects(
    plan({sourceSearches: [{url: other, terms: ['x']}]}),
    /no site extension search/,
  );
  assert.equal(db.get(id).sourceDraft.id, draft.id, 'a rejected call keeps the draft');

  db.resolveSourceDraft(id, draft.id, true);
  let a = db.get(id);
  const recipe = a.sourceSettings[dice].recipe;
  assert.equal(a.sourceSettings[dice].name, 'Dice', 'the starting source settings stay');
  assert.match(recipe.entry.template, /q=\{query\}&location=\{location\}/);
  assert.match(recipe.entry.template, /filters\.postedDate=THREE/);
  assert.match(recipe.entry.template, /filters\.workplaceTypes=Remote/);
  assert.deepEqual(recipe.terms, ['Staff Backend Engineer', 'Principal Engineer']);
  assert.equal(a.sourceState[dice].recipeState.status, 'candidate');
  assert.equal(a.sourceDraft, undefined);

  // A later profile change: only the search changes, the source list stays.
  await plan({
    sourceSearches: [{url: dice, filters: [{param: 'filters.workplaceTypes', value: ''}]}],
  });
  assert.deepEqual(db.get(id).sourceDraft.sources, [other, dice]);
  db.resolveSourceDraft(id, db.get(id).sourceDraft.id, true);
  a = db.get(id);
  assert.doesNotMatch(a.sourceSettings[dice].recipe.entry.template, /workplaceTypes/);
  assert.match(a.sourceSettings[dice].recipe.entry.template, /filters\.postedDate=THREE/);
  assert.deepEqual(a.sourceSettings[dice].recipe.terms, [
    'Staff Backend Engineer',
    'Principal Engineer',
  ]);
});
