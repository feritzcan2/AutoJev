import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {jobSearchSources} from '../app/templates/job-search/sources.mjs';

function store(t) {
  const core = new WorkspaceDatabase(':memory:');
  t.after(() => core.close());
  return new AutomationStore(core);
}

test('the catalog lists each ready board once, with its countries as choices', (t) => {
  const db = store(t);
  const a = db.create('job-search', {
    goal: 'backend',
    criteria: {country: 'de'},
    sources: ['https://www.linkedin.com/jobs/search?keywords=x', 'https://fr.indeed.com/'],
  });
  const catalog = db.sourceCatalog(a.id);
  const names = catalog.map((g) => g.name);
  assert.equal(names.includes('LinkedIn'), false, 'another address on an added site counts');
  assert.equal(new Set(names).size, names.length, 'one entry per board');
  assert.equal(
    catalog.flatMap((g) => g.choices).length,
    jobSearchSources.length - 2,
    'every other starting source stays reachable',
  );
  const indeed = catalog.find((g) => g.name === 'Indeed');
  assert.deepEqual(indeed.choices[0], {
    url: 'https://de.indeed.com/',
    name: 'Indeed (Germany)',
    countries: ['DE'],
    label: 'Germany',
  });
  assert.equal(
    indeed.choices.some((c) => c.url === 'https://fr.indeed.com/'),
    false,
    'an added country leaves the choices',
  );
  const arbeitnow = catalog.find((g) => g.name === 'Arbeitnow');
  assert.equal(arbeitnow.extension, 'api');
  assert.equal(arbeitnow.choices[0].countries[0], 'DE');
  assert.deepEqual(catalog.find((g) => g.name === 'Xing').choices, [
    {
      url: 'https://www.xing.com/jobs/',
      name: 'Xing',
      countries: ['DE', 'AT', 'CH'],
      label: 'DE, AT, CH',
    },
  ]);
  assert.equal(catalog.find((g) => g.name === 'We Work Remotely').extension, 'browser');
  assert.equal(catalog.find((g) => g.name === 'Company career pages').extension, null);
  const firstGlobal = catalog.findIndex((g) => !g.choices[0].countries.length);
  assert.ok(firstGlobal > 0);
  assert.ok(catalog.slice(0, firstGlobal).every((g) => g.choices[0].countries.includes('DE')));
  assert.deepEqual(db.snapshot(a.id).sourceCatalog, catalog);
});

test('a catalog choice added by its address alone gets the template settings and leaves the list', (t) => {
  const db = store(t);
  const a = db.create('job-search', {goal: 'backend', sources: []});
  const [choice] = db.sourceCatalog(a.id).find((g) => g.name === 'Berlin Startup Jobs').choices;
  db.addSource(a.id, {url: choice.url});
  const source = db.sources(a.id).find((s) => s.url === choice.url);
  assert.equal(source.name, 'Berlin Startup Jobs');
  assert.equal(source.recipe.entry.template, 'https://berlinstartupjobs.com/{query}/');
  assert.match(source.instructions, /category/);
  assert.equal(source.extension.kind, 'http');
  assert.equal(
    db.sourceCatalog(a.id).some((g) => g.name === 'Berlin Startup Jobs'),
    false,
  );
});
