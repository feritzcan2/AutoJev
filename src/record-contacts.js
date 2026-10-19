// One listing's LinkedIn contacts on the Contacts page: the people a contact
// task found, with the invitation note the user edits and approves. Nothing
// is sent before the user's "Approve and send".
const NOTE_CHARACTERS = 200;
const relationLabels = {
  poster: 'Posted the listing',
  recruiter: 'Recruiter',
  hiring_manager: 'Hiring manager',
  team: 'Team',
};
const stateLabels = {
  proposed: 'Suggested',
  queued: 'Sending…',
  invited: 'Invited',
  messaged: 'Messaged',
  uncertain: 'Check LinkedIn',
  failed: 'Not sent',
};
const styleLabels = {
  direct: ['Direct', 'Strengths first, short'],
  personal: ['Personal', 'Warm, ends with a question'],
};
const resendable = new Set(['proposed', 'invited', 'failed', 'uncertain']);

export const contactEntry = (data, recordId) =>
  (data?.automation.recordContacts ?? []).find((e) => e.recordId === recordId) ?? null;

export function recordContacts({el, button, api, refresh, rerender}) {
  // Unsaved notes and choices survive the drawer's rebuilds.
  const drafts = new Map(),
    chosen = new Map(),
    styles = new Map(),
    searchNotes = new Map(),
    errors = new Map();
  let busy = false;
  const fail = (recordId, message) => {
    errors.set(recordId, message);
    rerender();
  };
  const act = async (recordId, work) => {
    if (busy) return;
    busy = true;
    errors.delete(recordId);
    try {
      await work();
      await refresh();
    } catch (error) {
      errors.set(recordId, error.message);
    } finally {
      busy = false;
      rerender();
    }
  };
  const draft = (contact) => drafts.get(contact.id) ?? contact.message;
  const find = (workspace, recordId) =>
    act(recordId, async () => {
      await api.recordContactsFind(workspace, recordId, searchNotes.get(recordId) ?? '');
      searchNotes.delete(recordId);
    });

  // Initials for the card's avatar.
  const initials = (name) =>
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0].toUpperCase())
      .join('');

  // The note being edited, with its counter; kept on leaving the box, so an
  // edit survives without sending.
  function noteBox(workspace, result, contact, original) {
    const box = el('div', null, 'record-contact-editor'),
      note = el('textarea'),
      meta = el('div', null, 'record-contact-meta'),
      edited = el('small', 'Edited', 'record-contact-edited'),
      count = el('small', null, 'record-contact-count');
    note.maxLength = NOTE_CHARACTERS;
    note.rows = 4;
    note.value = draft(contact);
    note.setAttribute('aria-label', `Note to ${contact.name}`);
    const counted = () => {
      count.textContent = `${note.value.length}/${NOTE_CHARACTERS}`;
      edited.hidden = original == null || note.value === original;
    };
    counted();
    note.oninput = () => {
      drafts.set(contact.id, note.value);
      counted();
    };
    note.onchange = () => {
      const text = note.value;
      if (text.trim() && text !== contact.message)
        act(result.id, async () => {
          await api.recordContactEdit(workspace, result.id, contact.id, text);
          if (drafts.get(contact.id) === text) drafts.delete(contact.id);
        });
    };
    meta.append(edited, count);
    box.append(note, meta);
    return box;
  }

  // The two notes the agent wrote, side by side: the chosen one is edited in
  // place, a click on the other switches to it.
  function noteChoice(workspace, result, contact) {
    const choice = el('div', null, 'record-contact-options'),
      current = draft(contact),
      active =
        styles.get(contact.id) ??
        contact.notes.find((o) => o.text === current)?.style ??
        contact.notes[0].style;
    choice.setAttribute('role', 'radiogroup');
    choice.setAttribute('aria-label', `Note style for ${contact.name}`);
    for (const option of contact.notes) {
      const [label, hint] = styleLabels[option.style] ?? [option.style, ''],
        on = option.style === active,
        tile = el('div', null, 'record-contact-option'),
        top = el('div', null, 'record-contact-option-top');
      tile.setAttribute('role', 'radio');
      tile.setAttribute('aria-checked', String(on));
      top.append(el('b', label), el('small', hint));
      tile.append(top);
      if (on) tile.append(noteBox(workspace, result, contact, option.text));
      else {
        tile.tabIndex = 0;
        tile.title = 'Use this note';
        tile.append(
          el('p', option.text, 'record-contact-option-text'),
          el('small', 'Use this note', 'record-contact-option-use'),
        );
        // Shown at once and saved in the background, so a pending edit cannot win.
        const use = () => {
          styles.set(contact.id, option.style);
          drafts.set(contact.id, option.text);
          rerender();
          api
            .recordContactEdit(workspace, result.id, contact.id, option.text)
            .then(refresh, (error) => fail(result.id, error.message));
        };
        tile.onclick = use;
        tile.onkeydown = (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          use();
        };
      }
      choice.append(tile);
    }
    return choice;
  }

  function contactCard(workspace, result, contact, locked, picked) {
    const card = el('article', null, 'record-contact');
    card.dataset.state = contact.state;
    const head = el('header', null, 'record-contact-head'),
      who = el('div', null, 'record-contact-who'),
      name = button(
        contact.name + ' ↗',
        () => api.openLink(contact.profileUrl),
        'quiet record-contact-name',
      );
    name.title = contact.profileUrl;
    who.append(name);
    const about = [relationLabels[contact.relation], contact.headline].filter(Boolean).join(' · ');
    if (about) who.append(el('small', about, 'record-contact-about'));
    head.append(
      el('span', initials(contact.name), 'record-contact-avatar'),
      who,
      el('span', stateLabels[contact.state] ?? contact.state, 'record-contact-state'),
    );
    card.append(head);
    if (contact.reason) {
      const reason = el('p', null, 'record-contact-reason');
      reason.append(el('b', 'Why: '), contact.reason);
      card.append(reason);
    }
    const editable = resendable.has(contact.state) && !locked;
    if (editable) {
      card.append(
        contact.notes?.length > 1
          ? noteChoice(workspace, result, contact)
          : noteBox(workspace, result, contact, null),
      );
      const pick = el('label', null, 'record-contact-pick'),
        box = el('input');
      box.type = 'checkbox';
      box.checked = chosen.get(contact.id) ?? contact.state === 'proposed';
      box.onchange = () => {
        chosen.set(contact.id, box.checked);
        picked();
      };
      pick.append(
        box,
        el(
          'span',
          contact.state === 'invited'
            ? 'Send as a message (only after they accept)'
            : contact.state === 'proposed'
              ? 'Send this invitation'
              : 'Try again',
        ),
      );
      const remove = button(
        'Remove',
        () => act(result.id, () => api.recordContactRemove(workspace, result.id, contact.id)),
        'quiet record-contact-remove',
      );
      const foot = el('div', null, 'record-contact-foot');
      foot.append(pick, remove);
      card.append(foot);
    } else card.append(el('blockquote', contact.message, 'record-contact-note'));
    if (contact.state === 'invited' && contact.outcome === 'invited_without_note')
      card.append(
        el(
          'small',
          'Invited without a note (LinkedIn note limit). The note waits to be sent as a message once they accept.',
          'record-contact-hint',
        ),
      );
    const detail = contact.error || (contact.sentAt ? contact.evidence : '');
    if (detail) card.append(el('small', detail, 'record-contact-hint'));
    return card;
  }

  function content(result, data) {
    const cell = el('div', null, 'record-contacts'),
      workspace = data.automation.id,
      entry = contactEntry(data, result.id),
      contacts = entry?.contacts ?? [],
      searching = entry?.state === 'searching',
      sending = contacts.some((c) => c.state === 'queued'),
      locked = searching || sending;
    if (searching) cell.append(el('p', 'Searching LinkedIn…', 'record-listing-state'));
    else if (entry?.state === 'failed')
      cell.append(
        el('p', `The search stopped: ${entry.error || 'no reason given'}`, 'record-listing-state'),
      );
    else if (entry?.noneReason)
      cell.append(
        el('p', `No suitable contact found: ${entry.noneReason}`, 'record-listing-state'),
      );
    const sendable = contacts.filter((c) => resendable.has(c.state)),
      selected = () =>
        sendable.filter((c) => chosen.get(c.id) ?? c.state === 'proposed').map((c) => c.id);
    let send = null;
    // The send button names how many go out.
    const picked = () => {
      if (!send) return;
      const n = selected().length;
      send.textContent = n ? `Approve and send ${n}` : 'Approve and send';
      send.disabled = !n;
    };
    const people = el('div', null, 'record-contacts-people');
    for (const contact of contacts)
      people.append(contactCard(workspace, result, contact, locked, picked));
    if (contacts.length) cell.append(people);
    if (sendable.length && !locked) {
      send = button(
        'Approve and send',
        () => {
          const ids = selected();
          if (!ids.length) return fail(result.id, 'Choose a contact to send to.');
          return act(result.id, async () => {
            await api.recordContactsSend(
              workspace,
              result.id,
              ids,
              Object.fromEntries(ids.map((id) => [id, draft(contacts.find((c) => c.id === id))])),
            );
            for (const id of ids) {
              drafts.delete(id);
              chosen.delete(id);
              styles.delete(id);
            }
          });
        },
        'primary',
      );
      const row = el('div', null, 'record-contacts-send');
      row.append(el('small', 'Nothing goes out before you approve it.'), send);
      cell.append(row);
      picked();
    }
    const find = el('div', null, 'record-contacts-find'),
      notes = el('input');
    notes.placeholder = 'Notes for the search (optional), e.g. "the data team lead"';
    notes.maxLength = 1000;
    notes.value = searchNotes.get(result.id) ?? '';
    notes.oninput = () => searchNotes.set(result.id, notes.value);
    notes.disabled = locked;
    const start = button(contacts.length || entry ? 'Find again' : 'Find contacts', () =>
      find(workspace, result.id),
    );
    start.disabled = locked;
    find.append(notes, start);
    cell.append(find);
    if (errors.has(result.id)) {
      const error = el('p', errors.get(result.id), 'record-contacts-error');
      error.setAttribute('role', 'alert');
      cell.append(error);
    }
    return cell;
  }
  return {content, find};
}
