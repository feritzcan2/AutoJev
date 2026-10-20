import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
export const RELEASES_URL = 'https://api.github.com/repos/feritzcan2/AutoJob/releases?per_page=20';
const CHECK_DELAY = 15_000,
  CHECK_INTERVAL = 6 * 60 * 60_000;
const versionParts = (value) =>
  String(value)
    .replace(/^v/, '')
    .split('-')[0]
    .split('.')
    .map((part) => Number(part) || 0);
export function compareVersions(a, b) {
  const x = versionParts(a),
    y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}
// Published releases newer than the installed version, newest first.
export async function newerReleases(version, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(RELEASES_URL, {
    headers: {accept: 'application/vnd.github+json', 'user-agent': 'AutoJob'},
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw Error(`The releases list could not be read (HTTP ${response.status}).`);
  const list = await response.json();
  return (Array.isArray(list) ? list : [])
    .filter((release) => !release.draft && !release.prerelease && release.tag_name)
    .map((release) => ({
      version: String(release.tag_name).replace(/^v/, ''),
      name: String(release.name || release.tag_name).slice(0, 200),
      publishedAt: release.published_at ?? null,
      url: String(release.html_url ?? ''),
    }))
    .filter((release) => compareVersions(release.version, version) > 0)
    .sort((a, b) => compareVersions(b.version, a.version));
}
export function createUpdateManager({
  app,
  beforeInstall,
  onChange = () => {},
  updater,
  platform = process.platform,
  env = process.env,
  fetchImpl = globalThis.fetch,
  autoCheck = false,
}) {
  const enabled = Boolean(app.isPackaged) && (platform !== 'linux' || Boolean(env.APPIMAGE));
  let state = {
    enabled,
    status: enabled ? 'idle' : 'unsupported',
    version: app.getVersion(),
    availableVersion: null,
    progress: null,
    error: null,
    releases: [],
    checkedAt: null,
  };
  let busy = false,
    disposed = false,
    releaseInstall,
    timers = [];
  const publish = (patch) => {
    if (disposed) return;
    state = {...state, ...patch};
    onChange({...state});
  };
  const readReleases = async () => {
    const releases = await newerReleases(state.version, fetchImpl);
    publish({releases, checkedAt: Date.now()});
    return releases;
  };
  // Checks run shortly after start and then every few hours; they never download.
  const schedule = (check) => {
    if (!autoCheck) return;
    const run = () => check({quiet: true}).catch(() => {});
    timers = [setTimeout(run, CHECK_DELAY), setInterval(run, CHECK_INTERVAL)];
    for (const timer of timers) timer.unref?.();
  };
  const stopTimers = () => {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
  };
  if (!enabled) {
    let checking = false;
    // Without an in-app updater the releases list is the check.
    const check = async ({quiet = false} = {}) => {
      if (checking) return {...state};
      checking = true;
      const previous = state.status;
      if (!quiet) publish({status: 'checking', error: null});
      try {
        const [latest] = await readReleases();
        publish({
          status: latest ? 'available' : 'current',
          availableVersion: latest?.version ?? null,
          error: null,
        });
      } catch (error) {
        if (quiet) publish({status: previous});
        else publish({status: 'error', error: String(error.message ?? error).slice(0, 1000)});
        if (!quiet) throw error;
      } finally {
        checking = false;
      }
      return {...state};
    };
    schedule(check);
    return {
      snapshot: () => ({...state}),
      check: () => check(),
      download: async () => {
        throw Error('Automatic updates are not supported in this installation.');
      },
      install: async () => {
        throw Error('Automatic updates are not supported in this installation.');
      },
      prepareQuitInstall: async () => null,
      dispose: () => {
        disposed = true;
        stopTimers();
      },
    };
  }
  const client = updater ?? require('electron-updater').autoUpdater;
  client.autoDownload = false;
  client.autoInstallOnAppQuit = false;
  client.allowDowngrade = false;
  client.allowPrerelease = false;
  const listeners = {
    'checking-for-update': () => publish({status: 'checking', error: null}),
    'update-available': (info) =>
      publish({status: 'available', availableVersion: info.version, progress: null, error: null}),
    'update-not-available': () =>
      publish({status: 'current', availableVersion: null, progress: null, error: null}),
    'download-progress': (info) =>
      publish({
        status: 'downloading',
        progress: Math.max(0, Math.min(100, Number(info.percent) || 0)),
      }),
    'update-downloaded': (info) =>
      publish({status: 'downloaded', availableVersion: info.version, progress: 100, error: null}),
    error: (error) => {
      const release = releaseInstall;
      releaseInstall = null;
      Promise.resolve()
        .then(() => release?.())
        .catch(() => {});
      publish({status: 'error', error: String(error.message ?? error).slice(0, 1000)});
    },
  };
  for (const [event, listener] of Object.entries(listeners)) client.on(event, listener);
  async function action(fn) {
    if (busy) throw Error('An update is in progress.');
    busy = true;
    try {
      await fn();
      return {...state};
    } catch (error) {
      publish({status: 'error', error: String(error.message ?? error).slice(0, 1000)});
      throw error;
    } finally {
      busy = false;
    }
  }
  const check = async ({quiet = false} = {}) => {
    if (quiet && busy) return {...state};
    if (quiet && ['available', 'downloading', 'downloaded', 'installing'].includes(state.status))
      return readReleases().then(() => ({...state}));
    const result = action(async () => {
      await Promise.all([client.checkForUpdates(), readReleases().catch(() => {})]);
    }).then((next) => {
      // A found update downloads in the background; it installs when the app quits.
      if (autoCheck && state.status === 'available') download().catch(() => {});
      return next;
    });
    return quiet ? result.catch(() => ({...state})) : result;
  };
  const download = () =>
    action(async () => {
      if (state.status !== 'available') throw Error('No update available to download.');
      publish({status: 'downloading', progress: 0, error: null});
      await client.downloadUpdate();
    });
  schedule(check);
  return {
    snapshot: () => ({...state}),
    check: () => check(),
    download,
    install: () =>
      action(async () => {
        if (state.status !== 'downloaded') throw Error('Download the update first.');
        if (typeof beforeInstall !== 'function') throw Error('The pre-update backup is not ready.');
        try {
          releaseInstall = await beforeInstall();
          publish({status: 'installing', error: null});
          client.quitAndInstall(false, true);
        } catch (error) {
          const release = releaseInstall;
          releaseInstall = null;
          await release?.();
          throw error;
        }
      }),
    // Called while the app quits: backs up the data, then returns the step that
    // installs the downloaded update without reopening the app. Null when there is
    // nothing to install or the backup failed.
    prepareQuitInstall: async () => {
      if (state.status !== 'downloaded' || typeof beforeInstall !== 'function') return null;
      try {
        const release = await beforeInstall();
        return async () => {
          await release?.();
          client.autoRunAppAfterInstall = false;
          client.quitAndInstall(true, false);
        };
      } catch {
        return null;
      }
    },
    dispose: () => {
      disposed = true;
      stopTimers();
      for (const [event, listener] of Object.entries(listeners))
        client.removeListener(event, listener);
    },
  };
}
