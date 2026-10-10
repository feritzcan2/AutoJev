import test from 'node:test';
import assert from 'node:assert/strict';
import {siteSearchRecipe} from '../app/site-extensions/search.mjs';
import {siteExtensionKind} from '../app/site-extensions/index.mjs';
import {normalizeSourceRecipe} from '../app/sources/recipe.mjs';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {automationWorkflow} from '../app/automation/worker.mjs';

const searchOf = (url) => siteExtensionKind(url, 'job-search').search;
const recipe = (template, extra = {}) =>
  normalizeSourceRecipe({entry: {kind: 'url_template', template}, ...extra});

test('the extension keeps the ordering and pagination an agent did not verify', () => {
  const search = searchOf('https://berlinstartupjobs.com/engineering/');
  const agent = recipe('https://berlinstartupjobs.com/{query}/', {
    terms: ['engineering'],
    pagination: 'next_link',
    notes: 'own notes',
  });
  const {recipe: saved, changed} = siteSearchRecipe(search, agent);
  assert.deepEqual(saved, {
    ...agent,
    pagination: 'url_param',
    ordering: 'newest_first',
  });
  assert.deepEqual(changed, ['pagination', 'ordering']);
  assert.equal(saved.entry.template, agent.entry.template, 'the path stays the agent choice');
  assert.deepEqual(saved.terms, ['engineering'], 'terms stay the agent choice');
});

test('a site without a known order cannot be claimed newest first', () => {
  const agent = recipe('https://www.xing.com/jobs/search?keywords={query}&location={location}', {
    pagination: 'url_param',
    ordering: 'newest_first',
  });
  const {recipe: saved, changed} = siteSearchRecipe(searchOf('https://www.xing.com/jobs/'), agent);
  assert.equal(saved.ordering, undefined);
  assert.deepEqual(changed, ['ordering']);
});

test('the sort parameters come back; the agent path, placeholders and filter values stay', () => {
  const search = searchOf('https://www.stepstone.de/');
  const city = 'https://www.stepstone.de/jobs/{query}/in-berlin?radius=30&fdl=en';
  const {recipe: saved, changed} = siteSearchRecipe(search, recipe(city));
  const url = new URL(saved.entry.template.replace('{query}', 'q'));
  assert.equal(url.pathname, '/jobs/q/in-berlin');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    radius: '30',
    fdl: 'en',
    sort: '2',
    action: 'sort_publish',
  });
  assert.deepEqual(changed, ['template', 'pagination', 'ordering']);
  const kept = recipe(search.template, {pagination: 'url_param', ordering: 'newest_first'});
  assert.deepEqual(siteSearchRecipe(search, kept), {recipe: kept, changed: []});
  const linkedin = siteSearchRecipe(
    searchOf('https://www.linkedin.com/jobs/'),
    recipe(
      'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords={query}&location={location}&sortBy=R&f_WT=2',
    ),
  ).recipe.entry.template;
  assert.match(linkedin, /sortBy=DD/);
  assert.match(linkedin, /f_WT=2/);
  assert.match(linkedin, /keywords=\{query\}&location=\{location\}/);
});

test('a trial cannot save a search form for a site whose results address the extension knows', async (t) => {
  const core = new WorkspaceDatabase(':memory:');
  t.after(() => core.close());
  const db = new AutomationStore(core),
    url = 'https://berlinstartupjobs.com/engineering/',
    a = db.create('job-search', {
      goal: 'backend',
      criteria: {preferences: 'Germany'},
      sources: [url],
    });
  db.review(a.id);
  const task = core.workspaces.tasks.enqueue(a.id, {
      sourceUrl: url,
      operation: 'trial',
      sources: [url],
      lockKey: 'source:' + url,
    }),
    run = db.begin(a.id, {kind: 'trial', taskId: task.id});
  const flow = automationWorkflow({db, run, signal: new AbortController().signal});
  await assert.rejects(
    flow.call(a.id, run.id, 'save_source_recipe', {
      entry: {
        kind: 'search_form',
        url,
        fields: [{key: 'query', label: 'Search'}],
      },
    }),
    /site eklentisinde tanımlı/,
  );
  assert.equal(db.sources(a.id)[0].recipe.entry.template, 'https://berlinstartupjobs.com/{query}/');
});
