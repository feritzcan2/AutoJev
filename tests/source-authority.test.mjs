import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceMode} from '../app/sources/automation-sources.mjs';
import {recordSource} from '../app/records/operations.mjs';

test('unknown source URLs never inherit automatic workspace authority', () => {
  for (const source of [
    'https://example.test/jobs/',
    'https://example.test/?query=engineer',
    'https://other.test/catalog?type=home',
  ]) {
    const a = {mode: 'auto', sources: [source]};
    for (const url of [
      source.replace(/\/$/, ''),
      source + '/',
      source + '#old',
      'https://removed.test/list',
    ])
      assert.equal(sourceMode(a, url), url === source ? 'auto' : 'observe');
  }
});
test('known sources follow the profile permission; a saved source mode is ignored', () => {
  const source = 'https://example.test/jobs';
  for (const workspace of ['observe', 'prepare', 'auto'])
    for (const mode of ['observe', 'prepare', 'auto']) {
      const a = {mode: workspace, sources: [source], sourceSettings: {[source]: {mode}}};
      assert.equal(sourceMode(a, source), workspace);
      a.sourceSettings[source].enabled = false;
      assert.equal(sourceMode(a, source), 'observe');
    }
});
test('records without source provenance do not select an arbitrary same-origin source', () => {
  const a = {
    mode: 'auto',
    sources: ['https://example.test/read', 'https://example.test/act'],
    sourceSettings: {
      'https://example.test/read': {mode: 'observe'},
      'https://example.test/act': {mode: 'auto'},
    },
  };
  const item = {url: 'https://example.test/details/123'};
  assert.equal(recordSource(a, item), null);
  assert.equal(recordSource(a, {...item, sourceUrl: a.sources[1]}), a.sources[1]);
  assert.equal(recordSource({...a, sources: [a.sources[0]]}, item), a.sources[0]);
});
