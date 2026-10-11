import './jev-settings.css';

export function captchaSettingsPanel(api, root, {notice = () => {}} = {}) {
  if (!api.captchaSettingsStatus) {
    root.hidden = true;
    return {load: async () => {}};
  }
  let busy = false,
    status = null,
    error = '',
    version = 0;
  root.classList.add('jev-settings');
  root.innerHTML = `<div class="jev-settings-heading"><h4>CapSolver connection</h4><span data-state role="status">Loading…</span></div>
 <p>When an active CAPTCHA is detected, automatic solving is tried. For unsupported or unsolvable challenges you can ask for help from the current tab.</p>
 <form><label>CapSolver API key<input name="apiKey" type="password" autocomplete="new-password" spellcheck="false" maxlength="4096" placeholder="The API key from your CapSolver account"></label>
 <label>Automatic solving<select name="enabled"><option value="false">Off</option><option value="true">On</option></select></label>
 <label>Daily solve request limit<input name="dailyLimit" type="number" min="1" max="10000" value="100" required></label>
 <div class="jev-settings-actions"><button class="primary" type="submit">Save</button><button class="quiet" type="button" data-test>Check connection and balance</button><button class="quiet" type="button" data-remove>Remove key</button></div></form>
 <p data-usage></p><p class="jev-settings-hint">To solve a challenge, the page address and CAPTCHA details, or only the CAPTCHA image, are shared with CapSolver. The key is encrypted with the system keychain. Each image round counts as a separate request; the daily counter resets on UTC time and is not reset by a restart. The connection test only queries the balance.</p><p class="jev-settings-message" data-message role="status"></p>`;
  const $ = (selector) => root.querySelector(selector),
    form = $('form');
  function render() {
    $('[data-state]').textContent = status?.error
      ? 'Key could not be decrypted'
      : status?.enabled
        ? 'Automatic solving on'
        : status?.configured
          ? 'Automatic solving off'
          : 'Key required';
    for (const control of form.elements) control.disabled = busy;
    $('[data-test]').disabled = busy || !status?.configured;
    $('[data-remove]').disabled = busy || !status?.saved;
    $('[data-usage]').textContent = status
      ? `Today ${status.usedToday} / ${status.dailyLimit} solve requests`
      : '';
    $('[data-message]').textContent = error || status?.error || status?.lastCheck?.message || '';
    form.elements.apiKey.placeholder = status?.saved
      ? 'Enter a new key to replace it'
      : 'The API key from your CapSolver account';
  }
  async function load() {
    if (busy) return;
    const request = ++version;
    try {
      const next = await api.captchaSettingsStatus();
      if (request !== version) return;
      status = next;
      if (!form.contains(document.activeElement)) {
        form.elements.enabled.value = String(status.enabled);
        form.elements.dailyLimit.value = status.dailyLimit;
      }
      render();
    } catch (e) {
      notice(e.message);
    }
  }
  async function act(run) {
    if (busy) return;
    busy = true;
    version++;
    error = '';
    render();
    try {
      await run();
    } catch (e) {
      error = e.message;
      notice(error);
    } finally {
      busy = false;
      render();
    }
  }
  form.onsubmit = (event) => {
    event.preventDefault();
    const input = {
      apiKey: form.elements.apiKey.value,
      enabled: form.elements.enabled.value === 'true',
      dailyLimit: Number(form.elements.dailyLimit.value),
    };
    form.elements.apiKey.value = '';
    void act(async () => {
      try {
        status = await api.saveCaptchaSettings(input);
        notice('CAPTCHA settings saved.');
      } finally {
        input.apiKey = '';
      }
    });
  };
  $('[data-test]').onclick = () =>
    act(async () => {
      const check = await api.testCaptchaConnection();
      status = {...status, lastCheck: check};
    });
  $('[data-remove]').onclick = () =>
    act(async () => {
      status = await api.removeCaptchaSettings();
      form.elements.enabled.value = 'false';
      form.elements.apiKey.value = '';
      notice('CapSolver key removed.');
    });
  return {load};
}
