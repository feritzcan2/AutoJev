import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {recordUrlKey} from '../app/records/identity.mjs';
import {listingIdentity} from '../app/records/job-urls.mjs';
import {assessmentEvidence} from '../app/records/evidence.mjs';
import {recordOperationError} from '../app/records/operations.mjs';

const source = 'https://board.test/search',
  base = 'https://board.test/item/123';
function fixture(t) {
  const core = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(core);
  t.after(() => core.close());
  const a = db.create('housing', {
    goal: 'Homes',
    criteria: {location: 'Berlin', budget: '2000', requirements: '2 rooms'},
    sources: [source],
  });
  db.review(a.id);
  const task = core.workspaces.tasks.enqueue(a.id, {
    operation: 'scan',
    capability: 'browser.observe',
    sourceUrl: source,
    sources: [source],
    lockKey: 'source:' + source,
  });
  const run = db.begin(a.id, {kind: 'run', taskId: task.id});
  return {
    core,
    db,
    id: a.id,
    run,
    save: (url, extra = {}) =>
      db.record(a.id, run.id, {
        url,
        title: 'Home',
        summary: 'Observed detail',
        assessment: {score: 70},
        ...extra,
      }),
  };
}
function legacy(f, id, url, extra = {}) {
  const record = {
    id,
    automationId: f.id,
    key: url,
    url,
    title: 'Home',
    summary: 'Saved detail',
    status: 'found',
    createdAt: 1,
    trial: false,
    ...extra,
  };
  f.core.db
    .prepare('INSERT INTO workspace_records(id,workspace_id,record_key,data) VALUES(?,?,?,?)')
    .run(id, f.id, url, JSON.stringify(record));
  return record;
}

for (const urls of [
  [base, base + '/?utm_source=mail&trk=one'],
  [base + '/?utm_source=mail&trk=one', base],
  [base + '?item=3&utm_campaign=a', base + '?utm_campaign=b&item=3'],
])
  test('save and known lookups are symmetric: ' + urls[0], (t) => {
    const f = fixture(t),
      first = f.save(urls[0]),
      second = f.save(urls[1]);
    assert.equal(second.id, first.id);
    assert.equal(second.url, urls[0]);
    assert.equal(f.db.results(f.id).length, 1);
    assert.deepEqual(f.db.knownListingUrls(f.id, f.run.id, urls), urls);
    assert.ok(f.db.knownResults(f.id, f.run.id, urls).every((r) => r.id === first.id));
  });

test('query identifiers, unknown extra parameters, different hosts and SPA routes stay distinct', (t) => {
  const f = fixture(t),
    urls = [
      base,
      base + '?id=1',
      base + '?id=2',
      base + '?id=1&variant=blue',
      base + '#/a',
      base + '#/b',
      'https://other.test/item/123',
      base + '/apply',
    ];
  assert.equal(new Set(urls.map((url) => f.save(url).id)).size, urls.length);
  assert.notEqual(listingIdentity(base + '?id=1').key, listingIdentity(base + '?id=2').key);
  assert.notEqual(listingIdentity(base + '#/a').key, listingIdentity(base + '#/b').key);
  f.db.observe(f.id, f.run.id, base + '?id=1', 'First listing');
  assert.equal(assessmentEvidence(f.db, f.id, f.db.run(f.run.id), base + '?id=2'), null);
  assert.equal(recordUrlKey('javascript:alert(1)'), null);
});

test('observed canonical links join different URL shapes but not another task or incomplete pages', (t) => {
  const f = fixture(t),
    first = f.save(base),
    pretty = 'https://regional.test/homes/bright-flat';
  f.db.browserEvidence.rememberIdentity(f.run, {
    url: pretty,
    canonicalUrl: base,
    readiness: {loading: true},
  });
  assert.deepEqual(f.db.browserEvidence.aliases(f.run, pretty), []);
  f.db.browserEvidence.rememberIdentity(
    {...f.run, id: 'other-run', taskId: 'other-task'},
    {url: pretty, canonicalUrl: base, readiness: {loading: false}},
  );
  assert.deepEqual(f.db.browserEvidence.aliases(f.run, pretty), []);
  f.db.browserEvidence.rememberIdentity(f.run, {
    url: pretty,
    canonicalUrl: base,
    readiness: {loading: false},
  });
  assert.equal(f.save(pretty).id, first.id);
  assert.equal(f.core.workspaces.records.find(f.id, pretty).id, first.id);
});

test('verified duplicate rows retain receipts and documents, resolve old IDs and cannot be submitted again', (t) => {
  const f = fixture(t),
    a = f.save(base),
    receipt = {url: base + '/receipt', text: 'Message sent'};
  const b = legacy(f, 'old-completed', base + '/?utm_source=old', {
    status: 'completed',
    evidence: receipt,
    documents: [{path: 'letter.pdf'}],
    cells: {score: 70},
  });
  f.db.put({
    ...f.db.get(f.id),
    questions: [
      {id: 'question', recordId: a.id, text: 'Clarify the original record', answer: null},
    ],
  });
  const task = f.core.workspaces.tasks.enqueue(f.id, {
    recordId: a.id,
    lockKey: 'record:' + a.id,
    recordOperation: 'execute',
  });
  f.core.workspaces.records.identities.rebuild(f.id);
  const merged = f.db.result(f.id, a.id);
  assert.equal(merged.id, b.id);
  assert.equal(merged.status, 'completed');
  assert.deepEqual(merged.evidence, receipt);
  assert.deepEqual(merged.documents, b.documents);
  assert.equal(f.db.results(f.id, {all: true}).length, 1);
  assert.equal(f.db.resultCounts(f.id).resultCount, 1);
  assert.equal(f.core.workspaces.records.count(f.id), 1);
  assert.equal(f.core.workspaces.records.search(f.id, {query: 'Home'}).total, 1);
  assert.equal(
    recordOperationError(f.db.get(f.id), merged, 'execute', {manual: true, direct: true}),
    'Bu kayıt yeniden gönderilemez',
  );
  assert.equal(
    f.core.workspaces.tasks.put(f.core.workspaces.tasks.get(f.id, task.id)).recordId,
    b.id,
  );
  assert.equal(f.db.get(f.id).questions[0].recordId, b.id);
  assert.equal(f.db.get(f.id).questions[0].originalRecordId, a.id);
  assert.throws(() => f.db.putResult({...a, status: 'found'}), /birleştirildi/);
  const archived = JSON.parse(
    f.core.db.prepare('SELECT data FROM workspace_records WHERE id=?').get(a.id).data,
  );
  assert.equal(archived.mergedInto, b.id);
  assert.equal(archived.summary, a.summary);
  const before = JSON.stringify(f.db.results(f.id));
  f.core.workspaces.records.identities.rebuild(f.id);
  assert.equal(JSON.stringify(f.db.results(f.id)), before);
  assert.equal(f.core.db.prepare('PRAGMA foreign_key_check').get(), undefined);
});

test('migration honors established legacy relationships and isolates workspaces', (t) => {
  const f = fixture(t),
    a = legacy(f, 'old-a', base),
    b = legacy(f, 'old-b', 'https://employer.test/vacancy/uuid', {status: 'completed'});
  f.core.db.exec('CREATE TABLE job_members(candidate_id TEXT,job_id TEXT,canonical_id TEXT)');
  const insert = f.core.db.prepare('INSERT INTO job_members VALUES(?,?,?)');
  insert.run(f.id, a.id, b.id);
  insert.run(f.id, b.id, b.id);
  f.core.workspaces.records.identities.rebuild(f.id);
  assert.equal(f.db.result(f.id, a.id).id, b.id);
  const other = f.db.create('housing'),
    foreign = f.core.workspaces.records.put(other.id, base, {
      id: 'foreign',
      url: base,
      status: 'found',
    });
  assert.equal(f.core.workspaces.records.find(other.id, base).id, foreign.id);
  assert.throws(
    () => f.core.workspaces.records.identities.merge(f.id, [b.id, foreign.id]),
    /çalışma alanına/,
  );
  assert.equal(f.core.workspaces.records.get(other.id, foreign.id).status, 'found');
});

test('uncertain attempts are retained and merging cannot steal an active worker', (t) => {
  const f = fixture(t),
    a = f.save(base),
    b = f.save(base + '/other'),
    queue = f.core.workspaces.tasks;
  const task = queue.enqueue(f.id, {recordId: a.id, lockKey: 'record:' + a.id});
  queue.claim(f.id, task.id, 'record-worker');
  assert.throws(
    () => f.core.workspaces.records.identities.merge(f.id, [a.id, b.id]),
    /çalışan görevlerini/,
  );
  queue.finish(f.id, task.id);
  f.db.putResult({...a, status: 'uncertain', attemptRunId: 'uncertain-attempt'});
  f.db.putResult({...b, status: 'completed', evidence: 'Other receipt'});
  const merged = f.core.workspaces.records.identities.merge(f.id, [a.id, b.id]);
  assert.equal(merged.status, 'uncertain');
  assert.equal(merged.attemptRunId, 'uncertain-attempt');
  const one = queue.enqueue(f.id, {recordId: a.id, lockKey: 'record:' + a.id}),
    two = queue.enqueue(f.id, {recordId: b.id, lockKey: 'record:' + b.id});
  queue.claim(f.id, one.id, 'one');
  assert.throws(() => queue.claim(f.id, two.id, 'two'), /başka bir worker/);
  assert.throws(() => f.db.assertRecordIdle(f.id, b.id), /sırada veya çalışıyor/);
  const batch = queue.enqueue(f.id, {recordIds: [a.id, b.id]});
  assert.deepEqual(batch.recordIds, [merged.id]);
});

test('a key-based automation can intentionally store different records sharing a URL', (t) => {
  const f = fixture(t),
    a = f.db.create('custom');
  const one = f.core.workspaces.records.put(a.id, 'a', {url: base, title: 'A'}),
    two = f.core.workspaces.records.put(a.id, 'b', {url: base, title: 'B'});
  assert.notEqual(one.id, two.id);
});

test('a migrated trial sample cannot displace a live record', (t) => {
  const f = fixture(t),
    live = f.save(base),
    sample = legacy(f, 'trial-sample', base + '?utm_source=trial', {
      trial: true,
      status: 'prepared',
      proposal: 'Sample only',
    });
  f.core.workspaces.records.identities.rebuild(f.id);
  assert.equal(f.db.result(f.id, sample.id).id, live.id);
  assert.equal(f.db.result(f.id, live.id).trial, false);
  assert.equal(f.db.resultCounts(f.id).resultCount, 1);
});
