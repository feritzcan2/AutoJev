import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {workspaceDirectory} from '../app/workspaces/paths.mjs';
const require = createRequire(import.meta.url),
  {_electron: electron} = createRequire(require.resolve('@playwright/mcp/package.json'))(
    'playwright',
  );
// A cover letter the writer saved waits on the Files page; the Answers page
// points there, and approving an edited letter renders a real PDF.
const data = await mkdtemp(path.join(os.tmpdir(), 'cover-letter-review-')),
  core = new WorkspaceDatabase(path.join(data, 'jobloop.sqlite')),
  db = new AutomationStore(core),
  a = db.create('job-search', {title: 'Cover letter review test'}),
  run = db.begin(a.id, 'interview');
db.observe(a.id, run.id, 'https://example.test/1', 'Observed listing');
const item = db.record(a.id, run.id, {
  url: 'https://example.test/1',
  title: 'Senior Software Engineer',
  summary: 'Observed',
});
db.putResult({...item, trial: false});
const text =
  'Dear Example GmbH team,\n\n' +
  'I am applying for the Senior Software Engineer role. '.repeat(9) +
  '\n\nKind regards,\nAda Lovelace';
const relative = 'generated/cover-letters/Cover-Letter-Example.pdf',
  workspace = workspaceDirectory(data, core.workspaces.get(a.id));
await mkdir(path.join(workspace, 'generated', 'cover-letters'), {recursive: true});
await writeFile(path.join(workspace, relative), '%PDF-placeholder');
await mkdir(path.join(workspace, 'documents'), {recursive: true});
await writeFile(path.join(workspace, 'documents', 'CV.pdf'), '%PDF-cv');
const question = db.askQuestion(a.id, {
  recordId: item.id,
  text: 'Senior Software Engineer: the application needs a cover letter.',
  coverLetter: {state: 'review', path: relative, text, writtenAt: 1},
});
// A second letter is still being written; its card shows the writer's progress.
db.observe(a.id, run.id, 'https://example.test/2', 'Observed listing');
const writing = db.record(a.id, run.id, {
    url: 'https://example.test/2',
    title: 'Platform Engineer',
    summary: 'Observed',
  }),
  queue = core.workspaces.tasks,
  writer = queue.enqueue(a.id, {
    recordOperation: 'cover_letter',
    operation: 'record-cover-letter',
    capability: 'browser.observe',
    recordId: writing.id,
    lockKey: 'cover-letter:' + writing.id,
  });
db.putResult({...writing, trial: false});
db.askQuestion(a.id, {
  recordId: writing.id,
  text: 'Platform Engineer: the application needs a cover letter.',
  coverLetter: {state: 'writing', taskId: writer.id},
});
db.finish(a.id, run.id, 'completed', 'Waiting');
db.put({...db.get(a.id), status: 'paused'});
core.close();
const env = {...process.env, JOBLOOP_DATA_DIR: data};
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: require('electron'),
  args: [process.cwd()],
  env,
});
try {
  const page = await app.firstWindow(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // The first start after a build loads slowly; wait for the workspace data.
  await page.locator('#question-badge', {hasText: '2'}).waitFor({timeout: 90000});
  await page.locator('[data-view=answers]').click();
  const answer = page.locator(`.answer-card[data-question-id="${question.id}"]`);
  await answer.waitFor({state: 'visible'});
  assert.equal(await answer.locator('.candidate-question-form').count(), 0);
  await page.screenshot({path: path.join(data, 'answers.png')});
  await answer.getByRole('button', {name: 'Review on the Files page'}).click();
  const progress = page.locator('.cover-letter-card .cover-letter-progress');
  await progress.waitFor({state: 'visible'});
  // The app ends tasks left running at startup, so this writer waits in the queue.
  assert.equal(await progress.textContent(), 'Queued · waits for a free agent');
  const card = page.locator('.cover-letter-card', {hasText: 'Senior Software Engineer'});
  await card.waitFor({state: 'visible'});
  const letter = card.getByRole('textbox', {name: 'Cover letter text'});
  assert.equal(await letter.inputValue(), text);
  await page.screenshot({path: path.join(data, 'files.png')});
  // The user's documents and the agents' files are listed apart.
  assert.equal(
    await page
      .locator('#automation-file-list strong')
      .allInnerTexts()
      .then((t) => t.join()),
    'CV.pdf',
  );
  assert.equal(
    await page
      .locator('#automation-generated-file-list strong')
      .allInnerTexts()
      .then((t) => t.join()),
    'Cover-Letter-Example.pdf',
  );
  // An agent generated file names the application it was written for.
  const detail = page.locator('#automation-generated-file-list small');
  assert.equal(
    await detail.innerText(),
    'Cover letter for Senior Software Engineer · example.test · waiting for your review',
  );
  // The listing the letter was written for opens from the card and the file row.
  assert.equal(await card.getByRole('button', {name: 'Open listing ↗'}).count(), 1);
  assert.equal(
    await page
      .locator('#automation-generated-file-list')
      .getByRole('button', {name: 'Open listing ↗'})
      .count(),
    1,
  );
  assert.equal(
    await page
      .locator('#automation-file-list')
      .getByRole('button', {name: 'Open listing ↗'})
      .count(),
    0,
  );
  const edited = text.replace('Kind regards', 'Best regards');
  await letter.fill(edited);
  await card.getByRole('button', {name: 'Approve and continue'}).click();
  await card.waitFor({state: 'detached'});
  await detail.filter({hasText: 'approved'}).waitFor();
  await page.screenshot({path: path.join(data, 'files-after.png')});
  const pdf = await readFile(path.join(workspace, relative));
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 1000, 'Chromium rendered the edited letter');
  // The automatic acceptance setting is saved for the workspace.
  const auto = page.getByRole('checkbox', {name: /Accept cover letters automatically/});
  assert.equal(await auto.isChecked(), false);
  await auto.check();
  await page.locator('[data-view=answers]').click();
  await page.locator('[data-view=files]').click();
  assert.equal(await auto.isChecked(), true);
  await page.screenshot({path: path.join(data, 'files-auto.png')});
  assert.deepEqual(errors, []);
  console.log('Cover letter review smoke passed:', data);
} finally {
  await app.close();
}
