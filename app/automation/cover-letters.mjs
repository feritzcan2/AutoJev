// @ts-check
// Cover letters. An application task that meets a cover letter field, required
// or optional, does not write one: it asks for it and finishes blocked, or,
// when letters are accepted automatically and another worker can write it,
// keeps its tab and waits for the letter. A separate cover_letter
// task, on the stronger model, writes the letter from the CV and the listing
// and saves it as a PDF. The letter waits for the user's review on the Files
// page; approving it answers the record's question, which resumes the
// application in its own conversation and tab.
import path from 'node:path';
import {mkdir, realpath, writeFile} from 'node:fs/promises';
import {setTimeout as pause} from 'node:timers/promises';
import {recordSource, recordTask, pendingRecordQuestion} from '../records/operations.mjs';
import {AGENT_DIRECTORY} from './artifacts.mjs';

export const COVER_LETTER_DIRECTORY = AGENT_DIRECTORY + '/cover-letters';
// Short numbered steps; the writer does not apply or touch the form.
export const COVER_LETTER_PROMPT =
  'Read AGENTS.md. This is a cover letter task for one record: you write the letter, you do not apply. Steps: 1. Call read_cover_letter_brief. 2. Read the CV and saved facts with read_scoring_profile (source documents, then facts); follow nextOffset until null. 3. If the brief has no listing text, open record.url with browser_open and read the description with browser_read. 4. Write the letter following the brief rules. 5. Call save_cover_letter with the full text; if it is refused, fix the reason and save again. 6. Call finish_automation_run with status completed. If the CV or the listing cannot be read, finish blocked with the reason instead of writing a letter.';
const MIN_CHARACTERS = 400,
  MAX_CHARACTERS = 5000,
  LISTING_CHARACTERS = 12000;
// The listing text the application task had read, kept for the writer. Page
// text stays in RAM; after a restart the writer reads the listing again.
const listingTexts = new Map();

export const openCoverLetter = (a, recordId) =>
  (a.questions ?? []).find((q) => q.coverLetter && q.recordId === recordId && q.answer == null);
const approvedCoverLetter = (a, recordId) =>
  (a.questions ?? []).findLast(
    (q) => q.coverLetter?.state === 'approved' && q.recordId === recordId,
  )?.coverLetter;

// Third-party page vocabulary for a cover letter control. It is matched only
// against the labels of the form's own fields and uploads, never page text.
const COVER_LETTER_LABEL =
  /cover(?:ing)?\s*letter|motivation(?:al)?\s*letter|letter\s+of\s+motivation|anschreiben|motivationsschreiben|bewerbungsschreiben|lettre\s+de\s+motivation|carta\s+de\s+presentaci[oó]n|lettera\s+di\s+presentazione|sollicitatiebrief|motivatiebrief|list\s+motywacyjny|ön\s*yazı|personligt\s+brev|følgebrev/i;

// The cover letter controls of a browser_inspect_form result. A file field
// and its upload entry are the same control; the field carries `filled`.
export function coverLetterFields(form) {
  const label = (c) => [c.question, c.label].filter(Boolean).join(' '),
    uploads = (form?.uploads ?? []).filter((u) => COVER_LETTER_LABEL.test(u.label ?? '')),
    fields = (form?.fields ?? [])
      .filter((f) => COVER_LETTER_LABEL.test(label(f)))
      .map((f) => ({label: f.question || f.label, type: f.type, filled: f.filled === true}));
  const files = fields.filter((f) => f.type === 'file');
  if (!files.length)
    return [
      ...fields,
      ...uploads.map((u) => ({label: u.label, type: 'file', filled: false, uploadId: u.uploadId})),
    ];
  // A file field and its upload entry are the same control, in page order;
  // the upload id lets a later upload of the approved letter fill the field.
  return fields.map((f) =>
    f.type === 'file' && uploads[files.indexOf(f)]
      ? {...f, uploadId: uploads[files.indexOf(f)].uploadId}
      : f,
  );
}

// Merges a new inspection into the fields kept across the form's steps, per
// label. An upload entry never shows which file it holds, so a field the app
// saw receive the approved letter stays filled.
export function mergeCoverLetterFields(previous, current) {
  const kept = (previous ?? []).filter((f) => !current.some((c) => c.label === f.label));
  return [
    ...kept,
    ...current.map((c) =>
      c.type === 'file' && previous?.some((f) => f.label === c.label && f.uploaded)
        ? {...c, filled: true, uploaded: true}
        : c,
    ),
  ];
}

// After a successful browser_upload_document: the upload entry it targeted is
// filled when the file is this record's approved cover letter.
export function coverLetterUploaded(a, recordId, fields, uploadId, relative) {
  const approved = approvedCoverLetter(a, recordId);
  if (!approved || path.normalize(relative) !== path.normalize(approved.path)) return null;
  if (!(fields ?? []).some((f) => f.uploadId === uploadId)) return null;
  return fields.map((f) => (f.uploadId === uploadId ? {...f, filled: true, uploaded: true} : f));
}

// What the application agent must do with the cover letter fields it saw on
// this run's form pages; null once every one is filled. `wait` is set when
// this run waits for an automatically accepted letter.
export function coverLetterStep(a, recordId, fields, {wait = false} = {}) {
  const empty = (fields ?? []).filter((f) => !f.filled);
  if (!empty.length) return null;
  const names = empty.map((f) => `"${f.label}"`).join(', '),
    approved = approvedCoverLetter(a, recordId);
  if (approved)
    return `Fill the cover letter field ${names} with the approved cover letter ${approved.path}: upload that file to a file field, or type its text (in your saved answers) into a text box. Then call browser_inspect_form again before submitting.`;
  if (openCoverLetter(a, recordId) && wait)
    return `The cover letter for ${names} is being written. Call wait_for_cover_letter; it returns the letter when it is saved.`;
  if (openCoverLetter(a, recordId))
    return `The cover letter for ${names} is waiting for the user's approval. Finish blocked with blocker category needs_answer; the approval resumes this application.`;
  return `This form has a cover letter field ${names}. Every cover letter field gets a letter written for this employer, also an optional one: never skip it, never write one yourself and never put the CV there. Fill the other fields, call request_cover_letter and do what its result says next. The app refuses the submit while the field is empty.`;
}

function coverLetterQuestion(db, id, questionId, {answered = false} = {}) {
  const question = (db.get(id).questions ?? []).find((q) => q.id === questionId);
  if (!question?.coverLetter) throw Error('This cover letter does not belong to this workspace');
  if (question.answer != null && !answered) throw Error('This cover letter was already approved');
  return question;
}

// The answer that resumes the application: the file to upload and its text.
const approvalAnswer = (path, letter, automatic = false) =>
  `${automatic ? 'The cover letter was accepted automatically (workspace setting)' : 'The user approved the cover letter'}: ${path}. Upload this file to the cover letter field with browser_upload_document. If the field is a text box, type this letter text instead:\n\n${letter}`;

// Workspace setting: a saved letter is approved at once and the application
// continues without waiting for the user's review.
export function setCoverLetterAutoApprove(db, id, value) {
  if (typeof value !== 'boolean') throw Error('Choose on or off');
  return db.put({...db.get(id), coverLetterAutoApprove: value});
}

function updateCoverLetter(db, id, questionId, patch) {
  const a = db.get(id);
  db.put({
    ...a,
    questions: a.questions.map((q) =>
      q.id === questionId ? {...q, coverLetter: {...q.coverLetter, ...patch}} : q,
    ),
  });
}

function enqueueWriter(db, id, item, questionId, {notes = null, feedback = null} = {}) {
  const queue = db.store.workspaces.tasks,
    a = db.get(id);
  const task = queue.enqueue(id, {
    recordOperation: 'cover_letter',
    operation: 'record-cover-letter',
    capability: 'browser.observe',
    recordId: item.id,
    subject: item.id,
    sourceUrl: recordSource(a, item),
    sources: [item.url],
    lockKey: 'cover-letter:' + item.id,
    request: {
      manual: true,
      revision: a.revision,
      questionId,
      ...(notes ? {notes} : {}),
      ...(feedback ? {feedback} : {}),
      at: db.now(),
    },
    recordVersion: item.digest ?? String(item.updatedAt),
  });
  updateCoverLetter(db, id, questionId, {state: 'writing', taskId: task.id, error: null});
  db.event(id, 'record_operation_queued', {itemId: item.id, kind: 'cover_letter', taskId: task.id});
  return task;
}

// request_cover_letter: the record's question blocks the application until the
// user approves the letter; the writer task starts once a worker is free.
export function requestCoverLetter(db, id, run, {notes = '', listing = null} = {}) {
  const item = db.result(id, run.recordId),
    existing = openCoverLetter(db.get(id), item.id);
  if (existing) return existing;
  notes = String(notes ?? '')
    .trim()
    .slice(0, 1000);
  const question = db.askQuestion(
    id,
    {
      text: `${item.title ?? item.url}: the application needs a cover letter. A cover letter agent writes it; ${db.get(id).coverLetterAutoApprove ? 'the application continues as soon as it is saved (accepted automatically).' : 'review and approve it on the Files page to continue the application.'}`,
      recordId: item.id,
      coverLetter: {state: 'writing'},
    },
    {runId: run.id},
  );
  if (listing?.text?.trim()) {
    listingTexts.set(question.id, {url: listing.url, text: listing.text});
    while (listingTexts.size > 50) listingTexts.delete(listingTexts.keys().next().value);
  }
  enqueueWriter(db, id, item, question.id, {notes});
  return question;
}

// With automatic acceptance on and another enabled worker to write the
// letter, the application keeps its tab and conversation and waits for it.
export const coverLetterWaits = (a, workers, workerId) =>
  a.coverLetterAutoApprove === true &&
  workers.some((w) => w.id !== workerId && w.enabled !== false);

const finishBlocked = (reason) =>
  `${reason} Keep the tab and call finish_automation_run with status blocked and blocker category needs_answer.`;

// wait_for_cover_letter: one call waits at most waitMs; the whole wait ends
// after limitMs and the application finishes blocked, so a letter saved later
// resumes it the usual way.
export async function waitForCoverLetter(
  db,
  id,
  run,
  {signal = undefined, waitMs = 45000, limitMs = 10 * 60000, pollMs = 2000} = {},
) {
  const wait = run.coverLetterWait;
  if (!wait)
    throw Error(
      'No cover letter is being written for this application; call request_cover_letter first.',
    );
  for (let waited = 0; ; waited += pollMs) {
    const a = db.get(id),
      question = (a.questions ?? []).find((q) => q.id === wait.questionId);
    if (!question?.coverLetter) throw Error('The cover letter request no longer exists');
    const letter = question.coverLetter;
    if (letter.state === 'approved' && question.answer != null)
      return {
        ready: true,
        path: letter.path,
        letter: question.answer,
        next: 'Fill the cover letter field with this letter, call browser_inspect_form again, then continue the application.',
      };
    if (question.answer != null)
      return {
        ready: false,
        next: finishBlocked(`The cover letter request was closed: ${question.answer}`),
      };
    if (letter.state === 'failed')
      return {
        ready: false,
        next: finishBlocked(
          'The cover letter agent could not write the letter; the user retries it on the Files page.',
        ),
      };
    if (letter.state === 'review' || !a.coverLetterAutoApprove)
      return {
        ready: false,
        next: finishBlocked(
          "The letter waits for the user's review; the approval resumes this application.",
        ),
      };
    if (db.now() - wait.since >= limitMs)
      return {
        ready: false,
        next: finishBlocked(
          'The letter is not written yet; the saved letter resumes this application.',
        ),
      };
    if (waited >= waitMs)
      return {
        ready: false,
        next: 'The cover letter agent is still writing. Call wait_for_cover_letter again.',
      };
    await pause(pollMs, undefined, {signal});
  }
}

// read_cover_letter_brief: everything the writer needs besides the CV, which it
// reads with read_scoring_profile.
export function coverLetterBrief(db, id, run) {
  const question = coverLetterQuestion(db, id, run.request?.questionId),
    item = db.result(id, run.recordId),
    listing = listingTexts.get(question.id);
  return {
    record: {
      title: item.title,
      url: item.url,
      summary: item.summary,
      ...(item.cells && Object.keys(item.cells).length ? {cells: item.cells} : {}),
    },
    listing: listing
      ? {url: listing.url, text: listing.text.slice(0, LISTING_CHARACTERS)}
      : {
          text: null,
          instructions:
            'The listing text is not available. Open record.url with browser_open and read the description with browser_read before writing.',
        },
    ...(run.request?.notes ? {applicationNotes: run.request.notes} : {}),
    ...(run.request?.feedback
      ? {
          userFeedback: run.request.feedback,
          previousLetter: question.coverLetter.text ?? null,
          feedbackRule: 'Rewrite previousLetter and apply every change in userFeedback.',
        }
      : {}),
    rules: [
      'Read the CV and saved facts with read_scoring_profile (source documents, then facts); follow nextOffset.',
      'Write in the language of the listing unless applicationNotes or userFeedback name another language.',
      'Use only facts from the CV, the saved facts and the listing. Never invent experience, numbers, skills, degrees or facts about the employer.',
      'Link two or three concrete achievements from the CV to the main requirements of the listing.',
      'Second paragraph: why this company, from what the listing says about its product, mission or technology.',
      'Look forward: say which of their tasks you will take on and how; past work is the evidence, not a CV summary.',
      "Every claim must survive an interview: never stretch adjacent work into the listing's exact terms.",
      'Confident, plain tone. Never mention gaps, missing skills or weak language levels; never apologise or hedge ("I think I could").',
      'No clichés ("passionate about", "great fit", "leverage", "hit the ground running", "drive results") and no em dashes.',
      'Address the company named in the listing; without a named contact use a general greeting. Sign with the applicant name from the CV.',
      `Plain text only: 250-400 words in 3-5 paragraphs separated by blank lines, at most ${MAX_CHARACTERS} characters. No markdown, no placeholders such as [Company].`,
    ],
  };
}

const fileStem = (item) => {
  const name = String(item.cells?.company || item.title || 'listing')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .slice(0, 60);
  return `Cover-Letter-${name || 'listing'}-${item.id.slice(0, 8)}`;
};

function letterText(text) {
  text = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (text.length < MIN_CHARACTERS)
    throw Error(`The cover letter is too short; write at least ${MIN_CHARACTERS} characters.`);
  if (text.length > MAX_CHARACTERS)
    throw Error(`The cover letter is too long; keep it under ${MAX_CHARACTERS} characters.`);
  const placeholder = /\[[^\]\n]{2,40}\]/.exec(text);
  if (placeholder)
    throw Error(`Replace the placeholder ${placeholder[0]} with the real value or remove it.`);
  return text;
}

async function writeLetter(workspace, relative, text, renderPdf) {
  const base = await realpath(workspace),
    directory = path.join(base, COVER_LETTER_DIRECTORY);
  await mkdir(directory, {recursive: true, mode: 0o700});
  await writeFile(path.join(base, relative), await renderPdf(text), {mode: 0o600});
}

// save_cover_letter: the writer's letter becomes a PDF in the workspace and
// waits for the user's review.
export async function saveCoverLetter(db, id, run, text, {workspace, renderPdf}) {
  const question = coverLetterQuestion(db, id, run.request?.questionId),
    item = db.result(id, run.recordId);
  text = letterText(text);
  const relative = question.coverLetter.path ?? `${COVER_LETTER_DIRECTORY}/${fileStem(item)}.pdf`;
  await writeLetter(workspace, relative, text, renderPdf);
  updateCoverLetter(db, id, question.id, {
    state: 'review',
    path: relative,
    text,
    runId: run.id,
    writtenAt: db.now(),
    error: null,
  });
  if (!db.get(id).coverLetterAutoApprove)
    return {
      saved: true,
      path: relative,
      next: 'Call finish_automation_run with status completed. The user reviews the letter on the Files page.',
    };
  // Accepted at once: the answer resumes the application once this writer
  // task finishes, the same way a user's answer does while a task is live.
  db.store.workspaces.tasks.atomic(() => {
    updateCoverLetter(db, id, question.id, {
      state: 'approved',
      autoApproved: true,
      approvedAt: db.now(),
    });
    db.answerQuestion(id, question.id, approvalAnswer(relative, text, true));
    if (!pendingRecordQuestion(db.get(id), db.result(id, item.id))) {
      const queue = db.store.workspaces.tasks;
      queue.put({...queue.get(id, run.taskId), resumeRecordAfterAnswer: true});
    }
  });
  return {
    saved: true,
    path: relative,
    next: 'Call finish_automation_run with status completed. The letter was accepted automatically and the application continues.',
  };
}

// A writer may only report completed after saving its letter; a blocked or
// failed writer leaves the letter for the user to retry.
export function finishCoverLetter(db, id, run, status, summary) {
  const question = coverLetterQuestion(db, id, run.request?.questionId, {answered: true});
  if (status === 'completed') {
    if (question.coverLetter.runId !== run.id)
      throw Error('Save the cover letter with save_cover_letter before finishing.');
    return;
  }
  if (question.coverLetter.runId !== run.id)
    updateCoverLetter(db, id, question.id, {
      state: 'failed',
      error: String(summary ?? '').slice(0, 500),
    });
}

// Approving answers the question: the application resumes with the file and
// its text. An edited text replaces the saved letter first.
export async function approveCoverLetter(
  runtime,
  id,
  questionId,
  {text = undefined, workspace, renderPdf},
) {
  const {db} = runtime,
    question = coverLetterQuestion(db, id, questionId);
  if (question.coverLetter.state !== 'review' || !question.coverLetter.path)
    throw Error('The cover letter is not ready for review');
  let letter = question.coverLetter.text;
  if (text !== undefined && String(text).replace(/\r\n?/g, '\n').trim() !== letter) {
    letter = letterText(text);
    await writeLetter(workspace, question.coverLetter.path, letter, renderPdf);
  }
  updateCoverLetter(db, id, questionId, {
    state: 'approved',
    text: letter,
    approvedAt: db.now(),
  });
  return runtime.answer(id, questionId, approvalAnswer(question.coverLetter.path, letter));
}

// The user's notes go to a new writer task; the application stays blocked.
export async function reviseCoverLetter(runtime, id, questionId, feedback) {
  const {db} = runtime,
    question = coverLetterQuestion(db, id, questionId),
    task = recordTask(db, id, question.recordId);
  if (task?.recordOperation === 'cover_letter')
    throw Error('The cover letter is still being written');
  if (task) throw Error('Another task for this record is running; try again when it finishes');
  feedback = String(feedback ?? '')
    .trim()
    .slice(0, 2000);
  if (question.coverLetter.state === 'review' && !feedback)
    throw Error('Write what should change in the cover letter');
  const item = db.result(id, question.recordId);
  enqueueWriter(db, id, item, questionId, {feedback: feedback || null});
  runtime.changed(id);
  await runtime.tick();
}
