import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {automationTemplate, reusableTemplate} from '../app/templates/catalog.mjs';
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
  const global = template.defaultSources.filter((s) => !s.countries);
  assert.deepEqual(
    sources.map((s) => s.url),
    global.map((s) => s.url),
  );
  assert.ok(sources.every((s) => s.enabled));
  const linked = sources.find((s) => s.name === 'LinkedIn');
  assert.equal(linked.intervalMinutes, 15);
  assert.equal(linked.integrationId, undefined);
  assert.equal(linked.searchMethod, undefined);
  assert.ok(sources.some((s) => s.name === 'FreeHire'));
  assert.ok(
    !sources.some((s) => s.name === 'Jobindex'),
    'a Danish board does not join a workspace searching elsewhere',
  );
  assert.equal(a.sourceSettings[linked.url].countries, undefined);
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
