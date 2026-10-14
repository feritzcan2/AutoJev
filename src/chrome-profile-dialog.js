export function createChromeProfileDialog({loadProfiles, save}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'chrome-profile-dialog';
  dialog.setAttribute('aria-labelledby', 'chrome-profile-title');
  dialog.innerHTML =
    '<form><h2 id="chrome-profile-title">Change Chrome profile</h2><p>Choose the Chrome profile this workspace uses. Running work is paused; you can restart it once the connection is made.</p><label>Chrome profile<select name="profile" aria-describedby="chrome-profile-message"></select></label><p id="chrome-profile-message" role="status"></p><div class="chrome-profile-actions"><button type="button" class="quiet" data-cancel>Cancel</button><button type="submit" class="primary">Select and connect</button></div></form>';
  const select = dialog.querySelector('select'),
    message = dialog.querySelector('[role=status]'),
    submit = dialog.querySelector('[type=submit]'),
    cancel = dialog.querySelector('[data-cancel]');
  let owner = null,
    profiles = [],
    pending = false,
    request = 0;
  cancel.onclick = () => dialog.close();
  dialog.addEventListener('cancel', (event) => {
    if (pending) event.preventDefault();
  });
  dialog.querySelector('form').onsubmit = async (event) => {
    event.preventDefault();
    if (pending || submit.disabled) return;
    pending = true;
    select.disabled = submit.disabled = cancel.disabled = true;
    message.textContent = 'Saving the profile and refreshing the connection…';
    try {
      await save(owner, profiles.find((profile) => profile.directory === select.value) ?? null);
      dialog.close();
    } catch (error) {
      message.textContent = error.message;
    } finally {
      pending = false;
      select.disabled = submit.disabled = cancel.disabled = false;
    }
  };
  return {
    element: dialog,
    async show(workspace) {
      if (dialog.open) return;
      owner = workspace;
      const token = ++request;
      select.replaceChildren(new Option('Loading profiles…', ''));
      select.disabled = submit.disabled = true;
      message.textContent = '';
      dialog.showModal();
      try {
        profiles = await loadProfiles();
        if (token !== request || !dialog.open) return;
        select.replaceChildren(
          new Option('Last used Chrome profile', ''),
          ...profiles.map(
            (profile) => new Option(`${profile.name} — ${profile.directory}`, profile.directory),
          ),
        );
        const selected = workspace.chromeProfile;
        if (selected && !profiles.some((profile) => profile.directory === selected.directory)) {
          const missing = new Option(
            `${selected.name} — ${selected.directory} (not found)`,
            selected.directory,
          );
          missing.disabled = true;
          select.add(missing);
          message.textContent = 'The saved profile was not found. Choose another profile.';
        } else if (!profiles.length)
          message.textContent =
            'No Chrome profile found. Create a profile in Chrome and try again.';
        select.value = selected?.directory ?? '';
        select.disabled = false;
        const validate = () => {
          submit.disabled = !profiles.length || Boolean(select.selectedOptions[0]?.disabled);
        };
        select.onchange = validate;
        validate();
        select.focus();
      } catch (error) {
        if (token === request && dialog.open) message.textContent = error.message;
      }
    },
  };
}
