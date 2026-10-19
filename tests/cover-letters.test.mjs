import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {WebTasks} from '../app/automation/web-template.mjs';
import {automationWorkflow} from '../app/automation/worker.mjs';
import {automationPrompt} from '../app/automation/prompts.mjs';
import {approveCoverLetter, reviseCoverLetter} from '../app/automation/cover-letters.mjs';
import {coverLetterHtml} from '../app/automation/cover-letter-pdf.mjs';
import {automationAttention} from '../app/automation/attention.mjs';

const source = 'https://example.test/list',
  settle = () => new Promise((r) => setImmediate(r)),
  letter = (name = 'Example GmbH') =>
    `Dear ${name} team,\n\n` +
    'I am applying for the Senior Software Engineer role. '.repeat(6) +
    '\n\nAt my current employer I built event-driven services on AWS. '.repeat(4) +
    '\n\nKind regards,\nAda Lovelace';

async function fixture(t) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'cover-letter-'));
  const store = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(store),
    definition = db.template('job-search');
  const a = db.create('job-search', {
    goal: 'Find a suitable result',
    criteria: Object.fromEntries(
      definition.fields.filter((f) => f.required).map((f) => [f.id, 'Known criteria']),
    ),
    sources: [source],
  });
  db.review(a.id);
  const trial = db.begin(a.id, 'trial');
  for (const url of a.sources) db.observe(a.id, trial.id, url, 'Observed source');
  db.finish(a.id, trial.id, 'completed', 'Source checked');
  const seed = db.begin(a.id, 'run'),
    item = db.record(a.id, seed.id, {
      key: source + '/1',
      url: source + '/1',
      title: 'Senior Software Engineer',
      summary: 'Observed facts',
    });
  db.finish(a.id, seed.id, 'completed', 'Saved');
  const launches = [],
    rendered = [];
  const runtime = new WebTasks(db, {
    launch: async (run) => {
      launches.push(run);
      return {close: async () => {}};
    },
  });
  t.after(async () => {
    await runtime.close();
    store.close();
    await rm(workspace, {recursive: true, force: true});
  });
  const renderPdf = async (text) => {
    rendered.push(text);
    return Buffer.from('%PDF-fixture\n' + text);
  };
  const flow = (run) =>
    automationWorkflow({
      workspace,
      db,
      run,
      signal: {aborted: false},
      browser: {},
      renderPdf,
      report: (...args) => runtime.report(...args),
    });
  const finish = async (run, status, args = {}) => {
    await flow(run).call(a.id, run.id, 'finish_automation_run', {
      status,
      summary: 'Done',
      ...args,
    });
    await runtime.finish(a.id, status, 'Done', run.workerId);
    // The app's scheduler ticks on its own; tests tick by hand.
    await runtime.tick();
    await settle();
  };
  // An application that meets a required cover letter asks for one and stops.
  const requestLetter = async () => {
    await runtime.runRecord(a.id, item.id, 'execute', {direct: true});
    await settle();
    const execute = launches.at(-1);
    db.browserEvidence.save(execute, {
      id: 'snapshot-1',
      url: item.url,
      text: 'Example GmbH is hiring a Senior Software Engineer. Requirements: AWS, event-driven systems.',
    });
    const requested = await flow(execute).call(a.id, execute.id, 'request_cover_letter', {
      notes: 'The form asks for an English letter.',
    });
    await finish(execute, 'blocked', {
      blocker: {
        category: 'needs_answer',
        reason: 'The form requires a cover letter.',
        userAction: 'Review the cover letter on the Files page',
      },
    });
    return {execute, questionId: requested.questionId};
  };
  return {
    workspace,
    db,
    id: a.id,
    item,
    runtime,
    launches,
    rendered,
    renderPdf,
    flow,
    finish,
    requestLetter,
  };
}

test('a required cover letter blocks the application and starts a separate writer task', async (t) => {
  const f = await fixture(t);
  const {execute, questionId} = await f.requestLetter();
  const question = f.db.get(f.id).questions.find((q) => q.id === questionId);
  assert.equal(question.recordId, f.item.id);
  assert.equal(question.coverLetter.state, 'writing');
  // The writer runs while the record's cover letter question is open.
  const writer = f.launches.at(-1);
  assert.notEqual(writer.id, execute.id);
  assert.equal(writer.recordOperation, 'cover_letter');
  assert.equal(writer.recordId, f.item.id);
  assert.equal(writer.request.questionId, questionId);
  // A second request while the letter is open reuses it.
  assert.equal(f.db.get(f.id).questions.filter((q) => q.coverLetter).length, 1);
  // The Answers page points to the Files page instead of a form.
  const issue = automationAttention(f.db.snapshot(f.id)).find((i) => i.id === questionId);
  assert.equal(issue.coverLetter.state, 'writing');
});

test('only an application task can ask for a cover letter and only the writer can save one', async (t) => {
  const f = await fixture(t);
  const {questionId} = await f.requestLetter();
  const writer = f.launches.at(-1),
    tools = f.flow(writer).tools.map((tool) => tool.name);
  assert.ok(tools.includes('save_cover_letter'));
  assert.ok(tools.includes('read_cover_letter_brief'));
  assert.ok(!tools.includes('browser_interact'));
  assert.ok(!tools.includes('browser_upload_document'));
  assert.ok(!tools.includes('request_cover_letter'));
  await assert.rejects(
    f.flow(writer).call(f.id, writer.id, 'request_cover_letter', {}),
    /record application task/,
  );
  // The writer's prompt is its own short task, without the application steps.
  assert.match(automationPrompt(writer), /read_cover_letter_brief/);
  assert.doesNotMatch(automationPrompt(writer), /reserve_automation_action/);
  const brief = await f.flow(writer).call(f.id, writer.id, 'read_cover_letter_brief', {});
  assert.match(brief.listing.text, /event-driven systems/);
  assert.equal(brief.applicationNotes, 'The form asks for an English letter.');
  assert.equal(
    f.db.get(f.id).questions.find((q) => q.id === questionId).coverLetter.taskId,
    writer.taskId,
  );
});

test('the writer saves a PDF for review and cannot finish without it', async (t) => {
  const f = await fixture(t);
  const {questionId} = await f.requestLetter();
  const writer = f.launches.at(-1),
    flow = f.flow(writer);
  await assert.rejects(
    flow.call(f.id, writer.id, 'finish_automation_run', {status: 'completed', summary: 'Done'}),
    /save_cover_letter/,
  );
  await assert.rejects(
    flow.call(f.id, writer.id, 'save_cover_letter', {text: 'Too short.'}),
    /too short/,
  );
  await assert.rejects(
    flow.call(f.id, writer.id, 'save_cover_letter', {text: letter('[Company]')}),
    /placeholder \[Company\]/,
  );
  const saved = await flow.call(f.id, writer.id, 'save_cover_letter', {text: letter()});
  assert.match(saved.path, /^documents\/cover-letters\/Cover-Letter-Senior-Software-Engineer-/);
  assert.match(await readFile(path.join(f.workspace, saved.path), 'utf8'), /^%PDF-fixture/);
  await f.finish(writer, 'completed');
  const question = f.db.get(f.id).questions.find((q) => q.id === questionId);
  assert.equal(question.coverLetter.state, 'review');
  assert.equal(question.coverLetter.text, letter());
  assert.equal(question.answer, null);
  // The application stays blocked until the user approves.
  assert.equal(f.launches.at(-1).id, writer.id);
});

test('approving the letter answers the question and resumes the same application', async (t) => {
  const f = await fixture(t);
  const {execute, questionId} = await f.requestLetter();
  const writer = f.launches.at(-1);
  const saved = await f.flow(writer).call(f.id, writer.id, 'save_cover_letter', {text: letter()});
  await f.finish(writer, 'completed');
  const edited = letter('Example GmbH hiring');
  await approveCoverLetter(f.runtime, f.id, questionId, {
    text: edited,
    workspace: f.workspace,
    renderPdf: f.renderPdf,
  });
  await settle();
  // The edited text replaced the saved PDF before the application resumed.
  assert.equal(f.rendered.at(-1), edited);
  assert.match(await readFile(path.join(f.workspace, saved.path), 'utf8'), /hiring team/);
  const question = f.db.get(f.id).questions.find((q) => q.id === questionId);
  assert.equal(question.coverLetter.state, 'approved');
  assert.match(question.answer, new RegExp(saved.path.replace(/[.]/g, '\\.')));
  const resumed = f.launches.at(-1);
  assert.equal(resumed.recordOperation, 'execute');
  assert.equal(resumed.continuation.runId, execute.id);
  assert.deepEqual(resumed.continuation.questionIds, [questionId]);
  await assert.rejects(
    approveCoverLetter(f.runtime, f.id, questionId, {
      workspace: f.workspace,
      renderPdf: f.renderPdf,
    }),
    /already approved/,
  );
});

test('a rewrite sends the user notes and the earlier letter to a new writer task', async (t) => {
  const f = await fixture(t);
  const {questionId} = await f.requestLetter();
  const writer = f.launches.at(-1);
  await f.flow(writer).call(f.id, writer.id, 'save_cover_letter', {text: letter()});
  await assert.rejects(
    reviseCoverLetter(f.runtime, f.id, questionId, 'Shorter.'),
    /still being written/,
  );
  await f.finish(writer, 'completed');
  await assert.rejects(reviseCoverLetter(f.runtime, f.id, questionId, '  '), /what should change/);
  await reviseCoverLetter(f.runtime, f.id, questionId, 'Mention Kubernetes.');
  await settle();
  const rewrite = f.launches.at(-1);
  assert.notEqual(rewrite.id, writer.id);
  assert.equal(rewrite.recordOperation, 'cover_letter');
  const brief = await f.flow(rewrite).call(f.id, rewrite.id, 'read_cover_letter_brief', {});
  assert.equal(brief.userFeedback, 'Mention Kubernetes.');
  assert.equal(brief.previousLetter, letter());
  // The rewrite keeps the same file.
  const saved = await f
    .flow(rewrite)
    .call(f.id, rewrite.id, 'save_cover_letter', {text: letter('Example')});
  assert.equal(
    saved.path,
    f.db.get(f.id).questions.find((q) => q.id === questionId).coverLetter.path,
  );
});

test('a writer that stops without a letter can be retried', async (t) => {
  const f = await fixture(t);
  const {questionId} = await f.requestLetter();
  const writer = f.launches.at(-1);
  await f.finish(writer, 'blocked', {
    blocker: {
      category: 'technical',
      reason: 'The CV could not be read.',
      userAction: 'Add a readable CV',
    },
  });
  const question = f.db.get(f.id).questions.find((q) => q.id === questionId);
  assert.equal(question.coverLetter.state, 'failed');
  assert.equal(question.answer, null);
  await reviseCoverLetter(f.runtime, f.id, questionId, '');
  await settle();
  assert.equal(f.launches.at(-1).recordOperation, 'cover_letter');
  assert.notEqual(f.launches.at(-1).id, writer.id);
});

test('the PDF page escapes the letter text and keeps its paragraphs', () => {
  const html = coverLetterHtml('Dear <team>,\n\nLine one\nline two');
  assert.match(html, /<p>Dear &lt;team&gt;,<\/p><p>Line one<br>line two<\/p>/);
});
