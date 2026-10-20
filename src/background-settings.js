export function backgroundPanel(api, root, {notice = () => {}} = {}) {
  root.innerHTML = `<p data-help></p><label class="background-option"><span><b>Open at login</b><small data-login-note>AutoJob starts in the background when you sign in to this computer.</small></span><input class="switch" type="checkbox" data-login aria-label="Open at login"></label>`;
  const $ = (selector) => root.querySelector(selector),
    login = $('[data-login]');
  function render(state) {
    $('[data-help]').textContent =
      `Closing the window keeps AutoJob running in the ${state.place}: scans, applications and questions continue. Quit from the ${state.place} icon. While a task runs, the computer does not go to sleep on its own; closing a laptop lid still puts it to sleep, and work continues after it wakes. Questions arrive as system notifications; short ones can be answered from the notification.`;
    login.checked = state.openAtLogin;
    login.disabled = !state.supported;
    $('[data-login-note]').textContent = state.supported
      ? 'AutoJob starts in the background when you sign in to this computer.'
      : 'Available in the installed app on macOS and Windows.';
  }
  login.onchange = async () => {
    login.disabled = true;
    try {
      render(await api.setOpenAtLogin(login.checked));
    } catch (error) {
      notice(error.message);
      load();
    }
  };
  function load() {
    api.backgroundStatus().then(render, (error) => notice(error.message));
  }
  return {load};
}
