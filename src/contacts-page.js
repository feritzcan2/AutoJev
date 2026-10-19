// The Contacts page: one compact row per listing, newest search first, with
// what waits on the user. A row opens to that listing's contacts and notes.
// A listing's "Find contacts" menu entry starts the search and opens its row;
// nothing is sent before the user approves it here.
import {recordContacts} from './record-contacts.js';

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
const host = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};
const count = (entry, ...states) => entry.contacts.filter((c) => states.includes(c.state)).length;
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

// Contact tasks at work, for the sidebar: "1 searching", "1 sending".
export function contactsWorking(data) {
  const entries = data?.automation.recordContacts ?? [];
  return {
    searching: entries.filter((e) => e.state === 'searching').length,
    sending: entries.filter((e) => e.contacts.some((c) => c.state === 'queued')).length,
  };
}
// Suggestions waiting for the user's approval, for the sidebar badge.
export const contactsToReview = (data) =>
  (data?.automation.recordContacts ?? []).reduce((n, e) => n + count(e, 'proposed'), 0);

// The row's state, most urgent first: what the user has to do, what runs, what is done.
function entrySummary(entry) {
  const review = count(entry, 'proposed'),
    check = count(entry, 'uncertain', 'failed'),
    sent = count(entry, 'invited', 'messaged'),
    sending = count(entry, 'queued');
  const chips = [];
  if (entry.state === 'searching') chips.push(['active', 'Searching LinkedIn…']);
  if (sending) chips.push(['active', 'Sending…']);
  if (review) chips.push(['waiting', `${review} to approve`]);
  if (check) chips.push(['blocked', `${check} to check`]);
  if (sent) chips.push(['done', `${sent} sent`]);
  if (entry.state === 'failed') chips.push(['blocked', 'Search stopped']);
  if (!chips.length && entry.noneReason) chips.push(['muted', 'No contact found']);
  const group =
    entry.state === 'searching' || sending
      ? 'working'
      : review || check || entry.state === 'failed'
        ? 'review'
        : sent
          ? 'sent'
          : 'other';
  return {chips, group};
}
const FILTERS = [
  ['all', 'All'],
  ['review', 'To review'],
  ['working', 'In progress'],
  ['sent', 'Sent'],
];

// The agent's own words while a contact task runs: its latest messages from
// the worker transcript, newest last.
const UPDATE_LIMIT = 6,
  UPDATE_CHARACTERS = 400,
  POLL_MS = 3000;

export function contactsPage(root, api, {refresh}) {
  let data = null,
    focusId = null,
    filter = 'all',
    polling = false;
  const rows = new Map(),
    open = new Set(),
    updates = new Map(),
    filters = el('div', null, 'record-filter-chips contacts-page-filters'),
    list = el('div', null, 'contacts-page-list'),
    empty = el('p', null, 'contacts-page-empty');
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', 'Filter listings');
  root.className = 'contacts-page';
  root.innerHTML =
    '<div class="section-title"><h2>Contacts</h2><span>LinkedIn people to write to about your listings · nothing is sent until you approve it</span></div>';
  root.append(filters, empty, list);
  // Dropping the cached rows also drops their nodes, so no stale copy stays on the page.
  const reset = () => {
    rows.clear();
    list.replaceChildren();
  };
  const contacts = recordContacts({
    el,
    button,
    api,
    refresh,
    rerender: () => {
      reset();
      render();
    },
  });
  const entryAt = (entry) => Math.max(entry.requestedAt ?? 0, entry.searchedAt ?? 0);
  const liveTask = (entry) =>
    (data?.tasks ?? []).find(
      (t) => t.id === entry.taskId && ['running', 'reported'].includes(t.state),
    );
  // Reads the transcripts of the running contact tasks while this page shows.
  async function poll() {
    if (polling || !data || root.hidden || !root.isConnected) return;
    polling = true;
    try {
      const workspace = data.automation.id;
      let changed = false;
      const live = new Set();
      for (const entry of data.automation.recordContacts ?? []) {
        const task = liveTask(entry);
        if (!task) continue;
        live.add(entry.recordId);
        const {messages = []} = await api.workerTranscript(workspace, task.workerId ?? 'main');
        if (data?.automation.id !== workspace) return;
        const since = (task.startedAt ?? 0) - 1000,
          lines = messages
            .filter((m) => m.role === 'agent' && (!m.at || Date.parse(m.at) >= since))
            .slice(-UPDATE_LIMIT)
            .map((m) => ({text: m.text.slice(0, UPDATE_CHARACTERS), at: m.at}));
        if (JSON.stringify(lines) !== JSON.stringify(updates.get(entry.recordId) ?? [])) {
          updates.set(entry.recordId, lines);
          changed = true;
        }
      }
      for (const recordId of updates.keys())
        if (!live.has(recordId)) {
          updates.delete(recordId);
          changed = true;
        }
      if (changed) render();
    } catch {
      // A transcript that cannot be read leaves the last updates in place.
    } finally {
      polling = false;
    }
  }
  setInterval(poll, POLL_MS);
  function updateList(lines) {
    const box = el('div', null, 'contacts-page-updates');
    box.append(el('small', 'Agent updates', 'contacts-page-updates-title'));
    const list = el('ol');
    for (const line of lines) {
      const item = el('li');
      if (line.at)
        item.append(
          el(
            'time',
            new Date(line.at).toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'}),
          ),
        );
      item.append(el('span', line.text));
      list.append(item);
    }
    box.append(list);
    return box;
  }
  function row(entry, result, summary) {
    const node = el('section', null, 'contacts-page-row'),
      expanded = open.has(entry.recordId);
    node.dataset.recordId = entry.recordId;
    node.dataset.open = String(expanded);
    const head = el('button', null, 'contacts-page-head'),
      title = el('span', null, 'contacts-page-title'),
      chips = el('span', null, 'contacts-page-chips');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(expanded));
    title.append(
      el('b', result.title),
      el(
        'small',
        [result.cells?.company, host(result.url), entry.contacts.map((c) => c.name).join(', ')]
          .filter(Boolean)
          .join(' · '),
      ),
    );
    const lines = updates.get(entry.recordId) ?? [];
    if (lines.length && !expanded)
      title.append(el('small', lines.at(-1).text, 'contacts-page-latest'));
    for (const [tone, text] of summary.chips) {
      const chip = el('span', text, 'contacts-chip');
      chip.dataset.tone = tone;
      chips.append(chip);
    }
    if (!summary.chips.length)
      chips.append(el('small', plural(entry.contacts.length, 'contact'), 'contacts-page-count'));
    head.append(title, chips, el('span', expanded ? '▾' : '▸', 'contacts-page-caret'));
    head.onclick = () => {
      if (open.has(entry.recordId)) open.delete(entry.recordId);
      else open.add(entry.recordId);
      render();
    };
    node.append(head);
    if (expanded) {
      const body = el('div', null, 'contacts-page-body'),
        tools = el('div', null, 'contacts-page-tools');
      tools.append(button('Open listing ↗', () => api.openLink(result.url)));
      body.append(tools);
      if (lines.length) body.append(updateList(lines));
      body.append(contacts.content(result, data));
      node.append(body);
    }
    return node;
  }
  function renderFilters(counts) {
    filters.replaceChildren(
      ...FILTERS.map(([key, label]) => {
        const chip = button(`${label} ${counts[key] ?? 0}`, () => {
          filter = key;
          render();
        });
        chip.setAttribute('aria-pressed', String(filter === key));
        return chip;
      }),
    );
  }
  function render() {
    const entries = (data?.automation.recordContacts ?? [])
      .map((entry) => ({
        entry,
        result: data.results.find((r) => r.id === entry.recordId),
        summary: entrySummary(entry),
      }))
      .filter(({result}) => result)
      .sort((x, y) => entryAt(y.entry) - entryAt(x.entry));
    const counts = {all: entries.length};
    for (const {summary} of entries) counts[summary.group] = (counts[summary.group] ?? 0) + 1;
    renderFilters(counts);
    const shown = entries.filter(({summary}) => filter === 'all' || summary.group === filter);
    empty.hidden = Boolean(shown.length);
    empty.textContent = entries.length
      ? 'No listing matches this filter.'
      : 'No contacts yet. Choose Find contacts in a listing’s … menu on the Tracking table; the agent looks for up to two people on LinkedIn and drafts a note for each.';
    const keys = new Set();
    shown.forEach(({entry, result, summary}, n) => {
      const key = JSON.stringify([
        entry,
        result.title,
        result.url,
        open.has(entry.recordId),
        updates.get(entry.recordId) ?? null,
      ]);
      keys.add(entry.recordId);
      let cached = rows.get(entry.recordId);
      if (cached?.key !== key) {
        cached?.node.remove();
        cached = {key, node: row(entry, result, summary)};
        rows.set(entry.recordId, cached);
      }
      if (list.children[n] !== cached.node)
        list.insertBefore(cached.node, list.children[n] ?? null);
    });
    for (const [recordId, cached] of rows)
      if (!keys.has(recordId)) {
        cached.node.remove();
        rows.delete(recordId);
      }
    if (focusId && rows.has(focusId)) {
      rows.get(focusId).node.scrollIntoView({block: 'start'});
      focusId = null;
    }
  }
  return {
    update(next) {
      if (next?.automation.id !== data?.automation.id) {
        reset();
        open.clear();
      }
      data = next;
      if (!data) {
        reset();
        return;
      }
      render();
      void poll();
    },
    // From a listing's "Find contacts": show its row open, whatever the filter.
    focus(recordId) {
      focusId = recordId;
      filter = 'all';
      open.add(recordId);
      if (data) render();
    },
  };
}
