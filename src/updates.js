export function updatesPanel(api, root, {notice = () => {}} = {}) {
  root.classList.add('jev-settings');
  root.innerHTML = `<h3>App updates</h3><p data-version></p><p data-status role="status"></p><div class="jev-settings-actions"><button type="button" data-check>Check for updates</button><button type="button" data-download hidden>Download</button><button type="button" data-install hidden>Install and restart</button><button type="button" class="quiet" data-releases>Open the releases page</button></div><ul class="update-releases" data-list hidden></ul><p data-help></p>`;
  const $ = (selector) => root.querySelector(selector);
  let state = null,
    busy = false;
  const messages = {
    idle: 'You can check for updates here.',
    checking: 'Checking for a new version…',
    available: 'A new version is ready to download.',
    current: 'You are on the latest version.',
    downloading: 'Downloading the update…',
    downloaded: 'The update is downloaded. Install it now, or it installs when you quit AutoJob.',
    installing: 'Stopping running work, backing up your data and installing the update…',
    unsupported:
      'In-app updates are not supported for this installation. New releases are listed here; download the right package from the releases page.',
    error: 'The update could not be completed.',
  };
  function render() {
    if (!state) return;
    const newest = state.availableVersion || state.releases?.[0]?.version;
    $('[data-version]').textContent =
      `Installed version: ${state.version}${newest ? ' · New version: ' + newest : ''}`;
    $('[data-status]').textContent = state.error || messages[state.status] || state.status;
    if (state.status === 'downloading')
      $('[data-status]').textContent += ` ${Math.round(state.progress ?? 0)}%`;
    for (const button of root.querySelectorAll('button'))
      button.disabled = busy || ['checking', 'downloading', 'installing'].includes(state.status);
    $('[data-help]').textContent = state.enabled
      ? 'AutoJob checks for new releases a little after it starts and every few hours, and downloads a new version in the background. It installs when you quit AutoJob, after an automatic backup of your data. Install and restart stops running agents, scans and browser work first, then reopens AutoJob.'
      : 'AutoJob checks for new releases a little after it starts and every few hours and lists them here.';
    if (state.status === 'available' && !state.enabled)
      $('[data-status]').textContent =
        `Version ${state.availableVersion} is available. In-app updates are not supported for this installation; download it from the releases page.`;
    $('[data-download]').hidden = !state.enabled || state.status !== 'available';
    const list = $('[data-list]'),
      releases = state.releases ?? [];
    list.hidden = !releases.length;
    list.replaceChildren(
      ...releases.map((release) => {
        const item = document.createElement('li'),
          link = document.createElement('button'),
          date = release.publishedAt ? new Date(release.publishedAt) : null;
        link.type = 'button';
        link.className = 'link';
        link.textContent = `Version ${release.version}`;
        link.onclick = () => api.openLink(release.url).catch((error) => notice(error.message));
        item.append(link);
        if (date && !Number.isNaN(date.getTime()))
          item.append(` · released ${date.toLocaleDateString()}`);
        return item;
      }),
    );
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
      .openLink('https://github.com/feritzcan2/AutoJob/releases')
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

// The Configuration sidebar item shows "1" while a newer version is available,
// whether the in-app updater found it or only the GitHub releases list did (the
// updater may fail or be unsupported while a newer release exists). A row under
// it shows the download progress, then turns into the Install update button.
export function updateBadge(api, nav, {notice = () => {}} = {}) {
  if (!api.updateStatus || !nav) return;
  const row = document.createElement('button'),
    label = document.createElement('span');
  row.type = 'button';
  row.className = 'update-install-nav';
  row.hidden = true;
  row.innerHTML =
    '<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>';
  row.append(label);
  row.onclick = () => {
    if (row.dataset.state !== 'ready') return;
    row.disabled = true;
    api.updateInstall().catch((error) => {
      row.disabled = false;
      notice(error.message);
    });
  };
  nav.after(row);
  const badge = document.createElement('span');
  badge.className = 'agent-nav-status';
  badge.setAttribute('aria-hidden', 'true');
  badge.hidden = true;
  nav.append(badge);
  const render = (state) => {
    const version = state?.availableVersion || state?.releases?.[0]?.version,
      status = state?.status,
      progress = Math.round(state?.progress ?? 0),
      text =
        status === 'downloading'
          ? `${progress}%`
          : ['available', 'downloaded', 'installing'].includes(status) || state?.releases?.length
            ? '1'
            : '';
    badge.hidden = !text;
    badge.textContent = text;
    badge.dataset.tone = status === 'downloading' ? 'active' : 'waiting';
    nav.title = text && version ? `Version ${version} is available` : '';
    row.hidden = !['downloading', 'downloaded', 'installing'].includes(status);
    row.dataset.state = status === 'downloaded' ? 'ready' : 'busy';
    row.disabled = status !== 'downloaded';
    label.textContent =
      status === 'downloading'
        ? `Downloading update ${progress}%`
        : status === 'installing'
          ? 'Installing update…'
          : 'Install update';
    row.title =
      status === 'downloaded'
        ? `Stops running work, backs up your data, installs version ${version} and reopens AutoJob. It also installs when you quit AutoJob.`
        : '';
  };
  api.onUpdateStatus?.(render);
  api.updateStatus().then(render, () => {});
}
