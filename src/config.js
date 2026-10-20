import './config.css';
import {jevSettingsPanel} from './jev-settings.js';
import {readinessPanel} from './readiness.js';
import {createDataManagement} from './data-management.js';
import {updatesPanel} from './updates.js';
import {telegramPanel} from './telegram.js';
import {backgroundPanel} from './background-settings.js';
export function configPage(api, {notice, relativeTime}) {
  const root = document.getElementById('config');
  root.innerHTML = `<div class="config-head"><div><h2>Configuration</h2><p>Setup, background running, backups, updates and notifications.</p></div></div>
<div class="config-body"><nav class="config-nav" aria-label="Sections"><a href="#config-telegram">Notifications</a><a href="#config-readiness">Setup check</a><a href="#config-background">Background</a><a href="#config-jev">Jev</a><a href="#config-data">Data and backups</a><a href="#config-updates">Updates</a></nav>
<div class="config-sections">
<section id="config-telegram" class="config-section"><h3>Notifications</h3><p>The selected workspace's Telegram connection and which notifications it receives.</p><div id="config-telegram-panel"></div></section>
<section id="config-readiness" class="config-section"><h3>Setup check</h3><div id="config-readiness-panel"></div></section>
<section id="config-background" class="config-section"><h3>Background</h3><div id="config-background-panel"></div></section>
<section id="config-jev" class="config-section"><h3>Jev</h3><div id="config-jev-panel"></div></section>
<section id="config-updates" class="config-section"><div id="config-updates-panel"></div></section>
</div></div>`;
  const $ = (id) => root.querySelector('#' + id);
  let candidate = null;
  // One section at a time.
  const tabKey = 'jobloop-config-tab';
  let active = 'telegram';
  try {
    active = localStorage.getItem(tabKey) || 'telegram';
  } catch {}
  function layout() {
    const tabs = [...root.querySelectorAll('.config-nav a:not([hidden])')];
    if (!tabs.some((tab) => tab.getAttribute('href') === `#config-${active}`))
      active = tabs[0]?.getAttribute('href').slice(8) ?? 'telegram';
    for (const section of root.querySelectorAll('.config-section')) {
      const key = section.id.slice(7),
        tab = root.querySelector(`.config-nav a[href="#config-${key}"]`);
      if (tab.hidden) {
        section.hidden = true;
        continue;
      }
      section.hidden = key !== active;
      tab.classList.toggle('active', key === active);
      tab.setAttribute('aria-current', key === active ? 'page' : 'false');
    }
    if (candidate && !root.hidden && !$('config-telegram').hidden) telegram?.load();
  }
  function open(key) {
    active = key;
    try {
      localStorage.setItem(tabKey, key);
    } catch {}
    layout();
    if (window.scrollY) window.scrollTo({top: 0});
  }
  for (const a of root.querySelectorAll('.config-nav a'))
    a.onclick = (e) => {
      e.preventDefault();
      open(a.getAttribute('href').slice(8));
    };
  const telegram = api.telegramStatus
    ? telegramPanel(api, $('config-telegram-panel'), {notice})
    : null;
  const jev = jevSettingsPanel(api, $('config-jev-panel'), {notice});
  const readiness = readinessPanel(api, $('config-readiness-panel'), {
    getSettings: async () => {
      if (!candidate) return {};
      const snapshot = await api.workspaceSnapshot(candidate),
        profile = snapshot.workspace;
      return {
        provider: profile.agentSettings.provider,
        chromeProfile: profile.chromeProfile,
        decisions: profile.agentSettings.decisions ?? 'agent',
      };
    },
  });
  const background = api.backgroundStatus
    ? backgroundPanel(api, $('config-background-panel'), {notice})
    : null;
  if (!background) {
    $('config-background').hidden = true;
    root.querySelector('a[href="#config-background"]').hidden = true;
  }
  const dataPanel = api.dataStatus ? createDataManagement(api, {notice}) : null;
  if (dataPanel) root.querySelector('.config-sections').append(dataPanel.element);
  else root.querySelector('a[href="#config-data"]').hidden = true;
  const updates = api.updateStatus ? updatesPanel(api, $('config-updates-panel'), {notice}) : null;
  if (!updates) {
    $('config-updates').hidden = true;
    root.querySelector('a[href="#config-updates"]').hidden = true;
  }
  function load() {
    if (root.hidden) return;
    jev.load();
    readiness.load();
    background?.load();
    dataPanel?.load();
    updates?.load();
  }
  if (!telegram) {
    $('config-telegram').hidden = true;
    root.querySelector('a[href="#config-telegram"]').hidden = true;
  }
  layout();
  return {
    open,
    select(id) {
      telegram?.select(id);
      if (id === candidate) return;
      candidate = id;
      readiness.invalidate();
      load();
    },
    refresh: load,
    show() {
      layout();
      load();
    },
  };
}
