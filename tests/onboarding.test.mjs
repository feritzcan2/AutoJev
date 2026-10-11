import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {automationPrompt} from '../app/automation/prompts.mjs';
import {conversationMethods} from '../app/automation/web-template/conversation.mjs';
import {conversationRequest, CONVERSATION_WORKER} from '../app/workspaces/conversation.mjs';

function fixture(t, templateId = 'job-search') {
  const core = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(core);
  t.after(() => core.close());
  const a =
    templateId === 'job-search'
      ? db.create(templateId, {})
      : db.create(templateId, {
          title: 'Home search',
          goal: 'Homes in Berlin',
          criteria: {location: 'Berlin', budget: '1500', requirements: '2 rooms'},
          sources: ['https://example.com/homes'],
        });
  const sent = [],
    started = [];
  const runtime = {
    ...conversationMethods,
    db,
    active: [],
    closed: false,
    now: () => new Date().toISOString(),
    changed() {},
    slots() {
      return this.active;
    },
    assertNotStopping() {},
    start(id, input, worker) {
      started.push(input);
      const run = db.begin(id, input, worker);
      this.active.push({run, workerId: worker, worker: {message: async (text) => sent.push(text)}});
      return run;
    },
  };
  return {db, id: a.id, runtime, sent, started};
}

test('the welcome screen starts a setup turn whose request is the template CV task', async (t) => {
  const {db, id, runtime, started} = fixture(t);
  const run = await runtime.onboard(id);
  assert.deepEqual(started, [{kind: 'interview', onboarding: true}]);
  assert.equal(run.onboarding, true);
  assert.equal(run.workerId, CONVERSATION_WORKER);
  const request = conversationRequest(db, id, run);
  assert.match(request.task, /^## Profile from the CV/);
  const prompt = automationPrompt(run, request);
  assert.match(prompt, /Current user request/);
  assert.match(prompt, /Do not call ask_workspace_question/);
  assert.doesNotMatch(request.task, /[çğışöüÇĞİŞÖÜ]/, 'Agent-facing text stays English');
});

test('reading the CV again reuses the waiting session; a later message replaces the CV task', async (t) => {
  const {db, id, runtime, sent, started} = fixture(t);
  const first = await runtime.onboard(id);
  await assert.rejects(
    runtime.onboard(id),
    /preparing its reply/,
    'A busy turn is not interrupted',
  );
  db.putRun({...db.run(first.id), awaitingMessage: true});
  runtime.active[0].run = db.run(first.id);
  await runtime.onboard(id);
  assert.equal(started.length, 1, 'The same provider session continues');
  assert.match(sent.at(-1), /Profile from the CV/);
  assert.equal(db.run(first.id).onboarding, true);
  db.putRun({...db.run(first.id), awaitingMessage: true});
  runtime.active[0].run = db.run(first.id);
  await runtime.message(id, 'Only Berlin');
  const run = db.run(first.id);
  assert.equal(run.onboarding, undefined);
  assert.equal(conversationRequest(db, id, run).message, 'Only Berlin');
});

test('notes typed with the CV go to the agent with the CV task and stay in the chat', async (t) => {
  const {db, id, runtime, sent} = fixture(t);
  const run = await runtime.onboard(id, {notes: '  Remote only, at least 80k EUR  '});
  const notes = db.messages(id).find((m) => m.onboardingNotes);
  assert.equal(notes.role, 'user');
  assert.equal(notes.text, 'Remote only, at least 80k EUR');
  assert.equal(notes.conversation, true, 'The notes show in the setup chat');
  const request = conversationRequest(db, id, run);
  assert.match(request.task, /userNotes/);
  assert.equal(request.userNotes, 'Remote only, at least 80k EUR');
  assert.match(automationPrompt(run, request), /Remote only, at least 80k EUR/);
  db.putRun({...db.run(run.id), awaitingMessage: true});
  runtime.active[0].run = db.run(run.id);
  await runtime.onboard(id);
  assert.match(
    sent.at(-1),
    /"userNotes":"Remote only, at least 80k EUR"/,
    'Reading again reuses them',
  );
  assert.equal(db.messages(id).filter((m) => m.onboardingNotes).length, 1);
  await assert.rejects(runtime.onboard(id, {notes: 42}), /Notes must be text/);
});

test('a template without a CV task cannot start the welcome-screen setup', async (t) => {
  const {id, runtime, started} = fixture(t, 'housing');
  await assert.rejects(runtime.onboard(id), /does not support setup from a document/);
  assert.deepEqual(started, []);
});
