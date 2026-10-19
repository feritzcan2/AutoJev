// Agent trace viewer (development builds only): everything one run's agent
// received, in order — instruction files, start and follow-up messages, the
// tool list, every tool call with its arguments and full output, and every Jev
// request with its answers. The main process keeps it in RAM.
import './agent-trace.css';
const el = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
const clock = (at) =>
  at
    ? new Date(at).toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '—';
const size = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : String(n ?? 0)) + ' chars';
const button = (label, fn, cls = 'quiet') => {
  const b = el('button', label, cls);
  b.type = 'button';
  b.onclick = fn;
  return b;
};
const block = (label, value) => {
  const details = el('details', null, 'agent-trace-block');
  details.append(
    el('summary', `${label} · ${size(value?.characters)}${value?.truncated ? ' (shortened)' : ''}`),
    el('pre', value?.text ?? ''),
  );
  return details;
};
const percent = (x) => (Number.isFinite(x) ? Math.round(x * 100) + '%' : '—');
// "fit: possible 91% · link0: listing 98%" from Jev answers.
function answerLine(answersBlock) {
  try {
    const answers = JSON.parse(answersBlock?.text ?? 'null');
    return Object.entries(answers ?? {})
      .map(([key, a]) => `${key}: ${a?.choice ?? '?'} ${percent(a?.confidence)}`)
      .join(' · ');
  } catch {
    return '';
  }
}

let availability = null;
export async function devToolsAvailable(api) {
  availability ??= api.devToolsStatus?.().catch(() => ({available: false})) ?? {available: false};
  return (await availability).available === true;
}

const filters = [
  ['all', 'All'],
  ['prompt', 'Instructions'],
  ['tool', 'Tool calls'],
  ['jev', 'Jev'],
  ['error', 'Errors'],
];

// Opens the trace of one run in a modal dialog. `focus` names a tool whose
// last call opens and scrolls into view (for example the score it saved).
export function openAgentTrace(api, workspaceId, runId, {focus = null} = {}) {
  document.querySelector('dialog.agent-trace')?.remove();
  const dialog = el('dialog', null, 'agent-trace');
  dialog.setAttribute('aria-label', 'Agent trace');
  const head = el('div', null, 'agent-trace-head'),
    title = el('div'),
    heading = el('h2', 'Agent trace'),
    meta = el('p', null, 'agent-trace-meta'),
    picker = el('select', null, 'agent-trace-picker'),
    actions = el('div', null, 'agent-trace-actions');
  picker.setAttribute('aria-label', 'Run');
  title.append(heading, meta);
  const refresh = button('Refresh', () => load()),
    close = button('Close', () => dialog.close());
  actions.append(picker, refresh, close);
  head.append(title, actions);
  const bar = el('div', null, 'agent-trace-bar'),
    search = el('input');
  search.type = 'search';
  search.placeholder = 'Filter by tool, title or text';
  search.setAttribute('aria-label', 'Filter events');
  const list = el('ol', null, 'agent-trace-events'),
    state = el('p', 'Loading…', 'agent-trace-state');
  dialog.append(head, bar, state, list);
  document.body.append(dialog);
  let filter = 'all',
    current = null,
    focused = false;
  const open = new Set();
  const chips = filters.map(([key, label]) => {
    const chip = button(label, () => {
      filter = key;
      render();
    });
    chip.dataset.key = key;
    bar.append(chip);
    return chip;
  });
  bar.append(search);
  search.oninput = () => render();

  function eventView(event) {
    const item = el('li', null, 'agent-trace-event'),
      details = el('details');
    item.dataset.type = event.type;
    if (event.error) item.dataset.error = 'true';
    const label =
      event.type === 'tool'
        ? event.name
        : event.type === 'jev'
          ? 'Jev · ' +
            event.questions.slice(0, 4).join(', ') +
            (event.questions.length > 4 ? ` +${event.questions.length - 4}` : '')
          : event.title;
    const line = el('summary');
    line.append(
      el('span', '#' + event.seq, 'agent-trace-seq'),
      el('span', clock(event.at), 'agent-trace-time'),
      el(
        'span',
        {tool: 'Tool', jev: 'Jev', prompt: 'Instructions'}[event.type],
        'agent-trace-kind',
      ),
      el('b', label),
    );
    const extra =
      event.type === 'tool'
        ? `${event.ms ?? '?'} ms · in ${size(event.args?.characters)} · out ${size(event.output?.characters)}${event.error ? ' · error' : ''}`
        : event.type === 'jev'
          ? event.error
            ? `${event.ms ?? '?'} ms · ${event.error}`
            : `${event.ms ?? '?'} ms · ${(event.usage?.input_tokens ?? 0) + (event.usage?.output_tokens ?? 0)} tokens · ${answerLine(event.answers)}`
          : `${event.parts.length} part(s) · ${size(event.parts.reduce((n, p) => n + (p.characters ?? 0), 0))}`;
    line.append(el('small', extra));
    details.append(line);
    details.open = open.has(event.seq);
    details.ontoggle = () => (details.open ? open.add(event.seq) : open.delete(event.seq));
    // The body is built when it first opens; outputs can be large.
    const fill = () => {
      if (details.dataset.filled) return;
      details.dataset.filled = 'true';
      const body = el('div', null, 'agent-trace-body');
      if (event.type === 'tool')
        body.append(
          block('Arguments the agent sent', event.args),
          block('Output the agent received', event.output),
        );
      else if (event.type === 'jev')
        body.append(
          block('State Jev was given', event.state),
          block('Questions', event.instructions),
          block('Answers', event.answers),
        );
      else for (const part of event.parts) body.append(block(part.title || part.key, part));
      // Short blocks open at once; long ones on demand.
      for (const child of body.querySelectorAll('details'))
        child.open = child.querySelector('pre').textContent.length < 4000;
      details.append(body);
    };
    details.addEventListener('toggle', () => details.open && fill());
    if (details.open) fill();
    item.append(details);
    return item;
  }
  const matches = (event, text) =>
    !text ||
    JSON.stringify([event.name, event.title, event.questions, event.args?.text, event.output?.text])
      .toLowerCase()
      .includes(text);
  function render() {
    for (const chip of chips) chip.dataset.active = String(chip.dataset.key === filter);
    list.replaceChildren();
    if (!current) return;
    const text = search.value.trim().toLowerCase(),
      events = current.events.filter(
        (event) =>
          (filter === 'all' || (filter === 'error' ? event.error : event.type === filter)) &&
          matches(event, text),
      );
    for (const event of events) list.append(eventView(event));
    if (!events.length) list.append(el('li', 'No events match.', 'agent-trace-empty'));
    if (focus && !focused) {
      focused = true;
      const last = [...current.events]
        .reverse()
        .find((e) => e.type === 'tool' && e.name.startsWith(focus));
      const node = last && list.querySelector(`li:nth-child(${events.indexOf(last) + 1}) details`);
      if (node) {
        node.open = true;
        node.scrollIntoView({block: 'center'});
      }
    }
  }
  async function pick() {
    const runs = await api.agentTraceRuns(workspaceId).catch(() => []);
    picker.replaceChildren(
      ...runs.map((r) => {
        const option = el(
          'option',
          [
            clock(r.startedAt),
            r.run
              ? `${r.run.kind}${r.run.recordOperation ? ' · ' + r.run.recordOperation : ''}${r.run.dryRun ? ' (trial)' : ''}`
              : 'session',
            `${r.counts.tool} tools · ${r.counts.jev} Jev`,
          ].join(' · '),
        );
        option.value = r.runId;
        return option;
      }),
    );
    if (!runs.some((r) => r.runId === runId)) {
      const option = el('option', 'This run (no trace)');
      option.value = runId;
      picker.prepend(option);
    }
    picker.value = runId;
  }
  picker.onchange = () => {
    runId = picker.value;
    open.clear();
    focus = null;
    load();
  };
  async function load() {
    state.textContent = 'Loading…';
    try {
      current = await api.agentTraceRun(workspaceId, runId);
      const run = current?.run;
      heading.textContent = run
        ? `Agent trace · ${run.kind}${run.recordOperation ? ' · ' + run.recordOperation : ''}${run.dryRun ? ' (trial score)' : ''} · ${run.status}`
        : 'Agent trace';
      meta.textContent = current
        ? [
            `Started ${clock(current.startedAt)}`,
            `last event ${clock(current.lastAt)}`,
            `${current.counts.prompt} instruction events`,
            `${current.counts.tool} tool calls`,
            `${current.counts.jev} Jev requests`,
            current.counts.error ? `${current.counts.error} errors` : null,
            current.dropped ? `${current.dropped} oldest events dropped` : null,
            run?.summary || null,
          ]
            .filter(Boolean)
            .join(' · ')
        : '';
      state.textContent = current
        ? ''
        : 'No trace for this run. Traces live in RAM: runs before the last app start, or from a packaged build, have none.';
      render();
    } catch (error) {
      state.textContent = error.message;
    }
  }
  // Follows a live run without losing what is open.
  let timer = null;
  const stop = api.onAgentTraceChange?.((event) => {
    if (event?.workspaceId !== workspaceId || timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (dialog.open && current?.run?.status === 'running') load();
    }, 1500);
  });
  dialog.addEventListener('close', () => {
    stop?.();
    clearTimeout(timer);
    dialog.remove();
  });
  dialog.showModal();
  void pick().then(load);
  return dialog;
}
