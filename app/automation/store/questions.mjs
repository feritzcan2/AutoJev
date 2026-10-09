// @ts-check
import {isConversation} from '../../workspaces/conversation.mjs';
import {normalizeFields, validateAnswers, OUTCOME_FIELD} from '../question-forms.mjs';
import {randomUUID} from 'node:crypto';
import {boundedText} from '../../templates/catalog.mjs';
import {json} from './rows.mjs';
// AutomationStore methods: questions to the user and how answers resume tasks.
export const questionMethods = {
  questionScope(id, question) {
    if (question.recordId || Object.hasOwn(question, 'sourceUrl')) return question;
    // Recover the scope of older questions from their durable task, never from
    // the currently assigned worker or a guessed URL host.
    const task = question.taskId
      ? json(
          this.db
            .prepare('SELECT data FROM workspace_tasks WHERE workspace_id=? AND id=?')
            .get(id, question.taskId),
        )
      : null;
    return {...question, sourceUrl: task && !task.recordId ? (task.sourceUrl ?? null) : null};
  },
  askQuestion(
    id,
    {text, recordId = null, fields = null, accessCheck = null, outcome = false},
    {runId = undefined} = {},
  ) {
    text = boundedText(text, 'Soru', 6000);
    fields = normalizeFields(fields);
    if (recordId && this.result(id, recordId).status === 'dismissed')
      throw Error('Elenen kayıt için soru sorulamaz');
    const run = runId ? this.activeRun(id, runId) : null,
      sourceUrl =
        !recordId && ['run', 'trial'].includes(run?.kind) ? (run.sourceUrl ?? null) : null;
    const a = this.get(id),
      previous = (a.questions ?? []).find(
        (q) =>
          Boolean(q.conversation) === isConversation(run) &&
          q.answer == null &&
          q.text === text &&
          q.recordId === recordId &&
          (q.sourceUrl ?? null) === sourceUrl &&
          JSON.stringify(q.fields ?? null) === JSON.stringify(fields),
      );
    if (previous) return previous;
    const question = {
      id: randomUUID(),
      text,
      recordId,
      sourceUrl,
      fields,
      ...(isConversation(run) ? {conversation: true} : {}),
      ...(accessCheck ? {accessCheck} : {}),
      ...(outcome ? {outcome: true} : {}),
      answer: null,
      createdAt: this.now(),
      ...(run ? {runId: run.id} : {}),
      ...(run?.taskId ? {taskId: run.taskId} : {}),
      ...(run?.resumeContext
        ? {
            browserContext: {
              ...run.resumeContext,
              runId: run.id,
              workerId: run.workerId,
              sourceUrl: run.sourceUrl,
            },
          }
        : {}),
    };
    this.store.workspaces.tasks.atomic(() => {
      this.put({...a, questions: [...(a.questions ?? []), question]});
      this.event(id, 'question_asked', {id: question.id});
    });
    return question;
  },
  answerQuestion(id, questionId, value) {
    const a = this.get(id),
      question = (a.questions ?? []).find((q) => q.id === questionId);
    if (!question) throw Error('Soru bu çalışma alanına ait değil');
    if (question.answer !== null) throw Error('Bu soru zaten yanıtlandı');
    const result =
        question.fields && typeof value !== 'string'
          ? validateAnswers(question.fields, value)
          : {summary: boundedText(value, 'Yanıt', 10000), values: null},
      answer = result.summary;
    // Documents attached while the question was open belong to this answer.
    const documents = this.messages(id)
      .filter((m) => m.document && m.at >= question.createdAt)
      .map((m) => m.document);
    const updated = {
      ...question,
      answer,
      answerValues: result.values,
      ...(documents.length ? {documents} : {}),
      answeredAt: this.now(),
    };
    const runId = question.runId ?? question.browserContext?.runId,
      origin = runId
        ? json(
            this.db
              .prepare('SELECT data FROM automation_runs WHERE automation_id=? AND id=?')
              .get(id, runId),
          )
        : null;
    const conversation =
      !question.recordId &&
      !question.sourceUrl &&
      !question.browserContext?.sourceUrl &&
      (question.conversation === true || origin?.kind === 'interview');
    // The user's answer to the app's outcome question resolves the held
    // record: submitted completes it, not submitted makes it sendable again.
    let resolved = null;
    if (question.outcome && question.recordId) {
      const item = this.result(id, question.recordId),
        choice = result.values?.[OUTCOME_FIELD.id],
        at = this.now();
      if (item.status === 'uncertain' && choice === OUTCOME_FIELD.options[0])
        resolved = {
          ...item,
          status: 'completed',
          evidence: 'Kullanıcı kaydın gönderildiğini onayladı.',
          verifiedAt: at,
          updatedAt: at,
        };
      if (item.status === 'uncertain' && choice === OUTCOME_FIELD.options[1])
        resolved = {
          ...item,
          status: item.proposal ? 'prepared' : 'found',
          approvedDigest: null,
          requiresReview: true,
          evidence: 'Kullanıcı kaydın gönderilmediğini bildirdi; yeniden gönderilebilir.',
          verifiedAt: at,
          updatedAt: at,
          notSubmitted: {kind: 'user', at, digest: item.digest, attemptRunId: item.attemptRunId},
        };
    }
    this.store.workspaces.tasks.atomic(() => {
      this.put({...a, questions: a.questions.map((q) => (q.id === questionId ? updated : q))});
      if (resolved) this.putResult(resolved);
      this.message(id, 'user', question.text + '\nYanıt: ' + answer, {
        questionId,
        conversation,
        ...(runId ? {runId} : {}),
      });
      this.event(id, 'question_answered', {id: questionId});
    });
    return updated;
  },
  questionContext(id, question) {
    if (question.answer == null && question.recordId)
      question = {
        ...question,
        canDismissRecord: ['found', 'prepared'].includes(this.result(id, question.recordId).status),
      };
    if (question.answer != null || question.browserContext) return question;
    // Older questions predate saved tab context. Match their owning run even
    // after it leaves the short recent-history list; never guess across workers.
    const matches = this.db
      .prepare(
        `SELECT data FROM automation_runs WHERE automation_id=?
   AND json_extract(data,'$.recordId') IS ? AND json_extract(data,'$.startedAt')<=?
   AND (json_extract(data,'$.finishedAt') IS NULL OR json_extract(data,'$.finishedAt')>=?) LIMIT 2`,
      )
      .all(id, question.recordId ?? null, question.createdAt, question.createdAt)
      .map(json);
    if (matches.length !== 1 || !matches[0].resumeContext) return question;
    const run = matches[0];
    return {
      ...question,
      browserContext: {
        ...run.resumeContext,
        runId: run.id,
        workerId: run.workerId,
        sourceUrl: run.sourceUrl,
      },
    };
  },
};
