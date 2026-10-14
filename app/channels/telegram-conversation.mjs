import {randomBytes} from 'node:crypto';
import {validateAnswers} from '../automation/question-forms.mjs';

export const clip = (value, max = 3500) =>
  Array.from(String(value ?? ''))
    .slice(0, max)
    .join('');
const signature = (q) => JSON.stringify([q.question, q.fields]);
const help =
  'New listings and application notifications arrive in this chat. You can change notification preferences in AutoJev’s Telegram settings.\n/questions — Pending questions\n/status — Application summary\n/cancel — Cancel the answer you are writing\n/unlink — Remove the Telegram link';
const keyboard = (rows) => ({inline_keyboard: rows});
// English commands; the Turkish names stay accepted as aliases for existing users.
const commandAliases = {
  sorular: 'questions',
  durum: 'status',
  iptal: 'cancel',
  baglantiyikes: 'unlink',
};

export class TelegramConversation {
  constructor(db, {answer, changed = () => {}}) {
    this.db = db;
    this.store = db.store;
    this.answer = answer;
    this.changed = changed;
  }
  question(link, id) {
    return this.store.questions(link.candidate_id).find((q) => q.id === id && q.answer === null);
  }
  say(link, text, extra = {}, key) {
    return this.db.message(link.candidate_id, clip(text), extra, key);
  }
  jobTitle(link, q) {
    if (!q.jobId) return 'Candidate profile';
    try {
      const job = this.store.job(link.candidate_id, q.jobId);
      return clip(`${job.company} · ${job.role}`, 300);
    } catch {
      return 'Application';
    }
  }
  notifyQuestion(link, q, key) {
    this.say(
      link,
      `${this.jobTitle(link, q)}\n\n${clip(q.question, 3000)}`,
      {questionId: q.id, reply_markup: keyboard([[{text: 'Reply', callback_data: `q:${q.id}`}]])},
      key,
    );
  }
  begin(link, q) {
    link.data.dialog = {questionId: q.id, signature: signature(q), index: 0, values: {}};
    this.prompt(link, q);
  }
  prompt(link, q) {
    const dialog = link.data.dialog,
      fields = q.fields ?? [{id: 'reply', label: q.question, type: 'text', required: true}],
      f = fields[dialog.index];
    const promptId = randomBytes(10).toString('hex');
    dialog.promptId = promptId;
    this.db.saveLink(link);
    const button = (text, value) => ({
      text: clip(text, 60),
      callback_data: `a:${promptId}:${value}`,
    });
    if (!f) {
      const summary = q.fields
        ? validateAnswers(fields, dialog.values).summary
        : dialog.values.reply;
      const chunks = Array.from(summary);
      for (let i = 0; i < chunks.length; i += 3300)
        this.say(
          link,
          `${i === 0 ? 'Your answers:\n\n' : ''}${chunks.slice(i, i + 3300).join('')}`,
          {
            questionId: q.id,
            promptId,
          },
        );
      this.say(link, 'Send these answers to AutoJev?', {
        questionId: q.id,
        promptId,
        reply_markup: keyboard([
          [button('Send answers', 'save')],
          [button('Start over', 'restart'), button('Cancel', 'cancel')],
        ]),
      });
      return;
    }
    const rows = [];
    if (f.type === 'boolean') rows.push([button('Yes', 'true'), button('No', 'false')]);
    if (['select', 'multiselect'].includes(f.type))
      f.options.forEach((option, index) =>
        rows.push([
          button(
            `${index + 1}. ${f.type === 'multiselect' && dialog.values[f.id]?.includes(option) ? '✓ ' : ''}${option}`,
            String(index),
          ),
        ]),
      );
    if (f.type === 'multiselect') rows.push([button('Finish selection', 'done')]);
    if (f.required === false) rows.push([button('Leave this field empty', 'skip')]);
    const inputHint =
      f.type === 'date'
        ? 'Write the date as YYYY-MM-DD.'
        : f.type === 'number'
          ? 'Write a number (e.g. 70000 or 12.5).'
          : ['text'].includes(f.type)
            ? 'Reply to this message.'
            : '';
    // Keep the complete field/consent text and long choices visible, even when they need
    // more than one Telegram message. Button labels can then be short and numbered.
    const details = `${f.label}${f.help ? '\n' + f.help : ''}${f.options?.some((option) => option.length > 50) ? '\n\n' + f.options.map((option, index) => `${index + 1}. ${option}`).join('\n') : ''}`;
    const parts = Array.from(details);
    if (parts.length > 2900)
      for (let i = 0; i < parts.length; i += 3300)
        this.say(link, parts.slice(i, i + 3300).join(''), {questionId: q.id, promptId});
    const text = `${this.jobTitle(link, q)}\n${dialog.index + 1}/${fields.length} · ${parts.length > 2900 ? 'Your answer for the field above:' : details}\n\n${inputHint}\nSend /cancel to cancel`;
    const extra = {
      questionId: q.id,
      promptId,
      reply_markup: rows.length ? keyboard(rows) : {force_reply: true, selective: true},
    };
    this.say(link, text, extra);
  }
  async handle(update) {
    const callback = update.callback_query,
      message = callback?.message ?? update.message,
      user = callback?.from ?? message?.from;
    if (
      !message ||
      message.chat?.type !== 'private' ||
      !Number.isSafeInteger(message.chat.id) ||
      !Number.isSafeInteger(user?.id) ||
      user.is_bot
    )
      return null;
    const chat = message.chat.id,
      text = callback ? '' : String(message.text ?? '').trim();
    let link = this.db.sender(chat, user.id);
    const command = text.match(/^\/(\w+)(?:@\w+)?(?:\s+(.+))?$/s);
    if (command?.[1] === 'start' && command[2]) {
      const bound = this.db.bind(
        command[2].trim(),
        chat,
        user.id,
        [user.first_name, user.last_name].filter(Boolean).join(' ') ||
          user.username ||
          'Telegram user',
      );
      if (!bound)
        return {
          chat,
          text: 'The link is invalid or expired, or the account is already linked. Create a new link in AutoJev.',
        };
      link = bound;
      this.say(
        link,
        `${this.store.profile(link.candidate_id).name}, your Telegram link is ready.\n\n${help}`,
        {},
        `linked:${link.data.linkedAt}`,
      );
      this.db.openQuestions(link);
      this.changed(link.candidate_id);
      return null;
    }
    if (!link)
      return command
        ? {
            chat,
            text: 'To link, choose your candidate in AutoJev, create a link under Configuration → Telegram, and press Start here.',
          }
        : null;
    if (command) {
      const name = commandAliases[command[1]] ?? command[1];
      if (['start', 'help'].includes(name)) this.say(link, help);
      else if (name === 'unlink') {
        this.db.unlink(link.candidate_id);
        this.changed(link.candidate_id);
        return {chat, text: 'Your Telegram link was removed. No new notifications will be sent.'};
      } else if (name === 'cancel') {
        link.data.dialog = null;
        this.db.saveLink(link);
        this.say(link, 'Answer draft cancelled. Send /questions for pending questions.');
      } else if (name === 'status') {
        const jobs = this.store.visibleJobs(link.candidate_id),
          sent = jobs.filter((j) => ['submitted', 'already_submitted'].includes(j.status)).length,
          pending = this.store.questions(link.candidate_id).filter((q) => q.answer === null).length;
        this.say(
          link,
          `${this.store.profile(link.candidate_id).name}\n${sent} submitted applications\n${pending} pending questions\n\n${link.data.questions ? 'Send /questions to answer the questions.' : 'Question notifications are off.'}`,
        );
      } else if (name === 'questions') {
        if (!link.data.questions)
          this.say(
            link,
            'Question notifications are off. You can turn them on in AutoJev’s Telegram settings.',
          );
        else {
          const questions = this.store
            .questions(link.candidate_id)
            .filter((q) => q.answer === null);
          for (const q of questions.slice(0, 10)) this.notifyQuestion(link, q);
          if (!questions.length) this.say(link, 'No pending questions.');
          else if (questions.length > 10)
            this.say(
              link,
              'Showing the first 10 questions. After answering them, continue with /questions.',
            );
        }
      } else this.say(link, help);
      return null;
    }
    if (!link.data.questions) return null;
    if (callback?.data?.startsWith('q:')) {
      const q = this.question(link, callback.data.slice(2));
      if (q) this.begin(link, q);
      else
        this.say(
          link,
          'This question no longer needs an answer. Send /questions to see the current questions.',
        );
      return null;
    }
    const dialog = link.data.dialog;
    if (!dialog) {
      if (text) this.say(link, 'First choose a question with /questions.');
      return null;
    }
    const q = this.question(link, dialog.questionId);
    if (!q || dialog.signature !== signature(q)) {
      link.data.dialog = null;
      this.db.saveLink(link);
      this.say(
        link,
        'The question changed or was already answered. Open the current question with /questions.',
      );
      return null;
    }
    const fields = q.fields ?? [{id: 'reply', label: q.question, type: 'text', required: true}],
      f = fields[dialog.index];
    const match = callback?.data?.match(/^a:([a-f0-9]{20}):([a-z0-9]+)$/);
    if (callback && (!match || match[1] !== dialog.promptId)) return null;
    const action = match?.[2];
    if (!callback) {
      if (!text) return null;
      const reply = this.db.db
        .prepare('SELECT data FROM telegram_outbox WHERE candidate_id=? AND message_id=?')
        .get(link.candidate_id, message.reply_to_message?.message_id ?? -1);
      if (!reply || JSON.parse(reply.data).promptId !== dialog.promptId) {
        this.say(
          link,
          'Send your answer to the latest question message using Telegram’s Reply option.',
        );
        return null;
      }
    }
    if (action === 'cancel') {
      link.data.dialog = null;
      this.db.saveLink(link);
      this.say(link, 'Answer draft cancelled.');
      return null;
    }
    if (action === 'restart') {
      this.begin(link, q);
      return null;
    }
    if (!f) {
      if (action !== 'save') return null;
      const values = q.fields ? validateAnswers(fields, dialog.values).values : dialog.values.reply;
      // The existing answer handler records the answer before waking the campaign. A redelivered
      // update cannot answer twice because question() above only accepts unanswered questions.
      try {
        await this.answer(link.candidate_id, q.id, values);
      } catch (error) {
        if (this.question(link, q.id)) {
          this.say(link, `Could not save the answer: ${clip(error.message, 600)}`);
          return null;
        }
        this.say(
          link,
          'Answer saved. Check the agent status in AutoJev to continue the application.',
        );
      }
      const current = this.db.link(link.candidate_id);
      if (current?.chat_id !== link.chat_id || current?.user_id !== link.user_id) return null;
      current.data.dialog = null;
      this.db.saveLink(current);
      this.say(
        current,
        'Your answers were saved in AutoJev. Application status will be reported here.',
      );
      this.changed(link.candidate_id);
      return null;
    }
    try {
      if (action === 'skip' && f.required === false) delete dialog.values[f.id];
      else if (f.type === 'multiselect') {
        if (action === 'done') validateAnswers([f], {[f.id]: dialog.values[f.id]});
        else {
          if (!/^\d+$/.test(action ?? '')) return null;
          const option = f.options[Number(action)];
          if (option === undefined) return null;
          const selected = new Set(dialog.values[f.id] ?? []);
          if (selected.has(option)) selected.delete(option);
          else selected.add(option);
          dialog.values[f.id] = [...selected];
          this.prompt(link, q);
          return null;
        }
      } else {
        let value;
        if (f.type === 'boolean') {
          if (!['true', 'false'].includes(action)) return null;
          value = action === 'true';
        } else if (f.type === 'select') {
          if (!/^\d+$/.test(action ?? '')) return null;
          value = f.options[Number(action)];
        } else {
          if (callback) return null;
          value = text;
          if (f.type === 'number') {
            if (!/^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(text))
              throw Error('Write a number (e.g. 70000 or 12.5).');
            value = Number(text.replace(',', '.'));
          }
        }
        validateAnswers([f], {[f.id]: value});
        dialog.values[f.id] = value;
      }
      dialog.index++;
      if (q.fields && dialog.index === fields.length) validateAnswers(fields, dialog.values);
      this.prompt(link, q);
    } catch (error) {
      dialog.index = Math.min(dialog.index, fields.length - 1);
      this.say(link, clip(error.message, 1000));
      this.prompt(link, q);
    }
    return null;
  }
}
