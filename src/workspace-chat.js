import {renderMessageText} from './message-text.js';
import {interviewRun, interviewBusy} from '../app/workspaces/conversation.mjs';
import {conversationToolLabel} from '../app/agents/conversation-activity.mjs';
import {conversationMessages} from '../app/agents/conversation-messages.mjs';
import './workspace-chat.css';

const node = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const timestamp = (value) => (typeof value === 'number' ? value : Date.parse(value) || 0);
const clock = (value) =>
  new Date(timestamp(value)).toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'});
const drafts = new Map();

export function workspaceChat({
  root,
  form,
  log,
  input,
  send,
  attach,
  intro,
  api,
  owner,
  onSend,
  onClose,
  onShow = () => {},
  onReviewProfile = () => {},
  onReviewSources = () => {},
}) {
  let snapshot = null,
    sending = false,
    disposed = false,
    follow = true,
    native = [],
    activity = null,
    polling = false,
    pending = [],
    failures = [],
    lastSignature = '',
    visible = false;
  root.className = 'automation-conversation workspace-chat';
  root.setAttribute('aria-label', 'Chat with the setup agent');
  const header = node('div', 'workspace-chat-header'),
    identity = node('div', 'workspace-chat-identity'),
    mark = node('span', 'workspace-chat-avatar', 'A'),
    copy = node('div'),
    title = node('h2', '', 'Setup agent'),
    status = node('span', 'workspace-chat-status', 'Ready');
  status.id = 'automation-chat-state';
  status.setAttribute('role', 'status');
  copy.append(title, status);
  identity.append(mark, copy);
  const controls = node('div', 'workspace-chat-controls'),
    questionLink = node('button', 'quiet workspace-chat-question-link', 'Open form'),
    close = node('button', 'quiet', 'Close chat');
  questionLink.type = close.type = 'button';
  questionLink.hidden = true;
  questionLink.onclick = () => showQuestion();
  close.id = 'automation-chat-stop';
  close.hidden = true;
  close.onclick = async () => {
    close.disabled = true;
    try {
      await onClose();
    } finally {
      if (!disposed) close.disabled = false;
    }
  };
  controls.append(questionLink, close);
  header.append(identity, controls);
  const profileNotice = node('section', 'workspace-chat-profile'),
    profileCopy = node('div'),
    profileTitle = node('b', '', 'Profile change ready'),
    profileDetail = node('p'),
    reviewProfile = node('button', 'primary', 'Review and save the draft');
  profileNotice.setAttribute('aria-label', 'Profile change');
  profileNotice.hidden = true;
  reviewProfile.type = 'button';
  reviewProfile.onclick = onReviewProfile;
  profileCopy.append(profileTitle, profileDetail);
  profileNotice.append(profileCopy, reviewProfile);
  const sourceNotice = node('section', 'workspace-chat-profile'),
    sourceCopy = node('div'),
    reviewSources = node('button', 'primary', 'Review source suggestions');
  sourceNotice.setAttribute('aria-label', 'Source suggestions');
  sourceNotice.hidden = true;
  reviewSources.type = 'button';
  reviewSources.onclick = onReviewSources;
  sourceCopy.append(
    node('b', '', 'Source suggestions ready'),
    node('p', '', 'Review and apply the agent’s suggested source changes on the Sources screen.'),
  );
  sourceNotice.append(sourceCopy, reviewSources);
  const viewport = node('div', 'workspace-chat-viewport'),
    empty = node('div', 'workspace-chat-empty');
  empty.append(
    node('span', 'workspace-chat-eyebrow', 'LET’S WORK TOGETHER'),
    node('h3', '', 'What should we talk about?'),
    node(
      'p',
      '',
      'Ask about the results, change your preferences or decide the next step together.',
    ),
  );
  const suggestions = node('div', 'workspace-chat-suggestions');
  for (const text of [
    'Briefly summarise the results',
    'Why are these results a good fit?',
    'I want to update my preferences',
  ]) {
    const b = node('button', 'quiet', text);
    b.type = 'button';
    b.onclick = () => {
      input.value = text;
      input.dispatchEvent(new Event('input'));
      input.focus();
    };
    suggestions.append(b);
  }
  empty.append(suggestions);
  log.className = 'workspace-chat-messages';
  log.setAttribute('aria-label', 'Chat messages');
  log.setAttribute('aria-live', 'polite');
  log.setAttribute('aria-relevant', 'additions text');
  const thinking = node('div', 'workspace-chat-thinking'),
    dots = node('span', 'workspace-chat-dots');
  dots.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i++) dots.append(node('i'));
  const thinkingText = node('span'),
    elapsed = node('small');
  thinking.append(dots, thinkingText, elapsed);
  thinking.hidden = true;
  const questions = node('section', 'workspace-chat-questions');
  questions.setAttribute('aria-label', 'Questions awaiting an answer');
  questions.hidden = true;
  const jump = node('button', 'workspace-chat-jump', '↓ New messages');
  jump.type = 'button';
  jump.hidden = true;
  jump.onclick = () => {
    follow = true;
    jump.hidden = true;
    scroll();
  };
  if (intro) viewport.append(intro);
  viewport.append(empty, log, questions, thinking);
  form.className = 'workspace-chat-composer';
  form.querySelector('.automation-compose')?.remove();
  form.querySelector('label').className = 'workspace-chat-input-label';
  input.rows = 2;
  input.placeholder = 'Write a message to the agent…';
  input.setAttribute('aria-label', 'Message to the agent');
  send.removeAttribute('data-idle');
  send.textContent = 'Send ↑';
  attach.textContent = '＋ Document';
  const feedback = form.querySelector('#automation-chat-feedback');
  feedback.setAttribute('role', 'alert');
  feedback.hidden = true;
  const hint = form.querySelector('small');
  hint.textContent = 'Enter to send · Shift + Enter for a new line';
  root.replaceChildren(header, profileNotice, sourceNotice, viewport, jump, form);
  input.value = drafts.get(owner) ?? '';
  const sizeInput = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(160, Math.max(52, input.scrollHeight)) + 'px';
  };
  input.addEventListener('input', () => {
    drafts.set(owner, input.value);
    sizeInput();
    renderStatus();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!send.disabled) form.requestSubmit();
    }
  });
  viewport.onscroll = () => {
    follow = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 64;
    if (follow) jump.hidden = true;
  };
  function showQuestion(id) {
    const card = id
      ? [...questions.children].find((n) => n.dataset.issueId === id)
      : questions.firstElementChild;
    if (!card) return false;
    onShow();
    root.scrollIntoView({block: 'nearest'});
    viewport.scrollTop +=
      card.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 16;
    jump.hidden = true;
    return true;
  }
  const scroll = () => {
    if (follow)
      requestAnimationFrame(() => {
        if (!disposed && root.checkVisibility()) {
          if (questions.childElementCount) showQuestion();
          else viewport.scrollTop = viewport.scrollHeight;
        }
      });
    else jump.hidden = false;
  };
  function setQuestions(cards) {
    const changed =
      cards.length !== questions.childElementCount ||
      cards.some((card, index) => questions.children[index] !== card);
    if (!changed) return;
    for (const card of [...questions.children]) if (!cards.includes(card)) card.remove();
    for (const card of cards) if (card.parentElement !== questions) questions.append(card);
    questions.hidden = questionLink.hidden = !cards.length;
    questionLink.textContent = cards.length > 1 ? `Open forms · ${cards.length}` : 'Open form';
    jump.textContent = cards.length ? '↓ Form awaiting an answer' : '↓ New messages';
    renderStatus();
    scroll();
  }
  function layout() {
    if (disposed) return;
    if (!root.checkVisibility()) {
      visible = false;
      return;
    }
    const top = Math.round(root.getBoundingClientRect().top + window.scrollY) + 'px';
    if (root.style.getPropertyValue('--workspace-chat-top') !== top)
      root.style.setProperty('--workspace-chat-top', top);
    if (!visible) {
      visible = true;
      sizeInput();
      if (follow) scroll();
    }
  }
  const resize = new ResizeObserver(layout);
  resize.observe(root);
  window.addEventListener('resize', layout);
  function renderStatus() {
    if (!snapshot) return;
    const run = interviewRun(snapshot),
      working = interviewBusy(snapshot);
    const awaiting =
      snapshot.workers?.find((w) => w.id === (run?.workerId ?? 'main'))?.active?.state ===
      'AwaitingInput';
    const label = sending
      ? 'Sending message…'
      : awaiting
        ? 'Your reply is needed in the terminal'
        : working
          ? 'Preparing a reply'
          : questions.childElementCount
            ? 'Waiting for your answer'
            : run
              ? 'Chat open'
              : 'Ready';
    status.textContent = label;
    root.dataset.working = String(working || sending);
    close.hidden = !run;
    close.disabled = sending;
    const a = snapshot.automation;
    sourceNotice.hidden = !a?.sourceDraft;
    profileNotice.hidden = !a?.planDraft && !a?.profileUpdate;
    const savedProfile = a?.profileUpdate && !a?.planDraft;
    profileTitle.textContent = a?.profileUpdate?.error
      ? 'Profile could not be applied'
      : savedProfile
        ? 'Applying profile'
        : 'Profile change ready';
    reviewProfile.textContent = savedProfile ? 'View profile' : 'Review and save the draft';
    profileDetail.textContent = a?.profileUpdate?.error
      ? 'Your changes were kept. Save again from the Profile page.'
      : savedProfile
        ? 'Scans are being stopped and restarted with the new criteria. The chat stays open.'
        : 'The agent’s suggested changes are not applied yet. Review the profile and save it.';
    send.disabled =
      sending ||
      !input.value.trim() ||
      working ||
      Boolean(snapshot.activeRun && !snapshot.capabilities?.concurrentConversation);
    send.textContent = sending ? 'Sending…' : 'Send ↑';
    input.disabled = false;
    attach.disabled = sending || Boolean(snapshot.activeRun);
    const active = working || sending;
    thinking.hidden = !active;
    const currentActivity =
      activity?.at >= (run?.lastMessageAt ?? run?.startedAt ?? 0) ? activity : run?.chatActivity;
    thinkingText.textContent = sending
      ? 'Sending your message'
      : awaiting
        ? 'Open the Terminal tab to continue'
        : (currentActivity?.label ?? (working ? 'Preparing a reply' : ''));
    const seconds = Math.max(
      0,
      Math.floor((Date.now() - (run?.lastMessageAt ?? run?.startedAt ?? Date.now())) / 1000),
    );
    elapsed.textContent =
      active && seconds >= 10
        ? `${seconds < 60 ? seconds + ' s' : Math.floor(seconds / 60) + ' min ' + (seconds % 60) + ' s'}`
        : '';
    hint.textContent = working
      ? 'You can write your next message while the reply is being prepared.'
      : 'Enter to send · Shift + Enter for a new line';
  }
  function renderMessages() {
    if (!snapshot) return;
    const saved = conversationMessages(snapshot, native);
    pending = pending.filter(
      (p) =>
        !saved.some(
          (m) => m.role === 'user' && m.text === p.text && timestamp(m.at) >= p.at - 1000,
        ),
    );
    const messages = [...saved, ...pending].map((m) => ({
        ...m,
        failed:
          m.role === 'user' &&
          failures.some(
            (f) =>
              f.text === m.text && timestamp(m.at) >= f.at - 1000 && timestamp(m.at) <= f.until,
          ),
      })),
      signature = JSON.stringify(messages);
    if (signature === lastSignature) return;
    lastSignature = signature;
    const previousScroll = viewport.scrollTop;
    empty.hidden = Boolean(messages.length) || snapshot.progress?.fresh;
    const existing = new Map([...log.children].map((n) => [n.dataset.id, n]));
    let cursor = log.firstElementChild;
    for (const m of messages) {
      let bubble = existing.get(m.id);
      existing.delete(m.id);
      if (!bubble) {
        bubble = node('article', 'workspace-chat-message');
        bubble.dataset.id = m.id;
        bubble.dataset.role = m.role;
        const meta = node('div', 'workspace-chat-meta');
        meta.append(node('b', '', m.role === 'user' ? 'You' : 'JobLoop'), node('time'));
        bubble.append(meta, node('div', 'workspace-chat-body'));
      }
      bubble.dataset.pending = String(Boolean(m.pending));
      bubble.dataset.failed = String(Boolean(m.failed));
      bubble.querySelector('time').textContent = m.failed
        ? 'Not delivered'
        : m.pending
          ? 'Sending…'
          : clock(m.at);
      renderMessageText(bubble.querySelector('.workspace-chat-body'), m.text);
      if (bubble !== cursor) log.insertBefore(bubble, cursor);
      else cursor = cursor.nextElementSibling;
    }
    for (const old of existing.values()) old.remove();
    if (!follow) viewport.scrollTop = previousScroll;
    scroll();
  }
  form.onsubmit = async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || send.disabled || sending) return;
    sending = true;
    feedback.hidden = true;
    const echo = {
      id: 'pending:' + crypto.randomUUID(),
      role: 'user',
      text,
      at: Date.now(),
      pending: true,
    };
    pending.push(echo);
    follow = true;
    input.value = '';
    drafts.delete(owner);
    sizeInput();
    renderMessages();
    renderStatus();
    input.focus();
    try {
      await onSend(text);
    } catch (error) {
      if (disposed) return;
      pending = pending.filter((m) => m !== echo);
      failures.push({...echo, until: Date.now()});
      feedback.textContent = error.message + ' You can send it again.';
      feedback.hidden = false;
      feedback.classList.add('error');
      if (!input.value) {
        input.value = text;
        drafts.set(owner, text);
        sizeInput();
      }
    } finally {
      sending = false;
      if (!disposed) {
        renderMessages();
        renderStatus();
      }
    }
  };
  async function poll() {
    const run = snapshot && interviewRun(snapshot);
    if (disposed || polling || !snapshot || !root.checkVisibility() || !api.workerTranscript)
      return;
    polling = true;
    const runId = run?.id;
    try {
      const result = await api.workerTranscript(owner, run?.workerId ?? 'conversation');
      if (disposed || (runId && interviewRun(snapshot) && interviewRun(snapshot).id !== runId))
        return;
      native = result.messages ?? [];
      activity = result.activity
        ? {...result.activity, label: conversationToolLabel(result.activity.tool)}
        : null;
      renderMessages();
      renderStatus();
    } catch {
      /* Saved messages remain available when native output is unavailable. */
    } finally {
      polling = false;
    }
  }
  const timer = setInterval(() => {
    if (!disposed) {
      layout();
      renderStatus();
      void poll();
    }
  }, 800);
  return {
    setQuestions,
    showQuestion,
    update(value) {
      snapshot = value;
      renderMessages();
      renderStatus();
      layout();
      void poll();
    },
    focus() {
      input.focus();
      sizeInput();
    },
    dispose() {
      disposed = true;
      clearInterval(timer);
      resize.disconnect();
      window.removeEventListener('resize', layout);
      drafts.set(owner, input.value);
    },
  };
}
