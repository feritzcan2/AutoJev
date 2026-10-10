// @ts-check
const value = (result) => {
  if (result?.isError) throw Error('Sayfa kontrolü başarısız.');
  const text = result?.content?.find((p) => p.type === 'text')?.text;
  return JSON.parse(text);
};

// A page that failed this many checks is given up: checks move on to the
// source's own address. When that loads, the site works and the scan goes on
// without the failed page; when it fails too, the site itself is down.
export const PAGE_CHECK_LIMIT = 3;
export const givenUpUrls = (recovery) =>
  Object.entries(recovery?.failures ?? {})
    .filter(([, count]) => count >= PAGE_CHECK_LIMIT)
    .map(([url]) => url);
export function checkUrl(task) {
  const failed = task.technicalRecovery?.urls ?? [],
    candidates = [...failed, ...(failed.length ? [] : (task.scan?.pendingUrls ?? []).slice(0, 1))]
      .filter((url) => /^https?:\/\//.test(url))
      .concat(task.sourceUrl);
  const failures = task.technicalRecovery?.failures ?? {};
  return candidates.find((url) => (failures[url] ?? 0) < PAGE_CHECK_LIMIT) ?? task.sourceUrl;
}

// The tabs a source's readiness check owns.
export const sourceCheckOwner = (taskId) => `source-check:${taskId}`;

async function closeCheckTabs(client, owner, keep = null) {
  for (const slot of [...client.tabs.values()])
    if (slot.id !== keep && client.automationRuns.get(slot.id) === owner)
      try {
        await slot.page.close({runBeforeUnload: false});
        client.forgetTab(slot.id);
      } catch {}
  await client.persistTabs().catch(() => {});
}

// Use the managed browser and its login state, without model calls or site
// interactions. Only tabs created by these checks can be closed. A failed
// check leaves its tab open so the user sees what the page shows; the next
// check or the resumed run closes it.
export async function checkSourceBrowser(client, id, task) {
  const url = checkUrl(task);
  const owner = sourceCheckOwner(task.id);
  await closeCheckTabs(client, owner);
  const before = new Set(client.tabs.keys());
  let shown = null;
  const state = {
    automationWorkspaceId: id,
    automationTabKey: `source:${task.sourceUrl}`,
    automationSourceUrl: task.sourceUrl,
    automationSourceUrls: [task.sourceUrl],
    automationFreshTab: true,
  };
  try {
    let page = value(
      await client.callTool({name: 'browser_jev_open', arguments: {url}}, owner, state),
    );
    if (page.siteWait)
      return {ready: false, evidence: page.siteWait.message ?? 'Kaynak erişimi bekleniyor.'};
    if (page.tabId && !before.has(page.tabId)) shown = page.tabId;
    if (page.navigationError) throw Error(page.navigationError);
    if (!page.tabId) throw Error('Kontrol sekmesi açılamadı.');
    const tab = client.tabs.get(page.tabId);
    if (!tab || before.has(tab.id)) throw Error('Ayrı kontrol sekmesi oluşturulamadı.');
    page = value(
      await client.callTool(
        {
          name: 'browser_jev_observe',
          arguments: {tabId: tab.id, scope: 'document', full: true, fullReason: 'context_loss'},
        },
        owner,
        state,
      ),
    );
    const ready =
      !page.siteWait &&
      !page.navigationError &&
      !page.reading?.readiness?.loading &&
      /^https?:\/\//.test(page.url ?? '') &&
      Boolean(page.text?.trim()) &&
      !(tab.http?.status >= 500);
    if (ready) shown = null;
    return {
      ready,
      evidence: ready
        ? 'Kaydedilen adres yönetilen tarayıcıda tekrar okunabiliyor.'
        : 'Kaydedilen adres hâlâ yüklenemiyor.',
    };
  } catch (error) {
    return {ready: false, evidence: error.message};
  } finally {
    await closeCheckTabs(client, owner, shown);
  }
}
