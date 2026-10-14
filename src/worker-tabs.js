import {workerTabs} from './workspace-tabs.js';

const node = (tag, cls, text) => {
  const el = document.createElement(tag);
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};
const tabTitle = (tab) => {
  try {
    return tab.title || new URL(tab.url).hostname;
  } catch {
    return tab.title || tab.url;
  }
};

// One workspace read serves all worker menus. Only exact active-run tabs are shown.
export function workerTabControls(api, {notice}) {
  let owner = null,
    snapshot = null,
    panes = new Map(),
    tabs = [],
    version = 0,
    loading = false,
    runKey = '';
  function render(pane) {
    const items = workerTabs(snapshot ?? {}, pane.id, tabs),
      available = Boolean(snapshot?.automation);
    const runId = pane.worker.execution?.task?.id,
      running =
        pane.worker.active && snapshot?.runs?.some((r) => r.id === runId && r.status === 'running');
    if (pane.tabsRun !== runId || !running) {
      pane.tabsOpen = false;
      pane.tabsRun = runId;
    }
    pane.tab.hidden = !available;
    pane.tab.disabled = !running || pane.busy;
    pane.tab.textContent = `Tabs (${items.length})`;
    pane.tab.title = 'Open tabs of the active work';
    pane.tab.setAttribute(
      'aria-label',
      `Tabs of ${pane.worker.name}'s active work (${items.length})`,
    );
    pane.tab.setAttribute('aria-expanded', String(Boolean(pane.tabsOpen)));
    pane.tabList.hidden = !available || !pane.tabsOpen;
    if (pane.tabList.hidden) return;
    const signature = JSON.stringify([
      items,
      pane.tabBusy,
      pane.tabsError,
      !items.length && loading,
    ]);
    if (signature === pane.tabsSignature) return;
    pane.tabsSignature = signature;
    pane.tabList.replaceChildren(node('strong', 'worker-tabs-heading', 'Tabs of the active work'));
    if (pane.tabsError) {
      pane.tabList.append(node('p', 'worker-tabs-empty', pane.tabsError));
      return;
    }
    if (!items.length) {
      pane.tabList.append(
        node(
          'p',
          'worker-tabs-empty',
          loading ? 'Loading tabs…' : 'This work has no open tabs yet.',
        ),
      );
      return;
    }
    const list = node('ul', 'worker-tabs-list');
    for (const tab of items) {
      const item = node('li', ''),
        button = node('button', 'worker-tab-link');
      button.type = 'button';
      button.title = tab.url;
      button.dataset.tabId = tab.tabId;
      button.disabled = Boolean(pane.tabBusy);
      button.setAttribute('aria-label', `Go to the ${tabTitle(tab)} tab`);
      button.append(
        node('span', 'worker-tab-title', tabTitle(tab)),
        node('small', 'worker-tab-url', tab.url),
      );
      button.onclick = async () => {
        if (pane.dead || pane.tabBusy) return;
        pane.tabBusy = true;
        render(pane);
        try {
          const [current, open] = await Promise.all([
            api.workspaceSnapshot(pane.candidate),
            api.workspaceTabs(pane.candidate),
          ]);
          if (pane.dead) return;
          if (!workerTabs(current, pane.id, open).some((t) => t.tabId === tab.tabId))
            throw Error(
              'This tab no longer belongs to the worker’s active work, or it was closed.',
            );
          await api.focusWorkspaceTab(pane.candidate, tab.tabId);
        } catch (error) {
          if (!pane.dead) notice(error.message);
        } finally {
          pane.tabBusy = false;
          if (!pane.dead) {
            render(pane);
            void refresh();
          }
        }
      };
      item.append(button);
      list.append(item);
    }
    pane.tabList.append(list);
  }
  async function refresh() {
    if (!owner || !snapshot?.automation || loading) return;
    const id = owner,
      request = version;
    loading = true;
    try {
      const next = await api.workspaceTabs(id);
      if (request !== version) return;
      tabs = next;
      for (const pane of panes.values()) pane.tabsError = null;
    } catch (error) {
      if (request === version) for (const pane of panes.values()) pane.tabsError = error.message;
    } finally {
      if (request === version) {
        loading = false;
        for (const pane of panes.values()) render(pane);
      }
    }
  }
  setInterval(() => {
    if (
      [...panes.values()].some(
        (p) => p.card.isConnected && p.card.getClientRects().length && p.worker.active,
      )
    )
      void refresh();
  }, 3000);
  return {
    render,
    toggle(pane) {
      pane.tabsOpen = !pane.tabsOpen;
      render(pane);
      if (pane.tabsOpen) void refresh();
    },
    update(id, value, nextPanes) {
      if (owner !== id) {
        version++;
        tabs = [];
        loading = false;
        runKey = '';
      }
      owner = id;
      snapshot = value;
      panes = nextPanes;
      for (const pane of panes.values()) render(pane);
      const key = JSON.stringify(
        (value?.workers ?? []).map((w) => [w.id, w.active?.sessionId, w.execution?.task?.id]),
      );
      if (key !== runKey) {
        runKey = key;
        void refresh();
      }
    },
    reset() {
      version++;
      owner = null;
      snapshot = null;
      panes = new Map();
      tabs = [];
      loading = false;
      runKey = '';
    },
  };
}
