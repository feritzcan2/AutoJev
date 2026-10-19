import {formatTokens, parseTokenInput, setupTokenInput} from './token-input.js';
import {withAgentDefaults} from '../app/agents/settings.mjs';
import {coalesceRefresh} from './refresh-queue.js';
import {saveAgentSettings, createAgentRestartDialog} from './agent-settings-save.js';
import {instructionsPanel} from './instructions.js';
import {automationsPage} from './automations.js';
import {onboardingScreen, wantsOnboarding} from './onboarding.js';
import {createChromeProfileDialog} from './chrome-profile-dialog.js';
import {workspaceSwitcher} from './workspace-switcher.js';
import {workerTerminals} from './worker-terminals.js';
import {activityPanels} from './activity-panels.js';
import {configPage} from './config.js';
import './style.css';
import './question-form.css';
import './termloop-theme.css';
import './sidebar.css';
import './activity.css';
import './sources.css';
import './board.css';
import './profile.css';
import './simple/app.js';
const api = window.jobloop,
  $ = (id) => document.getElementById(id);
let catalog = [],
  chromeProfiles = [],
  chromeProfilesError = '',
  workspaceAgent = null,
  agentSettingsSignature = '',
  agentSettingsOwner = null,
  deletingWorkspace = null;
let settingsQueue = Promise.resolve(),
  refreshVersion = 0;
const refresh = coalesceRefresh(refreshWorkspace);
// Running workers report many changes; each one would otherwise read a full snapshot.
const refreshOnChange = coalesceRefresh(refreshWorkspace, {gap: 1000});
let agentSettingsDirty = false,
  agentSettingsSaving = false,
  agentSettingsBaseline = '';
const confirmAgentRestart = createAgentRestartDialog();
// A notice answers the action that just happened: it fades after a while and
// never follows the user to another page.
let noticeTimer = null;
const notice = (message) => {
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  $('notice').hidden = !message;
  if (message) noticeTimer = setTimeout(() => notice(''), 8000);
};
const attempt =
  (fn) =>
  async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      notice(error.message);
    }
  };
function element(tag, cls, value) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (value !== undefined) node.textContent = value;
  return node;
}
function relativeTime(value) {
  const minutes = Math.round(Math.abs(Date.now() - new Date(value).getTime()) / 60000);
  return minutes < 1
    ? 'just now'
    : minutes < 60
      ? `${minutes} min ago`
      : `${Math.round(minutes / 60)} h ago`;
}
const workspaceMenu = workspaceSwitcher($('candidates'));
const actions = element('div', 'workspace-actions');
actions.innerHTML =
  '<button id="rename-workspace" class="quiet" type="button">Rename</button><button id="delete-workspace" class="quiet danger" type="button">Delete</button>';
$('new').after(actions);
const renameDialog = document.createElement('dialog');
renameDialog.id = 'rename-workspace-dialog';
renameDialog.innerHTML =
  '<form><h2>Rename workspace</h2><label>New name<input name="workspaceName" maxlength="150" required></label><div class="workspace-dialog-actions"><button class="quiet" type="button" data-cancel>Cancel</button><button class="primary" type="submit">Save</button></div></form>';
document.body.append(renameDialog);
renameDialog.querySelector('[data-cancel]').onclick = () => renameDialog.close();
const selectedWorkspace = () => ({
  id: automationUI.selected,
  title: automationUI.data?.automation.title,
});
$('rename-workspace').onclick = () => {
  const owner = selectedWorkspace();
  if (!owner.id) return;
  renameDialog.dataset.workspaceId = owner.id;
  renameDialog.querySelector('input').value = owner.title;
  renameDialog.showModal();
  renameDialog.querySelector('input').select();
};
renameDialog.querySelector('form').onsubmit = attempt(async (event) => {
  event.preventDefault();
  await api.renameWorkspace(
    renameDialog.dataset.workspaceId,
    renameDialog.querySelector('input').value,
  );
  renameDialog.close();
  await refresh();
  notice('Workspace renamed.');
});
async function deleteWorkspace(owner = selectedWorkspace()) {
  if (!owner.id || deletingWorkspace || automationUI.busy) return;
  if (
    !confirm(
      `Delete the “${owner.title}” workspace? Its records, documents and run history will be removed permanently.`,
    )
  )
    return;
  deletingWorkspace = owner.id;
  ++refreshVersion;
  try {
    await settingsQueue;
    await api.deleteWorkspace(owner.id);
    automationUI.deselect();
    deletingWorkspace = null;
    await refresh();
    switchView('start');
    notice(`The “${owner.title}” workspace was deleted.`);
  } catch (error) {
    notice(error.message);
  } finally {
    deletingWorkspace = null;
  }
}
$('delete-workspace').onclick = () => deleteWorkspace();
const configUI = configPage(api, {notice, relativeTime});
const automationUI = automationsPage(api, {
  notice,
  getCatalog: () => catalog,
  navigate: switchView,
  onSnapshot: syncWorkspaceAgent,
  focusAgent: (options) => terminals.focus(options),
  syncWorkspaceMenu: () => workspaceMenu.sync(),
  refreshWorkspaces: refresh,
  deleteWorkspace,
  isDeleting: () => Boolean(deletingWorkspace),
  openOnboarding: (id, data) => {
    if (!wantsOnboarding(data)) return false;
    onboardingUI.open(id).catch((error) => notice(error.message));
    return true;
  },
});
// Leaving the welcome screen of a new profile returns to the profile open before it.
let workspaceBeforeNew = null;
const onboardingUI = onboardingScreen(api, {
  getCatalog: () => catalog,
  created: async (id) => {
    localStorage.setItem('selected-workspace', id);
    await refresh();
  },
  finish: async (id) => {
    await automationUI.select(id, {onboarding: false});
    switchView('board');
    await refresh();
  },
  chat: async (id) => {
    await automationUI.select(id, {onboarding: false});
    if (automationUI.selected === id) switchView('setup-agent');
    await refresh();
  },
  cancel: async (id, {remove}) => {
    const items = (await api.workspaces()).filter((item) => item.id !== id),
      other = items.find((item) => item.id === workspaceBeforeNew) ?? items[0];
    if (other) await automationUI.select(other.id);
    if (id && remove) await api.deleteWorkspace(id);
    await refresh();
  },
});
await document.fonts.ready;
const terminalSection = document.querySelector('#agent .terminal-section');
$('agent-settings').before(terminalSection);
const terminals = workerTerminals(api, {
  container: terminalSection,
  conversationContainer: $('setup-agent-terminal'),
  notice,
  refresh,
  beforeAction: async (id, method, worker) => {
    await settingsQueue;
    if (automationUI.dirty && ['startWorker', 'restartWorker'].includes(method)) {
      switchView('profile');
      throw Error('Save the profile changes first.');
    }
    if (method === 'startWorker' && worker === 'main' && !automationUI.data.progress.reviewed) {
      await automationUI.start();
      return false;
    }
  },
  sendMessage: async (id, text, worker) => {
    await settingsQueue;
    return worker === 'main'
      ? automationUI.sendMessage(text)
      : api.terminalMessage(id, text, worker);
  },
});
const instructionsUI = instructionsPanel(api, $('agent'));
const activities = activityPanels($('now-panel'), {openLink: (url) => api.openLink(url), notice});
const chromeStatus = element('div', 'chrome-status');
chromeStatus.setAttribute('role', 'status');
chromeStatus.setAttribute('aria-live', 'polite');
const chromeTitle = element('b'),
  chromeDetail = element('small'),
  chromeTip = element(
    'small',
    'chrome-tip',
    'Tip: in Chrome, turn on remote debugging at chrome://inspect/#remote-debugging.',
  ),
  chromeReconnect = element('button', 'quiet chrome-reconnect', 'Reconnect');
chromeReconnect.type = 'button';
chromeStatus.append(chromeTitle, chromeDetail, chromeTip, chromeReconnect);
document.querySelector('.sidebar-bottom').before(chromeStatus);
const chromeProfileChange = element('button', 'quiet chrome-profile-change', 'Change profile');
chromeProfileChange.type = 'button';
const chromeProfileNote = element(
  'small',
  'chrome-profile-note',
  'Use your real Chrome profile, signed in to the sites you use, so you are not blocked.',
);
chromeStatus.append(chromeProfileChange, chromeProfileNote);
const jevStatus = element('div', 'jev-status');
jevStatus.setAttribute('role', 'alert');
jevStatus.hidden = true;
jevStatus.append(element('b'), element('small'));
chromeStatus.before(jevStatus);
const chromeProfileDialog = createChromeProfileDialog({
  loadProfiles: async () => {
    chromeProfiles = await api.chromeProfiles();
    chromeProfilesError = '';
    return chromeProfiles;
  },
  save: async (owner, chromeProfile) => {
    await settingsQueue;
    await api.workspaceSettings(owner.id, {chromeProfile});
    await api.browserReconnect(owner.id);
    await refresh();
    notice('Chrome profile saved.');
  },
});
document.body.append(chromeProfileDialog.element);
chromeProfileChange.onclick = () => {
  const a = automationUI.data?.automation;
  if (a) chromeProfileDialog.show({id: a.id, chromeProfile: a.chromeProfile, web: true});
};
chromeReconnect.onclick = attempt(() => automationUI.reconnectBrowser());
const sourcesNav = element('button');
sourcesNav.dataset.view = 'sources';
sourcesNav.innerHTML =
  '<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><span>Sources</span><span id="sources-nav-status" class="agent-nav-status sources-nav-status" data-tone="active" aria-hidden="true" hidden></span>';
document.querySelector('nav button[data-view="agent"]').before(sourcesNav);
function switchView(name, options = {}) {
  notice('');
  const global = name === 'start',
    selected = automationUI.selected;
  document.querySelector('main>header>.actions').hidden =
    global || !selected || name === 'setup-agent';
  document.body.classList.toggle('automation-workspace', Boolean(selected) && !global);
  for (const id of ['config', 'profile', 'board', 'agent', 'setup-agent', 'files'])
    if ($(id)) $(id).hidden = true;
  automationUI.element.hidden = false;
  if (global) {
    $('heading').textContent = 'New workspace';
    if (!options.detail) automationUI.show().catch((error) => notice(error.message));
  } else if (selected) {
    automationUI.renderShell();
    if (name === 'config') {
      automationUI.element.hidden = true;
      $('config').hidden = false;
      configUI.select(selected);
      configUI.show();
    } else {
      automationUI.showPane(name);
      if (['agent', 'setup-agent'].includes(name)) $(name).hidden = false;
      if (name === 'agent') syncJevOption();
    }
  }
  localStorage.setItem('selected-view', name);
  document
    .querySelectorAll('aside nav button')
    .forEach((button) => button.classList.toggle('selected', button.dataset.view === name));
  workspaceMenu.sync();
}
// Jev can be chosen only after a TypeSafe key is saved under Configuration → Jev.
async function syncJevOption() {
  const option = $('decisions').querySelector('option[value=jev]');
  let configured = false;
  try {
    configured = Boolean((await api.jevSettingsStatus?.())?.configured);
  } catch {}
  option.disabled = !configured;
  option.textContent = configured
    ? 'Jev (TypeSafe key)'
    : 'Jev (save a TypeSafe key under Configuration → Jev first)';
}
function settingsOptions(saved) {
  const current = catalog.find((a) => a.id === $('provider').value);
  if (!current) return;
  const fields = $('agent-settings-form').elements,
    settings = withAgentDefaults({...saved, provider: current.id});
  fields.network.disabled = current.id !== 'codex';
  for (const name of ['contextCompactTokens', 'contextRestartTokens']) {
    const field = fields[name];
    field.value = formatTokens(settings[name]);
    field.setCustomValidity('');
  }
  for (const [key, list] of [
    ['model', current.models],
    ['permission', current.permissions],
    ['reasoning', current.reasoning],
  ]) {
    $(key).replaceChildren(...list.map((value) => new Option(value, value)));
    $(key).value = list.includes(settings[key]) ? settings[key] : 'default';
  }
  for (const key of ['trialModel', 'contactModel']) {
    $(key).replaceChildren(
      new Option('Same as main model', ''),
      ...current.models
        .filter((value) => value !== 'default')
        .map((value) => new Option(value, value)),
    );
    $(key).value = current.models.includes(settings[key]) ? settings[key] : '';
  }
}
function chromeProfileOptions(selected = workspaceAgent?.workspace?.chromeProfile) {
  const select = $('agent-settings-form').elements.chromeProfile;
  select.replaceChildren(
    new Option('No profile', ''),
    ...chromeProfiles.map((p) => new Option(`${p.name} — ${p.directory}`, p.directory)),
  );
  if (selected && !chromeProfiles.some((p) => p.directory === selected.directory))
    select.add(
      new Option(`${selected.name} — ${selected.directory} (not found)`, selected.directory),
    );
  select.value = selected?.directory ?? '';
  chromeProfileVisibility();
}
function chromeProfileVisibility() {
  $('chrome-profile-hint').textContent =
    chromeProfilesError ||
    (chromeProfiles.length
      ? 'Jev uses your existing sign-in and opens listings as tabs in a single JobLoop window.'
      : 'No Chrome profile found.');
}
function fillAgentSettings(profile, id) {
  const changedOwner = agentSettingsOwner !== id;
  agentSettingsOwner = id;
  if (changedOwner) agentSettingsDirty = false;
  if (agentSettingsDirty && !changedOwner) return;
  const p = profile ?? {},
    key = JSON.stringify([id, p.agentSettings, p.chromeProfile]);
  if (agentSettingsSignature === key) return;
  agentSettingsSignature = key;
  const form = $('agent-settings-form');
  chromeProfileOptions(p.chromeProfile);
  $('agent-settings').classList.toggle('is-off', !id);
  if (!id) $('agent-settings-status').textContent = 'Select a workspace first';
  else if (changedOwner || $('agent-settings-status').textContent === 'Select a workspace first')
    $('agent-settings-status').textContent = 'Apply changes with Save';
  $('provider').value = p.agentSettings?.provider ?? 'codex';
  settingsOptions(p.agentSettings ?? {});
  form.elements.network.value =
    p.agentSettings?.network == null ? 'inherit' : String(p.agentSettings.network);
  form.elements.decisions.value = withAgentDefaults(p.agentSettings ?? {}).decisions;
  agentSettingsBaseline = JSON.stringify(readAgentSettings());
  $('agent-settings-save').disabled = true;
}
function syncWorkspaceAgent(value) {
  workspaceAgent = value;
  if (!value) {
    terminals.update(null, null);
    instructionsUI.select(null);
    return;
  }
  const id = value.workspace.id;
  if (automationUI.selected !== id) return;
  const next = {
    ...value,
    capabilities: {
      ...value.capabilities,
      canStart: value.capabilities.canStart && !automationUI.dirty,
      canRestart: value.capabilities.canRestart && !automationUI.dirty,
    },
  };
  instructionsUI.select(id);
  terminals.update(id, next);
  activities.update(next, true);
  fillAgentSettings(next.workspace, id);
  renderContext(next);
  configUI.select(id);
}
function renderContext(value) {
  const usage = value?.active?.contextUsage,
    threshold = value?.workspace.agentSettings.contextRestartTokens ?? 0,
    compactThreshold = value?.workspace.agentSettings.contextCompactTokens ?? 0,
    compact = value?.active?.compaction;
  $('context-compact-status').textContent =
    {
      sending: 'Sending /compact…',
      submitted: '/compact sent; waiting for the provider to compact.',
      running_command: 'The provider is processing /compact…',
      verified: 'Compaction finished.',
      compacting: 'Compacting context…',
      awaiting_usage: 'Compaction turn finished; waiting for a new context measurement.',
      completed: 'Context usage dropped below the threshold.',
      waiting: 'Waiting for the terminal to accept commands.',
      unconfirmed: 'Compaction could not be verified. ' + (compact?.error ?? ''),
    }[compact?.state] ??
    (compactThreshold
      ? `Automatic compaction: ${formatTokens(compactThreshold)} tokens.`
      : 'Automatic compaction off.');
  if (value?.workspace.agentSettings.provider === 'opencode' && !compact?.state)
    $('context-compact-status').textContent = compactThreshold
      ? `OpenCode automatic compaction: ${formatTokens(compactThreshold)} tokens. A threshold change applies from the next agent session.`
      : 'The app’s compaction threshold is off; OpenCode uses its own default.';
  $('context-usage-status').textContent =
    !threshold && !compactThreshold
      ? 'Automatic context management off.'
      : !value?.active
        ? 'Context will be tracked in the next session.'
        : usage?.tokens == null
          ? 'Waiting for a context token measurement.'
          : `Context usage: ${formatTokens(usage.tokens)} tokens.${threshold > 0 && usage.peakTokens >= threshold ? ' Threshold reached; a new agent session opens when the task finishes.' : ''}`;
}
async function refreshWorkspace() {
  if (deletingWorkspace) return;
  const version = ++refreshVersion,
    items = await api.workspaces();
  if (version !== refreshVersion) return;
  $('candidates').replaceChildren(
    new Option('Select workspace', ''),
    ...items.map((item) => new Option(item.title, item.id)),
  );
  if (automationUI.selected && !items.some((item) => item.id === automationUI.selected))
    automationUI.deselect();
  if (automationUI.selected) {
    $('candidates').value = automationUI.selected;
    await automationUI.refresh();
  }
  workspaceMenu.sync();
}
$('new').textContent = 'New workspace';
$('new').onclick = () => {
  workspaceBeforeNew = automationUI.selected;
  return automationUI.create();
};
$('candidates').onchange = attempt(async () => {
  const id = $('candidates').value;
  notice('');
  if (id) {
    await automationUI.select(id);
    await refresh();
  }
});
$('start').onclick = attempt(async () => {
  await settingsQueue;
  await automationUI.start();
});
$('stop').onclick = attempt(() => automationUI.stop());
$('restart-agent').onclick = attempt(async () => {
  await settingsQueue;
  await automationUI.restart();
});
for (const button of document.querySelectorAll('aside nav button[data-view]'))
  button.onclick = () => switchView(button.dataset.view);
$('close-preview').onclick = () => $('document-preview').close();
api.onChange((event) => {
  if (event.candidateId && event.candidateId !== automationUI.selected) return;
  refresh().catch((error) => notice(error.message));
});
api.onAgentEvent((event) => {
  if (event.candidateId && event.candidateId !== automationUI.selected) return;
  terminals.event(event);
  if (['state', 'engine_exit', 'eof'].includes(event.event))
    refresh().catch((error) => notice(error.message));
  else if (event.event === 'error') notice(event.error);
});
chromeProfiles = await api.chromeProfiles().catch((error) => {
  chromeProfilesError = error.message;
  return [];
});
catalog = await api.catalog();
$('provider').replaceChildren(
  ...catalog.map((item) => {
    const option = new Option(item.label + (item.supported ? '' : ' — no MCP yet'), item.id);
    option.disabled = !item.supported;
    return option;
  }),
);
$('provider').onchange = () => settingsOptions();
function readAgentSettings() {
  const profile = workspaceAgent?.workspace,
    f = $('agent-settings-form').elements;
  const contextTokens = (name) => parseTokenInput(f[name].value);
  const chromeProfile =
    chromeProfiles.find((p) => p.directory === f.chromeProfile.value) ??
    (profile?.chromeProfile?.directory === f.chromeProfile.value ? profile.chromeProfile : null);
  const agentSettings = {
    provider: f.provider.value,
    model: f.model.value,
    trialModel: f.trialModel.value || null,
    contactModel: f.contactModel.value || null,
    permission: f.permission.value,
    reasoning: f.reasoning.value,
    network:
      f.provider.value !== 'codex' || f.network.value === 'inherit'
        ? null
        : f.network.value === 'true',
    contextRestartTokens: contextTokens('contextRestartTokens'),
    contextCompactTokens: contextTokens('contextCompactTokens'),
    decisions: f.decisions.value,
  };
  return {agentSettings, chromeProfile};
}
function markAgentSettingsDirty() {
  if (!automationUI.selected || agentSettingsSaving) return;
  chromeProfileVisibility();
  agentSettingsDirty = JSON.stringify(readAgentSettings()) !== agentSettingsBaseline;
  $('agent-settings-save').disabled = !agentSettingsDirty;
  $('agent-settings-status').textContent = agentSettingsDirty
    ? 'There are unsaved changes.'
    : 'No changes.';
}
for (const name of ['contextCompactTokens', 'contextRestartTokens'])
  setupTokenInput($('agent-settings-form').elements[name]);
$('agent-settings-form').oninput = markAgentSettingsDirty;
$('agent-settings-form').onchange = markAgentSettingsDirty;
$('agent-settings-form').onsubmit = (event) => {
  event.preventDefault();
  const owner = automationUI.selected;
  if (!owner || agentSettingsSaving || !agentSettingsDirty) return;
  const input = readAgentSettings(),
    baseline = JSON.parse(agentSettingsBaseline);
  if (JSON.stringify(input.chromeProfile) === JSON.stringify(baseline.chromeProfile))
    delete input.chromeProfile;
  const form = $('agent-settings-form'),
    status = $('agent-settings-status');
  agentSettingsSaving = true;
  form.inert = true;
  $('agent-settings-save').disabled = true;
  status.textContent = 'Saving…';
  let saved = false;
  settingsQueue = settingsQueue
    .then(async () => {
      const result = await saveAgentSettings({
        api,
        owner,
        input,
        confirmRestart: confirmAgentRestart,
        onSaved: () => {
          saved = true;
          if (automationUI.selected === owner) {
            agentSettingsDirty = false;
            agentSettingsSignature = '';
            status.textContent = 'Saved.';
          }
        },
      });
      if (automationUI.selected === owner) {
        await automationUI.refresh();
        status.textContent = result.failed.length
          ? `Settings saved. Agents that could not be restarted: ${result.failed.join('; ')}`
          : result.restarted
            ? `Saved. ${result.restarted} agent(s) restarted.`
            : input.agentSettings.provider === 'opencode'
              ? 'Saved. The new session threshold applies now; compaction and other settings apply at the next start.'
              : 'Saved. Context thresholds apply now; other settings apply at the next start.';
      }
    })
    .catch((error) => {
      if (automationUI.selected === owner)
        status.textContent = (saved ? 'Settings saved. ' : 'Could not save: ') + error.message;
    })
    .finally(() => {
      agentSettingsSaving = false;
      form.inert = false;
      $('agent-settings-save').disabled = !agentSettingsDirty;
    });
};
const initialView = localStorage.getItem('selected-view'),
  saved =
    localStorage.getItem('selected-workspace') ??
    localStorage.getItem('selected-automation') ??
    localStorage.getItem('selected-candidate');
await refresh();
const items = await api.workspaces(),
  selected = items.find((item) => item.id === saved) ?? items[0];
if (selected) {
  await automationUI.select(selected.id);
  await refresh();
  switchView(
    (automationUI.data.progress.fresh || automationUI.data.automation.status === 'draft') &&
      (!initialView || initialView === 'board')
      ? 'setup-agent'
      : [
            'board',
            'answers',
            'attention',
            'agent',
            'setup-agent',
            'profile',
            'sources',
            'files',
            'background',
            'config',
          ].includes(initialView)
        ? initialView
        : 'board',
  );
} else {
  switchView('start');
  await onboardingUI.open();
}
localStorage.removeItem('selected-candidate');
localStorage.removeItem('selected-automation');
api.onAutomationChange?.((event) => {
  if (event.automationId && event.automationId !== automationUI.selected) return;
  refreshOnChange().catch((error) => notice(error.message));
});
