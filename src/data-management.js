import './data-management.css';

export function createDataManagement(api, {notice = () => {}} = {}) {
  const element = document.createElement('section');
  element.id = 'config-data';
  element.className = 'config-section data-management';
  element.innerHTML = `<h3>Data and backups</h3>
 <h4>Data folder</h4><p data-directory class="data-directory"></p>
 <p>Records and documents for all workspaces are kept in this folder.</p>
 <div class="data-actions"><button type="button" class="quiet" data-open-directory>Show folder</button><button type="button" data-use-directory>Open existing data folder</button><button type="button" class="quiet" data-change-directory>Move data to another folder</button></div>
 <p>To open an existing data folder, select the folder that contains jobloop.sqlite. The app restarts and keeps using the records in the selected folder on later launches. To move your data, select an empty folder; the old folder stays as a recovery copy.</p>
 <h4>Backups</h4>
 <p>Export your automations, candidate profiles, documents and result records to a backup folder.</p>
 <p class="data-notice">Backups contain personal data and are not encrypted; keep them somewhere safe. An exported backup does not include saved portal passwords, Telegram connections, the Jev key or agent sessions. Reconnect them after restoring.</p>
 <div class="data-actions"><button type="button" data-backup>Export backup</button><button type="button" class="quiet" data-restore>Restore from backup</button><button type="button" class="quiet" data-open>Open automatic backups</button></div>
 <p class="data-restore-note">Restoring replaces the current automations, candidates and results with the selected backup. A recovery backup of the current data is taken first; the app then restarts. Automations, campaigns and Telegram open paused. Retry the automations’ sources. An older restored backup may not include applications made since; check the results before continuing.</p>
 <h4>Operation logs</h4><p data-retention>Prompt logs and finished background terminal logs are kept for at most 30 days.</p>
 <button type="button" class="quiet" data-clear>Clear prompt and terminal logs</button>
 <p class="data-status" role="status" aria-live="polite"></p><ul class="data-backups" aria-label="Automatic backups"></ul>`;
  const buttons = [...element.querySelectorAll('button')],
    status = element.querySelector('.data-status'),
    list = element.querySelector('.data-backups');
  let busy = false;
  async function load() {
    try {
      const data = await api.dataStatus();
      element.querySelector('[data-directory]').textContent =
        data.directory ?? 'Could not read the data location';
      element.querySelector('[data-retention]').textContent =
        `Prompt logs are kept for at most ${data.retention.days} days, ${data.retention.promptsPerCandidate.toLocaleString('en')} per candidate and ${data.retention.promptsTotal.toLocaleString('en')} in total. Finished background and automation terminal logs are limited to ${data.retention.days} days and ${data.retention.terminalFiles} files. Application history, automation conversations and results are not part of this cleanup.`;
      status.textContent = `Version ${data.appVersion} · ${data.prompts.toLocaleString('en')} prompt logs${data.pendingRestore ? ' · Waiting for a restart to restore' : ''}`;
      list.replaceChildren();
      for (const backup of data.backups.slice(0, 5)) {
        const item = document.createElement('li');
        item.textContent = `${new Date(backup.createdAt).toLocaleString('en-GB')} · ${backup.kind === 'before-restore' ? 'Before restore' : 'Before update'} · ${backup.candidates} candidates, ${backup.jobs} listings`;
        list.append(item);
      }
      if (!data.backups.length) {
        const item = document.createElement('li');
        item.textContent = 'An automatic backup is created at the first version upgrade.';
        list.append(item);
      }
    } catch (error) {
      status.textContent = error.message;
    }
  }
  async function run(action) {
    if (busy) return;
    busy = true;
    for (const button of buttons) button.disabled = true;
    status.textContent = 'Working…';
    try {
      await action();
      await load();
    } catch (error) {
      status.textContent = error.message;
      notice(error.message);
    } finally {
      busy = false;
      for (const button of buttons) button.disabled = false;
    }
  }
  element.querySelector('[data-backup]').onclick = () =>
    run(async () => {
      const result = await api.dataBackup();
      if (result) notice('Backup created: ' + result.path);
    });
  element.querySelector('[data-open-directory]').onclick = () => run(() => api.dataOpenDirectory());
  element.querySelector('[data-use-directory]').onclick = () =>
    run(async () => {
      const result = await api.dataUseDirectory();
      if (result?.restartRequired) notice('Restarting the app with the selected data folder.');
      else if (result?.changed === false) notice('This data folder is already open.');
    });
  element.querySelector('[data-change-directory]').onclick = () =>
    run(async () => {
      const result = await api.dataChangeDirectory();
      if (result?.restartRequired) notice('Restarting the app to move the data to the new folder.');
    });
  element.querySelector('[data-restore]').onclick = () =>
    run(async () => {
      const result = await api.dataRestore();
      if (result?.restartRequired) notice('Backup verified. JobLoop is restarting to restore it.');
    });
  element.querySelector('[data-open]').onclick = () => run(() => api.dataOpenBackups());
  element.querySelector('[data-clear]').onclick = () =>
    run(async () => {
      const result = await api.dataClearLogs();
      if (result) notice('Prompt and terminal logs cleared.');
    });
  return {element, load};
}
