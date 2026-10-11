// @ts-check
// UI-only captures: no agent tool call, focus change, navigation or model input.
export function workerPreviews({browsers, sessionFor}) {
  const pending = new Map(),
    capturing = new WeakSet();
  const empty = (state, message) => ({state, message});
  async function capture(id, worker) {
    const session = sessionFor(id, worker),
      runId = session?.sessionId;
    if (!runId) return empty('idle', 'The worker has no active browser work.');
    const connection = browsers.clients.get(id),
      client = connection?.client;
    const connected = () =>
      !browsers.closed &&
      browsers.clients.get(id) === connection &&
      client &&
      !client.closed &&
      client.profile?.directory === browsers.options(id).profile?.directory &&
      (client.connection !== 'existing' || client.browser?.isConnected());
    if (!connected()) return empty('waiting', 'Waiting for the Chrome connection.');
    const owned = (slot) =>
      slot &&
      slot.id !== client.homeId &&
      !slot.page.isClosed() &&
      client.automationWorkspaces.get(slot.id) === id &&
      client.automationRuns.get(slot.id) === runId;
    const slot = [...client.tabs.values()]
      .filter(owned)
      .reverse()
      .sort((a, b) => (b.previewAt ?? 0) - (a.previewAt ?? 0))[0];
    if (!slot) return empty('empty', 'This worker has not opened a browser tab yet.');
    // A UI timeout does not cancel CDP. Keep at most one actual capture per tab
    // until Chrome answers or disconnects, even across later refresh attempts.
    if (capturing.has(slot))
      return empty('waiting', 'Waiting for Chrome to finish the previous screenshot request.');
    const url = slot.page.url(),
      current = () =>
        connected() &&
        sessionFor(id, worker) === session &&
        session.sessionId === runId &&
        owned(slot) &&
        slot.page.url() === url;
    let timer;
    try {
      capturing.add(slot);
      const screenshot = (async () => {
        try {
          return await slot.cdp.send('Page.captureScreenshot', {
            format: 'jpeg',
            quality: 55,
            fromSurface: true,
            captureBeyondViewport: false,
          });
        } finally {
          capturing.delete(slot);
        }
      })();
      const {data} = await Promise.race([
        screenshot,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error('The Chrome screenshot did not arrive in time. Retrying.')),
            4000,
          );
        }),
      ]);
      if (!current())
        return empty('waiting', 'The worker’s tab changed; waiting for a new screenshot.');
      return {
        state: 'ready',
        runId,
        tabId: slot.id,
        url,
        title: slot.observed?.title ?? '',
        ...(slot.captchaProgress ? {captcha: slot.captchaProgress} : {}),
        capturedAt: new Date().toISOString(),
        image: `data:image/jpeg;base64,${data}`,
      };
    } catch (error) {
      return empty('waiting', current() ? error.message : 'The Chrome tab or connection changed.');
    } finally {
      clearTimeout(timer);
    }
  }
  return (id, worker = 'main') => {
    const key = JSON.stringify([id, worker]);
    if (pending.has(key)) return pending.get(key);
    const request = capture(id, worker).finally(() => {
      if (pending.get(key) === request) pending.delete(key);
    });
    pending.set(key, request);
    return request;
  };
}
