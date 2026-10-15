import {setTimeout as delay} from 'node:timers/promises';
import {TelegramStore, applicationCompleted, matchesTelegramScore} from './telegram-store.mjs';
import {TelegramConversation, clip} from './telegram-conversation.mjs';

const errors = {
  400: 'Telegram rejected the request.',
  401: 'The bot token is invalid. Update it in Configuration.',
  403: 'The candidate may have blocked the bot. Open the bot in Telegram and try again.',
  409: 'This bot is used by another app or a webhook.',
  429: 'Telegram sending limit reached; will retry.',
};
const deletable = (data) =>
  ['new_job', 'submission', 'question'].includes(data.kind) ||
  (data.kind === 'message' && Boolean(data.questionId) && !data.promptId);
const jobCard = (data) => ['new_job', 'submission'].includes(data.kind);
const html = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
const withDeleteButton = (row, body, dismissRecord) =>
  deletable(row.data) && body.reply_markup?.inline_keyboard
    ? {
        ...body,
        reply_markup: {
          inline_keyboard: [
            ...body.reply_markup.inline_keyboard,
            [
              {
                text: dismissRecord
                  ? '🗑 Delete · Dismiss record'
                  : jobCard(row.data)
                    ? '🗑 Delete message'
                    : '🗑 Delete',
                style: 'danger',
                callback_data: `d:${row.id}`,
              },
            ],
          ],
        },
      }
    : body;
const recordHeading = (view) =>
  view.heading
    .slice(0, 6)
    .map(
      (field) => `<b>${html(clip(field.label, 100))}:</b> ${html(clip(String(field.value), 300))}`,
    )
    .join('\n');
export class TelegramApi {
  constructor(token, {fetcher = fetch} = {}) {
    this.token = token;
    this.fetcher = fetcher;
  }
  async call(method, body = {}, signal) {
    let response, result;
    try {
      response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
        signal: AbortSignal.any([
          AbortSignal.timeout(method === 'getUpdates' ? 40000 : 15000),
          ...(signal ? [signal] : []),
        ]),
      });
      result = await response.json();
    } catch {
      throw Object.assign(
        Error('Cannot reach Telegram. Check the internet connection; will retry.'),
        {code: 0},
      );
    }
    if (!response.ok || !result.ok) {
      const code = Number(result.error_code) || response.status;
      // Classify only these known edit outcomes; never expose remote descriptions or tokens.
      const description =
        method === 'editMessageText' && code === 400
          ? String(result.description ?? '').toLowerCase()
          : '';
      const editResult = description.startsWith('bad request: message is not modified')
        ? 'unchanged'
        : description === 'bad request: message to edit not found'
          ? 'missing'
          : null;
      throw Object.assign(
        Error(errors[code] ?? 'Telegram returned a temporary error; will retry.'),
        {code, editResult, retryAfter: Math.max(0, Number(result.parameters?.retry_after) || 0)},
      );
    }
    return result.result;
  }
}

// One polling worker per bot. Candidate assignments are enforced by TelegramStore.
export class TelegramBot {
  constructor({
    store,
    botId,
    answer,
    queueApplication,
    withdrawApplication,
    changed = () => {},
    now = Date.now,
  }) {
    if (botId == null) throw Error('A Telegram bot id is required.');
    Object.assign(this, {store, queueApplication, withdrawApplication, changed, now});
    this.db = new TelegramStore(store, now, botId);
    this.conversation = new TelegramConversation(this.db, {answer, changed});
    this.config = {enabled: false, bot: null};
    this.error = null;
    this.api = null;
    this.controller = null;
    this.flushPromise = null;
    this.nextChatSend = new Map();
  }
  status(candidate = null) {
    return {
      configured: Boolean(this.api),
      enabled: Boolean(this.config.enabled),
      running: Boolean(this.controller),
      bot: this.config.bot,
      error: this.error,
      candidate: this.db.status(candidate),
    };
  }
  pairing(candidate) {
    if (!this.api || !this.config.enabled) throw Error('Save and enable the Telegram bot first.');
    const {token, expires} = this.db.pair(candidate);
    return {url: `https://t.me/${this.config.bot.username}?start=${token}`, expires};
  }
  unlink(candidate) {
    this.db.unlink(candidate);
    this.changed(candidate);
    return this.status(candidate);
  }
  preferences(candidate, input) {
    const link = this.db.preferences(candidate, input);
    this.db.openQuestions(link);
    this.changed(candidate);
    return this.status(candidate);
  }
  retry(candidate) {
    this.store.profile(candidate);
    this.db.retry(candidate);
    return this.status(candidate);
  }
  sendUnsentJobs(candidate, input) {
    if (!this.api || !this.config.enabled || !this.config.bot)
      throw Error('Save and enable the Telegram bot first.');
    const result = this.db.queueUnsentJobs(candidate, this.config.bot.id, input);
    this.changed(candidate);
    return result;
  }
  start() {
    if (this.controller || !this.api) return;
    this.controller = new AbortController();
    const {signal} = this.controller;
    this.pollPromise = this.poll(signal).catch(() => {
      if (!signal.aborted)
        this.error = 'The Telegram connection stopped. Turn it off and on again in Settings.';
    });
    const tick = () => {
      if (!this.flushPromise)
        this.flush(signal).catch(() => {
          if (!signal.aborted) this.error = 'Could not process the Telegram message queue.';
        });
    };
    tick();
    this.timer = setInterval(tick, 3000);
    this.timer.unref?.();
  }
  async stop() {
    clearInterval(this.timer);
    this.controller?.abort();
    await Promise.allSettled([this.pollPromise, this.flushPromise]);
    this.controller = null;
  }
  async poll(signal) {
    while (!signal.aborted) {
      try {
        const updates = await this.api.call(
          'getUpdates',
          {
            offset: Number(this.db.meta('offset', 0)),
            timeout: 25,
            allowed_updates: ['message', 'callback_query'],
          },
          signal,
        );
        if (signal.aborted) return;
        this.error = null;
        for (const update of updates) {
          if (signal.aborted) return;
          if (
            !Number.isSafeInteger(update.update_id) ||
            update.update_id < Number(this.db.meta('offset', 0))
          )
            continue;
          if (update.callback_query?.data?.startsWith('d:')) {
            const result = await this.deleteNotification(update.callback_query, signal);
            await this.api
              .call(
                'answerCallbackQuery',
                {callback_query_id: update.callback_query.id, ...result},
                signal,
              )
              .catch(() => {});
            this.db.setMeta('offset', update.update_id + 1);
            continue;
          }
          if (update.callback_query?.data?.startsWith('queue:')) {
            const result = await this.queueNotification(update.callback_query, signal);
            await this.api
              .call(
                'answerCallbackQuery',
                {callback_query_id: update.callback_query.id, ...result},
                signal,
              )
              .catch(() => {});
            this.db.setMeta('offset', update.update_id + 1);
            continue;
          }
          if (update.callback_query)
            await this.api
              .call('answerCallbackQuery', {callback_query_id: update.callback_query.id}, signal)
              .catch(() => {});
          const reply = await this.conversation.handle(update);
          if (reply && !signal.aborted) {
            try {
              await this.api.call(
                'sendMessage',
                {
                  chat_id: reply.chat,
                  text: clip(reply.text),
                  link_preview_options: {is_disabled: true},
                },
                signal,
              );
            } catch (error) {
              if (![400, 403].includes(error.code)) throw error;
            }
          }
          this.db.setMeta('offset', update.update_id + 1);
        }
      } catch (error) {
        if (signal.aborted) return;
        this.error = errors[error.code] ?? 'The Telegram connection dropped; will retry.';
        await delay(Math.max(5000, Math.min(300000, (error.retryAfter ?? 5) * 1000)), null, {
          signal,
        }).catch(() => {});
      }
    }
  }
  notification(callback, action) {
    const message = callback.message,
      user = callback.from,
      match = callback.data?.match(
        new RegExp(`^${action}:([a-f0-9]{24})${action === 'queue' ? '(?::([a-f0-9]{24}))?' : ''}$`),
      ),
      deliveryId = match?.[1];
    if (
      !deliveryId ||
      message?.chat?.type !== 'private' ||
      !Number.isSafeInteger(message.chat.id) ||
      !Number.isSafeInteger(message.message_id) ||
      message.message_id <= 0 ||
      !Number.isSafeInteger(user?.id) ||
      user.is_bot
    )
      return null;
    const link = this.db.sender(message.chat.id, user.id),
      row = this.db.delivery(deliveryId);
    if (
      !link ||
      !row ||
      row.candidate_id !== link.candidate_id ||
      row.message_id !== message.message_id
    )
      return null;
    return {link, row, token: match?.[2]};
  }
  async updateNotification(row, signal) {
    try {
      this.db.prioritizeEdit(row.id);
      // Finish any older in-flight edit before rendering the latest persisted state.
      // The timer and callback share one flush, so an old response cannot overwrite it.
      if (this.flushPromise) await this.flushPromise.catch(() => {});
      this.db.prioritizeEdit(row.id);
      if (!signal?.aborted) await this.flush(signal);
    } catch {
      if (!signal?.aborted) this.error = 'Could not update the Telegram message; will retry.';
    }
  }
  async queueNotification(callback, signal) {
    const notification = this.notification(callback, 'queue');
    if (
      !notification ||
      notification.row.status !== 'sent' ||
      notification.row.data.kind !== 'new_job'
    )
      return {text: 'This listing cannot be queued through this link.', show_alert: true};
    const {row, link} = notification,
      candidate = link.candidate_id;
    try {
      if (!this.queueApplication) throw Error('Queueing is unavailable. Restart JobLoop.');
      const job = this.store.job(candidate, row.data.jobId),
        state = this.store.queueState(candidate, job);
      if (state.state !== 'available') {
        this.db.refreshJobMessages(candidate, job.id);
        await this.updateNotification(row, signal);
        return {text: state.message, show_alert: state.state === 'unavailable'};
      }
      // The desktop handler persists the queue request before awaiting agent startup.
      // Refresh that state now; starting the browser/agent must not delay the card.
      if (notification.token !== state.token) {
        this.db.refreshJobMessages(candidate, job.id);
        await this.updateNotification(row, signal);
        return {
          text: 'The record changed. Choose the action again on the updated card.',
          show_alert: true,
        };
      }
      const application = this.queueApplication(candidate, job.id, notification.token);
      this.db.refreshJobMessages(candidate, job.id);
      this.changed(candidate);
      const [outcome] = await Promise.allSettled([
        application,
        this.updateNotification(row, signal),
      ]);
      if (outcome.status === 'rejected') throw outcome.reason;
      const result = outcome.value;
      this.db.refreshJobMessages(candidate, job.id);
      this.changed(candidate);
      await this.updateNotification(row, signal);
      return {text: clip(result?.message || 'Listing added to the application queue.', 200)};
    } catch (error) {
      return {text: clip('Could not queue: ' + error.message, 200), show_alert: true};
    }
  }
  dismissesRecord(row) {
    return (
      row.data.kind === 'new_job' &&
      !applicationCompleted(this.store.job(row.candidate_id, row.data.jobId))
    );
  }
  async deleteNotification(callback, signal) {
    const notification = this.notification(callback, 'd'),
      denied = {text: 'This message cannot be deleted through this link.', show_alert: true};
    if (!notification || !deletable(notification.row.data)) return denied;
    const {row, link} = notification,
      message = callback.message;
    if (row.status === 'deleted') return {text: 'Message already deleted.'};
    if (row.status !== 'sent') return denied;
    let withdrawn = false;
    if (jobCard(row.data)) {
      try {
        // Recheck current completion even for old cards still labelled "Dismiss record".
        if (this.dismissesRecord(row)) {
          const job = this.store.job(link.candidate_id, row.data.jobId);
          if (job.status !== 'skipped' && job.manualOutcome !== 'withdrawn') {
            if (!this.withdrawApplication) throw Error('Restart JobLoop.');
            // Use the desktop action so an active application is stopped before withdrawal.
            await this.withdrawApplication(link.candidate_id, job.id);
          }
          withdrawn = true;
          this.db.refreshJobMessages(link.candidate_id, job.id);
          this.changed(link.candidate_id);
        }
      } catch {
        return {
          text: 'Could not dismiss the record; the message was not deleted. Check in JobLoop and try again.',
          show_alert: true,
        };
      }
    }
    const prefix = withdrawn ? 'Record dismissed. ' : '';
    if (
      Number.isFinite(message.date) &&
      message.date > 0 &&
      this.now() - message.date * 1000 >= 48 * 60 * 60 * 1000
    )
      return {
        text:
          prefix +
          'Telegram bots cannot delete messages older than 48 hours. Long-press the message to delete it in Telegram.',
        show_alert: true,
      };
    try {
      await this.api.call(
        'deleteMessage',
        {chat_id: link.chat_id, message_id: row.message_id},
        signal,
      );
      // Keep the delivery receipt so collecting events or retrying cannot send it again.
      this.db.deleted(row.id);
      return {text: withdrawn ? 'Message deleted; record dismissed.' : 'Message deleted.'};
    } catch (error) {
      return {
        text:
          prefix +
          ([400, 403].includes(error.code)
            ? 'Could not delete the message. Long-press the message in Telegram to delete it.'
            : 'Could not delete the message. Press Delete again in a moment.'),
        show_alert: true,
      };
    }
  }
  delivery(row, link, {edit = false} = {}) {
    const data = row.data;
    if (data.kind === 'new_job') {
      if (!edit && link.data.newJobs === false && !data.backfill) return null;
      if (
        !edit &&
        !data.resend &&
        this.db.jobSent(link.candidate_id, this.config.bot?.id ?? this.db.meta('bot'), data.jobId)
      )
        return null;
      let job;
      try {
        job = this.store.job(link.candidate_id, data.jobId);
      } catch {
        return null;
      }
      if (!edit && data.backfill && !data.resend && applicationCompleted(job)) return null;
      if (!edit && !data.backfill && !matchesTelegramScore(job, link.data.newJobsMinScore))
        return {waitingForScore: true};
      if (!edit && !matchesTelegramScore(job, data.minScore)) return null;

      const view = this.store.recordNotification(link.candidate_id, job.id);
      const queue = this.queueApplication ? this.store.queueState(link.candidate_id, job) : null,
        buttons = [[{text: 'Open record', style: 'primary', url: job.url}]];
      if (queue?.state === 'available')
        buttons.push([
          {
            text: queue.actionLabel,
            style: 'success',
            callback_data: `queue:${row.id}${queue.token ? ':' + queue.token : ''}`,
          },
        ]);
      const status = ['queued', 'active'].includes(queue?.state) ? queue.message : view.status;
      return {
        text: `<b>${html(view.title)} · ${html(status)}</b>\n\n${recordHeading(view)}\n\n${html(clip(view.summary ?? '', 1000))}`,
        parse_mode: 'HTML',
        reply_markup: {inline_keyboard: buttons},
      };
    }
    if (data.kind === 'submission') {
      if (!link.data.notifications) return null;
      let job;
      try {
        job = this.store.job(link.candidate_id, data.jobId);
      } catch {
        return null;
      }
      const view = this.store.recordNotification(link.candidate_id, job.id);
      return {
        text: `<b>✅ ${html(view.title)} · ${html(view.completed)}</b>\n\n${recordHeading(view)}`,
        parse_mode: 'HTML',
        reply_markup: {inline_keyboard: [[{text: 'Open record', style: 'primary', url: job.url}]]},
      };
    }
    if (data.questionId) {
      const q = this.db.question(link.candidate_id, data.questionId);
      if (!q || q.answer !== null || q.resolution) {
        if (!edit) return null;
        const answered = q?.answer != null,
          title = answered ? '✅ Answered' : '⚪ Question closed';
        const question = q
          ? `<b>${html(this.conversation.jobTitle(link, q))}</b>\n\n${html(clip(q.question, 1800))}`
          : '';
        const result = answered
          ? `<b>Your answer:</b>\n${html(clip(q.answer, 1400))}`
          : 'This question no longer needs an answer.';
        return {
          text: `<b>${title}</b>\n\n${question}\n\n${result}`,
          parse_mode: 'HTML',
          reply_markup: {inline_keyboard: []},
        };
      }
      if (!link.data.questions && !edit) return null;
      if (data.kind === 'question' || !data.promptId)
        return {
          text: clip(`${this.conversation.jobTitle(link, q)}\n\n${q.question}`, 3900),
          reply_markup: {inline_keyboard: [[{text: 'Reply', callback_data: `q:${q.id}`}]]},
        };
    }
    if (data.promptId && link.data.dialog?.promptId !== data.promptId) return null;
    return {text: data.text, ...(data.reply_markup ? {reply_markup: data.reply_markup} : {})};
  }
  flush(signal) {
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.flushPending(signal).finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }
  async flushPending(signal) {
    this.db.collect();
    if (this.queueApplication) this.db.collectPins();
    if (Number(this.db.meta('sendAfter', 0)) > this.now()) return;
    if (!(await this.flushEdits(signal, {urgent: true}))) return;
    if (!(await this.flushPins(signal))) return;
    if (!(await this.flushEdits(signal))) return;
    for (const row of this.db.pending()) {
      if (signal?.aborted) return;
      const link = this.db.link(row.candidate_id);
      if (!link) continue;
      if ((this.nextChatSend.get(link.chat_id) ?? 0) > this.now()) continue;
      const delivery = this.delivery(row, link);
      if (delivery?.waitingForScore) {
        this.db.waitForScore(row.id);
        continue;
      }
      if (!delivery) {
        this.db.skipped(row.id);
        continue;
      }
      const body = withDeleteButton(row, delivery, this.dismissesRecord(row));
      try {
        const result = await this.api.call(
          'sendMessage',
          {chat_id: link.chat_id, ...body, link_preview_options: {is_disabled: true}},
          signal,
        );
        this.db.sent(row.id, result.message_id, this.config.bot?.id ?? this.db.meta('bot'), body);
        this.nextChatSend.set(link.chat_id, this.now() + 1100);
      } catch (error) {
        if (signal?.aborted) return;
        this.db.fail(row, error);
        if (error.code === 429)
          this.db.setMeta('sendAfter', this.now() + Math.max(1, error.retryAfter ?? 5) * 1000);
        if ([0, 401, 409, 429].includes(error.code)) {
          this.error = error.message;
          break;
        }
      }
    }
  }
  async flushPins(signal) {
    for (const pending of this.db.pendingPins()) {
      if (signal?.aborted) return false;
      const row = this.db.delivery(pending.id),
        link = row && this.db.link(row.candidate_id);
      if (!link || row.status !== 'sent' || (this.nextChatSend.get(link.chat_id) ?? 0) > this.now())
        continue;
      try {
        await this.api.call(
          pending.wanted ? 'pinChatMessage' : 'unpinChatMessage',
          {
            chat_id: link.chat_id,
            message_id: row.message_id,
            ...(pending.wanted ? {disable_notification: true} : {}),
          },
          signal,
        );
        this.db.pinned(row.id);
        this.nextChatSend.set(link.chat_id, this.now() + 1100);
      } catch (error) {
        if (signal?.aborted) return false;
        this.db.failPin(pending, error);
        this.nextChatSend.set(link.chat_id, this.now() + 1100);
        if (error.code === 429)
          this.db.setMeta('sendAfter', this.now() + Math.max(1, error.retryAfter ?? 5) * 1000);
        if ([0, 401, 409, 429].includes(error.code)) {
          this.error = error.message;
          return false;
        }
      }
    }
    return true;
  }
  async flushEdits(signal, options) {
    for (const pending of this.db.pendingEdits(options)) {
      if (signal?.aborted) return false;
      // A deletion or unlink may happen while another API request is in flight.
      const row = this.db.delivery(pending.id),
        link = row && this.db.link(row.candidate_id);
      if (!link || row.status !== 'sent') continue;
      const delivery = this.delivery(row, link, {edit: true});
      if (!delivery) {
        this.db.edited(row.id, null);
        continue;
      }
      const body = withDeleteButton(row, delivery, this.dismissesRecord(row));
      if (JSON.stringify(body) === pending.rendered_body) {
        this.db.edited(row.id, body);
        continue;
      }
      if ((this.nextChatSend.get(link.chat_id) ?? 0) > this.now()) continue;
      try {
        await this.api.call(
          'editMessageText',
          {
            chat_id: link.chat_id,
            message_id: row.message_id,
            ...body,
            link_preview_options: {is_disabled: true},
          },
          signal,
        );
        this.db.edited(row.id, body);
        this.nextChatSend.set(link.chat_id, this.now() + 1100);
      } catch (error) {
        if (signal?.aborted) return false;
        this.nextChatSend.set(link.chat_id, this.now() + 1100);
        if (error.editResult === 'unchanged') {
          this.db.edited(row.id, body);
          continue;
        }
        if (error.editResult === 'missing') {
          this.db.deleted(row.id);
          continue;
        }
        this.db.failEdit(pending, error);
        if (error.code === 429)
          this.db.setMeta('sendAfter', this.now() + Math.max(1, error.retryAfter ?? 5) * 1000);
        if ([0, 401, 409, 429].includes(error.code)) {
          this.error = error.message;
          return false;
        }
      }
    }
    return true;
  }
}
