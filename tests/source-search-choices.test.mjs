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

test('a source search takes setups that search another place with their own filters', async (t) => {
  const {db, id, chat, plan} = await fixture(t, {onboarding: true});
  const workable = 'https://jobs.workable.com/';
  await plan({
    addSources: [workable],
    sourceSearches: [
      {
        url: workable,
        terms: ['Staff Backend Engineer', 'Senior Backend Engineer'],
        filters: [
          {param: 'workplace', value: 'hybrid'},
          {param: 'employment_type', value: 'full_time'},
        ],
        setups: [
          {
            label: 'Remote in the US',
            location: 'United States',
            filters: [{param: 'workplace', value: 'remote'}],
          },
        ],
      },
    ],
  });
  const recipe = db.get(id).sourceSettings[workable].recipe;
  assert.match(recipe.entry.template, /location=\{location\}/);
  assert.match(recipe.entry.template, /workplace=hybrid/);
  assert.equal(recipe.entry.variants.length, 1);
  assert.equal(recipe.entry.variants[0].label, 'Remote in the US');
  assert.match(recipe.entry.variants[0].template, /query=\{query\}/);
  assert.match(recipe.entry.variants[0].template, /location=United\+States/);
  assert.match(recipe.entry.variants[0].template, /workplace=remote/);
  assert.match(
    recipe.entry.variants[0].template,
    /employment_type=full_time/,
    'main filters stay in a setup',
  );
  assert.equal(
    db.sourceRecipe(id, workable).replay.searches.length,
    4,
    'every term in every setup',
  );
  assert.deepEqual(
    automationTaskContext(db, id, chat, {section: 'profile'})
      .sourceSearch.find((o) => o.url === workable)
      .setups.map((s) => s.label),
    ['Remote in the US'],
  );

  // New terms keep the setups; an empty list removes them.
  await plan({sourceSearches: [{url: workable, terms: ['Principal Engineer']}]});
  assert.equal(db.get(id).sourceSettings[workable].recipe.entry.variants.length, 1);
  await plan({sourceSearches: [{url: workable, setups: []}]});
  assert.equal(db.get(id).sourceSettings[workable].recipe.entry.variants, undefined);

  await assert.rejects(
    plan({
      sourceSearches: [
        {url: workable, setups: [{label: 'x', filters: [{param: 'workplace', value: 'moon'}]}]},
      ],
    }),
    /accepts remote, hybrid, on_site/,
  );
  await assert.rejects(
    plan({
      sourceSearches: [
        {
          url: workable,
          terms: ['a', 'b', 'c', 'd'],
          setups: [{label: 'x'}, {label: 'y'}],
        },
      ],
    }),
    /more than 10 searches/,
  );
});
