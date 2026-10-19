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
const relative = 'documents/cover-letters/Cover-Letter-Example.pdf',
  workspace = workspaceDirectory(data, core.workspaces.get(a.id));
await mkdir(path.join(workspace, 'documents', 'cover-letters'), {recursive: true});
await writeFile(path.join(workspace, relative), '%PDF-placeholder');
const question = db.askQuestion(a.id, {
  recordId: item.id,
  text: 'Senior Software Engineer: the application needs a cover letter.',
  coverLetter: {state: 'review', path: relative, text, writtenAt: 1},
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
  await page.locator('[data-view=answers]').click();
  const answer = page.locator(`.answer-card[data-question-id="${question.id}"]`);
  await answer.waitFor({state: 'visible'});
  assert.equal(await answer.locator('.candidate-question-form').count(), 0);
  await page.screenshot({path: path.join(data, 'answers.png')});
  await answer.getByRole('button', {name: 'Review on the Files page'}).click();
  const card = page.locator('.cover-letter-card');
  await card.waitFor({state: 'visible'});
  const letter = card.getByRole('textbox', {name: 'Cover letter text'});
  assert.equal(await letter.inputValue(), text);
  await page.screenshot({path: path.join(data, 'files.png')});
  const edited = text.replace('Kind regards', 'Best regards');
  await letter.fill(edited);
  await card.getByRole('button', {name: 'Approve and continue'}).click();
  await card.waitFor({state: 'detached'});
  const pdf = await readFile(path.join(workspace, relative));
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 1000, 'Chromium rendered the edited letter');
  assert.deepEqual(errors, []);
  console.log('Cover letter review smoke passed:', data);
} finally {
  await app.close();
}
