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
// WebTasks methods: the workspace conversation worker, setup and answers.
export const conversationMethods = {
  conversationWorker(id) {
    this.db.get(id);
    return CONVERSATION_WORKER;
  },
  assertConversationAvailable(id) {
    this.assertNotStopping(id);
    if (this.conversationChanges?.has(id)) throw Error('Kurulum agenti güncelleniyor.');
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
          restart ? 'Kurulum agenti yeniden başlatıldı.' : 'Kurulum agenti ayarları değişti.',
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
  async answer(id, questionId, value) {
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
            'Kayıtlı sorunun yanıtı: ' +
              JSON.stringify({
                question: answer.text,
                answer: answer.answer,
                values: answer.answerValues,
                ...(answer.documents ? {documents: answer.documents} : {}),
              }),
            {messageId: null, inputQuestionIds: [questionId]},
          );
        else {
          if (active)
            await this.finish(id, 'interrupted', 'Sohbet yanıtla devam ediyor.', active.workerId);
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
      if (answer.outcome) return answer;
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
          this.db.message(id, 'system', 'Yanıt kaydedildi. Kayıt işlemi: ' + error.message);
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
        await this.finish(id, 'interrupted', 'Kurulum yanıtla devam ediyor.', interview.workerId);
      await this.setup(id);
    } catch (error) {
      this.db.message(id, 'system', 'Yanıtın kaydedildi. Agent devam edemedi: ' + error.message);
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
          'Sohbet agent’ı yanıtını hazırlıyor. Yanıt tamamlanınca yeni mesaj gönderebilirsin.',
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
    if (slot.finishing || this.closed) throw Error('Sohbet kapanıyor.');
    const before = this.db.run(slot.run.id),
      changed = before.contextVersion !== conversationContextVersion(this.db.get(id));
    slot.seenWorking = false;
    slot.run = this.db.putRun({
      ...before,
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
