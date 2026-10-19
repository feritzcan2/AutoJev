// The Contacts page: every listing's LinkedIn contacts in one place, newest
// search first. A listing's "Find contacts" menu entry starts the search and
// opens this page; nothing is sent before the user approves it here.
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
const company = (result) => result.cells?.company || null;

// Suggestions waiting for the user's approval, for the sidebar badge.
export const contactsToReview = (data) =>
  (data?.automation.recordContacts ?? []).reduce(
    (n, e) => n + e.contacts.filter((c) => c.state === 'proposed').length,
    0,
  );

export function contactsPage(root, api, {refresh}) {
  let data = null,
    focusId = null;
  const groups = new Map(),
    list = el('div', null, 'contacts-page-list'),
    empty = el(
      'p',
      'No contacts yet. Choose Find contacts in a listing’s … menu on the Tracking table; the agent looks for up to two people on LinkedIn and drafts a note for each.',
      'contacts-page-empty',
    );
  root.className = 'contacts-page';
  root.innerHTML =
    '<div class="section-title"><h2>Contacts</h2><span>LinkedIn people to write to about your listings · nothing is sent until you approve it</span></div>';
  root.append(empty, list);
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
  // Dropping the cached groups also drops their nodes, so no stale copy stays on the page.
  const reset = () => {
    groups.clear();
    list.replaceChildren();
  };
  const entryKey = (entry) => Math.max(entry.requestedAt ?? 0, entry.searchedAt ?? 0);
  function group(entry, result) {
    const node = el('section', null, 'contacts-page-group');
    node.dataset.recordId = entry.recordId;
    const head = el('div', null, 'contacts-page-head'),
      title = el('div');
    title.append(
      el('h3', result.title),
      el(
        'small',
        [company(result), new URL(result.url).hostname.replace(/^www\./, '')]
          .filter(Boolean)
          .join(' · '),
      ),
    );
    head.append(
      title,
      button('Open listing ↗', () => api.openLink(result.url)),
    );
    node.append(head, contacts.content(result, data));
    return node;
  }
  function render() {
    const entries = (data?.automation.recordContacts ?? [])
      .map((entry) => ({entry, result: data.results.find((r) => r.id === entry.recordId)}))
      .filter(({result}) => result)
      .sort((x, y) => entryKey(y.entry) - entryKey(x.entry));
    empty.hidden = Boolean(entries.length);
    const keys = new Set();
    entries.forEach(({entry, result}, n) => {
      const key = JSON.stringify([entry, result.title, result.url]);
      keys.add(key);
      if (!groups.has(key)) groups.set(key, group(entry, result));
      const node = groups.get(key);
      if (list.children[n] !== node) list.insertBefore(node, list.children[n] ?? null);
    });
    for (const [key, node] of groups)
      if (!keys.has(key)) {
        node.remove();
        groups.delete(key);
      }
    if (focusId) {
      const node = list.querySelector(`[data-record-id="${CSS.escape(focusId)}"]`);
      if (node) {
        node.scrollIntoView({block: 'start'});
        focusId = null;
      }
    }
  }
  return {
    update(next) {
      if (next?.automation.id !== data?.automation.id) reset();
      data = next;
      if (!data) {
        reset();
        return;
      }
      render();
    },
    focus(recordId) {
      focusId = recordId;
      if (data) render();
    },
  };
}
