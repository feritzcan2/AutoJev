import assert from 'node:assert/strict';
import test from 'node:test';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {englishTable} from '../app/workspaces/english-table.mjs';

test('legacy Turkish table labels become English and other labels stay', () => {
  const table = {
    title: 'Başvuru akışı',
    columns: [
      {key: 'title', label: 'Pozisyon', type: 'text'},
      {key: 'score', label: 'Uygunluk puanı', type: 'number'},
      {key: 'deadline', label: 'Son başvuru', type: 'date'},
      {key: 'focus', label: 'AI odağı', type: 'text'},
      {key: 'custom', label: 'My own label', type: 'text'},
    ],
  };
  assert.deepEqual(englishTable(table), {
    title: 'Applications',
    columns: [
      {key: 'title', label: 'Position', type: 'text'},
      {key: 'score', label: 'Fit score', type: 'number'},
      {key: 'deadline', label: 'Deadline', type: 'date'},
      {key: 'focus', label: 'AI focus', type: 'text'},
      {key: 'custom', label: 'My own label', type: 'text'},
    ],
  });
  assert.equal(englishTable({title: 'Applications', columns: []}), null);
});

test('opening the store renames legacy labels of saved workspaces', () => {
  const store = new WorkspaceDatabase(':memory:');
  try {
    store.db.prepare('INSERT INTO workspaces VALUES(?,?,?)').run(
      'w1',
      'job-search',
      JSON.stringify({
        id: 'w1',
        templateId: 'job-search',
        table: {title: 'Başvuru akışı', columns: [{key: 'title', label: 'Pozisyon', type: 'text'}]},
      }),
    );
    const reopened = new store.workspaces.constructor(store.db, {
      registry: store.workspaces.registry,
    });
    assert.deepEqual(reopened.table('w1'), {
      title: 'Applications',
      columns: [{key: 'title', label: 'Position', type: 'text'}],
    });
  } finally {
    store.close();
  }
});
