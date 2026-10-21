// @ts-check
// A results page that shows one listing at a time in a pane beside its cards
// (a site extension's dom.pane): click the listing's card on the open page and
// read the pane once it shows that listing. One click per listing instead of a
// page load per listing; the results page stays open for the next card.
import {setTimeout as pause} from 'node:timers/promises';
import {collectSiteData, siteExtensionFor, siteListing} from '../site-extensions/index.mjs';
import {humanClickElement, wheelReveal} from '../browser/human-input.mjs';

// How long a clicked card may take to show its listing, and how often the pane
// is read meanwhile.
export const PANE_SHOW_MS = 8000;
const POLL_MS = 250;

// Reads the listing at `url` from the pane of the results page open in this
// tab. Returns {status: 'read', listing} with the listing evidence, or a
// status that names why it was not read: unsupported (no pane on this page),
// no_card (the page lists no card for it), not_clicked, left_results (the
// click opened another page) or not_shown (the pane did not show it in time).
export async function readPane(slot, url, {signal = undefined, showMs = PANE_SHOW_MS} = {}) {
  const page = slot.page,
    dom = siteExtensionFor(page.url())?.dom,
    pane = dom?.pane,
    key = pane?.handles(page.url()) ? pane.key(url) : null;
  if (!key) return {status: 'unsupported', url: page.url()};
  const shown = async () => {
    const raw = await collectSiteData(page, dom, pane.collect).catch(() => null);
    const job = raw?.key === key ? pane.read(raw) : null;
    return job?.description ? job : null;
  };
  // A pane that already shows the listing (the first card) needs no click.
  if (!(await shown())) {
    const handle = await page.evaluateHandle(pane.card, key).catch(() => null),
      card = handle?.asElement() ?? null;
    if (!card) {
      await handle?.dispose().catch(() => {});
      return {status: 'no_card', url: page.url()};
    }
    try {
      await wheelReveal(page, card).catch(() => false);
      await card.scrollIntoViewIfNeeded({timeout: 5000});
      if (!(await humanClickElement(page, card))) await card.click({timeout: 5000});
    } catch (error) {
      if (pane.handles(page.url()))
        return {status: 'not_clicked', url: page.url(), message: String(error?.message ?? error)};
    } finally {
      await card.dispose().catch(() => {});
    }
  }
  // The pane counts once two reads in a row agree, so a title or text still
  // changing from the previous listing is not taken.
  let last = null;
  for (let waited = 0; waited <= showMs; waited += POLL_MS) {
    if (!pane.handles(page.url())) return {status: 'left_results', url: page.url()};
    const job = await shown(),
      seen = job && JSON.stringify(job);
    if (seen && seen === last)
      return {status: 'read', url: page.url(), listing: siteListing(url, job)};
    last = seen;
    await pause(POLL_MS, undefined, {signal});
  }
  return {status: 'not_shown', url: page.url()};
}
