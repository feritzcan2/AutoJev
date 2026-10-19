import './jev-settings.css';

// API accounts that some job sites require (Site accounts). Each site declares
// its fields; the values go to the main process and are never shown again.
export function siteCredentialsPanel(api, root, {notice = () => {}} = {}) {
  if (!api.siteCredentialsStatus) {
    root.hidden = true;
    return {load: async () => {}};
  }
  let busy = false,
    sites = [],
    message = '',
    version = 0;
  root.classList.add('jev-settings');
  const node = (tag, text, attrs = {}) => {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    return el;
  };
  function siteForm(site) {
    const box = node('div', '', {class: 'site-credentials-site'}),
      head = node('div', '', {class: 'jev-settings-heading'}),
      form = node('form');
    head.append(
      node('h4', site.label),
      node(
        'span',
        site.error ? 'Could not be decrypted' : site.configured ? 'Saved' : 'Not set up',
        {role: 'status'},
      ),
    );
    box.append(head, node('p', site.help));
    if (site.signupUrl) {
      const line = node('p');
      const link = node('a', 'Get the credentials', {href: site.signupUrl});
      link.onclick = (event) => {
        event.preventDefault();
        api.openLink?.(site.signupUrl).catch((e) => notice(e.message));
      };
      line.append(link);
      box.append(line);
    }
    for (const field of site.fields) {
      const label = node('label', field.label),
        input = node('input', '', {
          name: field.key,
          type: 'password',
          autocomplete: 'new-password',
          spellcheck: 'false',
          maxlength: '4096',
          placeholder: site.saved ? 'Enter a new value to replace it' : field.label,
        });
      label.append(input);
      form.append(label);
    }
    const actions = node('div', '', {class: 'jev-settings-actions'}),
      save = node('button', 'Save', {class: 'primary', type: 'submit'}),
      remove = node('button', 'Remove', {class: 'quiet', type: 'button'});
    actions.append(save, remove);
    form.append(actions);
    for (const control of form.elements) control.disabled = busy;
    remove.disabled = busy || !site.saved;
    form.onsubmit = (event) => {
      event.preventDefault();
      const input = Object.fromEntries(site.fields.map((f) => [f.key, form.elements[f.key].value]));
      form.reset();
      void act(async () => {
        sites = await api.saveSiteCredentials(site.site, input);
        notice(`${site.label} credentials saved.`);
      });
    };
    remove.onclick = () =>
      act(async () => {
        sites = await api.removeSiteCredentials(site.site);
        notice(`${site.label} credentials removed.`);
      });
    box.append(form);
    if (site.error) box.append(node('p', site.error, {class: 'jev-settings-message'}));
    return box;
  }
  function render() {
    root.replaceChildren(
      node(
        'p',
        'Some job sites are read through an official API that needs your own account. The values are encrypted with the system keychain and are used only for these sites’ requests.',
        {class: 'jev-settings-hint'},
      ),
      ...sites.map(siteForm),
      node('p', message, {class: 'jev-settings-message', role: 'status'}),
    );
    if (!sites.length) root.prepend(node('p', 'No site needs an account.'));
  }
  async function load() {
    if (busy) return;
    const request = ++version;
    try {
      const next = await api.siteCredentialsStatus();
      if (request !== version || root.contains(document.activeElement)) return;
      sites = next;
      render();
    } catch (e) {
      notice(e.message);
    }
  }
  async function act(run) {
    if (busy) return;
    busy = true;
    version++;
    message = '';
    render();
    try {
      await run();
    } catch (e) {
      message = e.message;
      notice(message);
    } finally {
      busy = false;
      render();
    }
  }
  return {load};
}
