// @ts-check
// LinkedIn contacts for a record, started by the user from the record panel
// or, with Find contacts automatically, for records that reach the minimum score.
// A find task looks for at most two people worth writing to about the listing
// (the poster, a recruiter, the hiring manager) in the user's signed-in
// browser and drafts a short invitation note for each. The user reviews and
// approves the notes; a send task then connects with a note (or messages an
// existing connection) once per approved contact. The app, not the prompt,
// gates every connect, message and send click. People the listing itself shows
// (its hiring team) are kept as listed contacts when a scan saves the record,
// read with the listing at no extra request.
import {automaticAssessmentError} from '../../src/scoring-state.js';
import {autoApplyThreshold} from '../scoring/thresholds.mjs';
import {autoContactsMode} from '../records/operation-definitions.mjs';
import {memoryDetail} from '../records/evidence.mjs';

export const CONTACT_LIMIT = 2,
  NOTE_CHARACTERS = 200;
// Each person gets one note per style; the user picks one.
export const NOTE_STYLES = ['direct', 'personal'];
// Invitations and messages per day across workspaces; LinkedIn limits weekly invitations.
const SEND_BUDGET = {requests: 20, windowMs: 24 * 3600_000},
  SEND_BUDGET_KEY = 'linkedin.com contact';
const RELATIONS = ['poster', 'recruiter', 'hiring_manager', 'team'];
// At most this many people from one listing.
const LISTED_LIMIT = 6;
export const CONTACT_OUTCOMES = [
  'invited_with_note',
  'invited_without_note',
  'messaged',
  'already_invited',
  'not_accepted_yet',
  'failed',
];
// Outcomes that need the reserved send click of this run.
const SENT = new Set(['invited_with_note', 'invited_without_note', 'messaged']);
// Contacts the user may (re)send: a proposal, a person the listing shows (with
// the user's own note), a follow-up after an invitation, a failed or unclear
// attempt (LinkedIn then shows Pending).
const RESENDABLE = new Set(['proposed', 'listed', 'invited', 'failed', 'uncertain']);

// Short numbered steps; the agents reading this are not experts.
export const CONTACT_FIND_PROMPT =
  'Read AGENTS.md. This is a contact search for one record: you find people on LinkedIn, you do not connect, message or apply. Steps: 1. Call read_contact_brief. 2. Open record.url with browser_open and read it with browser_read. Note the company, the team and any person the listing names (the poster or "hiring team" card, a recruiter, a contact person) with their LinkedIn profile link. 3. If you still have fewer than 2 good people, open a LinkedIn people search: https://www.linkedin.com/search/results/people/?keywords=<words> with the company name plus recruiter, talent acquisition, or the lead title of the team (for example engineering manager), and read the results. 4. Open the profile of each person you pick with browser_open and read it: keep only people who work at this company now and are close to this role (its poster, a recruiter for it, its hiring manager or team lead). Never pick former employees or unrelated people. 5. Read the CV with read_scoring_profile (source documents). 6. Write two invitation notes per person, one in each style of the brief noteRules. 7. Call save_record_contacts with at most 2 people; profileUrl is the address of the profile page you read. If nobody suitable exists, save an empty list with noneReason. 8. Call finish_automation_run with status completed. If LinkedIn asks you to sign in, finish blocked with blocker category needs_login. Never click Connect, Message, Follow or Send in this task; the app refuses those clicks.';
export const CONTACT_SEND_PROMPT =
  'Read AGENTS.md. This task sends the LinkedIn invitations or messages the user approved for one record. Steps: 1. Call read_contact_brief; it lists the contacts to handle and their approved text. 2. For each contact, one at a time: a. Open profileUrl with browser_open and read it. b. If the profile shows Pending, call record_contact_outcome with already_invited (or not_accepted_yet for a followUp contact) and go to the next contact. c. If the contact is a followUp and the profile has no Message button for a connection, call record_contact_outcome with not_accepted_yet. d. Otherwise call reserve_contact_action with the contactId. e. Existing connection (followUp, or a 1st-degree profile with Message): click Message, type the approved text, click Send. Otherwise click Connect (it may sit under More), click Add a note, type the approved text, click Send. If Add a note shows a limit or Premium offer instead of a text box, close it and click Send without a note. f. Read the page and call record_contact_outcome with what happened and the page words as evidence (invited_with_note, invited_without_note or messaged). If Connect is missing or the send failed, record failed with the reason. Click Send once per contact. 3. Call finish_automation_run with status completed after every contact has an outcome. If LinkedIn asks you to sign in, finish blocked with blocker category needs_login.';

const LIVE = ['pending', 'running', 'reported', 'paused'];
const entryOf = (a, recordId) => (a.recordContacts ?? []).find((e) => e.recordId === recordId);
const contactOf = (entry, contactId) => entry?.contacts.find((c) => c.id === contactId);
const sendPhase = (run) => run.request?.phase === 'send';
// Whether a contact search ran or anyone was written to; listed people alone are neither.
const searched = (entry) =>
  Boolean(entry && (entry.state || entry.contacts.some((c) => c.state !== 'listed')));
export const contactPrompt = (run) => (sendPhase(run) ? CONTACT_SEND_PROMPT : CONTACT_FIND_PROMPT);

function putEntry(db, id, recordId, patch) {
  const a = db.get(id),
    list = a.recordContacts ?? [],
    current = entryOf(a, recordId) ?? {recordId, contacts: []},
    next = {...current, ...(typeof patch === 'function' ? patch(current) : patch)};
  db.put({...a, recordContacts: [...list.filter((e) => e.recordId !== recordId), next]});
  return next;
}
const putContacts = (db, id, recordId, change) =>
  putEntry(db, id, recordId, (e) => ({contacts: e.contacts.map((c) => change(c) ?? c)}));

// https://www.linkedin.com/in/<slug>/ for a LinkedIn profile address, else null.
export function linkedInProfile(value) {
  try {
    const url = new URL(String(value ?? '').trim()),
      slug = /^\/in\/([^/?#]+)/.exec(url.pathname)?.[1];
    if (url.protocol !== 'https:' || !/(^|\.)linkedin\.com$/.test(url.hostname) || !slug)
      return null;
    return `https://www.linkedin.com/in/${decodeURIComponent(slug).toLowerCase()}/`;
  } catch {
    return null;
  }
}
const plain = (text) =>
  String(text ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/\s+/g, ' ');
// The profile page this run read for a contact, or null.
function readProfile(db, run, profileUrl) {
  return (
    db.browserEvidence
      .list(run)
      .reverse()
      .find((page) => linkedInProfile(page.url) === profileUrl) ?? null
  );
}

function noteText(text) {
  text = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) throw Error('Write the invitation note.');
  if (text.length > NOTE_CHARACTERS)
    throw Error(`The note is ${text.length} characters; keep it under ${NOTE_CHARACTERS}.`);
  const placeholder = /\[[^\]\n]{2,40}\]/.exec(text);
  if (placeholder)
    throw Error(`Replace the placeholder ${placeholder[0]} with the real value or remove it.`);
  return text;
}

function enqueueContactTask(db, id, item, request) {
  const a = db.get(id);
  const task = db.store.workspaces.tasks.enqueue(id, {
    recordOperation: 'contacts',
    operation: 'record-contacts',
    capability: 'browser.observe',
    recordId: item.id,
    subject: item.id,
    sourceUrl: null,
    sources: [item.url],
    lockKey: 'contacts:' + item.id,
    request: {manual: true, revision: a.revision, at: db.now(), ...request},
    recordVersion: item.digest ?? String(item.updatedAt),
  });
  db.event(id, 'record_operation_queued', {itemId: item.id, kind: 'contacts', taskId: task.id});
  return task;
}

// A contact task runs beside the record's other tasks (its application, a
// score), never beside another contact task of the same record.
function assertFree(db, id, item) {
  if (item.trial) throw Error('No action can run on a research sample');
  if (
    db.store.workspaces.tasks
      .list(id, {states: LIVE})
      .some((t) => t.recordOperation === 'contacts' && t.recordId === item.id)
  )
    throw Error('A contact task for this record is running');
}

// The user's "Find contacts": earlier proposals that were never sent are replaced.
export async function findRecordContacts(runtime, id, recordId, {notes = ''} = {}) {
  const {db} = runtime,
    item = db.result(id, recordId);
  assertFree(db, id, item);
  notes = String(notes ?? '')
    .trim()
    .slice(0, 1000);
  startSearch(db, id, item, notes ? {notes} : {});
  runtime.changed(id);
  await runtime.tick();
  return entryOf(db.get(id), item.id);
}
function startSearch(db, id, item, request) {
  const task = enqueueContactTask(db, id, item, {phase: 'find', ...request});
  putEntry(db, id, item.id, (e) => ({
    state: 'searching',
    requestedAt: db.now(),
    taskId: task.id,
    error: null,
    noneReason: null,
    contacts: e.contacts.filter((c) => c.state !== 'proposed'),
  }));
}

// Find contacts automatically: a record saved after the setting was turned on
// that reaches the minimum score gets one search, never a second one (a
// removed entry stays removed). One search at a time per workspace; tasks
// holds the workspace's task history.
export function queueAutomaticContacts(db, id, a, tasks) {
  if (!autoContactsMode(a.criteria)) return null;
  const contactTasks = tasks.filter((t) => t.recordOperation === 'contacts');
  if (contactTasks.some((t) => LIVE.includes(t.state))) return null;
  const searchedIds = new Set(contactTasks.map((t) => t.recordId)),
    threshold = autoApplyThreshold(a.criteria);
  const item = db
    .results(id)
    .find(
      (r) =>
        !r.trial &&
        !['dismissed', 'closed'].includes(r.status) &&
        !searchedIds.has(r.id) &&
        !searched(entryOf(a, r.id)) &&
        (r.createdAt ?? 0) >= (a.autoContactsAfter ?? 0) &&
        Number.isInteger(r.assessment?.score) &&
        !automaticAssessmentError(r.assessment, threshold),
    );
  if (!item) return null;
  startSearch(db, id, item, {manual: false});
  return item.id;
}

// The people a new record's listing shows (its hiring team, people LinkedIn
// suggests reaching out to), from the listing a scan read: listed contacts the
// user can write to or a contact search can pick. Nothing is sent.
export function keepListingContacts(db, id, run, recordId, url) {
  if (run.kind !== 'run' || run.recordOperation) return;
  const people = memoryDetail(db, id, run, url)?.listing?.people;
  if (!people?.length || db.result(id, recordId)?.trial) return;
  const seen = new Set((entryOf(db.get(id), recordId)?.contacts ?? []).map((c) => c.profileUrl)),
    listed = [];
  for (const person of people) {
    const profileUrl = linkedInProfile(person.profileUrl),
      name = String(person.name ?? '').trim();
    if (!profileUrl || !name || seen.has(profileUrl) || listed.length >= LISTED_LIMIT) continue;
    seen.add(profileUrl);
    listed.push({
      id: `listed-${listed.length + 1}`,
      name,
      headline: String(person.headline ?? '')
        .trim()
        .slice(0, 200),
      relation: person.hiringTeam ? 'hiring_team' : 'suggested',
      profileUrl,
      reason: [
        person.hiringTeam
          ? 'Shown as the hiring team on the listing.'
          : 'LinkedIn suggests reaching out on the listing.',
        person.insight,
      ]
        .filter(Boolean)
        .join(' ')
        .slice(0, 400),
      notes: [],
      message: '',
      state: 'listed',
      foundAt: db.now(),
    });
  }
  if (listed.length) putEntry(db, id, recordId, (e) => ({contacts: [...e.contacts, ...listed]}));
}

// The user's edit of a proposed note, or of the follow-up message of an invited contact.
export function editRecordContact(db, id, recordId, contactId, {message}) {
  const contact = contactOf(entryOf(db.get(id), recordId), contactId);
  if (!contact) throw Error('This contact no longer exists');
  if (!RESENDABLE.has(contact.state)) throw Error('This contact can no longer be edited');
  message = noteText(message);
  return putContacts(db, id, recordId, (c) => (c.id === contactId ? {...c, message} : null));
}

export function removeRecordContact(db, id, recordId, contactId) {
  const entry = entryOf(db.get(id), recordId),
    contact = contactOf(entry, contactId);
  if (!contact) return entry;
  if (contact.state === 'queued') throw Error('This contact is being sent');
  return putEntry(db, id, recordId, (e) => ({
    contacts: e.contacts.filter((c) => c.id !== contactId),
  }));
}

// The × on the Contacts page: the listing's whole contact entry goes, unless a
// task for it is still searching or sending. Sent invitations stay on LinkedIn.
export function removeRecordContacts(db, id, recordId) {
  const a = db.get(id),
    entry = entryOf(a, recordId);
  if (!entry) return null;
  if (entry.state === 'searching' || entry.contacts.some((c) => c.state === 'queued'))
    throw Error('A contact task for this listing is still running; remove it when it finishes');
  db.put({...a, recordContacts: a.recordContacts.filter((e) => e.recordId !== recordId)});
  return null;
}

// Approval: the chosen proposals (or invited contacts, as a follow-up message)
// go to one send task. messages carries edits made in the same step.
export async function sendRecordContacts(runtime, id, recordId, contactIds, messages = {}) {
  const {db} = runtime,
    item = db.result(id, recordId),
    entry = entryOf(db.get(id), recordId);
  assertFree(db, id, item);
  const chosen = (entry?.contacts ?? []).filter((c) => (contactIds ?? []).includes(c.id));
  if (!chosen.length) throw Error('Choose a contact to send to');
  for (const c of chosen)
    if (!RESENDABLE.has(c.state)) throw Error(`${c.name} was already handled`);
  const texts = new Map(chosen.map((c) => [c.id, noteText(messages?.[c.id] ?? c.message)]));
  const task = enqueueContactTask(db, id, item, {phase: 'send', contactIds: [...texts.keys()]});
  putEntry(db, id, recordId, (e) => ({
    taskId: task.id,
    error: null,
    contacts: e.contacts.map((c) =>
      texts.has(c.id)
        ? {
            ...c,
            message: texts.get(c.id),
            state: 'queued',
            followUp: c.state === 'invited' || c.followUp === true,
            approvedAt: db.now(),
            error: null,
          }
        : c,
    ),
  }));
  runtime.changed(id);
  await runtime.tick();
  return entryOf(db.get(id), recordId);
}

// read_contact_brief: the record, the user's notes and the rules of this phase.
export function contactBrief(db, id, run) {
  const item = db.result(id, run.recordId),
    entry = entryOf(db.get(id), item.id),
    record = {
      title: item.title,
      url: item.url,
      summary: item.summary,
      ...(item.cells && Object.keys(item.cells).length ? {cells: item.cells} : {}),
      applicationStatus: applicationStatus(item),
    };
  if (sendPhase(run))
    return {
      record,
      contacts: (entry?.contacts ?? [])
        .filter((c) => run.request.contactIds.includes(c.id))
        .map((c) => ({
          contactId: c.id,
          name: c.name,
          profileUrl: c.profileUrl,
          text: c.message,
          followUp: c.followUp === true,
          state: c.state,
        })),
      rules: [
        'Handle only these contacts and send exactly their text; do not change it.',
        'Call reserve_contact_action right before the first Connect or Message click of a contact. The app refuses Connect, Message and Send clicks without it, and a second Send click for the same contact.',
        'followUp: the user was invited earlier; send the text as a message only if the invitation was accepted (a Message button for a connection), otherwise record not_accepted_yet.',
        'Record an outcome for every contact before finishing, with the page words as evidence.',
      ],
    };
  return {
    record,
    ...(run.request?.notes ? {userNotes: run.request.notes} : {}),
    earlierContacts: (entry?.contacts ?? [])
      .filter((c) => c.state !== 'listed')
      .map((c) => ({name: c.name, profileUrl: c.profileUrl, state: c.state})),
    // People the listing shows; they may be picked like anyone found.
    listingPeople: (entry?.contacts ?? [])
      .filter((c) => c.state === 'listed')
      .map((c) => ({name: c.name, profileUrl: c.profileUrl, headline: c.headline, why: c.reason})),
    rules: [
      `Pick at most ${CONTACT_LIMIT} people who work at the company now and are close to this role, best first: the person who posted the listing, a recruiter or talent acquisition partner for this area, the hiring manager or team lead. Skip earlierContacts.`,
      'listingPeople are people the listing shows (its hiring team, or people LinkedIn suggests). Check them first; save one like anyone else when they fit.',
      'relation: poster, recruiter, hiring_manager or team. reason: one sentence on why this person, from what the listing and profile say.',
      'name and headline as the profile page shows them. Open every profile before saving it; the app refuses a profile this task did not read.',
    ],
    // Two notes in clearly different styles; the user picks one and may edit it.
    noteRules: [
      `notes: exactly two invitation notes per person, each at most ${NOTE_CHARACTERS} characters, one of each style below. Both greet the person by first name, name the role and the company, and say why the user is strong for this role: one or two strengths from the CV that match what the listing asks for most, with a concrete fact (years, technology, scale or result). Say that this is why the user is writing.`,
      'style direct: short and factual, strengths first. Example shape: "Hi Jane, the Senior Backend Engineer role at Example asks for event-driven AWS services; I have built them at scale for 8 years. That is why I wanted to reach out."',
      'style personal: warm and conversational, opens with what the team or listing is working on, puts the strength in one natural sentence and ends with a short question. Example shape: "Hi Jane, your team\'s move to event-driven payments caught my eye. I have spent 8 years building exactly that on AWS. Would you be open to a short chat about the Backend role?"',
      'The two notes must differ in opening, structure and tone, not reword the same sentences.',
      'record.applicationStatus applied: you may say you applied. Otherwise never say you applied.',
      'Write in the language of the listing unless userNotes name another. Only facts from the CV, the saved facts and the listing; no placeholders, links, emoji or signature.',
    ],
  };
}

// Whether the user already applied, so a note never claims an application that did not happen.
const applicationStatus = (item) =>
  item.status === 'completed'
    ? 'applied'
    : ['executing', 'uncertain'].includes(item.status)
      ? 'applying'
      : 'not_applied';
// Third-party wording for "I applied", in the languages notes are written in.
const APPLIED_CLAIM =
  /\b(?:I(?:'ve| have)? (?:already )?applied|I just applied|habe mich (?:bereits |schon )?beworben|ich habe mich beworben|j'ai postulé|he aplicado|başvurdum|başvuru yaptım)\b/i;

// One note, refused when it claims an application the user has not made.
function contactNote(name, text, item) {
  text = noteText(text);
  const status = applicationStatus(item);
  if (status !== 'applied' && APPLIED_CLAIM.test(text))
    throw Error(
      `The note to ${name} says the user applied, but record.applicationStatus is ${status}. Write why the user is strong for the role instead.`,
    );
  return text;
}

// The two notes of one person, one per style, in NOTE_STYLES order.
function contactNotes(name, notes, item, n) {
  if (!Array.isArray(notes) || notes.length !== NOTE_STYLES.length)
    throw Error(
      `contacts[${n}].notes needs exactly one note per style: ${NOTE_STYLES.join(', ')}.`,
    );
  const saved = NOTE_STYLES.map((style) => {
    const note = notes.find((x) => x?.style === style);
    if (!note) throw Error(`contacts[${n}].notes has no ${style} note.`);
    return {style, text: contactNote(name, note.text, item)};
  });
  if (plain(saved[0].text) === plain(saved[1].text))
    throw Error(`The two notes to ${name} are the same; write them in different styles.`);
  return saved;
}

// save_record_contacts: the proposals wait for the user's review.
export function saveRecordContacts(db, id, run, {contacts = [], noneReason = ''} = {}) {
  if (sendPhase(run)) throw Error('This task sends approved contacts; it does not save new ones');
  const entry = entryOf(db.get(id), run.recordId),
    known = new Set(
      (entry?.contacts ?? []).filter((c) => c.state !== 'listed').map((c) => c.profileUrl),
    ),
    item = db.result(id, run.recordId);
  if (!Array.isArray(contacts) || contacts.length > CONTACT_LIMIT)
    throw Error(`Save at most ${CONTACT_LIMIT} contacts.`);
  if (!contacts.length && !String(noneReason ?? '').trim())
    throw Error('Save at least one contact, or pass noneReason when nobody suitable exists.');
  const saved = contacts.map((c, n) => {
    const profileUrl = linkedInProfile(c.profileUrl),
      name = String(c.name ?? '').trim();
    if (!profileUrl)
      throw Error(
        `contacts[${n}].profileUrl must be a LinkedIn profile address (linkedin.com/in/…).`,
      );
    if (known.has(profileUrl))
      throw Error(`${name || profileUrl} is already a contact of this record.`);
    if (!name) throw Error(`contacts[${n}].name is required.`);
    const page = readProfile(db, run, profileUrl);
    if (!page)
      throw Error(
        `Open ${profileUrl} with browser_open and read it in this task before saving ${name}.`,
      );
    if (!plain(page.text).includes(plain(name)))
      throw Error(`The profile page you read does not show the name "${name}"; copy it exactly.`);
    if (!RELATIONS.includes(c.relation)) throw Error(`contacts[${n}].relation is not valid.`);
    const notes = contactNotes(name, c.notes, item, n);
    return {
      id: `${run.id}-${n + 1}`,
      name,
      headline: String(c.headline ?? '')
        .trim()
        .slice(0, 200),
      relation: c.relation,
      profileUrl,
      reason: String(c.reason ?? '')
        .trim()
        .slice(0, 400),
      notes,
      message: notes[0].text,
      state: 'proposed',
      foundAt: db.now(),
    };
  });
  if (new Set(saved.map((c) => c.profileUrl)).size !== saved.length)
    throw Error('Save each person once.');
  putEntry(db, id, run.recordId, (e) => ({
    state: 'ready',
    runId: run.id,
    searchedAt: db.now(),
    error: null,
    noneReason: saved.length ? null : String(noneReason).trim().slice(0, 400),
    // A listed person the search picked becomes its proposal.
    contacts: [
      ...e.contacts.filter(
        (c) =>
          c.state !== 'proposed' &&
          !(c.state === 'listed' && saved.some((s) => s.profileUrl === c.profileUrl)),
      ),
      ...saved,
    ],
  }));
  return {
    saved: saved.length,
    next: 'Call finish_automation_run with status completed. The user reviews the notes before anything is sent.',
  };
}

// reserve_contact_action: one connect/message and one Send click for this contact.
export function reserveContactAction(db, id, run, contactId) {
  if (!sendPhase(run)) throw Error('This task only finds contacts; it cannot connect or send');
  const contact = contactOf(entryOf(db.get(id), run.recordId), contactId);
  if (!contact || !run.request.contactIds.includes(contactId))
    throw Error('This contact is not part of this task');
  if (contact.state !== 'queued')
    throw Error(
      `${contact.name} already has an outcome (${contact.state}); go to the next contact.`,
    );
  const current = db.run(run.id);
  if (current.contactAction?.contactId === contactId && !current.contactAction.sent)
    return {reserved: true, contactId, text: contact.message};
  if (current.contactAction && !current.contactAction.recorded)
    throw Error(
      `Record the outcome for ${current.contactAction.contactId} with record_contact_outcome first.`,
    );
  const wait = db.siteAccess.reserve(SEND_BUDGET_KEY, SEND_BUDGET);
  if (wait > 0)
    throw Error(
      `The daily LinkedIn send budget (${SEND_BUDGET.requests}) is used up until ${new Date(db.now() + wait).toISOString()}. Finish blocked with blocker category site_problem; the user can send again later.`,
    );
  db.putRun({...current, contactAction: {contactId, sent: false, at: db.now()}});
  return {
    reserved: true,
    contactId,
    text: contact.message,
    next: contact.followUp
      ? 'Click Message, type the text exactly, then click Send once.'
      : 'Click Connect (or Message for an existing connection), add the note with exactly this text, then click Send once.',
  };
}

// Third-party page vocabulary for the LinkedIn controls that reach a person.
// It is matched only against the label of the clicked control.
const CONTACT_CONTROL =
  /\b(connect|vernetzen|se connecter|conectar|collegati|bağlantı kur|message|nachricht|mesaj|envoyer un message|invite|einladen)\b/i;

// The worker saw the Send click for the reserved contact: kept on the run for
// the one-click rule and on the contact, so a stopped task knows it may have gone out.
export function contactSendClicked(db, id, run) {
  const current = db.run(run.id),
    action = current.contactAction;
  db.putRun({...current, contactAction: {...action, sent: true}});
  putContacts(db, id, run.recordId, (c) =>
    c.id === action.contactId ? {...c, sendClickedAt: db.now()} : null,
  );
}

// The click gate of a contact task. Returns what the click spends, or throws.
export function contactClick(run, label, submit) {
  const contact = !submit && CONTACT_CONTROL.test(String(label ?? ''));
  if (!submit && !contact) return null;
  const name = JSON.stringify(String(label ?? '').slice(0, 80));
  if (!sendPhase(run))
    throw Error(
      `${name} would reach out to a person. This task only finds contacts; do not click it.`,
    );
  const action = run.contactAction;
  if (!action || action.recorded)
    throw Error(`Call reserve_contact_action for this contact before clicking ${name}.`);
  if (submit && action.sent)
    throw Error(
      `Send was already clicked for this contact. Do not click again; read the page and call record_contact_outcome.`,
    );
  return submit ? 'send' : 'open';
}

// record_contact_outcome: what the send task observed for one contact.
export function recordContactOutcome(db, id, run, {contactId, status, evidence}) {
  if (!sendPhase(run)) throw Error('This task only finds contacts');
  if (!CONTACT_OUTCOMES.includes(status)) throw Error('Unknown contact outcome');
  const entry = entryOf(db.get(id), run.recordId),
    contact = contactOf(entry, contactId);
  if (!contact || !run.request.contactIds.includes(contactId))
    throw Error('This contact is not part of this task');
  if (contact.state !== 'queued') throw Error(`${contact.name} already has an outcome`);
  const current = db.run(run.id),
    action = current.contactAction?.contactId === contactId ? current.contactAction : null;
  if (SENT.has(status) && !action?.sent)
    throw Error(
      `${status} needs the Send click of this task: call reserve_contact_action, click Send once, then record the outcome.`,
    );
  if (status === 'not_accepted_yet' && !contact.followUp)
    throw Error('not_accepted_yet is only for a followUp contact; use already_invited.');
  evidence = String(evidence ?? '')
    .trim()
    .slice(0, 500);
  if (!evidence) throw Error('Quote the page words that show the outcome.');
  const state =
    status === 'messaged'
      ? 'messaged'
      : status === 'failed'
        ? 'failed'
        : // An invitation without a note keeps the note for a message after acceptance.
          'invited';
  putContacts(db, id, run.recordId, (c) =>
    c.id === contactId
      ? {
          ...c,
          state,
          outcome: status,
          evidence,
          error: status === 'failed' ? evidence : null,
          ...(SENT.has(status)
            ? {
                sentAt: db.now(),
                sentAs: status,
                // What went out, for the Contacts page conversation.
                history: [
                  ...(c.history ?? []),
                  {
                    as: status,
                    text: status === 'invited_without_note' ? '' : c.message,
                    at: db.now(),
                  },
                ],
              }
            : {}),
          ...(status === 'invited_with_note' || status === 'messaged' ? {followUp: false} : {}),
        }
      : null,
  );
  if (action) db.putRun({...current, contactAction: {...action, recorded: true}});
  return {recorded: true, state};
}

// A find task completes only after saving; a send task only after every
// contact has an outcome. A stopped task hands its contacts back to the user.
export function finishContactTask(db, id, run, status, summary) {
  const entry = entryOf(db.get(id), run.recordId);
  if (!entry) return;
  const reason = String(summary ?? '').slice(0, 500);
  if (!sendPhase(run)) {
    if (status === 'completed' && entry.runId !== run.id)
      throw Error('Save the contacts with save_record_contacts before finishing.');
    if (status !== 'completed' && entry.runId !== run.id)
      putEntry(db, id, run.recordId, {state: 'failed', error: reason});
    return;
  }
  const open = entry.contacts.filter(
    (c) => c.state === 'queued' && run.request.contactIds.includes(c.id),
  );
  if (status === 'completed' && open.length)
    throw Error(
      `Record an outcome with record_contact_outcome for ${open.map((c) => c.name).join(', ')} before finishing.`,
    );
  const action = db.run(run.id).contactAction;
  const openIds = new Set(open.map((c) => c.id));
  putContacts(db, id, run.recordId, (c) =>
    openIds.has(c.id)
      ? action?.contactId === c.id && action.sent
        ? {
            ...c,
            state: 'uncertain',
            error: 'Send was clicked but no outcome was recorded. Check LinkedIn.',
          }
        : {...c, state: c.followUp ? 'invited' : 'proposed', error: reason || 'Not sent'}
      : null,
  );
}

// Contacts a stopped task or app left behind: a search or send whose task
// is no longer live goes back to the user.
export function contactsInterrupted(db, id) {
  const a = db.get(id),
    stale = (e) => e.state === 'searching' || e.contacts.some((c) => c.state === 'queued');
  if (!(a.recordContacts ?? []).some(stale)) return false;
  const live = new Set(
    db.store.workspaces.tasks
      .list(id, {states: ['pending', 'running', 'reported', 'paused'], summary: true})
      .map((t) => t.id),
  );
  if (a.recordContacts.every((e) => !stale(e) || live.has(e.taskId))) return false;
  db.put({
    ...a,
    recordContacts: a.recordContacts.map((e) =>
      !stale(e) || live.has(e.taskId)
        ? e
        : {
            ...e,
            state: e.state === 'searching' ? 'failed' : e.state,
            error: e.state === 'searching' ? 'The search stopped before saving contacts.' : e.error,
            contacts: e.contacts.map((c) =>
              c.state !== 'queued'
                ? c
                : // Only a Send click makes the outcome unclear; otherwise nothing went out.
                  c.sendClickedAt > (c.approvedAt ?? 0)
                  ? {
                      ...c,
                      state: 'uncertain',
                      error:
                        'The send task stopped after Send was clicked. Check LinkedIn before sending again.',
                    }
                  : {
                      ...c,
                      state: c.followUp ? 'invited' : 'proposed',
                      error: 'The send task stopped before sending; nothing was sent.',
                    },
            ),
          },
    ),
  });
  return true;
}
