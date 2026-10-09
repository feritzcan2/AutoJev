import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {reusableTemplate} from '../app/templates/catalog.mjs';
import {
  prepareDataUpgrade,
  inspectBackup,
  stageRestore,
  applyPendingRestore,
} from '../app/system/data-management.mjs';
import {DATA_SCHEMA_VERSION} from '../app/system/data-management-schema.mjs';
import {seedLegacyDatabase} from './helpers/legacy-database.mjs';

test('legacy mail metadata remains portable in saved templates', (t) => {
  const core = new WorkspaceDatabase(':memory:');
  t.after(() => core.close());
  const db = new AutomationStore(core);
  const mail = {
      instructions: 'Track appointment replies only.',
      outcomes: [{id: 'rescheduled', label: 'Tarih değişti'}],
    },
    definition = {...db.template('appointment'), mail};
  const exported = reusableTemplate(definition);
  assert.deepEqual(exported.mail, mail);
  const template = db.saveTemplate(exported);
  assert.deepEqual(db.template(template.id).mail, mail);
  for (const outcomes of [
    [null],
    [{id: 'ignored', label: 'Ignore'}],
    [{id: 'constructor', label: 'Bad'}],
    [
      {id: 'x', label: 'X'},
      {id: 'x', label: 'Duplicate'},
    ],
  ])
    assert.throws(
      () => reusableTemplate({...definition, mail: {...mail, outcomes}}),
      /posta sonucu/,
    );
});
