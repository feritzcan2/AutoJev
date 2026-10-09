import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';

const require = createRequire(import.meta.url),
  {_electron: electron} = createRequire(require.resolve('@playwright/mcp/package.json'))(
    'playwright',
  );
const data = await mkdtemp(path.join(tmpdir(), 'workspace-reads-')),
  core = new WorkspaceDatabase(path.join(data, 'jobloop.sqlite')),
  db = new AutomationStore(core);
const a = db.create('custom', {
  title: 'Snapshot performance fixture',
  goal: 'Read synthetic records',
  criteria: Object.fromEntries(
    db
      .template('custom')
      .fields.filter((f) => f.required)
      .map((f) => [f.id, 'Synthetic criteria']),
  ),
  sources: ['https://board.test/search?q=one', 'https://other.test/catalog/'],
});
db.review(a.id);
const recordIds = Array.from({length: 240}, (_, n) => 'record-' + n),
  checkpoint = 'Synthetic checkpoint '.repeat(3000),
  now = Date.now();
db.putRun({
  id: 'score-run',
  automationId: a.id,
  taskId: 'score-task',
  kind: 'run',
  recordOperation: 'score',
  status: 'completed',
  startedAt: now,
  finishedAt: now,
});
core.workspaces.tasks.put({
  id: 'score-task',
  workspaceId: a.id,
  state: 'interrupted',
  recordOperation: 'score',
  recordIds,
  request: {revision: a.revision},
  createdAt: now,
  finishedAt: now,
});
for (const id of recordIds)
  db.putResult({
    id,
    automationId: a.id,
    key: id,
    url: 'https://board.test/listing/' + id,
    title: 'Synthetic ' + id,
    status: 'found',
    trial: false,
    createdAt: now,
    updatedAt: now,
    assessment: {
      runId: 'score-run',
      revision: a.revision,
      scoringVersion: 4,
      score: 75,
      scoredAt: now,
      summary: 'Synthetic assessment',
      eligibility: 'match',
    },
  });
for (let n = 0; n < 160; n++)
  core.workspaces.tasks.put({
    id: 'history-' + n,
    workspaceId: a.id,
    state: 'completed',
    operation: 'scan',
    createdAt: now,
    finishedAt: now,
    scanPlan: {checkpoint},
    continuation: {checkpoint},
  });
core.close();
const env = {...process.env, JOBLOOP_DATA_DIR: data};
delete env.ELECTRON_RUN_AS_NODE;
const application = await electron.launch({
  executablePath: require('electron'),
  args: [process.cwd()],
  env,
});
let page;
try {
  page = await application.firstWindow({timeout: 20000});
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error('UI_ERROR', error.message);
  });
  await page.waitForFunction(() => document.querySelectorAll('#candidates option').length === 2);
  await page.selectOption('#candidates', a.id);
  await page.waitForFunction(
    () => document.querySelectorAll('#automation-results [data-result-id]').length > 0,
  );
  const snapshots = await page.evaluate(async (id) => {
    const result = [];
    for (let n = 0; n < 3; n++) {
      const start = performance.now(),
        s = await window.jobloop.workspaceSnapshot(id);
      result.push({
        ms: performance.now() - start,
        records: s.results.length,
        tasks: s.tasks.length,
        scored: s.results.every((r) => r.recordAction.scoringComplete),
        checkpoint: s.tasks.some((t) => 'scanPlan' in t || 'continuation' in t),
      });
    }
    return result;
  }, a.id);
  for (const snapshot of snapshots) {
    assert.equal(snapshot.records, 240);
    assert.equal(snapshot.tasks, 100);
    assert.equal(snapshot.scored, true);
    assert.equal(snapshot.checkpoint, false);
  }
  await page.locator('[data-view=sources]').click();
  await page.locator('.source-row').first().waitFor({state: 'visible'});
  assert.equal(await page.locator('.source-row').count(), 2);
  await page.locator('[data-view=board]').click();
  await page.locator('#automation-results').waitFor({state: 'visible'});
  await page.screenshot({path: path.join(data, 'workspace-reads.png')});
  assert.deepEqual(errors, []);
  console.log('WORKSPACE_READS_PASS', JSON.stringify({data, snapshots}));
} catch (error) {
  if (page) await page.screenshot({path: path.join(data, 'failure.png')}).catch(() => {});
  console.error('SCREENSHOTS', data);
  throw error;
} finally {
  await application.close();
}
