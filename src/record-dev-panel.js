// The record side panel's developer section (development builds only): the
// trace of the run that saved the score, and trial scores — an ordinary
// scoring run whose assessment is kept in RAM instead of on the record, so the
// same listing can be scored again and compared with the saved score.
import {openAgentTrace} from './agent-trace.js';

const el = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
const clock = (at) =>
  at
    ? new Date(at).toLocaleString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '—';
const POLL_MS = 3000;

export function recordDevPanel(api, {workspace, recordId}) {
  const section = el('section', null, 'record-dev-panel'),
    head = el('div', null, 'record-dev-head'),
    actions = el('div', null, 'record-dev-actions'),
    state = el('p', null, 'record-dev-state'),
    list = el('ol', null, 'record-dev-scores');
  head.append(el('h3', 'Developer'), actions);
  section.append(
    head,
    el(
      'small',
      'Development build. A trial score runs the ordinary scoring agent but keeps its score here; the record is unchanged. Trial scores and traces are cleared when the app restarts.',
    ),
    state,
    list,
  );
  let record = null,
    timer = null,
    busy = false;
  const button = (label, fn, cls = 'quiet') => {
    const b = el('button', label, cls);
    b.type = 'button';
    b.onclick = async () => {
      if (busy) return;
      busy = true;
      b.disabled = true;
      state.dataset.tone = '';
      try {
        await fn();
      } catch (error) {
        state.dataset.tone = 'error';
        state.textContent = error.message;
      } finally {
        busy = false;
        b.disabled = false;
      }
    };
    return b;
  };
  const scoreTrace = button('Trace of this score', async () => {
      openAgentTrace(api, workspace(), record.assessment.runId, {focus: 'record_automation_'});
    }),
    trial = button(
      'Trial score',
      async () => {
        await api.devTrialScore(workspace(), recordId);
        state.textContent = 'Trial scoring queued; it starts when a worker is free.';
        await load();
      },
      'primary',
    );
  scoreTrace.title = 'What the agent read and sent before it saved this score.';
  trial.title = 'Score this record again with the current profile and rubric, without saving.';
  actions.append(scoreTrace, trial);

  function scoreView(entry) {
    const item = el('li'),
      a = entry.assessment,
      saved = record?.assessment?.score,
      line = el('div', null, 'record-dev-score-line');
    line.append(
      el('b', a.score === null ? 'Not assessable' : `${a.score}/100`),
      el('span', `${a.eligibility} · ${clock(entry.at)}`),
    );
    if (Number.isInteger(saved) && Number.isInteger(a.score))
      line.append(
        el(
          'span',
          a.score === saved
            ? 'same as saved'
            : `${a.score > saved ? '+' : ''}${a.score - saved} vs saved ${saved}`,
          'record-dev-diff',
        ),
      );
    line.append(
      button('Trace', async () =>
        openAgentTrace(api, workspace(), entry.runId, {focus: 'record_automation_'}),
      ),
    );
    item.append(line, el('p', a.summary));
    const details = el('details');
    details.append(el('summary', 'Matches, gaps, uncertainties and evidence'));
    for (const [key, label] of [
      ['strengths', 'Matches'],
      ['gaps', 'Gaps'],
      ['uncertainties', 'Uncertainties'],
    ])
      if (a[key]?.length) {
        const ul = el('ul');
        for (const note of a[key]) ul.append(el('li', note));
        details.append(el('h4', label), ul);
      }
    if (a.eligibilityReason) details.append(el('h4', 'Eligibility'), el('p', a.eligibilityReason));
    if (a.evidence) details.append(el('h4', 'Evidence'), el('blockquote', a.evidence));
    item.append(details);
    return item;
  }
  async function load() {
    const {scores, queued} = await api.devTrialScores(workspace(), recordId);
    list.replaceChildren(...scores.map(scoreView));
    if (queued.length)
      state.textContent = `Trial scoring ${queued.map((q) => q.state).join(', ')}…`;
    else if (state.dataset.tone !== 'error')
      state.textContent = scores.length ? '' : 'No trial scores yet.';
    clearTimeout(timer);
    timer = queued.length
      ? setTimeout(() => {
          if (section.isConnected) void load().catch(() => {});
        }, POLL_MS)
      : null;
  }
  return {
    element: section,
    update(next) {
      record = next;
      scoreTrace.hidden = !next.assessment?.runId;
      void load().catch((error) => {
        state.dataset.tone = 'error';
        state.textContent = error.message;
      });
    },
  };
}
