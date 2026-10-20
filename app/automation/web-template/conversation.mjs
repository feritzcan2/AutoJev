// @ts-check
import {
  CONVERSATION_WORKER,
  isConversation,
  conversationWaiting,
} from '../../workspaces/conversation.mjs';
import {conversationContextVersion} from '../task-context.mjs';
import {
  setupAgentHistory,
  setupAgentSettings,
  setupAgentSettingsKey,
  resetSetupAgentHistory,
} from '../../agents/setup-agent.mjs';
import {
  recordTask,
  resumeRecordOperation,
  pendingRecordQuestion,
} from '../../records/operations.mjs';
import {siteKey} from '../../browser/site-access.mjs';
import {LOGGED_IN_FIELD} from '../login-question.mjs';
// WebTasks methods: the workspace conversation worker, setup and answers.
export const conversationMethods = {
  conversationWorker(id) {
    this.db.get(id);
    return CONVERSATION_WORKER;
  },
  assertConversationAvailable(id) {
    this.assertNotStopping(id);
    if (this.conversationChanges?.has(id)) throw Error('The setup agent is being updated.');
  },
  async configureConversation(id, settings, {restart = false} = {}) {
    if (settings) settings = this.db.normalizeSetupAgentSettings(settings);
    this.assertConversationAvailable(id);
    this.conversationChanges ??= new Set();
    this.conversationChanges.add(id);
    try {
      const before = setupAgentSettings(this.db, id),
        reset =
          restart || setupAgentSettingsKey(before) !== setupAgentSettingsKey(settings ?? before);
      const active = this.slots(id).find((slot) => slot.run.kind === 'interview');
      setupAgentHistory(this.db, id);
      if (reset && active)
        await this.finish(
          id,
          'interrupted',
          restart ? 'The setup agent restarted.' : 'The setup agent settings changed.',
          active.workerId,
        );
      if (settings) this.db.saveSetupAgentSettings(id, settings);
      if (reset) resetSetupAgentHistory(this.db, id);
      this.changed(id);
      if (reset && (active || restart))
        return await this.start(id, 'interview', CONVERSATION_WORKER);
      return {saved: true, restarted: false};
    } finally {
      this.conversationChanges.delete(id);
    }
  },
  async setup(id) {
    this.assertConversationAvailable(id);
    const active = this.slots(id).find((s) => s.run.kind === 'interview');
    if (active) return active.run;
    const worker = this.conversationWorker(id);
    if (
      (this.db.get(id).questions ?? []).some(
        (q) =>
          q.answer == null &&
          !q.recordId &&
          !q.sourceUrl &&
          (worker === CONVERSATION_WORKER ? q.conversation : !q.conversation),
      )
    )
      return {waitingForAnswers: true};
    return this.start(id, 'interview', worker);
  },
  // The welcome screen starts setup after a document upload. The template's
  // onboarding text is the request; the user reviews the result on a form.
  async onboard(id, {notes = ''} = {}) {
    this.assertConversationAvailable(id);
    const a = this.db.get(id),
      task = this.db.template(a.templateId).onboarding;
    if (!task) throw Error('This workspace does not support setup from a document.');
    if (typeof notes !== 'string') throw Error('Notes must be text.');
    const active = this.slots(id).find((s) => s.run.kind === 'interview');
    if (
      active &&
      (!conversationWaiting(this.db.run(active.run.id)) ||
        active.finishing ||
        active.worker?.isBusy?.())
    )
      throw Error('The setup agent is preparing its reply. Try again when the reply is complete.');
    // Notes typed with the CV are kept in the chat; reading again reuses the latest ones.
    const message = notes.trim()
      ? this.db.message(id, 'user', notes.trim(), {conversation: true, onboardingNotes: true})
      : this.db.messages(id).findLast((m) => m.onboardingNotes);
    if (!active)
      return this.start(
        id,
        {kind: 'interview', onboarding: true, ...(message ? {messageId: message.id} : {})},
        this.conversationWorker(id),
      );
    return this.sendConversation(
      id,
      active,
      'Current user request (JSON):\n' +
        JSON.stringify({task, ...(message ? {userNotes: message.text} : {})}),
      {messageId: message?.id ?? null, inputQuestionIds: [], onboarding: true},
    );
  },
  async answer(id, questionId, value) {
    const answer = await this.answerOne(id, questionId, value);
    // One sign-in serves every task waiting on the same site in this
    // workspace; each resumed task still checks its live page.
    const loginSite = (q) =>
      q.accessCheck?.kind === 'login' &&
      q.accessCheck.url &&
      q.fields?.length === 1 &&
      q.fields[0].id === LOGGED_IN_FIELD.id
        ? siteKey(q.accessCheck.url)
        : null;
    const site = answer.answerValues?.[LOGGED_IN_FIELD.id] === true ? loginSite(answer) : null;
    if (site)
      for (const q of this.db.get(id).questions ?? [])
        if (q.answer == null && loginSite(q) === site)
          await this.answerOne(id, q.id, {[LOGGED_IN_FIELD.id]: true}).catch((error) =>
            this.db.message(
              id,
              'system',
              'The sign-in answer could not be passed on: ' + error.message,
            ),
          );
    return answer;
  },
  async answerOne(id, questionId, value) {
    this.assertConversationAvailable(id);
    const answer = this.db.answerQuestion(id, questionId, value);
    this.changed(id);
    if (answer.conversation) {
      if (!(this.db.get(id).questions ?? []).some((q) => q.conversation && q.answer == null)) {
        const active = this.slots(id).find((s) => isConversation(s.run));
        if (active?.run.interactive)
          await this.sendConversation(
            id,
            active,
            'Answer to the saved question: ' +
              JSON.stringify({
                question: answer.text,
                answer: answer.answer,
                ...(answer.instruction ? {instruction: true} : {}),
                values: answer.answerValues,
                ...(answer.documents ? {documents: answer.documents} : {}),
              }),
            {messageId: null, inputQuestionIds: [questionId]},
          );
        else {
          if (active)
            await this.finish(
              id,
              'interrupted',
              'The conversation continues with the answer.',
              active.workerId,
            );
          await this.start(
            id,
            {kind: 'interview', inputQuestionIds: [questionId]},
            CONVERSATION_WORKER,
          );
        }
      }
      return answer;
    }
    if (answer.recordId) {
      // The outcome answer already resolved the record; the user picks the next step.
      // A record confirmed as submitted needs no page any more, as after Mark applied.
      if (answer.outcome) {
        if (this.db.result(id, answer.recordId).status === 'completed')
          await this.closeRecordTabs(id, answer.recordId);
        return answer;
      }
      if (!pendingRecordQuestion(this.db.get(id), this.db.result(id, answer.recordId))) {
        try {
          const active = recordTask(this.db, id, answer.recordId);
          if (active && active.state !== 'pending') {
            this.queue.put({...active, resumeRecordAfterAnswer: true});
            return answer;
          }
          const item = this.db.result(id, answer.recordId);
          const origin = answer.taskId ? this.queue.get(id, answer.taskId) : null;
          resumeRecordOperation(this, id, item, origin);
          await this.tick();
        } catch (error) {
          this.db.message(id, 'system', 'Answer saved. Record action: ' + error.message);
        }
      }
      return answer;
    }
    if (answer.sourceUrl) {
      const a = this.db.get(id);
      const recovery = a.sourceState?.[answer.sourceUrl]?.accessRecovery;
      if (recovery?.state === 'waiting' && recovery.runId === answer.runId) {
        await this.sourceAccess.resume(id, answer.sourceUrl, recovery.runId, answer.answer);
        return answer;
      }
      if (
        !(a.questions ?? []).some(
          (q) =>
            !q.conversation &&
            q.answer == null &&
            !q.recordId &&
            (!q.sourceUrl || q.sourceUrl === answer.sourceUrl),
        ) &&
        answer.taskId
      ) {
        const task = this.queue.get(id, answer.taskId);
        this.queue.put({...task, resumeSourceAfterAnswer: true});
        await this.tick();
      }
      return answer;
    }
    if (
      (this.db.get(id).questions ?? []).some(
        (q) => !q.conversation && !q.recordId && !q.sourceUrl && q.answer == null,
      )
    )
      return answer;
    try {
      const interview = this.slots(id).find((s) => s.run.kind === 'interview');
      if (interview)
        await this.finish(
          id,
          'interrupted',
          'Setup continues with the answer.',
          interview.workerId,
        );
      await this.setup(id);
    } catch (error) {
      this.db.message(
        id,
        'system',
        'Your answer was saved. The agent could not continue: ' + error.message,
      );
      this.changed(id);
    }
    return answer;
  },
  async message(id, text) {
    this.assertConversationAvailable(id);
    const active = this.slots(id).find((s) => s.run.kind === 'interview');
    if (active) {
      if (
        !conversationWaiting(this.db.run(active.run.id)) ||
        active.finishing ||
        active.worker?.isBusy?.()
      )
        throw Error(
          'The chat agent is preparing its reply. You can send a new message when the reply is complete.',
        );
      const message = this.db.message(id, 'user', text, {conversation: true, runId: active.run.id});
      this.changed(id);
      return this.sendConversation(id, active, message.text, {
        messageId: message.id,
        inputQuestionIds: [],
      });
    }
    const worker = this.conversationWorker(id),
      message = this.db.message(id, 'user', text, {conversation: true});
    this.changed(id);
    return this.start(id, {kind: 'interview', messageId: message.id}, worker);
  },
  async sendConversation(id, slot, text, input = {}) {
    if (slot.finishing || this.closed) throw Error('The conversation is closing.');
    const before = this.db.run(slot.run.id),
      changed = before.contextVersion !== conversationContextVersion(this.db.get(id));
    slot.seenWorking = false;
    slot.run = this.db.putRun({
      ...before,
      // A later message or answer is the new request, not the welcome-screen task.
      onboarding: undefined,
      undelivered: undefined,
      ...input,
      awaitingMessage: false,
      lastMessageAt: this.now(),
    });
    this.changed(id);
    try {
      const worker = slot.worker ?? (await slot.ready);
      await worker.message(
        changed
          ? 'Workspace profile or permissions changed. Read get_automation_context once before acting.\n\n' +
              text
          : text,
      );
      this.watchDelivery(slot);
      return this.db.run(slot.run.id);
    } catch (error) {
      if (!slot.finishing) {
        slot.run = this.db.putRun({...this.db.run(slot.run.id), awaitingMessage: true});
        this.changed(id);
      }
      throw error;
    }
  },
};
