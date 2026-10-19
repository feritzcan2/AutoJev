import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {WebTasks} from '../app/automation/web-template.mjs';
import {automationWorkflow} from '../app/automation/worker.mjs';
import {automationTaskContext} from '../app/automation/task-context.mjs';
import {readRecordListings} from '../app/records/listing-reader.mjs';
import {SITE_EXTENSIONS} from '../app/site-extensions/index.mjs';
import {listingPage} from '../app/site-extensions/listing.mjs';

const settle = () => new Promise((resolve) => setImmediate(resolve));
const host = (name) => (value) => {
  try {
    return new URL(value).hostname === name;
  } catch {
    return false;
  }
};
const apiUrl = (n) => `https://api.reader.test/jobs/${n}`,
  httpUrl = (n) => `https://http.reader.test/job/${n}`,
  plainUrl = 'https://plain.reader.test/job/1';
// Synthetic site extensions on reserved .test hosts.
const reads = [];
const collector = {
  id: 'reader-api',
  matches: host('api.reader.test'),
  collector: {
    templateId: 'job-search',
    searchUrl: (url) => url,
    acceptsQuery: () => false,
    readPage: async () => ({jobs: []}),
    readDetail: async (url, {signal}) => {
      reads.push(['api', url, signal instanceof AbortSignal]);
      if (url.endsWith('/9')) throw Error('API HTTP 503');
      return {url, title: 'Backend Engineer', company: 'Acme', description: 'Build Go services.'};
    },
    detail: (job) =>
      listingPage({
        browser: 'Reader API',
        url: job.url,
        title: job.title,
        description: job.description,
        fields: {company: job.company},
      }),
  },
};
const reader = {
  id: 'reader-http',
  matches: host('http.reader.test'),
  http: {
    handles: () => true,
    read: async (url, options) => {
      reads.push(['http', url, Boolean(options.siteAccess)]);
      return listingPage({url, title: 'Data Engineer', description: 'Own the pipelines.'});
    },
  },
};

function fixture(t, urls) {
  SITE_EXTENSIONS.unshift(collector, reader);
  t.after(() => {
    for (const extension of [collector, reader])
      SITE_EXTENSIONS.splice(SITE_EXTENSIONS.indexOf(extension), 1);
  });
  reads.length = 0;
  const core = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(core);
  const a = db.create('job-search', {
    goal: 'Find backend jobs',
    criteria: {preferences: 'Remote Go'},
    sources: ['https://api.reader.test/jobs'],
  });
  db.review(a.id);
  const seed = db.begin(a.id, 'run'),
    items = urls.map((url, i) =>
      db.record(a.id, seed.id, {url, title: 'Role ' + i, summary: 'Saved listing'}),
    );
  db.finish(a.id, seed.id, 'completed', 'Saved');
  const launches = [],
    runtime = new WebTasks(db, {
      launch: async (run) => {
        launches.push(run);
        return {close: async () => {}};
      },
    });
  t.after(async () => {
    await runtime.close();
    core.close();
  });
  const call = (run, name, args) =>
    automationWorkflow({
      db,
      run,
      signal: new AbortController().signal,
      browser: {},
      report: () => {},
    }).call(a.id, run.id, name, args);
  return {db, id: a.id, items, runtime, launches, call};
}
const value = (result) => (result?.content ? JSON.parse(result.content[0].text) : result);

test('a collector record is scored from the collector’s listing text, not the site', async (t) => {
  const f = fixture(t, [apiUrl(1)]);
  await f.runtime.runRecord(f.id, f.items[0].id, 'score');
  await settle();
  const run = f.launches.at(-1),
    outcome = await readRecordListings(f.db, run, {signal: new AbortController().signal});
  assert.deepEqual(reads, [['api', apiUrl(1), true]]);
  assert.equal(outcome.read[0].extension, 'reader-api');
  const context = automationTaskContext(f.db, f.id, f.db.run(run.id));
  assert.equal(context.savedListing.readBy, 'reader-api site extension (API collector)');
  assert.match(context.savedListing.instructions, /do not open the listing page in the browser/);
  // The agent reads the reader's clean text by its snapshot.
  const part = await f.call(f.db.run(run.id), 'browser_read_part', {
    snapshotId: context.savedListing.snapshotId,
  });
  assert.match(JSON.stringify(part), /Build Go services/);
  assert.match(JSON.stringify(part), /company: Acme/);
  // The saved score cites the reader's text as its evidence.
  await f.call(f.db.run(run.id), 'record_automation_score', {score: 80, summary: 'Go matches.'});
  const saved = f.db.result(f.id, f.items[0].id).assessment;
  assert.equal(saved.score, 80);
  assert.equal(saved.evidenceUrl, apiUrl(1));
});

test('an HTTP reader serves its records through the shared site access rules', async (t) => {
  const f = fixture(t, [httpUrl(1)]);
  await f.runtime.runRecord(f.id, f.items[0].id, 'score');
  await settle();
  const run = f.launches.at(-1);
  await readRecordListings(f.db, run, {});
  assert.deepEqual(reads, [['http', httpUrl(1), true]]);
  assert.equal(
    automationTaskContext(f.db, f.id, f.db.run(run.id)).savedListing.readBy,
    'reader-http site extension (HTTP reader)',
  );
});

test('a batch marks each read listing and reports the reads that failed', async (t) => {
  const f = fixture(t, [apiUrl(1), apiUrl(9), plainUrl]);
  await f.runtime.runRecords(
    f.id,
    f.items.map((item) => item.id),
  );
  await settle();
  const run = f.launches.at(-1),
    outcome = await readRecordListings(f.db, run, {});
  assert.equal(outcome.read.length, 1);
  assert.deepEqual(
    outcome.failed.map((x) => [x.url, x.extension, x.error]),
    [[apiUrl(9), 'reader-api', 'API HTTP 503']],
  );
  const context = automationTaskContext(f.db, f.id, f.db.run(run.id)),
    byUrl = Object.fromEntries(context.assignedRecords.map((r) => [r.url, r]));
  assert.equal(byUrl[apiUrl(1)].savedListing.readBy, 'reader-api site extension (API collector)');
  // A failed read and a site without a reader go to the browser as before.
  assert.equal(byUrl[apiUrl(9)].savedListing, undefined);
  assert.equal(byUrl[plainUrl].savedListing, undefined);
  assert.match(context.savedListings.instructions, /do not open the listing page/);
  assert.deepEqual(
    context.listingReadIssues.listings.map((x) => x.url),
    [apiUrl(9)],
  );
});

test('records without a site reader, and other templates, keep the browser read', async (t) => {
  const f = fixture(t, [plainUrl]);
  await f.runtime.runRecord(f.id, f.items[0].id, 'score');
  await settle();
  const run = f.launches.at(-1);
  assert.equal(await readRecordListings(f.db, run, {}), null);
  assert.deepEqual(reads, []);
  assert.equal(automationTaskContext(f.db, f.id, f.db.run(run.id)).savedListing, undefined);
  // Only score tasks read ahead.
  assert.equal(await readRecordListings(f.db, {...run, recordOperation: 'prepare'}, {}), null);
});
