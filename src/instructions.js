import {instructionExplanation} from './instruction-explanations.js';
import './instructions.css';
const labels = {
  system: 'System',
  template: 'Template',
  workspace: 'Workspace',
  user: 'User',
  skill: 'Skill',
  tool: 'Tool',
};
const states = {
  unrecorded: 'No record in the selected scope',
  changed: 'Current version differs from the recorded one',
  available: 'Present in a file · reading not verified',
  recorded: 'Same content is recorded',
};
const statuses = {
  available: 'Accessible from a file',
  requested: 'Delivery requested',
  accepted: 'Request accepted',
  returned: 'Tool reply returned',
  observed: 'Provider notice',
  failed: 'Failed',
};
const fieldLabels = {
  goal: 'Goal',
  criteria: 'Criteria',
  instructions: 'Custom instructions',
  facts: 'User information',
  mode: 'Action permission',
  sources: 'Sources',
  guidance: 'Template rules',
  workflow: 'Task steps',
  fields: 'Setup questions',
  preferences: 'Preferences',
  authorization: 'Action permission',
  applicationPolicy: 'Application rules',
  maxActionsPerDay: 'Daily action limit',
  maxBrowserSteps: 'Browser step limit',
  timeoutMinutes: 'Time limit',
  title: 'Title',
};
const node = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const time = (value) =>
  new Date(value).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
const title = (part) => fieldLabels[part.key.split(':').at(-1)] ?? part.title;
const workerName = (id) => (id === 'main' ? 'Worker 1' : id);
function textBody(part) {
  const wrap = node('div', 'instruction-text'),
    head = node('div', 'instruction-text-head'),
    copy = node('button', 'quiet', 'Copy');
  copy.type = 'button';
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(part.text);
      copy.textContent = 'Copied';
    } catch {
      copy.textContent = 'Could not copy';
    }
  };
  head.append(
    node(
      'small',
      '',
      `${(part.characters ?? part.text.length).toLocaleString('en-GB')} characters`,
    ),
    copy,
  );
  wrap.append(head);
  if (part.truncated)
    wrap.append(
      node(
        'p',
        'instruction-warning',
        'This long content was cut at the record limit; the text below is not the full content.',
      ),
    );
  wrap.append(node('pre', '', part.text || '(Empty)'));
  return wrap;
}
export function instructionsPanel(api, agent) {
  const tabs = node('div', 'agent-view-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Agent views');
  const live = node('button', '', 'Workspace'),
    inspect = node('button', '', 'Instructions');
  for (const [button, name] of [
    [live, 'work'],
    [inspect, 'instructions'],
  ]) {
    button.type = 'button';
    button.id = 'agent-tab-' + name;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', name === 'instructions' ? 'agent-instructions' : 'agent');
    button.onclick = () => show(name);
    tabs.append(button);
  }
  const root = node('section', 'instruction-panel');
  root.id = 'agent-instructions';
  root.hidden = true;
  root.setAttribute('aria-labelledby', inspect.id);
  root.setAttribute('role', 'tabpanel');
  root.innerHTML = `<div class="instruction-heading"><div><span class="instruction-eyebrow">AGENT CONTEXT</span><h2>Which instruction, which session?</h2><p>Review the current rules and compare them with what a session received.</p></div><button type="button" class="quiet" data-refresh>Refresh</button></div>
 <div class="instruction-agents" role="tablist" aria-label="Agent types"></div><div class="instruction-agent-summary"></div>
 <div class="instruction-filters"><label>Worker<select data-worker aria-label="Instruction worker filter"></select></label><label>Session<select data-session aria-label="Instruction session filter"></select></label><label class="instruction-search">Search text<input type="search" data-search placeholder="Tab, budget, permission…" aria-label="Search instructions"></label></div>
 <p class="instruction-error" role="alert" hidden></p><div class="instruction-stats"></div>
 <div class="instruction-modes" role="tablist" aria-label="Instruction view"><button type="button" role="tab" data-mode="parts">Instruction parts</button><button type="button" role="tab" data-mode="history">Delivery history</button></div>
 <details class="instruction-guide"><summary>How do instructions reach the agent?</summary><ol><li><strong>A session opens:</strong> The selected agent’s instruction is given as a system/developer message. The start message is delivered, and the shared instruction and skill files are made accessible. Reading a file is a separate step.</li><li><strong>A task starts:</strong> The agent asks for the saved plan and task details; your criteria, custom instructions and action permission are given inside that reply.</li><li><strong>The agent works:</strong> It receives new information as the pages it opens and the tools it uses return results. The whole plan is not resent on every action.</li></ol><p>This page shows the current definitions. Changing a setting does not mean a running agent sees the change right away. Check what a specific session received in the <strong>Delivery history</strong> section.</p></details>
 <p class="instruction-scope"></p><div class="instruction-sources"></div><div class="instruction-content"></div><button type="button" class="quiet instruction-more" hidden>Older records</button>
 <p class="instruction-footnote">A file being present in a session does not prove it was read, and a queued message does not prove the model processed it. Keys typed directly in the terminal, the provider’s own instructions and replies from external tools are not tracked in this history. Records are created after this feature is enabled; a 30-day limit and record limits apply.</p>`;
  agent.prepend(tabs);
  agent.append(root);
  const find = (q) => root.querySelector(q),
    content = find('.instruction-content'),
    search = find('[data-search]'),
    worker = find('[data-worker]'),
    session = find('[data-session]'),
    error = find('.instruction-error');
  let owner = null,
    visible = false,
    mode = 'parts',
    source = '',
    profile = '',
    data = null,
    version = 0,
    timer = null,
    loading = false;
  const detailCache = new Map();
  let editing = null;
  function renderAgents() {
    const strip = find('.instruction-agents');
    strip.replaceChildren();
    strip.onkeydown = (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...strip.querySelectorAll('button')],
        index = buttons.indexOf(document.activeElement),
        next =
          buttons[
            (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
          ];
      next?.click();
      next?.focus();
    };
    for (const item of [...(data?.profiles ?? []), {id: 'all', name: 'All records'}]) {
      const button = node('button', '', item.name);
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(profile === item.id));
      button.tabIndex = profile === item.id ? 0 : -1;
      button.onclick = () => {
        if (
          editing &&
          editing.value !== editing.original &&
          !window.confirm('Discard the unsaved agent instruction?')
        )
          return;
        editing = null;
        profile = item.id;
        worker.value = '';
        session.value = '';
        source = '';
        if (profile === 'all') mode = 'history';
        void refresh();
      };
      strip.append(button);
    }
    strip.hidden = !data?.profiles?.length;
    const summary = find('.instruction-agent-summary'),
      selected = data?.profiles?.find((a) => a.id === profile);
    summary.replaceChildren();
    if (!selected) return;
    summary.append(
      node('h3', '', selected.name + ' agent'),
      node('p', '', selected.description),
      node('p', '', selected.when),
      node(
        'small',
        '',
        `Version ${selected.version} · ${selected.agent_id} · ${selected.selection.model}. Provider and model come from the workspace settings.`,
      ),
    );
    const edit = node('details', 'instruction-profile-editor');
    edit.append(node('summary', '', 'Edit agent instruction'));
    const note = node(
      'p',
      '',
      'The saved instruction is given as the system/developer instruction when the next session opens. An open session continues with its own version. Shared rules are shown separately below.',
    );
    const input = node('textarea');
    input.setAttribute('aria-label', 'Agent instruction');
    input.value = editing?.id === profile ? editing.value : selected.instructions;
    input.rows = 10;
    if (editing?.id === profile) edit.open = true;
    input.oninput = () => {
      if (!editing)
        editing = {id: profile, revision: data.profileRevision, original: selected.instructions};
      editing.value = input.value;
    };
    const save = node('button', '', 'Save instruction');
    save.type = 'button';
    save.onclick = async () => {
      save.disabled = true;
      try {
        await api.saveAgentProfile(owner, selected.role, {
          instructions: input.value,
          expectedRevision: editing?.revision ?? data.profileRevision,
        });
        editing = null;
        await refresh();
      } catch (e) {
        fail(e);
      } finally {
        save.disabled = false;
      }
    };
    edit.append(note, input, save);
    summary.append(edit);
  }
  const workerLabel = (id) => data?.workers?.find((w) => w.id === id)?.name ?? workerName(id);
  const fail = (e) => {
    error.textContent = e.message;
    error.hidden = false;
  };
  function show(name) {
    visible = name === 'instructions';
    agent.dataset.panel = name;
    root.hidden = !visible;
    for (const [button, selected] of [
      [live, !visible],
      [inspect, visible],
    ]) {
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    if (visible) void refresh();
  }
  tabs.onkeydown = (e) => {
    if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      show(visible ? 'work' : 'instructions');
      (visible ? inspect : live).focus();
    }
  };
  function filters() {
    const selectedWorker = worker.value,
      selectedSession = session.value,
      workers = [
        ...new Set([
          ...(data?.sessions ?? []).map((s) => s.workerId),
          ...(data?.activeSessions ?? []).map((s) => s.workerId),
        ]),
      ];
    worker.replaceChildren(
      new Option('All workers', ''),
      ...workers.map((id) => new Option(workerLabel(id), id)),
    );
    worker.value = workers.includes(selectedWorker) ? selectedWorker : '';
    const all = new Map((data?.sessions ?? []).map((s) => [s.id, s]));
    for (const active of data?.activeSessions ?? [])
      if (!all.has(active.id)) all.set(active.id, active);
    const sessions = [...all.values()].filter((s) => !worker.value || s.workerId === worker.value);
    session.replaceChildren(
      new Option('All sessions', ''),
      ...sessions.map(
        (s) =>
          new Option(
            `${data.activeSessions.some((a) => a.id === s.id) ? '● Open · ' : ''}${s.startedAt ? time(s.startedAt) + ' · ' : ''}${workerLabel(s.workerId)} · ${s.id.slice(0, 8)}`,
            s.id,
          ),
      ),
    );
    session.value = sessions.some((s) => s.id === selectedSession) ? selectedSession : '';
  }
  async function refresh({older = false} = {}) {
    if (!visible || !owner) {
      if (visible) render();
      return;
    }
    const id = owner,
      request = ++version;
    loading = true;
    error.hidden = true;
    find('[data-refresh]').disabled = true;
    try {
      const next = await api.instructionSnapshot(id, {
        profile,
        worker: worker.value,
        session: session.value,
        ...(older && data?.next ? {before: data.next} : {}),
      });
      if (request !== version || owner !== id) return;
      data = older ? {...next, events: [...data.events, ...next.events]} : next;
      profile = next.selectedProfileId ?? (profile === 'all' ? 'all' : '');
      filters();
      render();
    } catch (e) {
      if (request === version) fail(e);
    } finally {
      if (request === version) {
        loading = false;
        find('[data-refresh]').disabled = false;
      }
    }
  }
  function schedule() {
    if (!visible || agent.hidden || loading) return;
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), 400);
  }
  function render() {
    renderAgents();
    find('[data-mode=parts]').disabled = profile === 'all';
    const open = new Set(
      [...content.querySelectorAll('details[open][data-key]')].map((n) => n.dataset.key),
    );
    content.replaceChildren();
    for (const button of root.querySelectorAll('[data-mode]'))
      button.setAttribute('aria-selected', String(button.dataset.mode === mode));
    find('.instruction-more').hidden = mode !== 'history' || !data?.next;
    const stats = find('.instruction-stats');
    stats.replaceChildren();
    for (const [value, label] of [
      [data?.parts.length ?? 0, 'Defined parts'],
      [data?.activeSessions.length ?? 0, 'Open sessions'],
      [data?.events.length ?? 0, 'Events shown'],
    ]) {
      const card = node('div');
      card.append(node('strong', '', String(value)), node('span', '', label));
      stats.append(card);
    }
    find('.instruction-scope').textContent =
      mode === 'parts'
        ? 'Currently defined content · States are compared with the latest stored content of the worker and session you selected.'
        : 'Actual run records · Newest event first. New records of an open session appear automatically. Search covers loaded event titles and part names.';
    const sources = find('.instruction-sources');
    sources.replaceChildren();
    sources.hidden = mode === 'history';
    for (const [id, label] of [['', 'All'], ...Object.entries(labels)]) {
      const b = node('button', source === id ? 'selected' : '', label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(source === id));
      b.onclick = () => {
        source = id;
        render();
      };
      sources.append(b);
    }
    if (!owner) {
      content.append(node('p', 'instruction-empty', 'Select a workspace to see its instructions.'));
      return;
    }
    if (!data) {
      content.append(node('p', 'instruction-empty', 'Loading instructions…'));
      return;
    }
    const query = search.value.toLocaleLowerCase('en-GB');
    if (mode === 'parts') {
      for (const part of data.parts) {
        if (
          (source && part.source !== source) ||
          (query && !`${title(part)} ${part.text}`.toLocaleLowerCase('en-GB').includes(query))
        )
          continue;
        const card = node('details', 'instruction-card');
        card.dataset.key = part.key;
        card.open = open.has(part.key);
        const summary = node('summary'),
          main = node('div');
        const explanation = instructionExplanation(part);
        main.append(
          node('small', 'instruction-source', labels[part.source] ?? part.source),
          node('strong', '', title(part)),
          node('span', 'instruction-purpose', explanation.purpose),
        );
        const timing = node('span', 'instruction-when');
        timing.append(
          node('b', '', 'When is it given? '),
          document.createTextNode(explanation.timing),
        );
        main.append(timing);
        const help = node('div', 'instruction-change');
        help.append(
          node('strong', '', 'What happens if you change it?'),
          node('p', '', explanation.change),
        );

        const state = node('span', 'instruction-state', states[part.state]);
        state.dataset.state = part.state;
        summary.append(main, state);
        card.append(summary, help, textBody(part));
        content.append(card);
      }
    } else {
      for (const event of data.events) {
        if (
          query &&
          !`${event.title} ${event.detail ?? ''} ${event.parts.map((p) => p.title).join(' ')}`
            .toLocaleLowerCase('en-GB')
            .includes(query)
        )
          continue;
        const card = node('details', 'instruction-event');
        card.dataset.key = String(event.seq);
        const summary = node('summary'),
          main = node('div');
        main.append(
          node(
            'small',
            '',
            `${time(event.at)} · ${workerLabel(event.workerId)} · ${event.sessionId.slice(0, 8)}`,
          ),
          node('strong', '', event.title),
          node('span', 'instruction-when', event.detail ?? `${event.parts.length} content parts`),
        );
        const status = node('span', 'instruction-state', statuses[event.status] ?? event.status);
        status.dataset.state = event.status;
        summary.append(main, status);
        card.append(summary);
        const body = node('div', 'instruction-event-body');
        card.append(body);
        let loaded = false;
        const load = async () => {
          if (loaded) return;
          loaded = true;
          body.textContent = 'Loading content…';
          const id = owner;
          try {
            let full = detailCache.get(event.seq);
            if (!full) {
              full = await api.instructionEvent(id, event.seq);
              if (owner !== id) return;
              detailCache.set(event.seq, full);
            }
            body.replaceChildren();
            if (!full.parts.length)
              body.append(node('p', '', full.detail ?? 'This event did not send new content.'));
            for (const part of full.parts) {
              const item = node('details', 'instruction-part');
              item.append(
                node('summary', '', `${labels[part.source] ?? part.source} · ${title(part)}`),
                textBody(part),
              );
              body.append(item);
            }
          } catch (e) {
            loaded = false;
            body.textContent = e.message;
          }
        };
        card.ontoggle = () => {
          if (card.open) void load();
        };
        if (open.has(card.dataset.key)) {
          card.open = true;
          void load();
        }
        content.append(card);
      }
    }
    if (!content.children.length)
      content.append(
        node(
          'p',
          'instruction-empty',
          query || source
            ? 'No content matches this filter.'
            : mode === 'history'
              ? 'No records yet. New agent sessions and tool replies will appear here.'
              : 'This template defines no instruction parts.',
        ),
      );
  }
  worker.onchange = () => {
    session.value = '';
    void refresh();
  };
  session.onchange = () => void refresh();
  search.oninput = render;
  for (const button of root.querySelectorAll('[data-mode]'))
    button.onclick = () => {
      mode = button.dataset.mode;
      search.value = '';
      render();
    };
  find('[data-refresh]').onclick = () => void refresh();
  find('.instruction-more').onclick = () => void refresh({older: true});
  api.onInstructionsChange?.(({workspaceId}) => {
    if (workspaceId === owner) schedule();
  });
  api.onLogsCleared?.(() => {
    detailCache.clear();
    data = null;
    void refresh();
  });
  show('work');
  return {
    select(id) {
      if (id === owner) {
        schedule();
        return;
      }
      owner = id;
      profile = '';
      editing = null;
      version++;
      loading = false;
      find('[data-refresh]').disabled = false;
      data = null;
      detailCache.clear();
      worker.replaceChildren(new Option('All workers', ''));
      session.replaceChildren(new Option('All sessions', ''));
      error.hidden = true;
      if (visible) {
        render();
        void refresh();
      }
    },
    show: () => show('instructions'),
  };
}
