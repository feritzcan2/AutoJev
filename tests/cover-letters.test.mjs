import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {WebTasks} from '../app/automation/web-template.mjs';
import {automationWorkflow} from '../app/automation/worker.mjs';
import {automationPrompt} from '../app/automation/prompts.mjs';
import {
  approveCoverLetter,
  reviseCoverLetter,
  setCoverLetterAutoApprove,
  waitForCoverLetter,
} from '../app/automation/cover-letters.mjs';
import {coverLetterHtml} from '../app/automation/cover-letter-pdf.mjs';
import {listDocuments, agentDocument} from '../app/automation/artifacts.mjs';
import {automationAttention} from '../app/automation/attention.mjs';
import {automationTaskContext} from '../app/automation/task-context.mjs';
import {withAgentDefaults} from '../app/agents/settings.mjs';
import {
  recordIsWorking,
  recordNeedsAnswer,
  recordOperationStatus,
} from '../src/record-operation-status.js';

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
      signal: new AbortController().signal,
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
  // The table shows the writer at work, not an answer the user owes.
  const row = f.db.snapshot(f.id).results.find((r) => r.id === f.item.id);
  assert.equal(recordOperationStatus(row).label, 'Writing cover letter');
  assert.equal(recordOperationStatus(row).tone, 'running');
  assert.equal(recordNeedsAnswer(row), false);
  assert.equal(recordIsWorking(row), true);
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
  assert.match(saved.path, /^generated\/cover-letters\/Cover-Letter-Senior-Software-Engineer-/);
  assert.match(await readFile(path.join(f.workspace, saved.path), 'utf8'), /^%PDF-fixture/);
  await f.finish(writer, 'completed');
  const question = f.db.get(f.id).questions.find((q) => q.id === questionId);
  assert.equal(question.coverLetter.state, 'review');
  assert.equal(question.coverLetter.text, letter());
  assert.equal(question.answer, null);
  // A saved letter waits for the user's review.
  const row = f.db.snapshot(f.id).results.find((r) => r.id === f.item.id);
  assert.equal(recordOperationStatus(row).label, 'Awaiting answer');
  assert.equal(recordNeedsAnswer(row), true);
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

test('an optional cover letter field blocks the submit until an approved letter fills it', async (t) => {
  const f = await fixture(t);
  await f.runtime.runRecord(f.id, f.item.id, 'execute', {direct: true});
  await settle();
  const form = (filled) => ({
    url: f.item.url,
    uploads: [{uploadId: 'cv', label: 'Resume/CV — Attach'}],
    fields: [
      {label: 'Attach', question: 'Resume/CV *', required: true, type: 'file', filled: true},
      {label: 'Attach', question: 'Cover Letter', type: 'file', filled},
    ],
    submitControls: [{label: 'Submit application'}],
  });
  const formFlow = (run, filled) =>
    automationWorkflow({
      workspace: f.workspace,
      db: f.db,
      run,
      signal: {aborted: false},
      browser: {currentUrl: async () => f.item.url, call: async () => form(filled)},
      renderPdf: f.renderPdf,
      report: (...args) => f.runtime.report(...args),
    });
  let execute = f.launches.at(-1);
  const inspected = await formFlow(execute, false).call(
    f.id,
    execute.id,
    'browser_inspect_form',
    {},
  );
  assert.match(inspected.coverLetter, /also an optional one.*request_cover_letter/);
  await assert.rejects(
    formFlow(execute, false).call(f.id, execute.id, 'reserve_automation_action', {
      itemId: f.item.id,
    }),
    /"Cover Letter".*request_cover_letter/,
  );
  const {questionId} = await formFlow(execute, false).call(
    f.id,
    execute.id,
    'request_cover_letter',
    {},
  );
  await assert.rejects(
    formFlow(execute, false).call(f.id, execute.id, 'reserve_automation_action', {
      itemId: f.item.id,
    }),
    /waiting for the user's approval/,
  );
  await f.finish(execute, 'blocked', {
    blocker: {
      category: 'needs_answer',
      reason: 'The form has a cover letter field.',
      userAction: 'Review the cover letter on the Files page',
    },
  });
  const writer = f.launches.at(-1);
  const saved = await f.flow(writer).call(f.id, writer.id, 'save_cover_letter', {text: letter()});
  await f.finish(writer, 'completed');
  await approveCoverLetter(f.runtime, f.id, questionId, {
    workspace: f.workspace,
    renderPdf: f.renderPdf,
  });
  await settle();
  execute = f.launches.at(-1);
  assert.equal(execute.recordOperation, 'execute');
  // The resumed application must fill the field with the approved file.
  await formFlow(execute, false).call(f.id, execute.id, 'browser_inspect_form', {});
  await assert.rejects(
    formFlow(execute, false).call(f.id, execute.id, 'reserve_automation_action', {
      itemId: f.item.id,
    }),
    new RegExp(saved.path.replace(/[.]/g, '\\.')),
  );
  await formFlow(execute, true).call(f.id, execute.id, 'browser_inspect_form', {});
  await formFlow(execute, true).call(f.id, execute.id, 'reserve_automation_action', {
    itemId: f.item.id,
  });
});

test('a form without a cover letter field submits as before', async (t) => {
  const f = await fixture(t);
  await f.runtime.runRecord(f.id, f.item.id, 'execute', {direct: true});
  await settle();
  const execute = f.launches.at(-1),
    flow = automationWorkflow({
      workspace: f.workspace,
      db: f.db,
      run: execute,
      signal: {aborted: false},
      browser: {
        currentUrl: async () => f.item.url,
        call: async () => ({
          url: f.item.url,
          uploads: [{uploadId: 'cv', label: 'Resume/CV — Attach'}],
          fields: [{label: 'Attach', question: 'Resume/CV *', type: 'file', filled: true}],
        }),
      },
    });
  const inspected = await flow.call(f.id, execute.id, 'browser_inspect_form', {});
  assert.equal(inspected.coverLetter, undefined);
  await flow.call(f.id, execute.id, 'reserve_automation_action', {itemId: f.item.id});
});

test('an approved cover letter is not shown to applications for other records', async (t) => {
  const f = await fixture(t);
  const {questionId} = await f.requestLetter();
  const writer = f.launches.at(-1);
  await f.flow(writer).call(f.id, writer.id, 'save_cover_letter', {text: letter()});
  await f.finish(writer, 'completed');
  await approveCoverLetter(f.runtime, f.id, questionId, {
    workspace: f.workspace,
    renderPdf: f.renderPdf,
  });
  await settle();
  await f.runtime.finish(f.id, 'blocked', 'Done', f.launches.at(-1).workerId);
  const seed = f.db.begin(f.id, 'run'),
    other = f.db.record(f.id, seed.id, {
      key: source + '/2',
      url: source + '/2',
      title: 'Other role',
      summary: 'Observed facts',
    });
  f.db.finish(f.id, seed.id, 'completed', 'Saved');
  await f.runtime.runRecord(f.id, other.id, 'execute', {direct: true});
  await settle();
  const context = automationTaskContext(f.db, f.id, f.db.run(f.launches.at(-1).id));
  assert.equal(context.assignedRecord.id, other.id);
  assert.doesNotMatch(JSON.stringify(context.earlierAnswers ?? {}), /cover letter/i);
});

test('agent generated files are listed apart and never read as profile documents', async (t) => {
  const f = await fixture(t);
  const {writeFile, mkdir} = await import('node:fs/promises');
  await mkdir(path.join(f.workspace, 'documents'), {recursive: true});
  await mkdir(path.join(f.workspace, 'generated', 'cover-letters'), {recursive: true});
  await writeFile(path.join(f.workspace, 'documents', 'CV.txt'), 'Ada Lovelace, engineer');
  await writeFile(
    path.join(f.workspace, 'generated', 'cover-letters', 'Cover-Letter-Example.txt'),
    'Dear team',
  );
  const files = await listDocuments(f.workspace);
  assert.deepEqual(files.map((d) => [d.path, d.generated]).sort(), [
    ['documents/CV.txt', false],
    ['generated/cover-letters/Cover-Letter-Example.txt', true],
  ]);
  // Letters saved before the split stay agent files.
  assert.equal(agentDocument('documents/cover-letters/Cover-Letter-Old.pdf'), true);
  assert.equal(agentDocument('documents/CV.pdf'), false);
});

test('with automatic acceptance the saved letter resumes the application without a review', async (t) => {
  const f = await fixture(t);
  setCoverLetterAutoApprove(f.db, f.id, true);
  assert.throws(() => setCoverLetterAutoApprove(f.db, f.id, 'yes'), /on or off/);
  const {execute, questionId} = await f.requestLetter();
  const writer = f.launches.at(-1);
  const saved = await f.flow(writer).call(f.id, writer.id, 'save_cover_letter', {text: letter()});
  assert.match(saved.next, /accepted automatically/);
  const question = f.db.get(f.id).questions.find((q) => q.id === questionId);
  assert.equal(question.coverLetter.state, 'approved');
  assert.equal(question.coverLetter.autoApproved, true);
  assert.match(question.answer, /accepted automatically/);
  // The writer finishes first; then the same application continues.
  assert.equal(f.launches.at(-1).id, writer.id);
  await f.finish(writer, 'completed');
  const resumed = f.launches.at(-1);
  assert.equal(resumed.recordOperation, 'execute');
  assert.equal(resumed.continuation.runId, execute.id);
  assert.deepEqual(resumed.continuation.questionIds, [questionId]);
});

test('with automatic acceptance and another worker the application waits for its letter', async (t) => {
  const f = await fixture(t);
  setCoverLetterAutoApprove(f.db, f.id, true);
  f.db.store.workspaces.workers.add(f.id);
  await f.runtime.runRecord(f.id, f.item.id, 'execute', {direct: true});
  await settle();
  const execute = f.launches.at(-1);
  const requested = await f.flow(execute).call(f.id, execute.id, 'request_cover_letter', {});
  assert.match(requested.next, /wait_for_cover_letter/);
  await f.runtime.tick();
  await settle();
  // The writer starts on the other worker while the application keeps its task.
  const writer = f.launches.at(-1);
  assert.equal(writer.recordOperation, 'cover_letter');
  assert.notEqual(writer.workerId, execute.workerId);
  const still = await waitForCoverLetter(f.db, f.id, f.db.run(execute.id), {waitMs: 0});
  assert.match(still.next, /still writing/);
  // A wait that outlasts its limit finishes blocked; the saved letter resumes it later.
  const late = await waitForCoverLetter(
    f.db,
    f.id,
    {coverLetterWait: {questionId: requested.questionId, since: 0}},
    {limitMs: 0},
  );
  assert.match(late.next, /status blocked/);
  const waiting = f.flow(execute).call(f.id, execute.id, 'wait_for_cover_letter', {});
  const saved = await f.flow(writer).call(f.id, writer.id, 'save_cover_letter', {text: letter()});
  const ready = await waiting;
  assert.equal(ready.ready, true);
  assert.equal(ready.path, saved.path);
  assert.match(ready.letter, /accepted automatically/);
  // The waiting application uses the letter; the writer's end starts no second one.
  await f.finish(writer, 'completed');
  assert.equal(f.launches.at(-1).id, writer.id);
});

// Uploads the approved letter on a form whose inspection `form(id, uploaded)`
// returns; each inspection gives the upload a new id.
async function uploadApprovedLetter(t, form) {
  const f = await fixture(t);
  const {questionId} = await f.requestLetter();
  const writer = f.launches.at(-1);
  const saved = await f.flow(writer).call(f.id, writer.id, 'save_cover_letter', {text: letter()});
  await f.finish(writer, 'completed');
  await approveCoverLetter(f.runtime, f.id, questionId, {
    workspace: f.workspace,
    renderPdf: f.renderPdf,
  });
  await settle();
  const execute = f.launches.at(-1);
  await writeFile(path.join(f.workspace, 'CV.pdf'), '%PDF-cv');
  let inspections = 0,
    uploaded = false;
  const flow = automationWorkflow({
    workspace: f.workspace,
    db: f.db,
    run: execute,
    signal: {aborted: false},
    browser: {
      currentUrl: async () => f.item.url,
      call: async (_, name, args) => {
        if (name === 'browser_upload_document') {
          uploaded = args.filePath.endsWith('.pdf') && !args.filePath.endsWith('CV.pdf');
          return {action: 'uploaded'};
        }
        if (name === 'browser_snapshot')
          return {
            pageContext: {url: f.item.url, tabId: 'tab-1'},
            content: [{type: 'text', text: `Page URL: ${f.item.url}\nApplication form`}],
          };
        return {
          url: f.item.url,
          submitControls: [{label: 'Submit application'}],
          ...form(`letter-${++inspections}`, uploaded),
        };
      },
    },
    renderPdf: f.renderPdf,
    report: (...args) => f.runtime.report(...args),
  });
  const reserve = () =>
    flow.call(f.id, execute.id, 'reserve_automation_action', {itemId: f.item.id});
  await flow.call(f.id, execute.id, 'browser_inspect_form', {});
  // Another file in the cover letter field does not count.
  await flow.call(f.id, execute.id, 'browser_upload_document', {
    ref: `letter-${inspections}`,
    filePath: 'CV.pdf',
  });
  await assert.rejects(reserve(), /approved cover letter/);
  await flow.call(f.id, execute.id, 'browser_inspect_form', {});
  await flow.call(f.id, execute.id, 'browser_upload_document', {
    ref: `letter-${inspections}`,
    filePath: saved.path,
  });
  // A later inspection of the same step keeps the field filled.
  await flow.call(f.id, execute.id, 'browser_inspect_form', {});
  await reserve();
}

const email = {label: 'Email', question: 'Email *', required: true, type: 'text', filled: true};

test('an upload-only cover letter field counts as filled once the approved letter is uploaded to it', (t) =>
  // The upload entry never says which file it holds.
  uploadApprovedLetter(t, (uploadId) => ({
    uploads: [{uploadId, label: 'Cover Letter — File upload'}],
    fields: [email],
  })));

test('a cover letter file field that disappears after the upload counts as filled', (t) =>
  // The field reports empty until the file is attached, then the form shows
  // the file name in its place.
  uploadApprovedLetter(t, (uploadId, uploaded) => ({
    uploads: uploaded ? [] : [{uploadId, label: 'Cover Letter — Attach'}],
    fields: [
      email,
      ...(uploaded
        ? []
        : [{label: 'Attach', question: 'Cover Letter', type: 'file', filled: false}]),
    ],
  })));

test('cover letters get their own model setting', async (t) => {
  assert.equal(withAgentDefaults({provider: 'claude'}).coverLetterModel, 'opus[1m]');
  assert.equal(withAgentDefaults({provider: 'codex'}).coverLetterModel, undefined);
  const f = await fixture(t);
  f.db.save(f.id, {
    agentSettings: {provider: 'claude', model: 'haiku', coverLetterModel: 'sonnet'},
  });
  assert.equal(f.db.get(f.id).agentSettings.coverLetterModel, 'sonnet');
  f.db.save(f.id, {agentSettings: {provider: 'claude', model: 'haiku', coverLetterModel: null}});
  assert.equal(f.db.get(f.id).agentSettings.coverLetterModel, null);
});
