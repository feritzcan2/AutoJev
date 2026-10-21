import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {
  InstructionLog,
  fileInstructionParts,
  contextInstructionParts,
  instructionPart,
} from '../app/system/instruction-log.mjs';
import {agentProfileId} from '../app/agents/profiles.mjs';
import {AUTOMATION_INSTRUCTIONS} from '../app/agents/automation-profiles.mjs';
const require = createRequire(import.meta.url),
  {_electron: electron} = createRequire(require.resolve('@playwright/mcp/package.json'))(
    'playwright',
  );
const data = await mkdtemp(path.join(tmpdir(), 'loop-instructions-ui-'));
const core = new WorkspaceDatabase(path.join(data, 'jobloop.sqlite')),
  db = new AutomationStore(core),
  a = db.create('housing', {
    title: 'Amsterdam ev araması',
    goal: 'Uygun evleri bul',
    criteria: {location: 'Amsterdam', budget: '1500 €', requirements: 'En az 2 oda'},
  }),
  b = db.create('custom', {title: 'Boş geçmiş'}),
  log = new InstructionLog(core.workspaces);
const record = (parts, extra = {}) =>
  log.record({
    workspaceId: a.id,
    agentProfileId: agentProfileId('web-interview'),
    sessionId: 'session-first',
    workerId: 'main',
    kind: 'context',
    title: 'Görev bağlamı okundu',
    status: 'returned',
    parts,
    ...extra,
  });
record(fileInstructionParts('AGENTS.md', AUTOMATION_INSTRUCTIONS), {
  kind: 'files',
  title: 'Oturum talimat dosyaları',
  status: 'available',
});
record(
  contextInstructionParts('get_automation_context', {
    automation: {...a, criteria: {...a.criteria, budget: '1200 €'}},
    template: db.template(a.templateId),
  }),
);
record(
  [
    instructionPart(
      'launch-prompt',
      'Başlangıç mesajı',
      'system',
      'İlan kartlarını önce listeden incele. Detay gerekiyorsa tek sekmeyi kullan.',
    ),
  ],
  {kind: 'launch', title: 'Oturum başlangıç mesajı', status: 'requested'},
);
record(
  [
    instructionPart(
      'response:browser_read',
      'browser_read',
      'tool',
      'Görünen kart: Merkez · 1.400 € · 2 oda',
    ),
  ],
  {sessionId: 'session-second', workerId: 'second', kind: 'tool_result', title: 'browser_read'},
);
core.close();
const app = await electron.launch({
  executablePath: process.env.JOBLOOP_ELECTRON_BINARY || require('electron'),
  args: [process.cwd()],
  env: {
    ...process.env,
    JOBLOOP_DATA_DIR: data,
    JOBLOOP_DIAGNOSTICS: 'off',
    LOOP_EXTENSIONS: process.env.LOOP_EXTENSIONS ?? '',
  },
});
try {
  const page = await app.firstWindow(),
    errors = [];
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => Boolean(window.jobloop));
  await page.waitForFunction(
    (id) => [...document.querySelector('#candidates').options].some((o) => o.value === id),
    a.id,
  );
  await page.locator('#candidates').selectOption(a.id);
  await page.locator('[data-view=agent]').click();
  await page.getByRole('tab', {name: 'Instructions', exact: true}).click();
  await page.waitForFunction(() => document.querySelectorAll('.instruction-card').length > 10);
  assert.equal(await page.getByRole('tab', {name: 'Setup', exact: true}).count(), 1);
  await page.getByRole('tab', {name: 'Run', exact: true}).click();
  await page.waitForFunction(
    () => document.querySelector('.instruction-agent-summary h3')?.textContent === 'Run agent',
  );
  assert.ok(
    (await page.locator('.instruction-agent-summary').textContent()).includes(
      'kurulum sohbetini almaz',
    ),
  );
  await page.locator('.instruction-profile-editor>summary').click();
  await page
    .getByLabel('Agent instruction', {exact: true})
    .fill('Only the assigned work. Save observed results.');
  await page.getByRole('button', {name: 'Save instruction', exact: true}).click();
  await page.waitForFunction(() =>
    document.querySelector('.instruction-agent-summary small')?.textContent.startsWith('Version 2'),
  );
  await page.getByRole('tab', {name: 'Setup', exact: true}).click();
  await page.waitForFunction(
    () => document.querySelector('.instruction-agent-summary h3')?.textContent === 'Setup agent',
  );
  assert.ok(
    (await page.getByText('Current version differs from the recorded one', {exact: true}).count()) >
      0,
  );
  assert.equal(await page.locator('#agent-settings').isVisible(), false);
  await page.getByLabel('Search instructions', {exact: true}).fill('1500');
  assert.equal(await page.locator('.instruction-card').count(), 1);
  await page.locator('.instruction-card summary').click();
  assert.ok((await page.locator('.instruction-card pre').textContent()).includes('1500'));
  await page.getByLabel('Search instructions', {exact: true}).fill('');
  await page.screenshot({path: '/tmp/loop-instructions-parts.png', fullPage: false});
  await page.getByRole('tab', {name: 'Delivery history', exact: true}).click();
  await page.getByLabel('Instruction worker filter').selectOption('second');
  await page.waitForFunction(() => document.querySelectorAll('.instruction-event').length === 1);
  await page.locator('.instruction-event>summary').click();
  await page.locator('.instruction-part>summary').click();
  assert.ok((await page.locator('.instruction-event pre').textContent()).includes('1.400 €'));
  await page.screenshot({path: '/tmp/loop-instructions-history.png', fullPage: false});
  await page.getByLabel('Instruction worker filter').selectOption('');
  await page.getByLabel('Instruction session filter').selectOption('session-first');
  await page.waitForFunction(() => document.querySelectorAll('.instruction-event').length === 3);
  await page.locator('#candidates').selectOption(b.id);
  await page.locator('[data-view=agent]').click();
  await page.waitForFunction(() =>
    document.querySelector('.instruction-empty')?.textContent.includes('No records yet'),
  );
  await page.getByRole('tab', {name: 'Workspace', exact: true}).click();
  assert.equal(await page.locator('.workspace-conversation').isVisible(), true);
  if (process.env.LOOP_EXTENSIONS === 'job-search') {
    const job = await page.evaluate(() =>
      window.jobloop.workspaceCreate('job-search', {
        name: 'Talimat testi',
        preferences: 'Remote engineering',
      }),
    );
    await page.waitForFunction(
      (id) => [...document.querySelector('#candidates').options].some((o) => o.value === id),
      job.id,
    );
    await page.locator('#candidates').selectOption(job.id);
    await page.locator('[data-view=agent]').click();
    await page.getByRole('tab', {name: 'Instructions', exact: true}).click();
    await page.getByRole('tab', {name: 'Instruction parts', exact: true}).click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.instruction-card')].some((c) =>
        c.textContent.includes('Görev yönlendirme'),
      ),
    );
    const catalog = await page.evaluate((id) => window.jobloop.instructionSnapshot(id), job.id);
    assert.ok(catalog.parts.some((p) => p.source === 'skill'));
    assert.ok(catalog.parts.some((p) => p.key === 'startup-routing'));
  }
  assert.deepEqual(errors, []);
  console.log(
    'INSTRUCTIONS_UI_PASS: current/history separation, search, worker/session filters, empty workspace, terminal view; /tmp/loop-instructions-{parts,history}.png',
  );
} catch (error) {
  for (const page of app.windows()) {
    await page.screenshot({path: '/tmp/loop-instructions-error.png'});
    console.error(
      await page.locator('#agent').evaluate((n) => ({
        hidden: n.hidden,
        panel: n.dataset.panel,
        tabs: [...n.querySelectorAll('[role=tab]')].map((t) => ({
          text: t.textContent,
          hidden: t.hidden,
          rect: t.getBoundingClientRect().toJSON(),
        })),
      })),
    );
  }
  throw error;
} finally {
  await app.close();
  await rm(data, {recursive: true, force: true});
}
