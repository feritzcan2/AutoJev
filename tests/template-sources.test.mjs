import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {automationTemplate, reusableTemplate} from '../app/templates/catalog.mjs';
import {recipeReplay, recipeValues, sourceRecipeOf} from '../app/sources/recipe.mjs';
import {adoptSearchTerms} from '../app/sources/automation-sources.mjs';
import {automationTaskContext} from '../app/automation/task-context.mjs';
function fixture(t) {
  const core = new WorkspaceDatabase(':memory:');
  t.after(() => core.close());
  return new AutomationStore(core);
}
test('job template creates its worldwide sources; country sources wait for setup', (t) => {
  const db = fixture(t),
    a = db.create('job-search'),
    sources = db.sources(a.id),
    template = db.template('job-search');
  const global = template.defaultSources.filter((s) => !s.countries && !s.remote);
  assert.deepEqual(
    sources.map((s) => s.url),
    global.map((s) => s.url),
  );
  assert.ok(sources.every((s) => s.enabled));
  const linked = sources.find((s) => s.name === 'LinkedIn');
  assert.equal(linked.intervalMinutes, 18 * 60);
  assert.equal(linked.integrationId, undefined);
  assert.equal(linked.searchMethod, undefined);
  assert.ok(sources.some((s) => s.name === 'FreeHire'));
  assert.ok(
    !sources.some((s) => s.name === 'Jobindex'),
    'a Danish board does not join a workspace searching elsewhere',
  );
  assert.equal(a.sourceSettings[linked.url].countries, undefined);
  for (const name of ['Himalayas', 'We Work Remotely', 'Hacker News: Who is hiring?'])
    assert.ok(!sources.some((s) => s.name === name), `${name} serves remote work; setup adds it`);
  assert.ok(
    template.defaultSources
      .filter((s) => s.countries)
      .every((s) => s.countries.every((c) => /^[A-Z]{2}$/.test(c))),
  );
  assert.equal(a.status, 'draft');
  assert.equal(a.mode, 'observe');
  assert.equal(a.nextRunAt, null);
});
test('a country source added in setup keeps its template recipe and instructions', (t) => {
  const db = fixture(t),
    a = db.create('job-search'),
    jobindex = db.template('job-search').defaultSources.find((s) => s.name === 'Jobindex');
  db.saveSources(a.id, [...a.sources, jobindex.url, 'https://own.test/jobs']);
  const saved = db.get(a.id).sourceSettings;
  assert.deepEqual(saved[jobindex.url].recipe, jobindex.recipe);
  assert.equal(saved[jobindex.url].instructions, jobindex.instructions);
  assert.equal(saved[jobindex.url].name, 'Jobindex');
  assert.equal(saved[jobindex.url].countries, undefined);
  assert.equal(saved['https://own.test/jobs'], undefined, 'other addresses start without presets');
  db.saveSource(a.id, jobindex.url, {instructions: 'My own rule'});
  db.saveSources(a.id, [...db.get(a.id).sources]);
  assert.equal(
    db.get(a.id).sourceSettings[jobindex.url].instructions,
    'My own rule',
    'an existing source keeps its edits',
  );
});
test('a remote source joins when setup adds it and keeps its template settings', (t) => {
  const base = automationTemplate('custom'),
    db = fixture(t),
    a = db.create('job-search'),
    sources = db.template('job-search').defaultSources,
    himalayas = sources.find((s) => s.name === 'Himalayas'),
    hn = sources.find((s) => s.name === 'Hacker News: Who is hiring?');
  assert.equal(himalayas.remote, true);
  assert.equal(himalayas.countries, undefined);
  assert.deepEqual([hn.countries, hn.remote], [['US'], true]);
  db.saveSources(a.id, [...a.sources, himalayas.url]);
  const saved = db.get(a.id).sourceSettings[himalayas.url];
  assert.deepEqual(saved.recipe, himalayas.recipe);
  assert.equal(saved.remote, undefined);
  assert.throws(
    () =>
      reusableTemplate({
        ...base,
        defaultSources: [{url: 'https://example.test', remote: 'yes'}],
      }),
    /remote must be true or false/,
  );
  assert.equal(
    reusableTemplate({...base, defaultSources: [{url: 'https://example.test', remote: false}]})
      .defaultSources[0].remote,
    undefined,
  );
});
test('template source countries are two-letter codes', () => {
  const base = automationTemplate('custom');
  for (const countries of [['de'], ['DEU'], 'DE', [1]])
    assert.throws(
      () => reusableTemplate({...base, defaultSources: [{url: 'https://example.test', countries}]}),
      /ISO/,
    );
  assert.deepEqual(
    reusableTemplate({
      ...base,
      defaultSources: [{url: 'https://example.test', countries: ['DE', 'DE', 'AT']}],
    }).defaultSources[0].countries,
    ['DE', 'AT'],
  );
});
test('explicit sources, explicit empty sources and removed sources stay under user control', (t) => {
  const db = fixture(t),
    empty = db.create('job-search', {sources: []}),
    custom = db.create('job-search', {sources: ['https://example.test/jobs']});
  assert.deepEqual(empty.sources, []);
  assert.deepEqual(custom.sources, ['https://example.test/jobs']);
  assert.deepEqual(custom.sourceSettings, {});
  const a = db.create('job-search');
  db.save(a.id, {sources: []});
  db.save(a.id, {title: 'Edited'});
  assert.deepEqual(db.get(a.id).sources, []);
});
test('source presets work for imported templates without exporting private workspace sources', (t) => {
  const db = fixture(t),
    base = automationTemplate('housing'),
    defaults = [
      {url: 'https://homes.test/list', name: 'Homes', intervalMinutes: 75, enabled: false},
    ];
  const copy = db.saveTemplate({
    ...base,
    defaultSources: defaults,
    sources: ['https://private.test/list'],
  });
  const a = db.create(copy.id);
  assert.deepEqual(a.sources, ['https://homes.test/list']);
  assert.equal(db.sources(a.id)[0].intervalMinutes, 75);
  assert.equal(db.sources(a.id)[0].enabled, false);
  assert.equal(copy.sources, undefined);
  assert.deepEqual(reusableTemplate(copy).defaultSources, copy.defaultSources);
  assert.deepEqual(db.create('housing').sources, []);
});
test('template source presets reject unsafe addresses, duplicates and invalid intervals', () => {
  const base = automationTemplate('custom');
  for (const defaultSources of [
    [{url: 'file:///tmp/private'}],
    [{url: 'https://name:secret@example.test'}],
    [{url: 'https://example.test', intervalMinutes: 0}],
    [{url: 'https://example.test'}, {url: 'https://example.test/'}],
  ])
    assert.throws(() => reusableTemplate({...base, defaultSources}));
});
test('Indeed joins a workspace by country with one shared recipe', () => {
  const indeed = automationTemplate('job-search').defaultSources.filter((s) =>
    /^Indeed \(/.test(s.name),
  );
  assert.ok(indeed.length >= 40);
  assert.equal(new Set(indeed.map((s) => s.url)).size, indeed.length);
  assert.equal(new Set(indeed.flatMap((s) => s.countries)).size, indeed.length);
  for (const source of indeed) {
    const host = new URL(source.url).hostname;
    assert.match(host, /^[a-z]+\.indeed\.com$/);
    assert.equal(source.countries.length, 1);
    assert.equal(source.recipe.entry.template, `https://${host}/jobs?q={query}&l={location}`);
    assert.equal(source.recipe.pagination, 'url_param');
  }
  assert.ok(indeed.some((s) => s.countries[0] === 'GB'));
  assert.ok(indeed.some((s) => s.countries[0] === 'TR'));
});
test('Himalayas searches worldwide unless the workspace names a country', () => {
  const himalayas = automationTemplate('job-search').defaultSources.find(
    (s) => s.name === 'Himalayas',
  );
  assert.equal(himalayas.countries, undefined);
  const replay = (criteria) =>
    recipeReplay(himalayas.recipe, recipeValues({criteria, goal: 'backend'}, himalayas.url))
      .searches[0].url;
  assert.equal(
    replay({}),
    'https://himalayas.app/jobs/api/search?q=backend&sort=recent',
    'an empty country drops the filter',
  );
  assert.equal(
    replay({country: 'GB'}),
    'https://himalayas.app/jobs/api/search?country=GB&q=backend&sort=recent',
  );
  assert.ok(automationTemplate('job-search').fields.some((f) => f.id === 'country'));
});
test('the setup agent sees starting sources by address and country only', (t) => {
  const db = fixture(t),
    a = db.create('job-search');
  const {template} = automationTaskContext(db, a.id, {
    id: 'r1',
    kind: 'interview',
    status: 'running',
  });
  assert.ok(template.defaultSources.length > 40);
  for (const source of template.defaultSources) {
    assert.deepEqual(
      Object.keys(source).filter((k) => !['url', 'name', 'countries', 'remote'].includes(k)),
      [],
    );
  }
  assert.ok(template.guidance);
});
test('Arbeitnow joins a workspace through the feed of its own country', () => {
  const feeds = automationTemplate('job-search').defaultSources.filter((s) =>
    /^Arbeitnow \(/.test(s.name),
  );
  assert.deepEqual(
    feeds.map((s) => [new URL(s.url).hostname, s.countries]),
    [
      ['www.arbeitnow.com', ['DE']],
      ['www.arbeitnow.co.uk', ['GB']],
      ['www.arbeitnow.fr', ['FR']],
      ['www.arbeitnow.ch', ['CH']],
      ['www.arbeitnow.nl', ['NL']],
    ],
  );
  for (const feed of feeds)
    assert.equal(
      feed.recipe.entry.template,
      `https://${new URL(feed.url).hostname}/api/job-board-api`,
    );
});
test('keyword sources without their own terms search with the workspace search terms', (t) => {
  const db = fixture(t),
    a = db.create('job-search'),
    sources = db.template('job-search').defaultSources,
    url = (name) => sources.find((s) => s.name === name).url,
    scanned = (name) => db.sources(a.id).find((s) => s.url === url(name)),
    withTerms = (name, terms) =>
      db.saveSource(a.id, url(name), {
        recipe: {...db.get(a.id).sourceSettings[url(name)].recipe, terms},
      });
  withTerms('Workable', ['Staff Engineer', 'Backend Engineer']);
  withTerms('Company career pages', ['Staff Engineer jobs London']);
  db.put({
    ...db.get(a.id),
    sourceState: {
      ...db.get(a.id).sourceState,
      [url('LinkedIn')]: {recipeState: {status: 'verified', successCount: 3, failCount: 0}},
    },
  });
  db.saveSearchTerms(a.id, ['Staff Engineer', 'Backend Engineer']);
  let saved = db.get(a.id);
  assert.deepEqual(saved.searchTerms, ['Staff Engineer', 'Backend Engineer']);
  assert.equal(saved.sourceSettings[url('LinkedIn')].recipe.terms, undefined);
  assert.deepEqual(scanned('LinkedIn').recipe.terms, ['Staff Engineer', 'Backend Engineer']);
  assert.equal(scanned('LinkedIn').sharedTerms, true);
  assert.equal(
    saved.sourceState[url('LinkedIn')].recipeState.status,
    'candidate',
    'new terms are a new search the next scan verifies',
  );
  assert.equal(
    saved.sourceSettings[url('Workable')].recipe.terms,
    undefined,
    'own terms equal to the list join it',
  );
  assert.deepEqual(scanned('Company career pages').recipe.terms, ['Staff Engineer jobs London']);
  assert.equal(scanned('Company career pages').sharedTerms, false);

  db.saveSources(a.id, [...saved.sources, url('Jobindex'), url('StepStone')]);
  assert.deepEqual(scanned('Jobindex').recipe.terms, ['Staff Engineer', 'Backend Engineer']);
  assert.equal(
    scanned('StepStone').recipe.terms,
    undefined,
    '{query} in the address path is a slug: the source needs its own terms',
  );
  assert.deepEqual(
    recipeReplay(scanned('Jobindex').recipe, recipeValues(saved, url('Jobindex'))).searches.map(
      (s) => s.url,
    ),
    [
      'https://www.jobindex.dk/jobsoegning?q=Staff+Engineer',
      'https://www.jobindex.dk/jobsoegning?q=Backend+Engineer',
    ],
  );

  // Typing the workspace terms as a source's own keeps it on the list.
  withTerms('Jobindex', ['Staff Engineer', 'Backend Engineer']);
  assert.equal(db.get(a.id).sourceSettings[url('Jobindex')].recipe.terms, undefined);
  db.saveSearchTerms(a.id, []);
  assert.deepEqual(db.get(a.id).searchTerms, []);
  assert.equal(scanned('Jobindex').recipe.terms, undefined);
});

test('a workspace from before the shared terms adopts the list its keyword sources share', () => {
  const recipe = (template, terms) => ({
      recipe: {
        entry: {kind: 'url_template', template},
        pagination: 'auto',
        ...(terms ? {terms} : {}),
      },
    }),
    roles = ['Compliance Specialist', 'AI Governance'],
    a = {
      sources: ['https://a.test/', 'https://b.test/', 'https://c.test/', 'https://d.test/'],
      sourceSettings: {
        'https://a.test/': recipe('https://a.test/jobs?q={query}', roles),
        'https://b.test/': recipe('https://b.test/search?k={query}&sort=date', roles),
        'https://c.test/': recipe('https://c.test/jobs/{query}', roles),
        'https://d.test/': recipe('https://d.test/jobs?q={query}', ['compliance officer']),
      },
    };
  const adopted = adoptSearchTerms(a);
  assert.deepEqual(adopted.searchTerms, roles);
  assert.equal(adopted.sourceSettings['https://a.test/'].recipe.terms, undefined);
  assert.equal(adopted.sourceSettings['https://b.test/'].recipe.terms, undefined);
  assert.deepEqual(
    adopted.sourceSettings['https://c.test/'].recipe.terms,
    roles,
    'a path slug keeps its own terms',
  );
  assert.deepEqual(adopted.sourceSettings['https://d.test/'].recipe.terms, ['compliance officer']);
  for (const url of a.sources)
    assert.deepEqual(
      sourceRecipeOf(adopted, url).terms,
      a.sourceSettings[url].recipe.terms,
      'every source searches as before',
    );
  assert.equal(adoptSearchTerms(adopted), null, 'it runs once');

  const scattered = adoptSearchTerms({
    ...a,
    sourceSettings: {...a.sourceSettings, 'https://b.test/': recipe('https://b.test/?k={query}')},
  });
  assert.deepEqual(scattered.searchTerms, [], 'no list two sources share: nothing is adopted');
  assert.deepEqual(scattered.sourceSettings['https://a.test/'].recipe.terms, roles);
});

test('opening the store converts a workspace saved before the shared terms', (t) => {
  const core = new WorkspaceDatabase(':memory:');
  t.after(() => core.close());
  const db = new AutomationStore(core),
    a = db.create('job-search'),
    sources = db.template('job-search').defaultSources,
    url = (name) => sources.find((s) => s.name === name).url,
    roles = ['Staff Engineer', 'Backend Engineer'];
  const old = {...db.get(a.id), sourceSettings: {...db.get(a.id).sourceSettings}};
  delete old.searchTerms;
  for (const name of ['LinkedIn', 'Workable'])
    old.sourceSettings[url(name)] = {
      ...old.sourceSettings[url(name)],
      recipe: {...old.sourceSettings[url(name)].recipe, terms: roles},
    };
  db.put(old);
  const reopened = new AutomationStore(core).get(a.id);
  assert.deepEqual(reopened.searchTerms, roles);
  assert.equal(reopened.sourceSettings[url('LinkedIn')].recipe.terms, undefined);
  assert.equal(reopened.sourceSettings[url('Workable')].recipe.terms, undefined);
});
