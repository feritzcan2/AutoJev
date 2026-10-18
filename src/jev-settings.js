import './jev-settings.css';

export function jevSettingsPanel(api, root, {notice = () => {}} = {}) {
  if (!api.jevSettingsStatus) {
    root.hidden = true;
    return {load: async () => {}};
  }
  let busy = false,
    status = null,
    version = 0,
    errorMessage = '';
  root.classList.add('jev-settings');
  root.innerHTML = `<div class="jev-settings-heading"><h4>Jev connection</h4><span data-state role="status">Loading…</span></div>
 <p>Workspaces whose listing decisions are set to Jev in Agent settings use this TypeSafe connection. With “This agent” no key is needed. Candidates’ site account passwords are kept separately in the Candidate profile section.</p>
 <form><label>TypeSafe API key<input name="apiKey" type="password" autocomplete="new-password" spellcheck="false" maxlength="4096" placeholder="The API key from your TypeSafe console"></label><label>Model<input name="model" value="jev-latest" maxlength="100" required spellcheck="false" autocomplete="off"></label><div class="jev-settings-actions"><button class="primary" type="submit">Save</button><button class="quiet" type="button" data-test>Test connection</button><button class="quiet" type="button" data-remove>Remove saved key</button></div></form>
 <p class="jev-settings-hint">The key is encrypted on this computer with the system keychain and is not shown after saving. The test only requests the model list from TypeSafe; it sends no candidate documents or browser content and starts no model task.</p><p class="jev-settings-message" data-message role="status"></p>`;
  const $ = (selector) => root.querySelector(selector),
    form = $('form'),
    key = form.elements.apiKey;
  function render() {
    $('[data-state]').textContent = status?.error
      ? 'Key could not be decrypted'
      : status?.configured
        ? 'Key configured'
        : 'Key required';
    key.placeholder = status?.saved
      ? 'Enter a new key to replace it'
      : 'The API key from your TypeSafe console';
    for (const control of form.elements) control.disabled = busy;
    $('[data-test]').disabled = busy || !status?.configured;
    $('[data-remove]').disabled = busy || !status?.saved;
    const source =
      status?.source === 'environment'
        ? 'The TYPESAFE_API_KEY environment variable or a development file is in use. A key you save is used instead. '
        : '';
    $('[data-message]').textContent =
      source + (errorMessage || status?.error || status?.lastCheck?.message || '');
  }
  async function load() {
    if (busy) return;
    const request = ++version;
    try {
      const next = await api.jevSettingsStatus();
      if (request !== version) return;
      status = next;
      if (document.activeElement !== form.elements.model) form.elements.model.value = status.model;
      render();
    } catch (error) {
      notice(error.message);
    }
  }
  async function act(run) {
    if (busy) return;
    busy = true;
    version++;
    errorMessage = '';
    render();
    try {
      await run();
    } catch (error) {
      errorMessage = error.message;
      notice(error.message);
    } finally {
      busy = false;
      render();
    }
  }
  form.onsubmit = (event) => {
    event.preventDefault();
    act(async () => {
      let input = {apiKey: key.value, model: form.elements.model.value.trim()};
      key.value = '';
      try {
        status = await api.saveJevSettings(input);
        notice('Jev settings saved.');
      } finally {
        input.apiKey = '';
      }
    });
  };
  $('[data-remove]').onclick = () =>
    act(async () => {
      status = await api.removeJevSettings();
      key.value = '';
      form.elements.model.value = status.model;
      notice(
        status.configured
          ? 'Saved key removed. The development environment key is active.'
          : 'Jev key removed.',
      );
    });
  $('[data-test]').onclick = () =>
    act(async () => {
      const check = await api.testJevConnection();
      status = {...status, lastCheck: check};
      notice(check.message);
    });
  return {load};
}

export function dataDisclosure(root) {
  root.classList.add('data-disclosure');
  root.innerHTML = `<h4>Where is your data processed?</h4><ul><li><b>On this computer:</b> Candidate profiles, CVs and documents, application history, browser profiles and app records are stored.</li><li><b>At the AI provider you choose:</b> While the agent works, task instructions, candidate details, documents it reads, browser observations and tool results are processed. Your provider account’s data preferences apply.</li><li><b>At TypeSafe / Jev:</b> When Jev is asked for a decision, the page address, title, text, current form field values and recent actions are shared. Personal details in forms can be part of this content.</li><li><b>At CapSolver:</b> If you turn on automatic CAPTCHA solving, the page address, challenge details and, when needed, the CAPTCHA image are shared with CapSolver.</li><li><b>On Telegram:</b> When you enable the bot, the listing, application and question notifications you choose, your replies to them and the chat id are processed through Telegram.</li><li><b>On job sites:</b> In application flows you allow, the details filled in and the documents uploaded are sent to that site.</li></ul><p>Portal passwords and API keys you save in the app are encrypted with the system keychain. Jev’s password fill tool passes the password straight to the site and never shows it in a chat reply. Protect your backups and exported candidate documents as personal data.</p>`;
}
