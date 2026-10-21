import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {WebTasks} from '../app/automation/web-template.mjs';
import {automationWorkflow} from '../app/automation/worker.mjs';
import {automationPrompt} from '../app/automation/prompts.mjs';
import {DatabaseSync} from 'node:sqlite';
import {withAgentDefaults} from '../app/agents/settings.mjs';
import {SiteAccess, runSiteLane, CONTACTS_LANE} from '../app/browser/site-access.mjs';
import {
  CONTACT_FIND_PROMPT,
  CONTACT_SEND_PROMPT,
  findRecordContacts,
  sendRecordContacts,
  editRecordContact,
  contactClick,
  linkedInProfile,
  contactsInterrupted,
  removeRecordContacts,
  contactSendClicked,
  queueAutomaticContacts,
} from '../app/automation/contacts.mjs';

const source = 'https://example.test/list',
  profile = 'https://www.linkedin.com/in/jane-doe-123/',
  settle = () => new Promise((r) => setImmediate(r)),
  note =
    'Hi Jane, the Senior Backend Engineer role at Example asks for event-driven AWS services; I have built them at scale for 8 years. That is why I wanted to reach out.',
  personal =
    "Hi Jane, your team's event-driven platform caught my eye. I have spent 8 years building exactly that on AWS. Open to a short chat about the Backend role?",
  notes = (direct, other = personal) => [
    {style: 'direct', text: direct},
    {style: 'personal', text: other},
  ];

async function fixture(t) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'record-contacts-'));
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
      title: 'Senior Backend Engineer',
      summary: 'Observed facts',
    });
  db.finish(a.id, seed.id, 'completed', 'Saved');
  const launches = [];
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
  const flow = (run) =>
    automationWorkflow({
      workspace,
      db,
      run,
      signal: {aborted: false},
      browser: {},
      report: (...args) => runtime.report(...args),
    });
  const call = (run, name, args = {}) => flow(run).call(a.id, run.id, name, args);
  const finish = async (run, status, args = {}) => {
    await call(run, 'finish_automation_run', {status, summary: 'Done', ...args});
    await runtime.finish(a.id, status, 'Done', run.workerId);
    await runtime.tick();
    await settle();
  };
  const entry = () => db.get(a.id).recordContacts.find((e) => e.recordId === item.id);
  // A find task that read Jane's profile and saved her.
  const found = async () => {
    await findRecordContacts(runtime, a.id, item.id, {notes: 'the backend team'});
    await settle();
    const run = launches.at(-1);
    db.browserEvidence.save(run, {
      id: 'profile-1',
      url: profile,
      text: 'Jane Doe · Talent Acquisition Partner at Example GmbH · Connect · Message',
    });
    await call(run, 'save_record_contacts', {
      contacts: [
        {
          name: 'Jane Doe',
          headline: 'Talent Acquisition Partner at Example GmbH',
          relation: 'recruiter',
          profileUrl: profile,
          reason: 'She recruits for the engineering team named in the listing.',
          notes: notes(note),
        },
      ],
    });
    await finish(run, 'completed');
    return run;
  };
  return {db, id: a.id, item, runtime, launches, flow, call, finish, entry, found};
}

test('a contact search is its own record task with read-only LinkedIn tools', async (t) => {
  const f = await fixture(t);
  await findRecordContacts(f.runtime, f.id, f.item.id, {notes: 'the backend team'});
  await settle();
  const run = f.launches.at(-1);
  assert.equal(run.recordOperation, 'contacts');
  assert.equal(run.request.phase, 'find');
  assert.equal(automationPrompt(run), CONTACT_FIND_PROMPT);
  assert.equal(f.entry().state, 'searching');
  const tools = f.flow(run).tools.map((tool) => tool.name);
  for (const name of ['read_contact_brief', 'save_record_contacts', 'browser_interact'])
    assert.ok(tools.includes(name), name);
  for (const name of [
    'reserve_contact_action',
    'record_contact_outcome',
    'reserve_automation_action',
    'browser_upload_document',
    'request_cover_letter',
  ])
    assert.ok(!tools.includes(name), name);
  const brief = await f.call(run, 'read_contact_brief');
  assert.equal(brief.userNotes, 'the backend team');
  assert.equal(brief.record.url, f.item.url);
  // A search may not reach out to anyone.
  assert.throws(() => contactClick(f.db.run(run.id), 'Connect', false), /only finds contacts/);
  assert.throws(() => contactClick(f.db.run(run.id), 'Send', true), /only finds contacts/);
  assert.equal(contactClick(f.db.run(run.id), 'Show all results', false), null);
});

test('a contact is saved only from a profile this task read', async (t) => {
  const f = await fixture(t);
  await findRecordContacts(f.runtime, f.id, f.item.id);
  await settle();
  const run = f.launches.at(-1),
    contact = {
      name: 'Jane Doe',
      relation: 'recruiter',
      profileUrl: profile,
      reason: 'Recruiter',
      notes: notes(note),
    };
  await assert.rejects(
    f.call(run, 'save_record_contacts', {contacts: [contact]}),
    /Open https:\/\/www\.linkedin\.com\/in\/jane-doe-123\/ with browser_open/,
  );
  await assert.rejects(
    f.call(run, 'finish_automation_run', {status: 'completed', summary: 'Done'}),
    /save_record_contacts/,
  );
  f.db.browserEvidence.save(run, {id: 'p', url: profile, text: 'John Roe · Engineer'});
  await assert.rejects(
    f.call(run, 'save_record_contacts', {contacts: [contact]}),
    /does not show the name/,
  );
  await assert.rejects(
    f.call(run, 'save_record_contacts', {
      contacts: [{...contact, profileUrl: 'https://example.test/jane'}],
    }),
    /LinkedIn profile address/,
  );
  f.db.browserEvidence.save(run, {id: 'p2', url: profile, text: 'Jane Doe · Recruiter'});
  // The user has not applied: no note may say so.
  await assert.rejects(
    f.call(run, 'save_record_contacts', {
      contacts: [{...contact, notes: notes('Hi Jane, I applied for the backend role.')}],
    }),
    /says the user applied/,
  );
  await assert.rejects(
    f.call(run, 'save_record_contacts', {
      contacts: [{...contact, notes: notes('x'.repeat(201))}],
    }),
    /keep it under 200/,
  );
  // Two notes, one per style, that really differ.
  await assert.rejects(
    f.call(run, 'save_record_contacts', {contacts: [{...contact, notes: notes(note).slice(0, 1)}]}),
    /exactly one note per style/,
  );
  await assert.rejects(
    f.call(run, 'save_record_contacts', {contacts: [{...contact, notes: notes(note, note)}]}),
    /are the same/,
  );
  // Nobody suitable is a valid result when it says why.
  await assert.rejects(f.call(run, 'save_record_contacts', {contacts: []}), /noneReason/);
  await f.call(run, 'save_record_contacts', {contacts: [], noneReason: 'Nobody works there.'});
  assert.equal(f.entry().noneReason, 'Nobody works there.');
});

test('approved contacts are sent once each by a send task', async (t) => {
  const f = await fixture(t);
  await f.found();
  const [jane] = f.entry().contacts;
  assert.equal(jane.state, 'proposed');
  assert.equal(jane.profileUrl, profile);
  assert.equal(jane.message, note);
  assert.deepEqual(jane.notes, notes(note));
  // The user's edit is kept; an empty note is refused.
  editRecordContact(f.db, f.id, f.item.id, jane.id, {message: note + ' Thanks.'});
  assert.throws(() => editRecordContact(f.db, f.id, f.item.id, jane.id, {message: ' '}), /Write/);
  await sendRecordContacts(f.runtime, f.id, f.item.id, [jane.id]);
  await settle();
  const run = f.launches.at(-1);
  assert.equal(run.request.phase, 'send');
  assert.equal(automationPrompt(run), CONTACT_SEND_PROMPT);
  assert.equal(f.entry().contacts[0].state, 'queued');
  const tools = f.flow(run).tools.map((tool) => tool.name);
  assert.ok(tools.includes('reserve_contact_action'));
  assert.ok(!tools.includes('save_record_contacts'));
  const brief = await f.call(run, 'read_contact_brief');
  assert.equal(brief.contacts[0].text, note + ' Thanks.');
  // No Connect or Send click before the reservation.
  assert.throws(() => contactClick(f.db.run(run.id), 'Connect', false), /reserve_contact_action/);
  await assert.rejects(
    f.call(run, 'record_contact_outcome', {
      contactId: jane.id,
      status: 'invited_with_note',
      evidence: 'Invitation sent',
    }),
    /needs the Send click/,
  );
  const reserved = await f.call(run, 'reserve_contact_action', {contactId: jane.id});
  assert.equal(reserved.text, note + ' Thanks.');
  assert.equal(contactClick(f.db.run(run.id), 'Connect', false), 'open');
  assert.equal(contactClick(f.db.run(run.id), 'Send', true), 'send');
  // The worker marks the Send click; a second one is refused.
  const current = f.db.run(run.id);
  f.db.putRun({...current, contactAction: {...current.contactAction, sent: true}});
  assert.throws(() => contactClick(f.db.run(run.id), 'Send', true), /already clicked/);
  await assert.rejects(
    f.call(run, 'finish_automation_run', {status: 'completed', summary: 'Done'}),
    /Record an outcome/,
  );
  await f.call(run, 'record_contact_outcome', {
    contactId: jane.id,
    status: 'invited_without_note',
    evidence: 'Invitation sent to Jane Doe',
  });
  await f.finish(run, 'completed');
  const sent = f.entry().contacts[0];
  assert.equal(sent.state, 'invited');
  assert.equal(sent.outcome, 'invited_without_note');
  // The conversation keeps what went out: an invitation without its note.
  assert.deepEqual(
    sent.history.map((h) => [h.as, h.text]),
    [['invited_without_note', '']],
  );
  // After acceptance the kept note goes out as a message.
  await sendRecordContacts(f.runtime, f.id, f.item.id, [jane.id]);
  await settle();
  assert.equal(f.entry().contacts[0].followUp, true);
});

test('a stopped send task hands its contacts back to the user', async (t) => {
  const f = await fixture(t);
  await f.found();
  const [jane] = f.entry().contacts;
  await sendRecordContacts(f.runtime, f.id, f.item.id, [jane.id]);
  await settle();
  const run = f.launches.at(-1);
  await f.call(run, 'reserve_contact_action', {contactId: jane.id});
  contactSendClicked(f.db, f.id, run);
  await f.finish(run, 'blocked', {
    blocker: {category: 'needs_login', reason: 'LinkedIn sign-in', userAction: 'Sign in'},
  });
  // Send was clicked without an outcome: the user checks LinkedIn first.
  assert.equal(f.entry().contacts[0].state, 'uncertain');
});

test('contact tools stay out of other tasks and contacts get their own model', () => {
  assert.equal(withAgentDefaults({provider: 'claude'}).contactModel, 'opus[1m]');
  assert.equal(withAgentDefaults({provider: 'codex'}).contactModel, undefined);
  assert.equal(
    linkedInProfile('https://de.linkedin.com/in/Jane-Doe-123?trk=x'),
    'https://www.linkedin.com/in/jane-doe-123/',
  );
  assert.equal(linkedInProfile('https://www.linkedin.com/company/example/'), null);
});

test('application tasks do not see contact tools', async (t) => {
  const f = await fixture(t);
  await f.runtime.runRecord(f.id, f.item.id, 'execute', {direct: true});
  await settle();
  const tools = f.flow(f.launches.at(-1)).tools.map((tool) => tool.name);
  for (const name of [
    'read_contact_brief',
    'save_record_contacts',
    'reserve_contact_action',
    'record_contact_outcome',
  ])
    assert.ok(!tools.includes(name), name);
});

test('a scan wait on LinkedIn does not hold a contact task', () => {
  const db = new DatabaseSync(':memory:'),
    gate = new SiteAccess(db, {now: () => 100000}),
    linkedIn = 'https://www.linkedin.com/in/jane-doe-123/';
  try {
    assert.equal(runSiteLane({recordOperation: 'contacts'}), CONTACTS_LANE);
    // The public job API budget parks scans only.
    gate.spend(linkedIn, {requests: 1, windowMs: 3600_000});
    gate.spend(linkedIn, {requests: 1, windowMs: 3600_000});
    assert.ok(gate.status(linkedIn));
    assert.equal(gate.forLane(runSiteLane({recordOperation: 'contacts'})).status(linkedIn), null);
  } finally {
    db.close();
  }
});

test('a send task that stops before any Send click sends nothing and keeps the proposal', async (t) => {
  const f = await fixture(t);
  await f.found();
  const [jane] = f.entry().contacts;
  await sendRecordContacts(f.runtime, f.id, f.item.id, [jane.id]);
  await settle();
  const run = f.launches.at(-1);
  // The app parks the task (a site wait) without the agent's finish call.
  f.db.store.workspaces.tasks.finish(f.id, run.taskId, 'blocked', 'Site wait');
  assert.equal(contactsInterrupted(f.db, f.id), true);
  assert.equal(f.entry().contacts[0].state, 'proposed');
  assert.match(f.entry().contacts[0].error, /nothing was sent/);
});

test('a listing leaves the Contacts page only when no contact task runs for it', async (t) => {
  const f = await fixture(t);
  await findRecordContacts(f.runtime, f.id, f.item.id);
  await settle();
  assert.throws(() => removeRecordContacts(f.db, f.id, f.item.id), /still running/);
  await f.finish(f.launches.at(-1), 'blocked', {
    blocker: {category: 'needs_login', reason: 'LinkedIn sign-in', userAction: 'Sign in'},
  });
  removeRecordContacts(f.db, f.id, f.item.id);
  assert.equal(f.db.get(f.id).recordContacts.length, 0);
});

test('find contacts automatically searches once per record that reaches the minimum score', async (t) => {
  const f = await fixture(t),
    run = f.db.begin(f.id, 'run'),
    scored = (key, score) =>
      f.db.record(f.id, run.id, {
        key: source + '/' + key,
        url: source + '/' + key,
        title: 'Backend Engineer ' + key,
        summary: 'Observed facts',
        assessment: {score, eligibility: 'verified', eligibilityReason: 'Met', summary: 'Fits'},
      }),
    low = scored('low', 69),
    high = scored('high', 70);
  f.db.finish(f.id, run.id, 'completed', 'Saved');
  const queue = () =>
      queueAutomaticContacts(f.db, f.id, f.db.get(f.id), f.db.store.workspaces.tasks.list(f.id)),
    tasks = () =>
      f.db.store.workspaces.tasks.list(f.id).filter((x) => x.recordOperation === 'contacts');
  assert.equal(queue(), null, 'off by default');
  const a = f.db.get(f.id);
  f.db.put({...a, criteria: {...a.criteria, auto_contacts: 'find'}});
  // Without a minimum score the default 70 applies; 69 and the unscored record wait.
  assert.equal(queue(), high.id);
  assert.equal(f.db.get(f.id).recordContacts[0].state, 'searching');
  assert.equal(tasks()[0].request.manual, false);
  // The automatic search never sends; the user approves every note.
  assert.equal(tasks()[0].request.phase, 'find');
  assert.equal(tasks()[0].request.send, undefined);
  assert.equal(queue(), null, 'one search at a time');
  f.db.store.workspaces.tasks.finish(f.id, tasks()[0].id, 'completed', 'Done');
  // A removed entry is not searched again.
  const done = f.db.get(f.id);
  f.db.put({...done, recordContacts: []});
  assert.equal(queue(), null);
  assert.equal(tasks().length, 1);
  void low;
});

test('a contact search runs beside the same record’s application', async (t) => {
  const f = await fixture(t),
    tasks = f.db.store.workspaces.tasks,
    execute = tasks.enqueue(f.id, {
      recordOperation: 'execute',
      recordId: f.item.id,
      lockKey: 'submit',
      request: {manual: true},
    });
  tasks.claim(f.id, execute.id, 'apply-worker');
  await findRecordContacts(f.runtime, f.id, f.item.id);
  await settle();
  // The worker started the search while the application holds the record.
  const search = tasks.list(f.id).find((x) => x.recordOperation === 'contacts');
  assert.equal(search.state, 'running');
  assert.equal(f.launches.at(-1).recordOperation, 'contacts');
  await assert.rejects(findRecordContacts(f.runtime, f.id, f.item.id), /contact task/);
});

test('an earlier saved find_and_send only searches', async (t) => {
  const f = await fixture(t),
    run = f.db.begin(f.id, 'run'),
    item = f.db.record(f.id, run.id, {
      key: source + '/legacy',
      url: source + '/legacy',
      title: 'Backend Engineer',
      summary: 'Observed facts',
      assessment: {score: 90, eligibility: 'verified', eligibilityReason: 'Met', summary: 'Fits'},
    });
  f.db.finish(f.id, run.id, 'completed', 'Saved');
  const a = f.db.get(f.id);
  f.db.put({...a, criteria: {...a.criteria, auto_contacts: 'find_and_send'}});
  const tasks = f.db.store.workspaces.tasks;
  assert.equal(queueAutomaticContacts(f.db, f.id, f.db.get(f.id), tasks.list(f.id)), item.id);
  const task = tasks.list(f.id).find((x) => x.recordOperation === 'contacts');
  assert.deepEqual([task.request.phase, task.request.send], ['find', undefined]);
});

test('people the listing shows wait as listed contacts until the user writes or a search picks them', async (t) => {
  const f = await fixture(t);
  const listed = (name, profileUrl) => ({
    id: 'listed-' + name,
    name,
    headline: 'Senior Recruiter',
    relation: 'hiring_team',
    profileUrl,
    reason: 'Shown as the hiring team on the listing.',
    notes: [],
    message: '',
    state: 'listed',
    foundAt: 1,
  });
  const other = 'https://www.linkedin.com/in/john-roe/';
  f.db.put({
    ...f.db.get(f.id),
    recordContacts: [
      {recordId: f.item.id, contacts: [listed('Jane Doe', profile), listed('John Roe', other)]},
    ],
  });
  // Listed people alone are no search: the automatic search still runs once.
  const a = f.db.get(f.id);
  f.db.put({...a, criteria: {...a.criteria, auto_contacts: 'find'}});
  const run = f.db.begin(f.id, 'run');
  f.db.record(f.id, run.id, {
    key: f.item.key,
    url: f.item.url,
    title: f.item.title,
    summary: 'Observed facts',
    assessment: {score: 90, eligibility: 'verified', eligibilityReason: 'Met', summary: 'Fits'},
  });
  f.db.finish(f.id, run.id, 'completed', 'Saved');
  assert.equal(
    queueAutomaticContacts(f.db, f.id, f.db.get(f.id), f.db.store.workspaces.tasks.list(f.id)),
    f.item.id,
  );
  const queued = f.db.store.workspaces.tasks
    .list(f.id)
    .find((x) => x.recordOperation === 'contacts');
  f.db.store.workspaces.tasks.finish(f.id, queued.id, 'completed', 'Done');
  await findRecordContacts(f.runtime, f.id, f.item.id);
  await settle();
  const search = f.launches.at(-1),
    brief = await f.call(search, 'read_contact_brief');
  assert.deepEqual(brief.earlierContacts, []);
  assert.deepEqual(
    brief.listingPeople.map((p) => p.name),
    ['Jane Doe', 'John Roe'],
  );
  // The search may pick a listed person; the proposal replaces the listed entry.
  f.db.browserEvidence.save(search, {id: 'p', url: profile, text: 'Jane Doe · Recruiter'});
  await f.call(search, 'save_record_contacts', {
    contacts: [
      {
        name: 'Jane Doe',
        relation: 'recruiter',
        profileUrl: profile,
        reason: 'Hiring team',
        notes: notes(note),
      },
    ],
  });
  await f.finish(search, 'completed');
  assert.deepEqual(
    f.entry().contacts.map((c) => [c.name, c.state]),
    [
      ['John Roe', 'listed'],
      ['Jane Doe', 'proposed'],
    ],
  );
  // The user writes their own note to a listed person.
  const john = f.entry().contacts.find((c) => c.name === 'John Roe');
  await assert.rejects(
    sendRecordContacts(f.runtime, f.id, f.item.id, [john.id]),
    /Write the invitation note/,
  );
  await sendRecordContacts(f.runtime, f.id, f.item.id, [john.id], {
    [john.id]: 'Hi John, I would like to hear more about the backend team at Example.',
  });
  assert.equal(f.entry().contacts.find((c) => c.id === john.id).state, 'queued');
});
