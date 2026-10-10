import {captureVerificationTargets, clickVerificationCheckbox} from './verification-checkbox.mjs';
import {
  prepareCloudflareCheckbox,
  cloudflareCheckboxMessage,
} from '../captcha/cloudflare-checkbox.mjs';
import {installTurnstileRegistration} from '../captcha/turnstile-registration.mjs';
import {installNoTranslate} from './translation.mjs';
import {prepareTurnstileBarrier, turnstileBarrierResult} from '../captcha/barrier.mjs';
import {privateJevPage, retryJevRead} from './page.mjs';
import {acquireTabRendering} from './rendering.mjs';
import {accessBarrier, SiteWaitError} from '../browser/site-access.mjs';
import {observeFormFrame, actFormFrame, usableFormFrame} from './frame-actions.mjs';
import {captureCookieFrameTargets, clickCookieFrameTarget} from './cookie-frame.mjs';
import {documentObservation, waitForDocument} from './document.mjs';
import {uploadDetails, validateUploadPurpose, isUploadTrigger} from './upload.mjs';
import {capturePasswordFields, savedLoginState} from './credentials.mjs';
import {captureEmbeddedForms, embeddedFormTarget} from './frames.mjs';
import {takeUploadAttempt} from './upload-budget.mjs';
import {installFormSemantics} from './form-semantics.mjs';
import {verificationEvidence, updateVerification, verificationHandoff} from './verification.mjs';
import {readFile, mkdir} from 'node:fs/promises';
import {setTimeout as pause} from 'node:timers/promises';
import {createRequire} from 'node:module';
import {randomUUID, createHash} from 'node:crypto';
import path from 'node:path';
import {actionSpace, chooseJev, jevConfig} from './policy.mjs';
import {
  existingChromeEndpoint,
  openChromeWindow,
  chromeWindowMarker,
  resolveChromeProfile,
} from './chrome.mjs';
import {JevCdpTransport} from './cdp.mjs';
import {acquireChromeConnection} from './connection-queue.mjs';
import {JevTabs, restoredTargets, sameBrowserInstance} from './tabs.mjs';
import {disposableResearchTab} from './tab-lifecycle.mjs';
import {selectAutocomplete} from './autocomplete.mjs';
import {selectChoice, verifyChoice, choiceKey} from './choice.mjs';
import {captureClickTargets, takeClickTarget} from './click.mjs';
import {
  captureFillFields,
  clearFillFields,
  fillKnownFields,
  inspectApplicationForm,
} from './form.mjs';
import {
  captureControls,
  navigateObserved,
  compactElements,
  presentObservation,
  observationPolicy,
  progressKey,
  blockedRepeat,
  rememberProgress,
  stalled,
} from './navigation.mjs';
import {validateJevArgs} from './tools.mjs';
const require = createRequire(import.meta.url);
const urlHash = (url) => createHash('sha256').update(url).digest('hex');
// Tools that write to or scroll the page need a rendering tab (see rendering.mjs).
const WRITE_TOOLS = new Set([
  'browser_jev_act',
  'browser_jev_autocomplete',
  'browser_jev_click',
  'browser_jev_fill_fields',
  'browser_jev_frame_act',
  'browser_jev_next',
  'browser_jev_reveal',
  'browser_jev_scroll',
  'browser_jev_select_choice',
  'browser_jev_select_option',
  'browser_jev_upload',
  'browser_target_press',
]);
const homeUrl =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    '<!doctype html><title>AutoJev</title><h1>AutoJev</h1><p>İlanlar ve başvuru formları bu pencerede sekmeler olarak açılır.</p>',
  );
const checkedUrl = (value) => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw Error('Only HTTP(S) URLs without credentials are supported');
  return url.toString();
};

export class JevBrowser {
  constructor(
    directory,
    {
      config = jevConfig,
      choose = chooseJev,
      launch,
      headless = false,
      workspace,
      siteAccess,
      autoVerify = () => false,
      connection = 'existing',
      profile,
      endpoint = existingChromeEndpoint,
      openWindow = openChromeWindow,
      checkpoints = [],
      accountVault = null,
      onDisconnect = () => {},
      onTabsClosed = () => {},
    } = {},
  ) {
    this.siteAccess = siteAccess;
    this.autoVerify = autoVerify;
    this.accountVault = accountVault;
    this.directory = directory;
    this.config = config;
    this.choose = choose;
    this.launch = launch;
    this.headless = headless;
    this.workspace = workspace;
    this.onDisconnect = onDisconnect;
    this.onTabsClosed = onTabsClosed;
    this.checkpoints = checkpoints;
    this.connection = connection;
    this.profile = profile;
    this.endpoint = endpoint;
    this.openWindow = openWindow;
    this.tabs = new Map();
    this.automationTabs = new Map();
    this.automationRuns = new Map();
    this.automationWorkspaces = new Map();
    this.automationSources = new Map();
    this.urlHashes = new Map();
    this.busy = false;
    this.closed = false;
    this.abort = new AbortController();
  }
  async context() {
    if (this.closed) throw Error('Jev browser is closed');
    if (!this.opening)
      this.opening = (async () => {
        const snapshot = await readFile(
          new URL('../../vendor/jev-ultrafast/snapshot.js', import.meta.url),
          'utf8',
        );
        this.reader = `(() => { (${installFormSemantics.toString()})(); return ${snapshot}; })()`;
        if (this.connection === 'existing') {
          this.profileDirectory ??= await resolveChromeProfile(this.profile);
          this.registry ??= new JevTabs(this.directory, this.profileDirectory);
          let transport, browser, release;
          try {
            release = await acquireChromeConnection({signal: this.abort.signal});
            // Chrome chooses the approval dialog's profile before CDP connects.
            // Open and focus our selected profile first, even when it was closed.
            const marker = await this.prepareProfileWindow();
            const endpoint = await this.endpoint(),
              saved = await this.registry.read();
            await marker.waitForReady({signal: this.abort.signal});
            transport = await JevCdpTransport.connect(endpoint, {signal: this.abort.signal});
            this.transport = transport;
            transport.onTargetDestroyed = (id) => {
              this.forgetTab(id);
              this.persistTabs().catch(() => {});
            };
            this.abort.signal.throwIfAborted();
            const markerId = await transport.ownWindow(marker.url);
            const {targetInfo} = await transport.call('Target.getTargetInfo', {targetId: markerId});
            const contextId = targetInfo.browserContextId;
            if (!contextId) throw Error('Seçili Chrome profilinin tarayıcı bağlamı doğrulanamadı.');
            const {targetInfos} = await transport.call('Target.getTargets');
            const live = new Map(
              targetInfos.filter((t) => t.type === 'page').map((t) => [t.targetId, t]),
            );
            // A reconnect may change the address, but a different browser instance
            // must not inherit old ownership. A saved context ID is not proof of
            // the selected profile: verify it through a window opened in that
            // profile before restoring any live tabs, including saved home tabs.
            const recoverable = !saved || sameBrowserInstance(saved.endpoint, endpoint);
            const restored = recoverable
              ? restoredTargets(saved, this.checkpoints, live, contextId)
              : [];
            this.homeId = restored.includes(saved?.homeId) ? saved.homeId : null;
            this.windowId =
              saved?.endpoint === endpoint && saved.contextId === contextId ? saved.windowId : null;
            if (restored.length) {
              transport.owned.delete(markerId);
              await transport.call('Target.closeTarget', {targetId: markerId});
              marker.close();
              this.profileWindow = null;
            } else {
              this.homeId = markerId;
              this.windowId = (
                await transport.call('Browser.getWindowForTarget', {targetId: markerId})
              ).windowId;
            }
            this.automationTabs = new Map(
              restored
                .filter((id) => typeof saved?.automationTabs?.[id] === 'string')
                .map((id) => [id, saved.automationTabs[id]]),
            );
            this.automationRuns = new Map(
              restored
                .filter((id) => typeof saved?.automationRuns?.[id] === 'string')
                .map((id) => [id, saved.automationRuns[id]]),
            );
            this.automationWorkspaces = new Map(
              restored
                .filter((id) => typeof saved?.automationWorkspaces?.[id] === 'string')
                .map((id) => [id, saved.automationWorkspaces[id]]),
            );
            this.automationSources = new Map(
              restored
                .filter((id) => typeof saved?.automationSources?.[id] === 'string')
                .map((id) => [id, saved.automationSources[id]]),
            );
            this.urlHashes = new Map(
              restored
                .filter((id) => typeof saved?.urlHashes?.[id] === 'string')
                .map((id) => [id, saved.urlHashes[id]]),
            );
            for (const id of restored) transport.owned.add(id);
            this.connectedEndpoint = endpoint;
            this.contextId = contextId;
            browser = await createRequire(require.resolve('@playwright/mcp/package.json'))(
              'playwright',
            ).chromium.connectOverCDP(transport, {timeout: 30000, noDefaults: true});
            this.abort.signal.throwIfAborted();
            this.browser = browser;
            this.tracking = new WeakMap();
            this.tabs.clear();
            const context = browser.contexts()[0];
            if (!context) throw Error('Chrome tarayıcı bağlamı bulunamadı.');
            browser.on('disconnected', () => {
              if (this.browser !== browser) return;
              this.browser = null;
              this.transport = null;
              this.opening = null;
              this.tabs.clear();
              this.tracking = new WeakMap();
              if (!this.closed) this.onDisconnect();
            });
            for (const page of context.pages()) await this.track(context, page);
            context.on('page', (page) => this.track(context, page).catch(() => {}));
            if (this.homeId === markerId) await this.tab(markerId).page.goto(homeUrl);
            marker.close();
            this.profileWindow = null;
            if (contextId) await this.persistTabs();
            return context;
          } catch (error) {
            await browser?.close().catch(() => {});
            transport?.close();
            if (this.transport === transport) this.transport = null;
            if (this.browser === browser) {
              this.browser = null;
              this.tabs.clear();
            }
            if (this.abort.signal.aborted) {
              this.profileWindow?.close();
              this.profileWindow = null;
            }
            throw Object.assign(
              Error(`Chrome bağlantısı kurulamadı: ${error.message.split('\n')[0]}`),
              {code: 'BROWSER_DISCONNECTED'},
            );
          } finally {
            release?.();
          }
        }
        await mkdir(this.directory, {recursive: true, mode: 0o700});
        const launch =
          this.launch ??
          ((dir, options) =>
            createRequire(require.resolve('@playwright/mcp/package.json'))(
              'playwright',
            ).chromium.launchPersistentContext(dir, options));
        const context = await launch(this.directory, {
          channel: 'chrome',
          headless: this.headless,
          viewport: {width: 1120, height: 780},
        });
        for (const page of context.pages()) await this.track(context, page);
        context.on('page', (page) => this.track(context, page).catch(() => {}));
        return context;
      })().catch((error) => {
        this.opening = null;
        throw error;
      });
    return this.opening;
  }
  async prepareProfileWindow() {
    this.abort.signal.throwIfAborted();
    if (!this.profileWindow) {
      const marker = await chromeWindowMarker({observeFocus: true});
      this.profileWindow = marker;
      try {
        await this.openWindow(
          marker.url,
          {directory: this.profileDirectory},
          {signal: this.abort.signal},
        );
      } catch (error) {
        marker.close();
        this.profileWindow = null;
        throw error;
      }
    }
    // A slow load or a denied connection reuses this window on retry.
    this.abort.signal.throwIfAborted();
    await this.profileWindow.waitForReady({signal: this.abort.signal});
    return this.profileWindow;
  }
  async findOwnedPage(id) {
    for (let i = 0; i < 100; i++) {
      for (const context of this.browser.contexts())
        for (const page of context.pages()) {
          const slot = await this.track(context, page);
          if (slot.id === id) return page;
        }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw Error('Yeni Jev penceresi bağlantıya eklenemedi; mevcut formlar korunuyor.');
  }
  async track(context, page) {
    if (this.tracking?.has(page)) return this.tracking.get(page);
    this.tracking ??= new WeakMap();
    const pending = (async () => {
      const cdp = await context.newCDPSession(page),
        {targetInfo} = await cdp.send('Target.getTargetInfo');
      const slot = {
        page: privateJevPage(page),
        cdp,
        id: targetInfo.targetId,
        openerId: targetInfo.openerId,
        history: [],
        pending: null,
        uploads: new Map(),
      };
      // A tab that rejects init scripts still works; its labels may then be translated.
      await installNoTranslate(slot.page).catch(() => {});
      if (this.autoVerify()) await installTurnstileRegistration(slot.page);
      if (this.connection === 'existing') {
        this.contextId = targetInfo.browserContextId;
        await this.persistTabs();
      }
      page.on('response', (response) => {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame())
          slot.http = {
            url: response.url(),
            status: response.status(),
            retryAfter: response.headers()['retry-after'],
          };
      });
      this.tabs.set(slot.id, slot);
      if (!this.automationTabs.has(slot.id) && this.automationTabs.has(slot.openerId))
        this.automationTabs.set(slot.id, this.automationTabs.get(slot.openerId));
      if (!this.automationRuns.has(slot.id) && this.automationRuns.has(slot.openerId))
        this.automationRuns.set(slot.id, this.automationRuns.get(slot.openerId));
      if (this.automationWorkspaces.has(slot.openerId))
        this.automationWorkspaces.set(slot.id, this.automationWorkspaces.get(slot.openerId));
      if (this.automationSources.has(slot.openerId))
        this.automationSources.set(slot.id, this.automationSources.get(slot.openerId));
      page.on('close', () => {
        if (this.tabs.get(slot.id) === slot) {
          this.tabs.delete(slot.id);
          if (
            this.connection === 'existing' &&
            this.transport?.socket.readyState !== WebSocket.OPEN
          )
            return;
          this.forgetTab(slot.id);
          this.persistTabs().catch(() => {});
        }
      });
      await this.persistTabs();
      return slot;
    })();
    this.tracking.set(page, pending);
    return pending;
  }
  async claimAutomationTab(slot, owner, state) {
    if (!state.automationWorkspaceId) return;
    if (
      this.automationRuns.get(slot.id) === owner &&
      this.automationWorkspaces.get(slot.id) === state.automationWorkspaceId &&
      (!state.automationTabKey || this.automationTabs.get(slot.id) === state.automationTabKey)
    )
      return;
    this.automationRuns.set(slot.id, owner);
    if (state.automationTabKey) this.automationTabs.set(slot.id, state.automationTabKey);
    this.automationWorkspaces.set(slot.id, state.automationWorkspaceId);
    await this.persistTabs();
  }
  async persistTabs() {
    if (this.connection === 'existing' && this.transport && this.contextId)
      await this.registry.save(this.connectedEndpoint, this.contextId, this.transport.owned, {
        homeId: this.homeId ?? null,
        windowId: this.windowId ?? null,
        automationTabs: Object.fromEntries(this.automationTabs),
        automationRuns: Object.fromEntries(this.automationRuns),
        automationWorkspaces: Object.fromEntries(this.automationWorkspaces),
        automationSources: Object.fromEntries(this.automationSources),
        urlHashes: Object.fromEntries(this.urlHashes),
      });
  }
  forgetTab(id) {
    this.tabs.delete(id);
    this.automationTabs.delete(id);
    this.automationRuns.delete(id);
    this.automationWorkspaces.delete(id);
    this.automationSources.delete(id);
    this.urlHashes.delete(id);
    this.transport?.owned.delete(id);
    this.transport?.attached.delete(id);
    for (const slot of this.tabs.values())
      for (const [url, child] of slot.openedFrames ?? [])
        if (child === id) slot.openedFrames.delete(url);
  }
  async openTabFrom(slot) {
    // Opening from an owned page selects its exact window; Target.createTarget
    // otherwise picks whichever personal Chrome window was activated last.
    const marker = await chromeWindowMarker();
    try {
      const {frameTree} = await slot.cdp.send('Page.getFrameTree');
      const {executionContextId} = await slot.cdp.send('Page.createIsolatedWorld', {
        frameId: frameTree.frame.id,
        worldName: 'jobloop-tabs',
      });
      await slot.cdp.send('Runtime.evaluate', {
        expression: `window.open(${JSON.stringify(marker.url)}, '_blank')`,
        contextId: executionContextId,
        userGesture: true,
      });
      const id = await this.transport.ownWindow(marker.url),
        page = await this.findOwnedPage(id);
      const [parent, child] = await Promise.all(
        [slot.id, id].map((targetId) =>
          this.transport.call('Browser.getWindowForTarget', {targetId}),
        ),
      );
      if (parent.windowId !== child.windowId) {
        await page.close();
        throw Error('Yeni sekme AutoJev penceresinde açılamadı.');
      }
      return page;
    } finally {
      marker.close();
    }
  }
  async home() {
    let home = this.tabs.get(this.homeId);
    if (home && !home.page.isClosed() && home.page.url() === homeUrl) return home;
    this.homeId = null;
    const candidates = [...this.tabs.values()].filter((s) => !s.page.isClosed());
    let anchor;
    for (const slot of candidates) {
      const window = await this.transport
        .call('Browser.getWindowForTarget', {targetId: slot.id})
        .catch(() => null);
      if (window && (!anchor || window.windowId === this.windowId)) {
        anchor = slot;
        if (window.windowId === this.windowId) break;
      }
    }
    let page;
    if (anchor) page = await this.openTabFrom(anchor);
    else {
      const marker = await chromeWindowMarker();
      try {
        await this.openWindow(marker.url, {directory: this.profileDirectory});
        page = await this.findOwnedPage(await this.transport.ownWindow(marker.url));
      } finally {
        marker.close();
      }
    }
    home = await this.track(page.context(), page);
    this.homeId = home.id;
    this.windowId = (
      await this.transport.call('Browser.getWindowForTarget', {targetId: home.id})
    ).windowId;
    await page.goto(homeUrl);
    await this.persistTabs();
    return home;
  }
  // Sites rewrite their own URL after an observation (selected listing,
  // tracking parameters). Only a different origin counts as navigating away.
  leftObservedPage(slot) {
    const url = slot.page.url();
    if (this.urlHashes.get(slot.id) === urlHash(url)) return false;
    try {
      return new URL(slot.observed.url).origin !== new URL(url).origin;
    } catch {
      return true;
    }
  }
  // runIds are the finished runs whose tabs belong to the completed work.
  async closeFinishedAutomationRunTabs(
    runIds,
    workspaceId,
    {keepForms = false, pendingTabIds = [], resetSource = null} = {},
  ) {
    if (
      this.closed ||
      this.busy ||
      !this.opening ||
      (this.connection === 'existing' && !this.browser?.isConnected())
    )
      return {deferred: true};
    this.busy = true;
    try {
      const closed = [],
        retained = [],
        pending = new Set(pendingTabIds);
      for (const slot of [...this.tabs.values()]) {
        if (
          slot.id === this.homeId ||
          slot.page.isClosed() ||
          this.automationWorkspaces.get(slot.id) !== workspaceId ||
          !runIds.includes(this.automationRuns.get(slot.id))
        )
          continue;
        if (
          resetSource &&
          (this.automationSources.get(slot.id) !== resetSource ||
            this.automationTabs.get(slot.id)?.startsWith('record:'))
        )
          continue;
        if (
          !resetSource &&
          (pending.has(slot.id) ||
            slot.verification ||
            this.leftObservedPage(slot) ||
            (keepForms && !(await disposableResearchTab(slot))))
        ) {
          retained.push(slot.id);
          continue;
        }
        try {
          await slot.page.close({runBeforeUnload: false});
          this.forgetTab(slot.id);
          closed.push(slot.id);
        } catch {
          retained.push(slot.id);
        }
      }
      if (closed.length) await this.onTabsClosed(closed);
      await this.persistTabs();
      return {closed, retained};
    } finally {
      this.busy = false;
    }
  }
  tab(id) {
    if (/^\d+$/.test(id))
      throw Object.assign(
        Error(
          'Bu sayısal sekme kimliği mevcut Chrome aracına ait, Jev CDP kimliği değil. Kayıtlı taslağı orijinal Chrome aracıyla sürdür; Jev bağlantısını yenileme veya yeni sekme açma.',
        ),
        {code: 'TAB_BACKEND_MISMATCH'},
      );
    const slot = this.tabs.get(id);
    if (!slot || slot.page.isClosed())
      throw Object.assign(
        Error(
          'Jev sekmesi bulunamadı: kayıtlı sekme kapatılmış veya seçili Chrome oturumunda artık mevcut değil. browser_jev_tabs ile kurtarılan sekmeleri kontrol et. Kaydı yeniden açmadan önce kayıtlı sonucu doğrula; gönderildiği belirsiz bir işlemi tekrar gönderme.',
        ),
        {code: 'TAB_MISSING'},
      );
    return slot;
  }
  async navigate(slot, url) {
    if (this.autoVerify()) await installTurnstileRegistration(slot.page);
    // Paced sites wait their turn before the request leaves; cancellable.
    const gap = this.siteAccess?.pace?.(url) ?? 0;
    if (gap > 0) await pause(gap, undefined, {signal: this.abort.signal});
    const token = this.siteAccess?.begin(url);
    slot.accessProbe = {url, token};
    slot.http = null;
    try {
      return await slot.page.goto(url, {waitUntil: 'domcontentloaded', timeout: 20000});
    } catch (error) {
      // A 429 answered before its document loaded may still be an interactive
      // verification page; with automatic verification the observation decides.
      if (slot.http?.status === 429 && this.siteAccess && this.autoVerify()) throw error;
      const wait =
        this.siteAccess?.complete(url, token, {
          ...slot.http,
          reason: slot.http?.status === 429 ? 'rate_limit' : null,
        }) ?? this.siteAccess?.unreachable(url, error);
      slot.accessProbe = null;
      if (wait) throw Object.assign(new SiteWaitError(wait), {url, tabId: slot.id});
      throw error;
    }
  }
  async observe(slot) {
    return retryJevRead(slot.page, async () => {
      const release = await acquireTabRendering(slot, {
        signal: this.readSignal ?? this.abort.signal,
      });
      try {
        return await this.observeOnce(slot);
      } finally {
        await release();
      }
    });
  }
  async observeOnce(slot) {
    // HTTP 429 can accompany a real interactive verification page. With
    // automatic verification the loaded document decides below: a challenge
    // gets its checkbox attempt, an ordinary rate limit starts the shared wait.
    // Without it, rate limits return immediately.
    if (this.siteAccess && slot.http?.status === 429 && !this.autoVerify()) {
      const probe = slot.accessProbe,
        url = probe?.url ?? slot.http.url;
      const wait =
        (slot.accessChecked === slot.http && this.siteAccess.status(url)) ||
        this.siteAccess.complete(url, probe?.token, {...slot.http, reason: 'rate_limit'});
      slot.accessProbe = null;
      slot.accessChecked = slot.http;
      slot.pending = null;
      throw Object.assign(new SiteWaitError(wait), {url: slot.http.url, tabId: slot.id});
    }
    await waitForDocument(slot, {signal: this.readSignal ?? this.abort.signal});
    const previousFields = slot.fillFields;
    await clearFillFields(slot);
    slot.pending = null;
    const previousUploads = slot.uploads;
    slot.uploads = new Map();
    const observed = await slot.page.evaluate(this.reader);
    if (!observed) throw Error('Sayfa yükleniyor; tekrar gözlemle.');
    if (this.siteAccess && /^https?:/.test(observed.url)) {
      const verificationPage =
        accessBarrier({title: observed.title, text: observed.text}) === 'verification';
      // A verification document behind HTTP 429 is the same interactive barrier.
      const reason = verificationPage
          ? 'verification'
          : accessBarrier({...slot.http, title: observed.title, text: observed.text}),
        probe = slot.accessProbe;
      const mayVerify =
        this.autoVerify() &&
        (!this.siteAccess.status(observed.url)?.waiting ||
          (probe?.token && this.siteAccess.row(observed.url)?.token === probe.token)) &&
        !this.automationTabs.get(slot.id)?.startsWith('record:');
      if (verificationPage && mayVerify && (await prepareTurnstileBarrier(slot))) {
        slot.observed = observed;
        this.urlHashes.set(slot.id, urlHash(observed.url));
        await this.persistTabs();
        return turnstileBarrierResult(slot, observed);
      }
      if (
        !verificationPage &&
        slot.turnstileBarrier?.phase === 'checking' &&
        !reason &&
        slot.http?.status >= 200 &&
        slot.http.status < 400
      ) {
        slot.turnstileBarrier.phase = 'cleared';
        delete slot.verification;
        delete slot.captchaDocument;
      }
      // A visible Cloudflare checkbox gets one native attempt before cooldown.
      // Record/application tabs retain their submission checkpoints. The
      // coordinator performs the click and waiting outside this observation.
      if (
        reason === 'verification' &&
        mayVerify &&
        !slot.turnstileBarrier &&
        (await prepareCloudflareCheckbox(slot))
      ) {
        slot.observed = observed;
        this.urlHashes.set(slot.id, urlHash(observed.url));
        await this.persistTabs();
        slot.verification = {
          state: 'checking',
          capability: 'pending',
          handoff: false,
          message: 'Cloudflare doğrulama kutusu kontrol ediliyor…',
        };
        return {
          browser: 'Jev Chrome',
          tabId: slot.id,
          url: observed.url,
          title: observed.title,
          text: '',
          status: 'verification_pending',
          verification: slot.verification,
          captcha: {
            kind: 'cloudflare_checkbox',
            state: 'checking',
            message: slot.verification.message,
          },
        };
      }
      if (!reason && slot.http?.status >= 200 && slot.http.status < 400) {
        delete slot.cloudflareAttempt;
        delete slot.cloudflareDiscovery;
        delete slot.cloudflareDiagnostic;
        delete slot.cloudflareDocument;
        delete slot.turnstileDiagnostic;
        await slot.cloudflareCheckbox?.dispose();
        delete slot.cloudflareCheckbox;
      }
      const wait =
        (reason && slot.accessChecked === slot.http && this.siteAccess.status(observed.url)) ||
        this.siteAccess.complete(probe?.url ?? observed.url, probe?.token, {...slot.http, reason});
      slot.accessProbe = null;
      slot.accessChecked = slot.http;
      if (wait) {
        const diagnostic = slot.cloudflareDiagnostic;
        if (diagnostic) {
          diagnostic.phase = 'handoff';
          if (diagnostic.clicked && diagnostic.reason !== 'document_changed')
            diagnostic.reason = 'barrier_after_click';
          diagnostic.elapsedMs = Date.now() - (slot.cloudflareDiscovery?.startedAt ?? Date.now());
        }
        const captcha = slot.turnstileBarrier
          ? slot.turnstileDiagnostic
          : diagnostic
            ? {
                ...diagnostic,
                message: cloudflareCheckboxMessage(diagnostic),
                ...(slot.turnstileDiagnostic ? {api: slot.turnstileDiagnostic} : {}),
              }
            : slot.turnstileDiagnostic;
        const detail = [captcha?.message, captcha?.api?.message].filter(Boolean).join(' '),
          reported = detail ? {...wait, message: wait.message + ' ' + detail} : wait;
        throw Object.assign(new SiteWaitError(reported), {
          url: observed.url,
          tabId: slot.id,
          ...(captcha ? {captcha} : {}),
        });
      }
    }
    const verification = updateVerification(slot, await verificationEvidence(slot.page, slot));
    slot.observed = observed;
    this.urlHashes.set(slot.id, urlHash(observed.url));
    await this.persistTabs();
    const fillFields = await captureFillFields(slot, slot.owner, previousFields);
    const uploadFrames = [slot.page.mainFrame()];
    for (const frame of slot.page.frames())
      if (await usableFormFrame(frame, slot.page).catch(() => false)) uploadFrames.push(frame);
    const uploads = [];
    try {
      for (const frame of uploadFrames)
        for (const locator of await frame.locator('input[type=file]').all()) {
          const input = await locator.elementHandle();
          if (!input) continue;
          const details = await input.evaluate(uploadDetails);
          if (!details) {
            await input.dispose();
            continue;
          }
          let uploadId;
          for (const [id, old] of previousUploads) {
            if (
              old.owner === slot.owner &&
              old.url === slot.page.url() &&
              JSON.stringify(old.details) === JSON.stringify(details) &&
              (await old.input.evaluate((e, current) => e === current, input).catch(() => false))
            ) {
              uploadId = id;
              break;
            }
          }
          uploadId ??= randomUUID();
          slot.uploads.set(uploadId, {
            input,
            frame,
            frameUrl: frame.url(),
            owner: slot.owner,
            url: slot.page.url(),
            details,
          });
          uploads.push({uploadId, ...details});
        }
    } finally {
      await Promise.all(
        [...previousUploads.values()].map(({input}) => input.dispose().catch(() => {})),
      );
    }
    const links = await slot.page.locator('a[href]').evaluateAll((nodes) =>
      nodes
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return (
            /^https?:/.test(e.href) &&
            e.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}) &&
            r.width > 0 &&
            r.height > 0 &&
            r.bottom > 0 &&
            r.top < innerHeight
          );
        })
        .slice(0, 100)
        .map((e) => ({
          text: (e.getAttribute('aria-label') || e.innerText || '').trim().slice(0, 500),
          url: e.href,
        })),
    );
    // Chrome's page translation rewrites labels between runs and away from the
    // page's own wording; the model must act on ids, not remembered labels.
    const translated = await slot.page
      .evaluate(() => /\btranslated-(?:ltr|rtl)\b/.test(document.documentElement.className))
      .catch(() => false);
    return {
      savedLogin: await slot.page.evaluate(savedLoginState),
      passwordFields: await capturePasswordFields(slot, slot.owner),
      ...(translated
        ? {
            translated: true,
            translationNotice:
              'Chrome translated this page. Labels differ from the original wording and from earlier runs; act on the ids and roles in this observation, never on a remembered label. A control with visible:false may be a translated duplicate; prefer the visible clickTargets entry.',
          }
        : {}),
      accountCredentials: this.accountVault?.status() ?? {configured: false},
      browser: 'Jev Chrome',
      tabId: slot.id,
      url: observed.url,
      title: observed.title,
      text: observed.text,
      verification,
      embeddedForms: await captureEmbeddedForms(slot),
      links,
      elements: compactElements(actionSpace(observed.actions).elements),
      clickTargets: [
        ...captureClickTargets(slot, slot.owner),
        ...(await captureCookieFrameTargets(slot)),
        ...(await captureVerificationTargets(slot)),
      ],
      ...captureControls(slot, slot.owner),
      fillFields,
      uploads,
      verificationDiagnostics: slot.verificationDiagnostics?.length
        ? slot.verificationDiagnostics
        : undefined,
      history: slot.history.slice(-4),
      omittedActions: observed.omitted_actions,
    };
  }
  async fresh(slot, page, action) {
    if (action?.kind === 'scroll') {
      const current = await slot.page.evaluate(this.reader);
      return (
        JSON.stringify(current?.scroll_guards?.[action.node]) ===
          JSON.stringify(page.scroll_guards?.[action.node]) &&
        JSON.stringify(current?.page_key) === JSON.stringify(page.page_key)
      );
    }
    if (action && ['click', 'select'].includes(action.kind)) {
      const current = await slot.page.evaluate((node) => {
        const c = window.__jevFast;
        return c ? [c.pageKey(), c.guard(c.nodes.get(node))] : null;
      }, action.node);
      return JSON.stringify(current) === JSON.stringify([page.page_key, page.guards[action.node]]);
    }
    return (
      JSON.stringify((await slot.page.evaluate(this.reader))?.marker) ===
      JSON.stringify(page.marker)
    );
  }
  async observeAfterAction(slot) {
    return this.observe(slot);
  }
  async execute(slot, pending, text) {
    const {action, observed, operation} = pending;
    if (
      slot.verification &&
      slot.verification.state !== 'answer_applied' &&
      action?.kind === 'click' &&
      /submit|send application|apply now|başvur|gönder/i.test(action.label ?? '')
    )
      return {
        ...verificationHandoff(slot),
        message:
          'Site doğrulaması çözümlenmedi. Başvuruyu tekrar gönderme; mevcut doğrulama adımını veya belirsiz sonucu işle.',
      };
    if (!(await this.fresh(slot, observed, action)))
      return {
        ...(await this.observe(slot)),
        status: 'stale',
        executed: false,
        message: 'Sayfa değişti. Yeni bir Jev kararı al.',
      };
    if (!action)
      return {
        ...(await this.observe(slot)),
        status: operation.toLowerCase(),
        executed: false,
        verified: false,
      };
    if (action.kind === 'click')
      for (const upload of slot.uploads?.values() ?? []) {
        if (
          upload.owner === slot.owner &&
          (await slot.page
            .evaluate(isUploadTrigger, {input: upload.input, node: action.node})
            .catch(() => false))
        )
          return {
            ...(await this.observe(slot)),
            status: 'upload_required',
            executed: false,
            message:
              'Dosya seçici açılmadı. Güncel uploads listesindeki uploadId ve çalışma alanındaki belge yolu ile browser_upload_document (doğrudan Jev: browser_jev_upload) kullan. Normal tıklamayı tekrarlama.',
          };
      }
    const repeatKey = JSON.stringify([action.kind, action.node, action.value, action.delta, text]),
      before = progressKey(observed);
    if (action.kind !== 'wait' && blockedRepeat(slot, repeatKey, before))
      return {...(await this.observe(slot)), ...stalled};
    if (action.choice && blockedRepeat(slot, choiceKey(action.node), before))
      return {...(await this.observe(slot)), ...stalled};
    let began = false;
    try {
      if (action.kind === 'wait') await new Promise((resolve) => setTimeout(resolve, 100));
      else if (action.kind === 'scroll') {
        began = true;
        await slot.page.evaluate(
          ({node, delta}) =>
            window.__jevFast.nodes.get(node).scrollBy({top: delta, behavior: 'instant'}),
          action,
        );
      } else {
        // Resolve only a node observed by Jev; model output never becomes code or selectors.
        const target = await slot.page.evaluate((a) => {
          const e = window.__jevFast?.nodes.get(a.node);
          if (
            !e?.isConnected ||
            e.matches(':disabled') ||
            e.closest('[aria-disabled="true"],[inert]')
          )
            return null;
          if (a.kind === 'fill' && (e.readOnly || e.getAttribute('aria-readonly') === 'true'))
            return null;
          return window.__jevFast.clickPoint(e);
        }, action);
        if (!target)
          return {
            ...(await this.observe(slot)),
            status: 'stale',
            executed: false,
            message: 'Hedef değişti veya üzeri kapandı. Yeni bir karar al.',
          };
        began = true;
        if (action.kind === 'select')
          await slot.page.evaluate((a) => {
            const e = window.__jevFast?.nodes.get(a.node);
            if (
              e?.tagName !== 'SELECT' ||
              ![...e.options].some(
                (o) => o.value === a.value && !o.disabled && !o.closest('optgroup[disabled]'),
              )
            )
              throw Error('Invalid option');
            e.value = a.value;
            e.dispatchEvent(new Event('input', {bubbles: true}));
            e.dispatchEvent(new Event('change', {bubbles: true}));
          }, action);
        else {
          for (const type of ['mousePressed', 'mouseReleased'])
            await slot.cdp.send('Input.dispatchMouseEvent', {
              type,
              ...target,
              button: 'left',
              clickCount: 1,
            });
          if (action.kind === 'fill') {
            await slot.cdp.send('Input.dispatchKeyEvent', {
              type: 'keyDown',
              key: 'a',
              code: 'KeyA',
              modifiers: process.platform === 'darwin' ? 4 : 2,
              commands: ['selectAll'],
            });
            await slot.cdp.send('Input.dispatchKeyEvent', {
              type: 'keyUp',
              key: 'a',
              code: 'KeyA',
              modifiers: process.platform === 'darwin' ? 4 : 2,
            });
            await slot.cdp.send('Input.insertText', {text});
          }
        }
      }
      slot.history.push({
        action: action.label,
        kind: action.kind,
        operation,
        text: action.kind === 'fill' ? text : undefined,
      });
      if (slot.history.length > 60) slot.history.shift();
      // Allow rendering/navigation to settle. Record execution first; never retry a mutation.
      await new Promise((resolve) => setTimeout(resolve, 100));
      let controlState;
      if (action.kind === 'click' && action.choice) {
        const expected =
          action.role === 'radio'
            ? true
            : action.choice.selected === null
              ? null
              : !action.choice.selected;
        controlState =
          expected === null
            ? {expected: null, actual: null, verified: false}
            : await verifyChoice(slot, action.node, action.choice, expected);
      } else if (
        action.kind === 'click' &&
        ['checkbox', 'radio', 'switch'].includes(action.role) &&
        action.checked !== undefined
      ) {
        const expected = action.role === 'radio' ? true : action.checked !== 'true';
        const actual = await slot.page.evaluate((node) => {
          const e = window.__jevFast?.nodes.get(node);
          if (!e?.isConnected) return null;
          return e.tagName === 'INPUT' && ['checkbox', 'radio'].includes(e.type)
            ? e.checked
            : e.getAttribute('aria-checked');
        }, action.node);
        controlState = {
          expected,
          actual,
          verified: actual === expected || actual === String(expected),
        };
      }
      const result = await this.observeAfterAction(slot),
        progress = rememberProgress(slot, repeatKey, before, progressKey(slot.observed));
      if (controlState && !controlState.verified) {
        const state = progressKey(slot.observed);
        rememberProgress(slot, repeatKey, state, state);
        if (action.choice) rememberProgress(slot, choiceKey(action.node), state, state);
      }
      const noChange = !progress && action.kind !== 'wait' && !controlState?.verified;
      return {
        ...result,
        status:
          controlState && !controlState.verified
            ? 'uncertain'
            : noChange
              ? action.kind === 'scroll'
                ? 'no_progress'
                : 'uncertain'
              : 'ready',
        executed: true,
        progress,
        ...(noChange || (controlState && !controlState.verified)
          ? {
              retryBlocked: true,
              message:
                action.kind === 'scroll'
                  ? stalled.message
                  : 'Eylem gönderildi fakat etkisi doğrulanamadı. Aynı işlemi tekrarlama; özellikle gönderimden sonra mevcut sonuç kanıtını kontrol et.',
            }
          : {}),
        ...(controlState ? {controlState} : {}),
      };
    } catch (error) {
      if (error.code === 'SITE_WAIT') {
        error.executed = began ? 'unknown' : false;
        throw error;
      }
      return {
        browser: 'Jev Chrome',
        tabId: slot.id,
        url: slot.page.url(),
        status: began ? 'uncertain' : 'error',
        executed: began ? 'unknown' : false,
        message:
          'İşlem sonrası durum doğrulanamadı. Önce browser_jev_observe çağır; özellikle gönderim işlemini tekrar etme.',
      };
    }
  }
  async callTool({name, arguments: args}, owner = 'local', state = {}) {
    validateJevArgs(name, args);
    if (this.busy) throw Error('Jev işlem yapıyor; mevcut çağrının sonucunu bekle.');
    this.busy = true;
    let releaseRendering;
    try {
      this.readSignal = state.signal
        ? AbortSignal.any([this.abort.signal, state.signal])
        : this.abort.signal;
      this.readSignal.throwIfAborted();
      if (name === 'browser_jev_open') {
        checkedUrl(args.url);
        const wait = this.siteAccess?.status(args.url);
        if (wait?.waiting) throw Object.assign(new SiteWaitError(wait), {url: args.url});
      } else if (
        args.tabId &&
        !['browser_jev_observe', 'browser_jev_screenshot', 'browser_jev_close_tab'].includes(name)
      ) {
        const url = this.tab(args.tabId).page.url();
        if (/^https?:/.test(url)) this.siteAccess?.assertAction(url);
      }
      const context = await this.context();
      let value;
      const sourceScope = Boolean(
        state.automationWorkspaceId && state.automationSourceUrl && state.automationTabKey,
      );
      if (sourceScope) {
        // Recover old, app-owned tabs before source labels existed. Never infer
        // ownership from the URL: require our persisted target and last URL.
        const hostname = (url) => {
          try {
            return new URL(url).hostname.replace(/^www\./, '');
          } catch {
            return '';
          }
        };
        let migrated = false;
        for (const slot of this.tabs.values()) {
          if (
            slot.id === this.homeId ||
            slot.page.isClosed() ||
            this.automationSources.has(slot.id)
          )
            continue;
          const workspace = this.automationWorkspaces.get(slot.id);
          if (
            (workspace && workspace !== state.automationWorkspaceId) ||
            (slot.owner && slot.owner !== owner)
          )
            continue;
          if (
            this.connection === 'existing'
              ? !this.transport?.owned.has(slot.id)
              : !this.automationTabs.has(slot.id)
          )
            continue;
          if (this.urlHashes.get(slot.id) !== urlHash(slot.page.url())) continue;
          const matches = (state.automationSourceUrls ?? []).filter(
            (url) => hostname(url) === hostname(slot.page.url()),
          );
          if (matches.length !== 1 || matches[0] !== state.automationSourceUrl) continue;
          this.automationWorkspaces.set(slot.id, state.automationWorkspaceId);
          this.automationSources.set(slot.id, state.automationSourceUrl);
          migrated = true;
        }
        if (migrated) await this.persistTabs();
      }
      const recordScope = Boolean(
        state.automationWorkspaceId && state.automationTabKey?.startsWith('record:'),
      );
      const accessible = (slot) => {
        if (recordScope)
          return (
            slot.id !== this.homeId &&
            !slot.page.isClosed() &&
            this.automationWorkspaces.get(slot.id) === state.automationWorkspaceId &&
            this.automationTabs.get(slot.id) === state.automationTabKey
          );
        if (sourceScope)
          return (
            slot.id !== this.homeId &&
            !slot.page.isClosed() &&
            this.automationWorkspaces.get(slot.id) === state.automationWorkspaceId &&
            this.automationSources.get(slot.id) === state.automationSourceUrl
          );
        return !state.multiWorker || slot.owner === owner;
      };
      if (name === 'browser_jev_tabs')
        value = {
          browser: 'Jev Chrome',
          tabs: [...this.tabs.values()]
            .filter((s) => s.id !== this.homeId && !s.page.isClosed() && accessible(s))
            .map((s) => ({
              tabId: s.id,
              url: s.page.url(),
              title: s.observed?.title ?? '',
              changedSinceLastObservation: this.urlHashes.get(s.id) !== urlHash(s.page.url()),
              ...(this.automationTabs.get(s.id)?.startsWith('record:')
                ? {recordId: this.automationTabs.get(s.id).slice(7)}
                : {}),
            })),
        };
      else if (name === 'browser_jev_close_tab') {
        const slot = this.tab(args.tabId);
        if (!sourceScope || !accessible(slot))
          throw Error('Yalnızca devraldığın kaynağın tarama sekmesi kapatılabilir.');
        if (this.urlHashes.get(slot.id) !== urlHash(slot.page.url()))
          throw Error('Sekme değişti. Kapatmadan önce güncel sayfayı gözlemle.');
        await slot.page.close();
        this.forgetTab(slot.id);
        await this.persistTabs();
        value = {closed: true, closedTabId: slot.id};
      } else if (name === 'browser_jev_open' && state.automationTabKey) {
        // Internal read-only automation scope, never a model-selected target.
        const reusable = [...this.tabs.values()].filter(
          (s) =>
            (sourceScope || this.automationTabs.get(s.id) === state.automationTabKey) &&
            accessible(s) &&
            !s.page.isClosed() &&
            (recordScope ||
              this.urlHashes.get(s.id) === urlHash(s.page.url()) ||
              (sourceScope && s.navigationFailed && s.page.url().startsWith('chrome-error://'))),
        );
        const retained =
          recordScope &&
          state.automationResumeRecord &&
          (reusable.find((s) => s.id === state.automationPreferredTabId) ?? reusable.at(-1));
        let slot =
          retained ||
          (state.automationFreshTab
            ? null
            : (reusable.find((s) => s.page.url() === args.url) ??
              reusable.find((s) => s.id === state.automationPreferredTabId) ??
              reusable.find((s) => this.automationTabs.get(s.id) === state.automationTabKey) ??
              reusable[0]));
        if (!slot) {
          // Each detail can require a fresh transport retry. Retire this run's
          // failed Chrome error tabs before allocating another, including an
          // error document committed after goto rejected. Keep real pages,
          // drafts, user navigation and other task owners untouched.
          const closed = [];
          if (sourceScope && !recordScope)
            for (const failed of [...this.tabs.values()]) {
              if (
                !accessible(failed) ||
                this.automationRuns.get(failed.id) !== owner ||
                this.automationTabs.get(failed.id) !== state.automationTabKey ||
                failed.verification ||
                !failed.navigationFailed ||
                !failed.page.url().startsWith('chrome-error://')
              )
                continue;
              try {
                await failed.page.close({runBeforeUnload: false});
              } catch {
                throw Error('Önceki hata sekmesi kapatılamadı; yeni kontrol sekmesi açılmadı.');
              }
              this.forgetTab(failed.id);
              closed.push(failed.id);
            }
          if (closed.length) {
            await this.onTabsClosed(closed);
            await this.persistTabs();
          }
          const page =
            this.connection === 'existing'
              ? await this.openTabFrom(await this.home())
              : await context.newPage();
          slot = await this.track(page.context(), page);
          this.automationTabs.set(slot.id, state.automationTabKey);
          if (state.automationWorkspaceId)
            this.automationWorkspaces.set(slot.id, state.automationWorkspaceId);
          if (state.automationSourceUrl)
            this.automationSources.set(slot.id, state.automationSourceUrl);
          await this.persistTabs();
        }
        slot.owner = owner;
        await this.claimAutomationTab(slot, owner, state);
        if (state.automationWorkspaceId && !this.automationWorkspaces.has(slot.id)) {
          this.automationWorkspaces.set(slot.id, state.automationWorkspaceId);
          await this.persistTabs();
        }
        if (
          state.automationSourceUrl &&
          this.automationSources.get(slot.id) !== state.automationSourceUrl
        ) {
          this.automationSources.set(slot.id, state.automationSourceUrl);
          await this.persistTabs();
        }
        try {
          if (!retained && (slot.page.url() !== args.url || this.siteAccess?.status(args.url)))
            await this.navigate(slot, checkedUrl(args.url));
          value = await this.observe(slot);
          slot.navigationFailed = false;
        } catch (error) {
          if (error.code === 'SITE_WAIT') throw error;
          // Chrome may commit its error document after goto rejects. Keep
          // that owned source tab reusable without accepting unrelated URLs.
          slot.navigationFailed = sourceScope && !recordScope;
          this.urlHashes.set(slot.id, urlHash(slot.page.url()));
          await this.persistTabs();
          value = {
            browser: 'Jev Chrome',
            tabId: slot.id,
            url: slot.page.url(),
            status: 'loading',
            message: 'Gezinme tamamlanmadı; aynı sekmeyi gözlemle.',
            ...(sourceScope && !recordScope
              ? {navigationError: String(error.message ?? error), requestedUrl: args.url}
              : {}),
          };
        }
      } else if (name === 'browser_jev_open') {
        const page =
          this.connection === 'existing'
            ? await this.openTabFrom(await this.home())
            : await context.newPage();
        const slot = await this.track(page.context(), page);
        slot.owner = owner;
        await this.claimAutomationTab(slot, owner, state);
        if (state.automationWorkspaceId)
          this.automationWorkspaces.set(slot.id, state.automationWorkspaceId);
        if (state.automationSourceUrl)
          this.automationSources.set(slot.id, state.automationSourceUrl);
        await this.persistTabs();
        try {
          await this.navigate(slot, checkedUrl(args.url));
          value = await this.observe(slot);
        } catch (error) {
          if (error.code === 'SITE_WAIT') throw error;
          value = {
            browser: 'Jev Chrome',
            tabId: slot.id,
            url: page.url(),
            status: 'loading',
            message: 'Gezinme tamamlanmadı; aynı sekmeyi gözlemle.',
          };
        }
      } else {
        const slot = this.tab(args.tabId);
        if (!accessible(slot))
          throw Error('Sekme başka bir worker’ın görevine ait. Kendi görev sekmeni kullan.');
        slot.owner = owner;
        await this.claimAutomationTab(slot, owner, state);
        if (state.automationWorkspaceId && !this.automationWorkspaces.has(slot.id)) {
          this.automationWorkspaces.set(slot.id, state.automationWorkspaceId);
          await this.persistTabs();
        }
        if (
          state.automationSourceUrl &&
          this.automationSources.get(slot.id) !== state.automationSourceUrl
        ) {
          this.automationSources.set(slot.id, state.automationSourceUrl);
          await this.persistTabs();
        }
        releaseRendering = await acquireTabRendering(slot, {
          signal: this.readSignal,
          foreground: WRITE_TOOLS.has(name),
        });
        if (slot.verification) {
          updateVerification(slot, await verificationEvidence(slot.page, slot));
          if (
            slot.verification &&
            [
              'browser_jev_act',
              'browser_jev_click',
              'browser_jev_select_choice',
              'browser_jev_fill_fields',
              'browser_jev_select_option',
              'browser_jev_autocomplete',
              'browser_jev_list_suggestions',
              'browser_jev_upload',
            ].includes(name)
          ) {
            if (slot.verification.handoff)
              return {content: [{type: 'text', text: JSON.stringify(verificationHandoff(slot))}]};
            slot.verification.attempts++;
          }
        }
        if (name === 'browser_jev_screenshot') {
          if (slot.verification?.screenshots >= 1)
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    ...verificationHandoff(slot),
                    message:
                      'Bu doğrulama adımı için görüntü zaten alındı. Aynı ekranı tekrar isteme; bilinen araç kısıtına göre ilerle veya tek teknik soru ile turu bitir.',
                  }),
                },
              ],
            };
          if (slot.verification) slot.verification.screenshots++;
          slot.pending = null;
          await clearFillFields(slot);
          const jpeg = args.format === 'jpeg';
          const screenshot = await slot.page.screenshot({
            type: jpeg ? 'jpeg' : 'png',
            ...(jpeg ? {quality: 60} : {}),
            fullPage: false,
            timeout: 10000,
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  browser: 'Jev Chrome',
                  tabId: slot.id,
                  url: slot.page.url(),
                  ...(slot.verification ? {verification: slot.verification} : {}),
                }),
              },
              {
                type: 'image',
                mimeType: jpeg ? 'image/jpeg' : 'image/png',
                data: screenshot.toString('base64'),
              },
            ],
          };
        }
        if (name === 'browser_jev_frame_observe' || name === 'browser_jev_frame_act') {
          let result = {};
          if (name === 'browser_jev_frame_act') {
            if (slot.verification)
              throw Error('Önce mevcut doğrulama adımını tamamla; formu tekrar gönderme.');
            const frame = slot.embeddedFrames?.get(args.frameId),
              target = slot.frameActionTargets?.get(args.targetId);
            if (!frame || !target || target.frame !== frame.frame)
              throw Error('Hedef bu frameId alanına ait değil.');
            result = await actFormFrame(slot, args, owner);
          }
          let observed;
          try {
            observed = await observeFormFrame(slot, args.frameId, owner);
          } catch {
            observed = {
              ...(await this.observe(slot)),
              message: 'Gömülü form kapandı veya yönlendi; dönen sayfa durumunu kontrol et.',
            };
          }
          return {content: [{type: 'text', text: JSON.stringify({...observed, ...result})}]};
        }
        if (name === 'browser_jev_open_frame') {
          if (slot.verification)
            throw Error('Doğrulama/gönderim beklerken gömülü form yeniden açılamaz.');
          const url = await embeddedFormTarget(slot, args.frameId, owner);
          const openedId = slot.openedFrames?.get(url),
            opened = openedId ? this.tabs.get(openedId) : null;
          if (opened && !opened.page.isClosed()) {
            opened.owner = owner;
            await this.claimAutomationTab(opened, owner, state);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    ...presentObservation(opened, await this.observe(opened), {full: true}),
                    parentTabId: slot.id,
                    reused: true,
                  }),
                },
              ],
            };
          }
          const page =
            this.connection === 'existing' ? await this.openTabFrom(slot) : await context.newPage();
          const child = await this.track(page.context(), page);
          child.owner = owner;
          await this.claimAutomationTab(child, owner, state);
          slot.openedFrames ??= new Map();
          slot.openedFrames.set(url, child.id);
          if (this.automationWorkspaces.has(slot.id))
            this.automationWorkspaces.set(child.id, this.automationWorkspaces.get(slot.id));
          if (this.automationSources.has(slot.id))
            this.automationSources.set(child.id, this.automationSources.get(slot.id));
          await this.persistTabs();
          try {
            await this.navigate(child, checkedUrl(url));
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    ...presentObservation(child, await this.observe(child), {full: true}),
                    parentTabId: slot.id,
                  }),
                },
              ],
            };
          } catch (error) {
            if (error.code === 'SITE_WAIT') throw error;
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'loading',
                    tabId: child.id,
                    parentTabId: slot.id,
                    message: 'Gömülü sayfa açılıyor; aynı yeni sekmeyi gözlemle, tekrar açma.',
                  }),
                },
              ],
            };
          }
        }
        if (name === 'browser_jev_observe') {
          // Only an assigned read-only source tab may probe an expired gate.
          // Reuse that tab once; record drafts and other workers stay untouched.
          if (sourceScope && !recordScope && /^https?:/.test(slot.page.url())) {
            const wait = this.siteAccess?.status(slot.page.url());
            if (
              (wait && !wait.waiting) ||
              (!wait && slot.http?.status === 429 && slot.accessChecked === slot.http)
            )
              await this.navigate(slot, checkedUrl(slot.page.url()));
          }
          value = await this.observe(slot);
        }
        if (name === 'browser_jev_click') {
          const cookie =
            (await clickVerificationCheckbox(slot, args.targetId, owner)) ??
            (await clickCookieFrameTarget(slot, args.targetId, owner));
          if (cookie) value = {...(await this.observe(slot)), ...cookie};
          else {
            const target = takeClickTarget(slot, args.targetId, owner);
            // A radio/checkbox controlId from inspect_form selects that answer.
            const choice =
              !target && slot.controls?.get(args.targetId)?.kind === 'control'
                ? await selectChoice(slot, {controlId: args.targetId}, owner, this.reader)
                : null;
            value = target
              ? await this.execute(slot, target)
              : choice
                ? {...(await this.observe(slot)), ...choice}
                : {
                    ...(await this.observe(slot)),
                    status: 'stale',
                    executed: false,
                    message: 'Tıklama hedefi eski; güncel clickTargets listesini kullan.',
                  };
          }
        }
        if (name === 'browser_jev_inspect_form' && slot.verification?.handoff)
          return {content: [{type: 'text', text: JSON.stringify(verificationHandoff(slot))}]};
        if (name === 'browser_jev_inspect_form') {
          const observation = await this.observe(slot);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  browser: 'Jev Chrome',
                  tabId: slot.id,
                  url: slot.page.url(),
                  uploads: observation.uploads,
                  ...(await inspectApplicationForm(slot.page, slot)),
                }),
              },
            ],
          };
        }
        if (
          [
            'browser_jev_reveal',
            'browser_jev_scroll',
            'browser_jev_select_option',
            'browser_jev_list_options',
          ].includes(name)
        ) {
          const result = await navigateObserved(slot, name, args, owner, this.reader);
          value = {...(await this.observe(slot)), ...result};
        }
        if (['browser_jev_autocomplete', 'browser_jev_list_suggestions'].includes(name)) {
          slot.rejectedControlIds ??= new Set();
          const repeated = slot.rejectedControlIds.has(args.controlId);
          const result = repeated
            ? {
                status: 'no_progress',
                executed: false,
                retryable: false,
                message:
                  'Aynı geçersiz controlId yeniden gönderildi; işlem yapılmadı. Bu kimliği bırak. availableTargets içinden doğru soruya ait güncel hedefi seç; hedef yoksa görünür kıl veya desteklenmeyen kontrolü teknik engel olarak raporla.',
              }
            : await selectAutocomplete(slot, args, owner, this.reader);
          if (result.status === 'stale') {
            slot.rejectedControlIds.add(args.controlId);
            if (slot.rejectedControlIds.size > 100)
              slot.rejectedControlIds.delete(slot.rejectedControlIds.values().next().value);
          }
          const observation = await this.observe(slot);
          value = {
            ...observation,
            ...result,
            ...(['stale', 'no_progress', 'unsupported'].includes(result.status)
              ? {
                  rejectedControlId: args.controlId,
                  availableTargets: observation.controls
                    .filter((c) => c.autocomplete || c.nativeSelect)
                    .map(({controlId, label, recommendedTool}) => ({
                      controlId,
                      label,
                      recommendedTool,
                    })),
                }
              : {}),
          };
        }
        if (name === 'browser_jev_select_choice') {
          const result = await selectChoice(slot, args, owner, this.reader);
          value = {...(await this.observe(slot)), ...result};
        }
        if (name === 'browser_jev_fill_fields') {
          const result = await fillKnownFields(slot, args.fields, owner, this.reader);
          const observed = await this.observe(slot).catch(() => ({
            browser: 'Jev Chrome',
            tabId: slot.id,
            observationUnavailable: true,
          }));
          value = {...observed, ...result};
        }
        if (name === 'browser_jev_next') {
          const page = await this.observe(slot);
          if (slot.verification?.handoff)
            return {content: [{type: 'text', text: JSON.stringify(verificationHandoff(slot))}]};
          const decision = await this.choose(slot.observed, args.goal, slot.history, {
            ...(await this.config()),
            signal: this.abort.signal,
          });
          const action = decision.action,
            key =
              action &&
              JSON.stringify([action.kind, action.node, action.value, action.delta, undefined]);
          const repeated =
            action &&
            action.kind !== 'fill' &&
            action.kind !== 'wait' &&
            (blockedRepeat(slot, key, progressKey(slot.observed)) ||
              (action.choice &&
                blockedRepeat(slot, choiceKey(action.node), progressKey(slot.observed))));
          const decisionId = repeated ? undefined : randomUUID();
          slot.pending = repeated
            ? null
            : {...decision, decisionId, observed: slot.observed, owner};
          value = {
            browser: page.browser,
            tabId: slot.id,
            url: page.url,
            title: page.title,
            textExcerpt: page.text.slice(0, 2000),
            observationMode: 'decision',
            status: 'proposed',
            ...(slot.verification ? {verification: slot.verification} : {}),
            decisionId,
            operation: decision.operation,
            action: decision.action
              ? {
                  label: decision.action.label,
                  kind: decision.action.kind,
                  role: decision.action.role,
                  value: decision.action.value,
                  checked: decision.action.checked,
                  pressed: decision.action.pressed,
                  choice: decision.action.choice,
                }
              : null,
            needsText: decision.operation === 'TYPE_TEXT',
            confidence: decision.confidence,
            latency_ms: decision.latency_ms,
          };
          if (repeated)
            value = {...value, ...stalled, operation: 'BLOCKED', action: null, needsText: false};
          if (value.operation === 'BLOCKED')
            value = {
              ...value,
              clickTargets: page.clickTargets,
              controls: page.controls,
              scrollTargets: page.scrollTargets,
              recovery:
                'Inspect current targets and any overlay before reporting a blocker. Use browser_interact click for an authorized observed target, reveal an offscreen control, or screenshot to diagnose occlusion. Verify the resulting form; never repeat an uncertain submission.',
            };
        }
        if (name === 'browser_jev_act') {
          const pending = slot.pending;
          if (!pending || pending.owner !== owner || pending.decisionId !== args.decisionId)
            throw Error('Bu oturuma ait geçerli bir Jev kararı yok. Önce browser_jev_next çağır.');
          if (pending.operation === 'TYPE_TEXT' && typeof args.text !== 'string')
            throw Error(
              'Yazılacak text değerini AutoJev agent’ı sağlamalı. Ayrı API anahtarı gerekmez.',
            );
          if (pending.operation !== 'TYPE_TEXT' && args.text !== undefined)
            throw Error('Bu işlem metin kabul etmiyor.');
          slot.pending = null;
          value = await this.execute(slot, pending, args.text);
        }
        if (name === 'browser_jev_upload') {
          if (!path.isAbsolute(args.filePath)) throw Error('Dosya yolu mutlak olmalı.');
          const upload = slot.uploads.get(args.uploadId);
          if (!upload || upload.owner !== owner || upload.url !== slot.page.url())
            throw Error('Dosya alanı değişti; tekrar gözlemle.');
          if (
            upload.frame &&
            (upload.frame.url() !== upload.frameUrl ||
              (upload.frame !== slot.page.mainFrame() &&
                !(await usableFormFrame(upload.frame, slot.page))))
          )
            throw Error('Dosya alanının çerçevesi değişti; tekrar gözlemle.');
          const current = await upload.input.evaluate(uploadDetails);
          if (JSON.stringify(current) !== JSON.stringify(upload.details))
            throw Error('Dosya alanı değişti; tekrar gözlemle.');
          const {realpath, stat} = await import('node:fs/promises');
          const file = await realpath(args.filePath),
            workspace = await realpath(this.workspace ?? this.directory);
          if (!file.startsWith(workspace + path.sep) || !(await stat(file)).isFile())
            throw Error('Yalnızca bu adayın çalışma alanındaki dosyalar yüklenebilir.');
          validateUploadPurpose(upload.details.label, path.basename(file));
          slot.pending = null;
          slot.uploads.delete(args.uploadId);
          try {
            const info = await stat(file),
              selected = await upload.input.evaluate((e) =>
                [...e.files].map((f) => ({
                  name: f.name,
                  size: f.size,
                  lastModified: f.lastModified,
                })),
              );
            const alreadySelected =
              selected.length === 1 &&
              selected[0].name === path.basename(file) &&
              selected[0].size === info.size &&
              selected[0].lastModified === Math.trunc(info.mtimeMs);
            const key = JSON.stringify([upload.url, upload.details, file, info.size, info.mtimeMs]);
            if (alreadySelected)
              value = {
                ...(await this.observe(slot)),
                status: 'ready',
                executed: false,
                message:
                  'Dosya zaten seçili; yeniden yüklenmedi. Bu, sunucunun dosyayı kabul ettiğinin kanıtı değildir; mevcut site yükleme durumunu kontrol et.',
              };
            else if (!takeUploadAttempt(slot, key))
              value = {
                tabId: slot.id,
                status: 'no_progress',
                executed: false,
                message:
                  'Aynı dosya/alan için iki deneme veya 60 saniye sınırına ulaşıldı. Taslağı koru ve gerçek teknik engeli raporla; dosya seçiciyi tekrar açma.',
              };
            else {
              await upload.input.setInputFiles(file, {timeout: 10000});
              value = {...(await this.observe(slot)), status: 'ready', executed: true};
            }
          } catch {
            value = {
              tabId: slot.id,
              status: 'uncertain',
              message:
                'Yükleme doğrulanamadı; yeniden denemeden önce sayfayı gözlemle. Aynı dosya/alan için en fazla iki deneme ve 60 saniye.',
            };
          } finally {
            await upload.input.dispose().catch(() => {});
          }
        }
      }
      const slot = this.tabs.get(value?.tabId);
      if (slot) {
        value = presentObservation(
          slot,
          value,
          args.scope === 'document'
            ? {full: true, standalone: true}
            : observationPolicy(name, args, value.status),
        );
        if (name === 'browser_jev_observe' && args.scope === 'document')
          value = await retryJevRead(slot.page, async (attempt) => {
            const observed = attempt
              ? presentObservation(slot, await this.observe(slot), {full: true, standalone: true})
              : value;
            return documentObservation(slot, observed);
          });
        if (
          name === 'browser_jev_observe' &&
          args.full === true &&
          !args.fullReason &&
          value.observationMode === 'compact'
        )
          value.observationHint =
            'Current control maps are complete replacements; no baseline is needed to act. Reuse these IDs. Only lost page prose requires fullReason:context_loss.';
      }
      return {content: [{type: 'text', text: JSON.stringify(value)}]};
    } catch (error) {
      if (error.code !== 'SITE_WAIT') throw error;
      const url = error.url ?? args.url ?? this.tabs.get(args.tabId)?.page.url();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              browser: 'Jev Chrome',
              status: 'site_wait',
              url,
              tabId: error.tabId ?? args.tabId,
              siteWait: error.wait,
              ...(error.captcha ? {captcha: error.captcha} : {}),
              text: error.message,
              message: error.message,
              executed: error.executed ?? false,
            }),
          },
        ],
      };
    } finally {
      await releaseRendering?.();
      this.readSignal = null;
      this.busy = false;
    }
  }
  async focus(id) {
    await this.context();
    await this.tab(id).page.bringToFront();
    return {focused: true};
  }
  async close({closeTabs = false} = {}) {
    this.closed = true;
    this.abort.abort();
    this.profileWindow?.close();
    this.profileWindow = null;
    const closed = [],
      failed = [];
    if (closeTabs && this.connection === 'existing' && this.transport) {
      // The CDP ownership set includes restored tabs and tabs opened by pages.
      // Never close other tabs in the user's Chrome profile.
      const ids = [...this.transport.owned].sort(
        (a, b) => (a === this.homeId) - (b === this.homeId),
      );
      for (const id of ids) {
        try {
          const result = await this.transport.call('Target.closeTarget', {targetId: id});
          if (!result.success) throw Error('Chrome did not close the target');
          this.forgetTab(id);
          closed.push(id);
        } catch {
          failed.push(id);
        }
      }
      if (closed.length)
        try {
          await this.persistTabs();
        } catch (error) {
          console.warn('Kapatılan Chrome sekmeleri kaydedilemedi:', error);
        }
    }
    this.transport?.close();
    const context = await this.opening?.catch(() => null);
    if (this.connection === 'existing') await this.browser?.close();
    else await context?.close();
    this.tabs.clear();
    return {closed, failed};
  }
}
