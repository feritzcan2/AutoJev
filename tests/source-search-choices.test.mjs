import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {WebTasks} from '../app/automation/web-template.mjs';
import {automationTaskContext} from '../app/automation/task-context.mjs';
import {automationWorkflow} from '../app/automation/worker.mjs';

const dice = 'https://www.dice.com/',
  other = 'https://other.test/jobs';

async function fixture(t, {onboarding = false} = {}) {
  const core = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(core),
    a = db.create('job-search', {
      goal: 'backend',
      criteria: {preferences: 'Remote staff backend roles', country: 'US'},
      sources: [other],
    });
  if (!onboarding) db.review(a.id);
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

test('the initial setup applies its sources and search terms without a draft', async (t) => {
  const {db, id, plan} = await fixture(t, {onboarding: true});
  const result = await plan({
    addSources: [dice],
    sourceSearches: [{url: dice, terms: ['Staff Backend Engineer']}],
  });
  assert.equal(result.applied, true);
  const a = db.get(id);
  assert.equal(a.sourceDraft, undefined);
  assert.deepEqual(a.sources, [other, dice]);
  assert.deepEqual(a.sourceSettings[dice].recipe.terms, ['Staff Backend Engineer']);
});

test('the initial setup adds the boards of a newly saved country and names those without terms', async (t) => {
  const {db, id, plan} = await fixture(t, {onboarding: true});
  const criteria = Object.entries({...db.get(id).criteria, country: 'DK'}).map(([key, value]) => ({
    key,
    value,
  }));
  const result = await plan({criteria});
  const a = db.get(id),
    jobindex = 'https://www.jobindex.dk/';
  assert.ok(a.sources.includes(jobindex), 'a Danish board joins with the country');
  assert.ok(a.sources.includes('https://jobnet.dk/'));
  assert.ok(!a.sources.some((url) => url.includes('france')), 'other countries stay out');
  assert.ok(result.sourcesWithoutTerms.includes(jobindex));
  assert.match(result.message, /sourceSearches/);
  await plan({criteria, sourceSearches: [{url: jobindex, terms: ['backend udvikler']}]});
  assert.deepEqual(db.get(id).sourceSettings[jobindex].recipe.terms, ['backend udvikler']);
  assert.equal(
    db.get(id).sources.filter((url) => url === jobindex).length,
    1,
    'saving again adds nothing twice',
  );
});

test('the setup agent sets the workspace search terms once; a source can keep its own', async (t) => {
  const {db, id, chat, plan} = await fixture(t);
  await plan({addSources: [dice], searchTerms: ['Staff Backend Engineer', 'Principal Engineer']});
  let draft = db.get(id).sourceDraft;
  assert.deepEqual(draft.searchTerms, ['Staff Backend Engineer', 'Principal Engineer']);
  assert.equal(db.get(id).searchTerms, undefined, 'nothing applies before the user does');
  assert.deepEqual(
    automationTaskContext(db, id, chat, {section: 'profile'}).automation.searchTerms,
    ['Staff Backend Engineer', 'Principal Engineer'],
    'the agent reads its pending terms',
  );
  // A later call that names other changes keeps the pending terms.
  await plan({
    sourceSearches: [{url: dice, filters: [{param: 'filters.postedDate', value: 'THREE'}]}],
  });
  draft = db.get(id).sourceDraft;
  assert.deepEqual(draft.searchTerms, ['Staff Backend Engineer', 'Principal Engineer']);
  db.resolveSourceDraft(id, draft.id, true);
  const options = () =>
    automationTaskContext(db, id, chat, {section: 'profile'}).sourceSearch.find(
      (o) => o.url === dice,
    );
  let source = db.sources(id).find((s) => s.url === dice);
  assert.deepEqual(db.get(id).searchTerms, ['Staff Backend Engineer', 'Principal Engineer']);
  assert.equal(db.get(id).sourceSettings[dice].recipe.terms, undefined);
  assert.deepEqual(source.recipe.terms, ['Staff Backend Engineer', 'Principal Engineer']);
  assert.equal(source.termsRequired, false);
  assert.equal(options().usesSearchTerms, true);
  assert.equal(db.sourceRecipe(id, dice).replay.searches.length, 2);

  await plan({sourceSearches: [{url: dice, terms: ['Remote Backend']}]});
  db.resolveSourceDraft(id, db.get(id).sourceDraft.id, true);
  source = db.sources(id).find((s) => s.url === dice);
  assert.deepEqual(source.recipe.terms, ['Remote Backend'], 'own terms win');
  assert.equal(options().usesSearchTerms, undefined);

  await plan({sourceSearches: [{url: dice, terms: []}]});
  db.resolveSourceDraft(id, db.get(id).sourceDraft.id, true);
  assert.deepEqual(
    db.sources(id).find((s) => s.url === dice).recipe.terms,
    ['Staff Backend Engineer', 'Principal Engineer'],
    'empty terms return the source to the workspace terms',
  );
});

test('the initial setup applies the workspace search terms right away', async (t) => {
  const {db, id, plan} = await fixture(t, {onboarding: true});
  const result = await plan({addSources: [dice], searchTerms: ['Staff Backend Engineer']});
  assert.equal(result.applied, true);
  assert.equal(result.sourcesWithoutTerms, undefined);
  const a = db.get(id);
  assert.equal(a.sourceDraft, undefined);
  assert.deepEqual(a.searchTerms, ['Staff Backend Engineer']);
  assert.deepEqual(db.sources(id).find((s) => s.url === dice).recipe.terms, [
    'Staff Backend Engineer',
  ]);
});
