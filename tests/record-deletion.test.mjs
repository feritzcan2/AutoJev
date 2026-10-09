import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {deleteRecords} from '../app/records/deletion.mjs';

function fixture(t, template = 'job-search') {
  const store = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(store),
    a = db.create(template),
    other = db.create(template);
  t.after(() => store.close());
  const add = (name, owner = a.id) =>
    db.putResult({
      id: name,
      automationId: owner,
      key: 'https://example.test/' + name,
      url: 'https://example.test/' + name,
      title: name,
      summary: 'Synthetic record',
      status: 'found',
      trial: false,
      updatedAt: Date.now(),
    });
  const first = add('first'),
    second = add('second'),
    third = add('third'),
    foreign = add('foreign', other.id);
  return {
    store,
    db,
    id: a.id,
    other: other.id,
    first,
    second,
    third,
    foreign,
    queue: store.workspaces.tasks,
  };
}

for (const template of ['job-search', 'housing', 'appointment', 'custom'])
  test(`${template}: deletes only selected records and their questions`, (t) => {
    const {store, db, id, other, queue} = fixture(t, template);
    db.putResult({...db.result(id, 'second'), status: 'completed'});
    db.askQuestion(id, {text: 'Selected record question', recordId: 'first'});
    const keep = db.askQuestion(id, {text: 'Other record question', recordId: 'third'});
    const working = queue.enqueue(id, {
      recordId: 'third',
      recordOperation: 'score',
      lockKey: 'record:third',
    });
    queue.claim(id, working.id);
    assert.deepEqual(deleteRecords(db, id, ['first', 'second', 'first']), {deleted: 2});
    assert.deepEqual(
      db.results(id).map((item) => item.id),
      ['third'],
    );
    assert.deepEqual(
      db.get(id).questions.map((q) => q.id),
      [keep.id],
    );
    assert.equal(db.result(other, 'foreign').id, 'foreign');
    assert.equal(queue.get(id, working.id).state, 'running');
    assert.equal(store.workspaces.records.identities.find(id, 'https://example.test/first'), null);
    assert.doesNotThrow(() => db.snapshot(id));
  });

test('invalid or foreign selections fail atomically', (t) => {
  const {db, id} = fixture(t);
  for (const ids of [[], null, ['first', 3], ['first', 'missing'], ['first', 'foreign']])
    assert.throws(() => deleteRecords(db, id, ids));
  assert.equal(db.results(id).length, 3);
});

for (const state of ['pending', 'running', 'reported', 'paused'])
  test(`rejects ${state} tasks anywhere in a selected batch`, (t) => {
    const {db, id, queue} = fixture(t),
      task = queue.enqueue(id, {
        recordId: 'third',
        recordIds: ['third', 'second'],
        recordOperation: 'score',
      });
    queue.put({...task, state});
    assert.throws(() => deleteRecords(db, id, ['first', 'second']), /işlemlerini durdur/);
    assert.equal(db.results(id).length, 3);
    assert.equal(queue.get(id, task.id).state, state);
  });

test('rejects a live run even without a queue task and preserves uncertain execution', (t) => {
  const {db, id} = fixture(t);
  db.putRun({
    id: 'live',
    automationId: id,
    status: 'running',
    kind: 'run',
    recordIds: ['first', 'second'],
  });
  assert.throws(() => deleteRecords(db, id, ['second']), /işlemlerini durdur/);
  db.putRun({...db.run('live'), status: 'completed'});
  db.putResult({...db.result(id, 'first'), status: 'executing'});
  assert.throws(() => deleteRecords(db, id, ['first']), /işlemlerini durdur/);
});

test('merged aliases disappear together without orphaning old record keys', (t) => {
  const {store, db, id} = fixture(t),
    records = store.workspaces.records;
  const survivor = records.identities.merge(id, ['first', 'second']);
  assert.deepEqual(deleteRecords(db, id, ['second', survivor.id]), {deleted: 1});
  for (const itemId of ['first', 'second']) {
    assert.equal(records.identities.raw(id, itemId), null);
    assert.equal(records.find(id, 'https://example.test/' + itemId), null);
  }
  assert.equal(db.results(id).length, 1);
  assert.equal(store.db.prepare('PRAGMA foreign_key_check').get(), undefined);
});

test('stopped batches can still resume remaining records and removed records cannot resume', (t) => {
  const {db, id, queue} = fixture(t),
    batch = queue.enqueue(id, {
      recordId: 'first',
      recordIds: ['first', 'second'],
      recordOperation: 'score',
      subject: 'first',
    }),
    single = queue.enqueue(id, {
      recordId: 'first',
      recordOperation: 'verify',
      lockKey: 'record:first',
    });
  queue.put({...batch, state: 'blocked', resumeRecordAfterAnswer: true});
  queue.put({...single, state: 'completed', resumeRecordAfterVerification: true});
  deleteRecords(db, id, ['first']);
  const remaining = queue.get(id, batch.id),
    removed = queue.get(id, single.id);
  assert.deepEqual(remaining.recordIds, ['second']);
  assert.equal(remaining.recordId, 'second');
  assert.equal(remaining.subject, 'second');
  assert.equal(remaining.resumeRecordAfterAnswer, true);
  assert.equal(removed.recordId, 'first');
  assert.equal(removed.stopRequested, true);
  assert.equal(removed.resumeRecordAfterVerification, false);
  assert.equal(removed.resumeSourceAfterAnswer, false);
  assert.deepEqual(
    queue.resumptions(id).map((task) => task.id),
    [batch.id],
  );
  assert.doesNotThrow(() => db.snapshot(id));
});

test('a storage failure rolls the entire deletion back', (t) => {
  const {store, db, id} = fixture(t);
  store.db.exec(
    "CREATE TRIGGER prevent_test_delete BEFORE DELETE ON workspace_records WHEN OLD.id='second' BEGIN SELECT RAISE(ABORT,'Synthetic failure'); END",
  );
  db.askQuestion(id, {text: 'Keep on failure', recordId: 'first'});
  assert.throws(() => deleteRecords(db, id, ['first', 'second']), /Synthetic failure/);
  assert.equal(db.results(id).length, 3);
  assert.equal(db.get(id).questions.length, 1);
});
