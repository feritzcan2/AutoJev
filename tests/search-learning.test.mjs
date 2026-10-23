import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {WebTasks} from '../app/automation/web-template.mjs';
import {automationWorkflow} from '../app/automation/worker.mjs';
import {automationTaskContext} from '../app/automation/task-context.mjs';
import {prepareCollection} from '../app/sources/collector-worker.mjs';
import {
  continueSourceRun,
  unreportedSourceRun,
  requeueSourceRun,
} from '../app/automation/recovery.mjs';
import {siteSourceTrialReady} from '../app/sources/automation-sources.mjs';
import {SearchValueError} from '../app/site-extensions/search.mjs';
import {normalizeSourceRecipe, recipeReplay, searchLabel} from '../app/sources/recipe.mjs';
import {linkedInSignedInSearch, linkedInGeoSuggestions} from '../app/site-extensions/linkedin.mjs';
import {
  searchLearning,
  searchLearningContext,
  cardsShowLocation,
  learnedLocationApplied,
} from '../app/sources/search-learning.mjs';

// A synthetic collector source; the readers below stand in for its site.
const source = 'https://himalayas.app/';
const card = (id, location) => ({
  url: `https://himalayas.app/companies/synthetic/jobs/${id}`,
  title: `Synthetic role ${id}`,
  location,
});
const page = (value, jobs) => ({
  url: value,
  jobs,
  page: 1,
  totalPages: 1,
  nextUrl: null,
  complete: true,
});

function fixture(t, {location = 'Netherlands', readPage}) {
  const core = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(core);
  t.after(() => core.close());
  const a = db.create('job-search', {
    goal: 'backend',
    criteria: {location, preferences: 'Synthetic preferences'},
    sources: [source],
  });
  db.saveSource(a.id, source, {
    recipe: {...db.get(a.id).sourceSettings[source].recipe, terms: ['backend']},
  });
  db.review(a.id);
  const begin = (kind) => {
    const task = core.workspaces.tasks.enqueue(a.id, {
        batchId: 'synthetic-batch',
        sourceUrl: source,
        operation: kind === 'trial' ? 'trial' : 'scan',
        sources: [source],
        lockKey: 'source:' + source,
      }),
      run = db.begin(a.id, {kind, taskId: task.id});
    if (kind === 'run') prepareCollection(db, run, db.get(a.id));
    const flow = automationWorkflow({
      db,
      run: db.run(run.id),
      signal: new AbortController().signal,
      collectorReadPage: readPage,
      collectorReadDetail: async () => {
        throw Error('No synthetic detail');
      },
      browser: {
        hasPage: () => false,
        call: () => {
          throw Error('No browser read');
        },
      },
      report: (...args) => db.finish(...args),
    });
    return {run: db.run(run.id), call: (name, args = {}) => flow.call(a.id, run.id, name, args)};
  };
  return {core, db, id: a.id, begin};
}

test('the LinkedIn extension reports a location it cannot write as a search value', () => {
  const error = (() => {
    try {
      linkedInSignedInSearch('https://www.linkedin.com/jobs/search/?keywords=Go&location=Atlantis');
    } catch (thrown) {
      return thrown;
    }
  })();
  assert.ok(error instanceof SearchValueError);
  assert.equal(error.code, 'SEARCH_VALUE');
  assert.deepEqual([error.field, error.value], ['location', 'Atlantis']);
});

test('the LinkedIn extension suggests geoIds from the site lookup, and nothing for other fields or failures', async () => {
  const asked = [];
  const fetch = async (url) => {
    asked.push(new URL(url).searchParams.get('query'));
    assert.match(
      new URL(url).searchParams.get('geoTypes'),
      /\bADMIN_DIVISION_1\b/,
      'a state or constituent country (England) is offered itself',
    );
    return {
      ok: true,
      json: async () => [{id: '111'}, {id: 'x'}, {id: '222'}, {id: '333'}, {id: '444'}],
    };
  };
  assert.deepEqual(await linkedInGeoSuggestions('location', 'Atlantis, Oceania', {fetch}), [
    {param: 'geoId', value: '111'},
    {param: 'geoId', value: '222'},
    {param: 'geoId', value: '333'},
  ]);
  assert.deepEqual(asked, ['Atlantis, Oceania']);
  assert.deepEqual(await linkedInGeoSuggestions('query', 'Go', {fetch}), []);
  assert.deepEqual(await linkedInGeoSuggestions('location', ' ', {fetch}), []);
  assert.deepEqual(asked.length, 1, 'only a location is looked up');
  const refused = async () => ({ok: false, json: async () => null});
  assert.deepEqual(await linkedInGeoSuggestions('location', 'Atlantis', {fetch: refused}), []);
});

test('learning guidance lists the suggested address values before the search field', () => {
  const context = searchLearningContext({
    field: 'location',
    value: 'Atlantis',
    suggestions: [
      {param: 'geoId', value: '111'},
      {param: 'geoId', value: '222'},
    ],
  });
  assert.deepEqual(context.suggestions.length, 2);
  assert.match(context.guidance, /best match first: geoId=111, geoId=222\. Try the first one/);
  assert.match(context.guidance, /enter "Atlantis" in the site's own location field/);
  assert.doesNotMatch(
    searchLearningContext({field: 'location', value: 'Atlantis'}).guidance,
    /lookup suggests/,
  );
});

test('a search value the collector cannot write ends the scan without a technical retry and plans a trial', async (t) => {
  const f = fixture(t, {
    readPage: async () => {
      throw new SearchValueError('location', 'Netherlands', 'Synthetic: no ID for Netherlands.');
    },
  });
  const scan = f.begin('run');
  const reply = await scan.call('collect_source_page');
  assert.equal(reply.status, 'search_learning');
  assert.match(reply.next, /End the turn now without calling any tool/);
  assert.equal(f.db.run(scan.run.id).collectorError, null, 'no collector error is left to retry');
  assert.deepEqual((({field, value}) => ({field, value}))(searchLearning(f.db.get(f.id), source)), {
    field: 'location',
    value: 'Netherlands',
  });
  assert.equal(siteSourceTrialReady(f.db.get(f.id), source), false);

  const finished = await scan.call('finish_automation_run', {
    status: 'blocked',
    summary: 'The location could not be written.',
  });
  assert.equal(finished.status, 'interrupted');
  assert.match(finished.summary, /next round learns how the site writes it/);
  const task = f.core.workspaces.tasks.get(f.id, scan.run.taskId);
  assert.equal(task.technicalRecovery, undefined, 'no technical retry was counted');

  // The app puts the interrupted scan back in the queue, as after any interrupted run.
  requeueSourceRun(f.db, f.db.run(scan.run.id));
  const runtime = new WebTasks(f.db, {browserReady: () => false, launch: async () => ({})});
  t.after(() => runtime.close());
  const planned = runtime.plan(
    f.id,
    'synthetic-batch',
    f.db.sources(f.id).find((s) => s.url === source),
  );
  assert.deepEqual(
    planned.map((p) => p.operation),
    ['trial'],
    'the collector source goes to a trial first',
  );
  assert.equal(
    f.core.workspaces.tasks.get(f.id, scan.run.taskId).state,
    'cancelled',
    'the trial replaced the scan',
  );

  // The trial learned the value: the same round scans with the learned recipe.
  f.core.workspaces.tasks.finish(f.id, planned[0].id, 'completed', 'Learned');
  const learned = f.db.get(f.id);
  f.db.put({
    ...learned,
    sourceState: {
      ...learned.sourceState,
      [source]: {
        ...learned.sourceState[source],
        searchLearning: undefined,
        trial: {status: 'passed'},
      },
    },
  });
  const next = runtime.plan(
    f.id,
    'synthetic-batch',
    f.db.sources(f.id).find((s) => s.url === source),
  );
  assert.deepEqual(
    next.map((p) => [p.operation, p.state]),
    [['scan', 'pending']],
    'a new scan starts in the same round instead of waiting for the interval',
  );
});

test('a scan agent that ends its turn for the learning is neither nudged nor retried', async (t) => {
  const f = fixture(t, {
    readPage: async () => {
      throw new SearchValueError('location', 'Netherlands', 'Synthetic: no ID for Netherlands.');
    },
  });
  f.db.enable(f.id);
  const scan = f.begin('run');
  await scan.call('collect_source_page');
  assert.equal(continueSourceRun(f.db, f.id, scan.run.id), null, 'the idle agent is not nudged');
  const ended = unreportedSourceRun(f.db, f.id, scan.run.id, 'idle', Date.now());
  assert.equal(ended.status, 'interrupted');
  assert.equal(f.db.run(scan.run.id).recovery, undefined, 'no automatic resume is scheduled');
});

test('a learning trial saves the recipe for the value, and a changed value is learned again', async (t) => {
  const reads = [];
  const f = fixture(t, {
    readPage: async (value) => {
      reads.push(value);
      return new URL(value).searchParams.get('country') === 'NL'
        ? page(value, [
            card(1, 'Amsterdam, North Holland, Netherlands'),
            card(2, 'Utrecht, Netherlands'),
          ])
        : page(value, [card(3, 'Berlin, Germany')]);
    },
  });
  const a = f.db.get(f.id);
  f.db.put({
    ...a,
    sourceState: {
      ...a.sourceState,
      [source]: {
        ...a.sourceState?.[source],
        searchLearning: {field: 'location', value: 'Netherlands', message: 'Synthetic', at: 1},
      },
    },
  });
  const trial = f.begin('trial');
  const context = automationTaskContext(f.db, f.id, f.db.run(trial.run.id), {});
  assert.match(
    context.assignedSource.searchLearning.guidance,
    /enter "Netherlands" in the site's own location field/,
  );
  await assert.rejects(
    trial.call('finish_automation_run', {status: 'completed', summary: 'Done'}),
    /Save the recipe with save_source_recipe first/,
  );
  const saved = await trial.call('save_source_recipe', {
    entry: {
      kind: 'url_template',
      template: 'https://himalayas.app/jobs/api/search?q={query}&country=NL',
    },
    terms: ['backend'],
    pagination: 'url_param',
    learnedFor: {location: 'Atlantis'},
  });
  assert.equal(saved.status, 'verified');
  const recipe = f.db.get(f.id).sourceSettings[source].recipe;
  assert.deepEqual(
    recipe.learnedFor,
    {location: 'Netherlands'},
    'the app, not the agent, records the value',
  );
  assert.equal(f.db.get(f.id).sourceState[source].searchLearning, undefined);
  assert.equal(searchLearning(f.db.get(f.id), source), null);
  assert.equal(reads.length, 1, 'cards naming the value need no comparison read');

  const changed = f.db.get(f.id);
  f.db.put({...changed, criteria: {...changed.criteria, location: 'Germany'}});
  assert.deepEqual(searchLearning(f.db.get(f.id), source), {
    field: 'location',
    value: 'Germany',
    learnedValue: 'Netherlands',
  });
  assert.equal(siteSourceTrialReady(f.db.get(f.id), source), false);
});

test('a learned address whose results ignore the location is refused', async (t) => {
  const f = fixture(t, {
    readPage: async (value) =>
      page(value, [card(1, 'Berlin, Germany'), card(2, 'Munich, Germany')]),
  });
  const a = f.db.get(f.id);
  f.db.put({
    ...a,
    sourceState: {
      ...a.sourceState,
      [source]: {
        searchLearning: {field: 'location', value: 'Netherlands', message: 'Synthetic', at: 1},
      },
    },
  });
  const trial = f.begin('trial');
  await assert.rejects(
    trial.call('save_source_recipe', {
      entry: {
        kind: 'url_template',
        template: 'https://himalayas.app/jobs/api/search?q={query}&country=XX',
      },
      terms: ['backend'],
      pagination: 'url_param',
    }),
    /do not follow the location "Netherlands".*Berlin, Germany/,
  );
  assert.ok(searchLearning(f.db.get(f.id), source), 'the value still needs learning');
});

test('card locations decide first; otherwise the results must differ from the search without the value', async () => {
  assert.equal(cardsShowLocation('Netherlands', [{location: 'Amsterdam, Netherlands'}]), true);
  assert.equal(cardsShowLocation('Berlin, Germany', [{location: 'Berlin'}]), true);
  assert.equal(cardsShowLocation('São Paulo', [{location: 'Sao Paulo, Brazil'}]), true);
  assert.equal(cardsShowLocation('Netherlands', [{location: 'Berlin, Germany'}]), false);
  assert.equal(cardsShowLocation('Netherlands', [{}]), null, 'no card locations to compare');
  const localized = [
    {url: 'a', location: 'Amsterdam, Niederlande'},
    {url: 'b', location: 'Utrecht, Niederlande'},
  ];
  assert.deepEqual(
    await learnedLocationApplied('Netherlands', localized, async () => [{url: 'c'}, {url: 'd'}]),
    {ok: true},
    'other results than the search without the value pass in another language',
  );
  const ignored = await learnedLocationApplied('Netherlands', localized, async () => [
    {url: 'a'},
    {url: 'b'},
  ]);
  assert.equal(ignored.ok, false);
});

test('a trial of a search without terms ends only with the terms chosen', async (t) => {
  const f = fixture(t, {
    location: '',
    readPage: async (value) => page(value, [card(1, 'Remote')]),
  });
  const a = f.db.get(f.id),
    {terms, ...recipe} = a.sourceSettings[source].recipe;
  f.db.put({
    ...a,
    sourceSettings: {...a.sourceSettings, [source]: {...a.sourceSettings[source], recipe}},
  });
  assert.equal(siteSourceTrialReady(f.db.get(f.id), source), false, 'the round is a trial');
  const trial = f.begin('trial');
  await assert.rejects(
    trial.call('finish_automation_run', {status: 'completed', summary: 'Done'}),
    /no search terms yet/,
  );
  const saved = await trial.call('save_source_recipe', {
    entry: {kind: 'url_template', template: recipe.entry.template},
    terms: ['backend'],
    pagination: 'url_param',
  });
  assert.equal(saved.status, 'verified');
  assert.deepEqual(f.db.get(f.id).sourceSettings[source].recipe.terms, ['backend']);
});

test('a recipe with further search setups checks the first search of each and scans every term in every setup', async (t) => {
  const reads = [];
  const f = fixture(t, {
    location: '',
    readPage: async (value) => {
      reads.push(new URL(value).searchParams.get('country'));
      return page(value, [card(reads.length, 'Remote')]);
    },
  });
  const trial = f.begin('trial');
  const entry = {
    kind: 'url_template',
    template: 'https://himalayas.app/jobs/api/search?q={query}&country=DE',
    variants: [
      {
        label: 'Netherlands',
        template: 'https://himalayas.app/jobs/api/search?q={query}&country=NL',
      },
    ],
  };
  const saved = await trial.call('save_source_recipe', {
    entry,
    terms: ['backend', 'platform'],
    pagination: 'url_param',
  });
  assert.equal(saved.status, 'verified');
  assert.deepEqual(reads, ['DE', 'NL'], 'one check read per setup');
  const recipe = f.db.get(f.id).sourceSettings[source].recipe;
  assert.deepEqual(
    recipe.entry.variants,
    [
      {
        label: 'Netherlands',
        template: 'https://himalayas.app/jobs/api/search?q={query}&country=NL&sort=recent',
      },
    ],
    'the site extension keeps its sort in every setup',
  );
  assert.deepEqual(
    recipeReplay(recipe, {query: 'x'}).searches.map((s) => searchLabel(s)),
    ['backend', 'platform', 'backend · Netherlands', 'platform · Netherlands'],
  );

  const failing = fixture(t, {
    location: '',
    readPage: async (value) =>
      page(value, new URL(value).searchParams.get('country') === 'NL' ? [] : [card(1, 'Remote')]),
  }).begin('trial');
  await assert.rejects(
    failing.call('save_source_recipe', {entry, terms: ['backend'], pagination: 'url_param'}),
    /search setup "Netherlands": the first page has no listings/,
  );
});

test('search setups take {query} like the main address and stay within the search limit', () => {
  const template = 'https://example.test/jobs?q={query}&where=a';
  const variant = (label, address = 'https://example.test/jobs?q={query}&where=b') => ({
    label,
    template: address,
  });
  assert.throws(
    () =>
      normalizeSourceRecipe({
        entry: {
          kind: 'url_template',
          template,
          variants: [variant('b', 'https://example.test/jobs?where=b')],
        },
      }),
    /exactly when the main address does/,
  );
  assert.throws(
    () =>
      normalizeSourceRecipe({
        entry: {
          kind: 'url_template',
          template,
          variants: [variant('b'), variant('c'), variant('d')],
        },
      }),
    /at most 2/,
  );
  assert.throws(
    () =>
      normalizeSourceRecipe({
        entry: {kind: 'url_template', template, variants: [variant('b'), variant('c')]},
        terms: ['a', 'b', 'c', 'd'],
      }),
    /more than 10 searches/,
  );
  assert.equal(
    normalizeSourceRecipe({entry: {kind: 'url_template', template, variants: []}}).entry.variants,
    undefined,
  );
});
