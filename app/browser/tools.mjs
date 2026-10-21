import {checkSourceBrowser, sourceCheckOwner} from '../sources/browser-check.mjs';
import {BrowserConnections, browserWaitResult} from './connection.mjs';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {JevBrowser} from '../jev/browser.mjs';
import {jevTools} from '../jev/tools.mjs';
import {pressBrowserTarget} from './target.mjs';
import {resolveBrowserCaptcha} from '../captcha/automation.mjs';

// One browser step holds the workspace queue, so every worker of the workspace
// waits behind it. A step past this bound is cancelled; one that ignores the
// cancellation drops the Chrome connection so the queue moves on.
const STEP_MS = 5 * 60000,
  STEP_GRACE_MS = 15000;

// Every workspace uses one Jev-managed Chrome connection shared by its workers.
export class BrowserTools {
  constructor(directory, jevOptionsForCandidate = () => ({})) {
    this.directory = directory;
    this.jevOptionsForCandidate = jevOptionsForCandidate;
    this.stepMs = STEP_MS;
    this.stepGraceMs = STEP_GRACE_MS;
    this.clients = new Map();
    this.operations = new Map();
    this.connectionKeys = new Map();
    this.connections = new BrowserConnections({
      connect: async (id) => {
        const {client} = await this.connect(id);
        await client.context();
      },
      changed: (id, state) => this.onStatus?.(id, state),
    });
  }
  forWorker(workerId = 'main', isActive = () => true, {signal, siteLane} = {}) {
    const scoped = Object.create(this);
    scoped.siteLane = siteLane;
    scoped.workerId = workerId;
    scoped.isActive = isActive;
    scoped.signal = signal;
    return scoped;
  }
  options(id) {
    return this.jevOptionsForCandidate(id, this.workerId ?? 'main');
  }
  status(id) {
    const options = this.options(id),
      key = JSON.stringify([options.profile?.directory, options.connection]);
    if (this.connectionKeys.get(id) !== key) {
      this.connectionKeys.set(id, key);
      this.connections.reset(id);
    }
    return this.connections.status(id);
  }
  prepare(id, options) {
    this.status(id);
    return this.connections.prepare(id, options);
  }
  waiting(id) {
    const state = this.status(id);
    return !state.ready && state.state !== 'idle';
  }
  async resetCandidate(id) {
    this.connections.reset(id);
    const previous = this.clients.get(id);
    this.clients.delete(id);
    this.connectionKeys.delete(id);
    if (previous) {
      const connected = await previous.pending.catch(() => null);
      if (connected) await connected.client.close();
    }
  }
  async connect(candidateId) {
    const options = this.options(candidateId),
      key = JSON.stringify({profile: options.profile?.directory, connection: options.connection});
    const previous = this.clients.get(candidateId);
    if (previous?.key === key) return previous.pending;
    if (previous)
      try {
        await (await previous.pending).client.close();
      } catch {}
    const connection = {key};
    const pending = this.open(candidateId, options)
      .then((value) => {
        connection.client = value.client;
        return value;
      })
      .catch((error) => {
        if (this.clients.get(candidateId) === connection) this.clients.delete(candidateId);
        throw error;
      });
    connection.pending = pending;
    this.clients.set(candidateId, connection);
    return pending;
  }
  async open(candidateId, options = {}) {
    const base = this.directoryFor?.(candidateId) ?? this.directory;
    const directory = path.join(base, 'browsers', candidateId);
    const workspace =
      this.workspaceFor?.(candidateId) ?? path.join(base, 'candidates', candidateId);
    await mkdir(workspace, {recursive: true, mode: 0o700});
    await mkdir(directory, {recursive: true, mode: 0o700});
    return {
      client: new JevBrowser(path.join(directory, 'jev-profile'), {
        ...options,
        siteAccess: this.siteAccess,
        workspace,
        onDisconnect: (reason) => this.connections.disconnected(candidateId, reason),
        onTabsClosed: (ids) => {
          if (!this.closed) return this.onTabsClosed?.(candidateId, ids);
        },
      }),
      tools: jevTools,
      directory,
      workspace,
    };
  }
  async tools() {
    return jevTools;
  }
  async call(candidateId, name, args, sessionId, options) {
    const result = await this.enqueue(candidateId, (signal) =>
      this.performCall(candidateId, name, args, sessionId, options, signal),
    );
    return resolveBrowserCaptcha(this, candidateId, result, sessionId, options);
  }
  async enqueue(candidateId, run, {checkActive = true} = {}) {
    const previous = this.operations.get(candidateId) ?? Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(() => {
        if (checkActive && this.isActive && !this.isActive())
          throw Error('The worker session has closed.');
        return this.bounded(candidateId, run);
      });
    this.operations.set(candidateId, operation);
    try {
      return await operation;
    } finally {
      if (this.operations.get(candidateId) === operation) this.operations.delete(candidateId);
    }
  }
  async bounded(candidateId, run) {
    const step = new AbortController(),
      minutes = this.stepMs / 60000;
    let cancel, drop;
    const expired = new Promise((_, reject) => {
      cancel = setTimeout(() => {
        step.abort(
          Object.assign(
            Error(
              `The browser step did not finish within ${minutes} minutes and was stopped. Report it as a technical blocker; do not repeat an action whose result is uncertain.`,
            ),
            {code: 'BROWSER_STEP_TIMEOUT'},
          ),
        );
        drop = setTimeout(() => {
          this.resetCandidate(candidateId).catch(() => {});
          reject(
            Object.assign(
              Error(
                `The browser step did not finish within ${minutes} minutes and ignored cancellation, so the app dropped the Chrome connection; the next step reconnects. Report it as a technical blocker; do not repeat an action whose result is uncertain.`,
              ),
              {code: 'BROWSER_STEP_TIMEOUT'},
            ),
          );
        }, this.stepGraceMs);
      }, this.stepMs);
    });
    try {
      return await Promise.race([Promise.resolve().then(() => run(step.signal)), expired]);
    } finally {
      clearTimeout(cancel);
      clearTimeout(drop);
    }
  }
  async waitForOperations(candidateId) {
    await this.operations.get(candidateId)?.catch(() => {});
  }
  async performCall(
    candidateId,
    name,
    args,
    sessionId,
    {
      automationTabKey,
      automationWorkspaceId,
      automationSourceUrl,
      automationSourceUrls,
      automationPreferredTabId,
      automationFreshTab,
      automationResumeRecord,
    } = {},
    stepSignal,
  ) {
    if (!this.prepare(candidateId).ready)
      return {content: [{type: 'text', text: JSON.stringify(browserWaitResult())}]};
    const {client} = await this.connect(candidateId);
    if (this.isActive && !this.isActive()) throw Error('The worker session has closed.');
    if (name === 'browser_target_press') {
      const url = client.tab(args.tabId).page.url();
      try {
        const token = /^https?:/.test(url)
          ? this.siteAccess?.forLane(this.siteLane).assertAction(url)
          : null;
        if (token) client.tab(args.tabId).accessProbe = {url, token};
      } catch (error) {
        if (error.code !== 'SITE_WAIT') throw error;
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'site_wait',
                url,
                tabId: args.tabId,
                siteWait: error.wait,
                text: error.message,
                message: error.message,
                executed: false,
              }),
            },
          ],
        };
      }
      client.siteLane = this.siteLane;
      try {
        return await pressBrowserTarget(client, true, args, sessionId);
      } finally {
        client.siteLane = undefined;
      }
    }
    if (!jevTools.some((t) => t.name === name)) throw Error('Unknown browser tool');
    let result;
    try {
      result = await client.callTool({name, arguments: args}, sessionId, {
        ...this.options(candidateId).lifecycle,
        signal: AbortSignal.any([this.signal, stepSignal].filter(Boolean)),
        ...(this.siteLane ? {siteLane: this.siteLane} : {}),
        ...(automationTabKey ? {automationTabKey} : {}),
        ...(automationWorkspaceId ? {automationWorkspaceId: candidateId} : {}),
        ...(automationSourceUrl ? {automationSourceUrl, automationSourceUrls} : {}),
        ...(automationPreferredTabId ? {automationPreferredTabId} : {}),
        ...(automationFreshTab ? {automationFreshTab: true} : {}),
        ...(automationResumeRecord ? {automationResumeRecord: true} : {}),
      });
    } catch (error) {
      if (
        (!client.browser && client.connection === 'existing') ||
        error.code === 'BROWSER_DISCONNECTED'
      ) {
        this.connections.disconnected(candidateId);
        return {content: [{type: 'text', text: JSON.stringify(browserWaitResult())}]};
      }
      throw error;
    }
    if (!result.isError)
      for (const part of result.content ?? []) {
        if (part.type !== 'text') continue;
        try {
          const slot = client.tabs.get(JSON.parse(part.text).tabId);
          if (slot) slot.previewAt = Date.now();
        } catch {}
      }
    return result;
  }
  // The connected client for a workspace, or null when nothing is connected or
  // the profile changed. UI reads must never start Chrome or prompt for permission.
  async connectedClient(candidateId) {
    const connection = this.clients.get(candidateId);
    if (!connection) return null;
    const connected = await connection.pending.catch(() => null),
      client = connected?.client;
    if (
      !client ||
      client.closed ||
      this.clients.get(candidateId) !== connection ||
      client.profile?.directory !== this.options(candidateId).profile?.directory
    )
      return null;
    return client;
  }
  async focus(candidateId, context) {
    return (await this.connect(candidateId)).client.focus(context.tabId);
  }
  probeAutomationSource(id, task) {
    const connection = this.clients.get(id),
      client = connection?.client;
    if (
      this.closed ||
      !client ||
      client.closed ||
      client.busy ||
      this.operations.has(id) ||
      !this.status(id).ready
    )
      return Promise.resolve({ready: false, deferred: true});
    return this.enqueue(
      id,
      () => {
        if (
          this.clients.get(id) !== connection ||
          client.profile?.directory !== this.options(id).profile?.directory
        )
          return {ready: false, deferred: true};
        return checkSourceBrowser(client, id, task);
      },
      {checkActive: false},
    );
  }
  async workspaceTabs(id) {
    const client = await this.connectedClient(id);
    if (!client || (client.connection === 'existing' && !client.browser?.isConnected())) return [];
    const ownTab = (slot) => {
      const owner = client.automationWorkspaces.get(slot.id);
      if (owner) return owner === id;
      // Tabs created before workspace labels were added remain in this browser's
      // exact owned-target set. Never infer ownership from URL or profile alone.
      return client.connection === 'existing' ? client.transport?.owned.has(slot.id) : true;
    };
    return [...client.tabs.values()]
      .filter(
        (slot) =>
          slot.id !== client.homeId &&
          !client.spareTabs?.has(slot.id) &&
          !slot.page.isClosed() &&
          ownTab(slot),
      )
      .map((slot) => ({
        tabId: slot.id,
        url: slot.page.url(),
        title: slot.observed?.title ?? '',
        browser: 'Jev Chrome',
        ...(client.automationRuns.has(slot.id) ? {runId: client.automationRuns.get(slot.id)} : {}),
        ...(client.automationTabs.get(slot.id)?.startsWith('record:')
          ? {recordId: client.automationTabs.get(slot.id).slice(7)}
          : {}),
        ...(client.automationSources.has(slot.id)
          ? {sourceUrl: client.automationSources.get(slot.id)}
          : {}),
      }));
  }
  async focusWorkspaceTab(id, tabId) {
    if (
      typeof tabId !== 'string' ||
      !(await this.workspaceTabs(id)).some((tab) => tab.tabId === tabId)
    )
      throw Object.assign(Error('No open tab was found for this workspace.'), {
        code: 'TAB_MISSING',
      });
    const connection = this.clients.get(id),
      client = (await connection?.pending)?.client,
      slot = client?.tabs.get(tabId);
    if (this.clients.get(id) !== connection || !slot || slot.page.isClosed())
      throw Object.assign(Error('The tab was closed.'), {code: 'TAB_MISSING'});
    await client.bringToFront(slot);
    return {focused: true};
  }
  async closeWorkspaceTabs(id, selection) {
    if (
      !Array.isArray(selection) ||
      !selection.length ||
      selection.some(
        (tab) => !tab || typeof tab.tabId !== 'string' || typeof tab.url !== 'string',
      ) ||
      new Set(selection.map((tab) => tab.tabId)).size !== selection.length
    )
      throw Error('The tabs to close are invalid.');
    return this.enqueue(
      id,
      async () => {
        const available = new Map((await this.workspaceTabs(id)).map((tab) => [tab.tabId, tab]));
        if (
          selection.some((tab) => {
            const live = available.get(tab.tabId);
            return !live || live.url !== tab.url || live.sourceUrl !== tab.sourceUrl;
          })
        )
          throw Object.assign(Error('The tabs changed. Refresh the list and try again.'), {
            code: 'TAB_CHANGED',
          });
        const connection = this.clients.get(id),
          client = (await connection?.pending)?.client;
        if (this.clients.get(id) !== connection || !client)
          throw Object.assign(Error('The Chrome connection closed.'), {code: 'TAB_MISSING'});
        const closed = [],
          failed = [];
        for (const tab of selection) {
          const slot = client.tabs.get(tab.tabId);
          if (!slot || slot.page.isClosed() || slot.page.url() !== tab.url) {
            failed.push(tab.tabId);
            continue;
          }
          try {
            await slot.page.close({runBeforeUnload: false});
            client.forgetTab(tab.tabId);
            closed.push(tab.tabId);
          } catch {
            failed.push(tab.tabId);
          }
        }
        if (closed.length) await client.onTabsClosed(closed);
        await client.persistTabs();
        return {closed, failed};
      },
      {checkActive: false},
    );
  }
  // A failed source check leaves its tab open for the user; the resumed run
  // closes it like a finished run's tab.
  closeSourceCheck(id, run) {
    return this.finishAutomationRun(
      id,
      {id: sourceCheckOwner(run.taskId), workerId: run.workerId},
      {closeTabs: true, keepForms: false},
    );
  }
  async finishAutomationRun(
    id,
    run,
    {
      closeTabs = false,
      sourceAccessReset = false,
      runIds = [run.id],
      keepForms = true,
      pendingTabIds = [],
      closeAll = false,
    } = {},
  ) {
    if (!closeTabs) return {closed: []};
    const connection = this.clients.get(id);
    if (!connection) return {deferred: true};
    return this.forWorker(run.workerId ?? 'main').enqueue(
      id,
      async () => {
        const client = await this.connectedClient(id);
        if (!client || this.clients.get(id) !== connection) return {deferred: true};
        return client.closeFinishedAutomationRunTabs(runIds, id, {
          keepForms,
          pendingTabIds,
          closeAll,
          ...(sourceAccessReset ? {resetSource: run.sourceUrl} : {}),
        });
      },
      {checkActive: false},
    );
  }
  async close({closeTabs = false} = {}) {
    this.closed = true;
    this.connections.close();
    // Cancel all queued connections before an active one releases its turn.
    await Promise.all(
      [...this.clients].map(async ([key, {pending}]) => {
        try {
          const {client} = await pending;
          const result = await client.close({closeTabs});
          if (closeTabs && result?.closed?.length) this.onTabsClosed?.(key, result.closed);
          if (result?.failed?.length)
            console.warn(`Could not close Chrome tabs: ${result.failed.join(', ')}`);
        } catch (error) {
          console.warn('Could not close the browser connection:', error);
        }
      }),
    );
    this.clients.clear();
  }
}
