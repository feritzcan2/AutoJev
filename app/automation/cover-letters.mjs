// @ts-check
// Cover letters. An application task that meets a required cover letter does
// not write one: it asks for it and finishes blocked. A separate cover_letter
// task, on the stronger model, writes the letter from the CV and the listing
// and saves it as a PDF. The letter waits for the user's review on the Files
// page; approving it answers the record's question, which resumes the
// application in its own conversation and tab.
import path from 'node:path';
import {mkdir, realpath, writeFile} from 'node:fs/promises';
import {recordSource, recordTask} from '../records/operations.mjs';

export const COVER_LETTER_DIRECTORY = 'documents/cover-letters';
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

function coverLetterQuestion(db, id, questionId) {
  const question = (db.get(id).questions ?? []).find((q) => q.id === questionId);
  if (!question?.coverLetter) throw Error('This cover letter does not belong to this workspace');
  if (question.answer != null) throw Error('This cover letter was already approved');
  return question;
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
      text: `${item.title ?? item.url}: the application needs a cover letter. A cover letter agent writes it; review and approve it on the Files page to continue the application.`,
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
  return {
    saved: true,
    path: relative,
    next: 'Call finish_automation_run with status completed. The user reviews the letter on the Files page.',
  };
}

// A writer may only report completed after saving its letter; a blocked or
// failed writer leaves the letter for the user to retry.
export function finishCoverLetter(db, id, run, status, summary) {
  const question = coverLetterQuestion(db, id, run.request?.questionId);
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
  return runtime.answer(
    id,
    questionId,
    `The user approved the cover letter ${question.coverLetter.path}. Upload this file to the cover letter field with browser_upload_document. If the field is a text box, type this letter text instead:\n\n${letter}`,
  );
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
