// The short qualification profile Jev compares every listing with. The user
// sees what Jev reads and can correct it; an edit they save is kept.
const states = {
  missing:
    'Not written yet. The agent writes it from your documents and facts on the next scan; until then Jev reads the full profile.',
  stale:
    'Your documents or facts changed. The agent rewrites it on the next scan; until then Jev reads the full profile.',
};

export function renderJevProfile(box, view, save) {
  if (!box.firstChild) {
    const label = document.createElement('label'),
      text = document.createElement('textarea'),
      state = document.createElement('small'),
      button = document.createElement('button');
    label.textContent = 'Short profile for Jev';
    text.maxLength = 3000;
    text.rows = 8;
    text.placeholder =
      'Languages and levels, experience, field, education, work permit, where you can work.';
    button.type = 'button';
    button.textContent = 'Save short profile';
    label.append(text);
    box.append(label, state, button);
    text.addEventListener('input', () => {
      button.disabled = text.value.trim() === box.dataset.saved;
    });
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await save(text.value);
      } catch (error) {
        state.textContent = error.message;
        button.disabled = false;
      }
    });
  }
  const [label, state, button] = box.children,
    text = label.querySelector('textarea'),
    editing = text.value.trim() !== (box.dataset.saved ?? '');
  box.dataset.saved = view?.text ?? '';
  if (!editing) text.value = box.dataset.saved;
  button.disabled = text.value.trim() === box.dataset.saved;
  const at = view?.at ? new Date(view.at).toLocaleString('en-GB') : '';
  state.textContent =
    states[view?.status] ??
    `Jev compares every listing with this instead of your CV. ${view?.by === 'user' ? 'Edited by you' : 'Written by the agent'}${at ? ' · ' + at : ''}. If anything is wrong or missing, fix it and save; if you save it empty, Jev reads the full profile.`;
}
