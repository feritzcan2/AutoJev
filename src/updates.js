export function updatesPanel(api, root, {notice = () => {}} = {}) {
  root.classList.add('jev-settings');
  root.innerHTML = `<h3>App updates</h3><p data-version></p><p data-status role="status"></p><div class="jev-settings-actions"><button type="button" data-check>Check for updates</button><button type="button" data-download hidden>Download</button><button type="button" data-install hidden>Back up and restart</button><button type="button" class="quiet" data-releases>Open the releases page</button></div><p>Stop running tasks before installing an update. Your data is backed up automatically, then JobLoop restarts. Checking and downloading only start from these buttons.</p>`;
  const $ = (selector) => root.querySelector(selector);
  let state = null,
    busy = false;
  const messages = {
    idle: 'You can check for updates here.',
    checking: 'Checking for a new version…',
    available: 'A new version is ready to download.',
    current: 'You are on the latest version.',
    downloading: 'Downloading the update…',
    downloaded: 'Download complete. Stop tasks to install it.',
    installing: 'Backup taken. Installing the update…',
    unsupported:
      'In-app updates are not supported for this installation. Download the right package from the releases page.',
    error: 'The update could not be completed.',
  };
  function render() {
    if (!state) return;
    $('[data-version]').textContent =
      `Installed version: ${state.version}${state.availableVersion ? ' · New version: ' + state.availableVersion : ''}`;
    $('[data-status]').textContent = state.error || messages[state.status] || state.status;
    if (state.status === 'downloading')
      $('[data-status]').textContent += ` ${Math.round(state.progress ?? 0)}%`;
    for (const button of root.querySelectorAll('button'))
      button.disabled = busy || ['checking', 'downloading', 'installing'].includes(state.status);
    $('[data-check]').hidden = !state.enabled;
    $('[data-download]').hidden = state.status !== 'available';
    $('[data-install]').hidden = state.status !== 'downloaded';
  }
  async function action(fn) {
    if (busy) return;
    busy = true;
    render();
    try {
      state = await fn();
    } catch (error) {
      notice(error.message);
    } finally {
      busy = false;
      render();
    }
  }
  $('[data-check]').onclick = () => action(() => api.updateCheck());
  $('[data-download]').onclick = () => action(() => api.updateDownload());
  $('[data-install]').onclick = () => action(() => api.updateInstall());
  $('[data-releases]').onclick = () =>
    api
      .openLink('https://github.com/feritzcan2/AutoJev/releases')
      .catch((error) => notice(error.message));
  api.onUpdateStatus?.((next) => {
    state = next;
    render();
  });
  return {
    async load() {
      try {
        state = await api.updateStatus();
        render();
      } catch (error) {
        notice(error.message);
      }
    },
  };
}
