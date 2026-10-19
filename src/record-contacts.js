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
const resendable = new Set(['proposed', 'invited', 'failed', 'uncertain']);
const styleLabels = {
  role_fit: 'Fit with the role',
  team_question: 'Question about the team',
  short_direct: 'Short and direct',
};

export const contactEntry = (data, recordId) =>
  (data?.automation.recordContacts ?? []).find((e) => e.recordId === recordId) ?? null;

export function recordContacts({el, button, api, refresh, rerender}) {
  // Unsaved notes and choices survive the drawer's rebuilds.
  const drafts = new Map(),
    chosen = new Map(),
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

  function contactCard(workspace, result, contact, locked) {
    const card = el('article', null, 'record-contact');
    card.dataset.state = contact.state;
    const head = el('div', null, 'record-contact-head'),
      name = button(
        contact.name + ' ↗',
        () => api.openLink(contact.profileUrl),
        'quiet record-contact-name',
      );
    name.title = contact.profileUrl;
    head.append(
      name,
      el('span', stateLabels[contact.state] ?? contact.state, 'record-contact-state'),
    );
    card.append(head);
    const about = [relationLabels[contact.relation], contact.headline].filter(Boolean).join(' · ');
    if (about) card.append(el('small', about, 'record-contact-about'));
    if (contact.reason) card.append(el('p', contact.reason, 'record-contact-reason'));
    if (contact.listingPoint)
      card.append(el('small', `Listing: “${contact.listingPoint}”`, 'record-contact-hint'));
    const editable = resendable.has(contact.state) && !locked;
    if (editable) {
      const note = el('textarea'),
        count = el('small', null, 'record-contact-count');
      note.maxLength = NOTE_CHARACTERS;
      note.rows = 3;
      note.value = draft(contact);
      note.setAttribute('aria-label', `Note to ${contact.name}`);
      const counted = () => (count.textContent = `${note.value.length}/${NOTE_CHARACTERS}`);
      counted();
      note.oninput = () => {
        drafts.set(contact.id, note.value);
        counted();
      };
      // Kept on leaving the box, so an edit survives without sending.
      note.onchange = () =>
        note.value.trim() &&
        note.value !== contact.message &&
        act(result.id, async () => {
          await api.recordContactEdit(workspace, result.id, contact.id, note.value);
          drafts.delete(contact.id);
        });
      // The agent's three notes: choosing one puts it in the box to send or edit.
      if (contact.options?.length) {
        const options = el('div', null, 'record-contact-options');
        options.setAttribute('role', 'radiogroup');
        options.setAttribute('aria-label', `Note styles for ${contact.name}`);
        for (const option of contact.options) {
          const choice = el('button', null, 'record-contact-option');
          choice.type = 'button';
          choice.setAttribute('role', 'radio');
          choice.setAttribute('aria-checked', String(note.value === option.text));
          choice.append(
            el('b', styleLabels[option.style] ?? option.style),
            el('span', option.text),
          );
          choice.onclick = () => {
            note.value = option.text;
            note.oninput();
            note.onchange();
            for (const other of options.children)
              other.setAttribute('aria-checked', String(other === choice));
          };
          options.append(choice);
        }
        card.append(options);
      }
      const pick = el('label', null, 'record-contact-pick'),
        box = el('input');
      box.type = 'checkbox';
      box.checked = chosen.get(contact.id) ?? contact.state === 'proposed';
      box.onchange = () => chosen.set(contact.id, box.checked);
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
      const remove = button('Remove', () =>
        act(result.id, () => api.recordContactRemove(workspace, result.id, contact.id)),
      );
      const foot = el('div', null, 'record-contact-foot');
      foot.append(pick, count, remove);
      card.append(note, foot);
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
    for (const contact of contacts) cell.append(contactCard(workspace, result, contact, locked));
    const sendable = contacts.filter((c) => resendable.has(c.state));
    if (sendable.length && !locked) {
      const send = button(
        'Approve and send',
        () => {
          const ids = sendable
            .filter((c) => chosen.get(c.id) ?? c.state === 'proposed')
            .map((c) => c.id);
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
            }
          });
        },
        'primary',
      );
      const row = el('div', null, 'record-contacts-send');
      row.append(send);
      cell.append(row);
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
