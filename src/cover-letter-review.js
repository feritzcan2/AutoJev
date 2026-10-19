import './answers-page.css';
import './cover-letter-review.css';
const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
const button = (text, click, cls = 'quiet') => {
  const node = el('button', text, cls);
  node.type = 'button';
  node.onclick = click;
  return node;
};
const finished = ['completed', 'partial', 'blocked', 'failed', 'interrupted', 'cancelled'];

// Cover letters the cover letter agent wrote wait here for the user's review.
// Approving one answers the record's question and resumes the application.
// Cards stay mounted while their letter is unchanged, so edits survive refreshes.
export function coverLetterReview(root, api, {refresh}) {
  let workspace = null;
  const cards = new Map(),
    list = el('div', null, 'answers-list cover-letter-list');
  root.append(list);

  function state(question, tasks) {
    const letter = question.coverLetter;
    if (letter.state !== 'writing') return letter.state;
    const task = tasks.find((t) => t.id === letter.taskId);
    return !task || finished.includes(task.state) ? 'failed' : 'writing';
  }

  // The writer task's live state: queued while it waits for a free agent, then running.
  function progress(task) {
    const line = el('p', null, 'cover-letter-progress');
    if (task?.state !== 'running') {
      line.textContent = 'Queued · waits for a free agent';
      return line;
    }
    line.dataset.running = '';
    let shown = false;
    const tick = () => {
      // The card is replaced when the task state changes; stop with it.
      if (shown && !line.isConnected) return clearInterval(timer);
      const seconds = Math.max(0, Math.round((Date.now() - (task.startedAt ?? Date.now())) / 1000));
      line.textContent = `Running · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      shown = true;
    };
    const timer = setInterval(tick, 1000);
    tick();
    return line;
  }

  function card(question, record, current, task) {
    const letter = question.coverLetter,
      node = el('article', null, 'answer-card cover-letter-card'),
      head = el('header', null, 'answer-card-head'),
      body = el('div', null, 'answer-card-body'),
      footer = el('footer', null, 'answer-card-footer'),
      tools = el('div', null, 'answer-card-tools'),
      feedback = el('p', null, 'answer-card-feedback'),
      owner = workspace;
    feedback.setAttribute('role', 'status');
    const heading = el('div');
    head.append(heading);
    heading.append(
      el(
        'span',
        current === 'review'
          ? 'COVER LETTER TO REVIEW'
          : current === 'writing'
            ? 'COVER LETTER BEING WRITTEN'
            : 'COVER LETTER NOT WRITTEN',
        'answer-card-eyebrow',
      ),
      el('h3', record?.title ?? 'Cover letter'),
    );
    if (record?.url)
      heading.append(
        el('p', new URL(record.url).hostname.replace(/^www\./, ''), 'answer-card-source'),
      );
    const busy = async (work) => {
      const controls = [...node.querySelectorAll('button,textarea')];
      controls.forEach((c) => (c.disabled = true));
      feedback.textContent = '';
      try {
        await work();
        await refresh();
      } catch (error) {
        feedback.textContent = error.message;
        controls.forEach((c) => (c.disabled = false));
      }
    };
    if (current === 'writing') {
      body.append(
        progress(task),
        el(
          'p',
          'The cover letter agent is writing this letter from your CV and the listing. The application waits for your review.',
          'answer-card-message',
        ),
      );
    } else if (current === 'failed') {
      body.append(
        el(
          'p',
          letter.error
            ? 'The cover letter agent stopped: ' + letter.error
            : 'The cover letter agent stopped before saving a letter.',
          'answer-card-message',
        ),
      );
      tools.append(
        button('Try again', () => busy(() => api.reviseCoverLetter(owner, question.id, ''))),
      );
    } else {
      const text = el('textarea', null, 'cover-letter-text'),
        notes = el('textarea', null, 'cover-letter-notes');
      text.value = letter.text ?? '';
      text.setAttribute('aria-label', 'Cover letter text');
      notes.placeholder = 'What should change? (for a rewrite)';
      notes.setAttribute('aria-label', 'Changes for a rewrite');
      body.append(
        el(
          'p',
          'Edit the text if needed, then approve it. The application continues with this letter.',
          'answer-card-message',
        ),
        text,
        notes,
      );
      tools.append(
        button(
          'Approve and continue',
          () => busy(() => api.approveCoverLetter(owner, question.id, text.value)),
          'primary',
        ),
        button('Rewrite', () => busy(() => api.reviseCoverLetter(owner, question.id, notes.value))),
        button('Open PDF ↗', () => api.openDocument(owner, letter.path)),
      );
    }
    if (record?.url) tools.append(button('Open listing ↗', () => api.openLink(record.url)));
    footer.append(tools, feedback);
    node.append(head, body, footer);
    return node;
  }

  return {
    update(data) {
      const owner = data?.automation.id ?? null;
      if (owner !== workspace) {
        cards.clear();
        list.replaceChildren();
        workspace = owner;
      }
      const tasks = data?.tasks ?? [],
        open = (data?.automation.questions ?? []).filter((q) => q.coverLetter && q.answer == null),
        keys = new Set();
      open.forEach((question, n) => {
        const current = state(question, tasks),
          task = tasks.find((t) => t.id === question.coverLetter.taskId),
          key = [
            question.id,
            current,
            current === 'writing' ? task?.state : '',
            question.coverLetter.writtenAt ?? '',
          ].join(':');
        keys.add(key);
        if (!cards.has(key))
          cards.set(
            key,
            card(
              question,
              data.results.find((r) => r.id === question.recordId),
              current,
              task,
            ),
          );
        const node = cards.get(key);
        if (list.children[n] !== node) list.insertBefore(node, list.children[n] ?? null);
      });
      for (const [key, node] of cards)
        if (!keys.has(key)) {
          node.remove();
          cards.delete(key);
        }
      root.hidden = !open.length;
    },
  };
}
