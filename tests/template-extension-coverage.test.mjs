import test from 'node:test';
import assert from 'node:assert/strict';
import {jobSearchSources} from '../app/templates/job-search/sources.mjs';
import {siteExtensionFor} from '../app/site-extensions/index.mjs';

// Every starting source of the job-search template is read by its own site
// extension; none is left to a plain recipe and the generic reader alone.
test('every job-search starting source has a site extension', () => {
  const missing = jobSearchSources.filter((s) => !siteExtensionFor(s.url)).map((s) => s.name);
  assert.deepEqual(missing, []);
  for (const source of jobSearchSources.filter((s) => s.recipe?.entry.kind === 'url_template'))
    assert.ok(
      siteExtensionFor(source.recipe.entry.template.replace(/\{[a-z_]+\}/g, 'x')),
      `${source.name}: its recipe address is read by an extension`,
    );
});
