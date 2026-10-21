import test from 'node:test';
import assert from 'node:assert/strict';
import {apiCollector, sourceCollector} from '../app/sources/collectors.mjs';

const workspace = {templateId: 'job-search'};

test('a collector that reads in the browser needs Chrome; an API collector does not', () => {
  for (const url of [
    'https://www.linkedin.com/jobs/search/?keywords=x',
    'https://de.indeed.com/jobs?q=x',
  ]) {
    assert.ok(sourceCollector(workspace, url), url);
    assert.equal(apiCollector(workspace, url), false, url);
  }
  assert.equal(apiCollector(workspace, 'https://www.arbeitnow.com/'), true);
  assert.equal(apiCollector(workspace, 'https://example.com/jobs'), false, 'no collector');
  assert.equal(
    apiCollector({templateId: 'other'}, 'https://www.arbeitnow.com/'),
    false,
    'collectors serve the job-search template only',
  );
});
