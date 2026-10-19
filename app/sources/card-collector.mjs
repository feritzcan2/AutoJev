// @ts-check
// A collector for sites whose result pages list cards only (title, company,
// address) and whose full listing text needs one request per listing. The app
// reads both itself, at the site's own pacing, so the agent receives the same
// ready review batches as from an API that returns full listings. Only cards
// the workspace still needs (wanted) cost a listing read; a listing the site
// reports gone (404/410) is dropped, and one that cannot be read stays out of
// this batch and is listed as unavailable.
//
// A site with listingIn: 'browser' has its listings opened in the browser and
// read with its posting reader (dom.listing); the app passes that read as
// options.readListing. Without it (a record read) only a listing already read
// in this session is served.
//
// A site with cardsInBrowser ({open(url), read(page, url)}) has its result
// pages opened in the user's browser too and read by its results reader; the
// app passes that read as options.readCardsInBrowser.
//
// Listing texts already read stay in RAM for a while, so a page that a site
// wait interrupted does not spend its requests again when it is read later.
const CACHE_MS = 12 * 60 * 60000,
  CACHE_MAX = 2000;
const details = new Map();
export const clearCardDetails = () => details.clear();

const stopsPage = (error, signal) =>
  signal?.aborted || error?.code === 'SITE_WAIT' || error?.name === 'AbortError';

/**
 * @param {{
 *   templateId: string,
 *   searchUrl: (url: string) => string,
 *   readCards?: (url: string, options?: any) => Promise<{url: string, jobs: any[], page: number, totalPages: number | null, nextUrl: string | null, complete: boolean}>,
 *   readListing?: (url: string, options?: any) => Promise<any>,
 *   detail: (job: any) => any,
 *   acceptsQuery?: (url: string) => boolean,
 *   listingIn?: 'http' | 'browser',
 *   cardsInBrowser?: {open: (url: string) => string, read: (page: any, url: string) => any} | null,
 *   now?: () => number,
 * }} site
 */
export function cardCollector({
  templateId,
  searchUrl,
  readCards = undefined,
  readListing = undefined,
  detail,
  acceptsQuery = () => false,
  listingIn = 'http',
  cardsInBrowser = null,
  now = Date.now,
}) {
  /** @param {string} url @param {any} [options] */
  const readDetail = async (url, options = {}) => {
    const saved = details.get(url);
    if (saved && now() - saved.at < CACHE_MS) return saved.job;
    const read = options.readListing ?? (listingIn === 'browser' ? null : readListing);
    if (!read) throw Error("This site's listings are read in the browser during a scan.");
    const job = await read(url, options);
    if (details.size >= CACHE_MAX) details.delete(details.keys().next().value);
    details.set(url, {job, at: now()});
    return job;
  };
  return {
    templateId,
    searchUrl,
    acceptsQuery,
    // Result pages carry cards only; the worker reads them before the agent.
    cards: true,
    listingIn,
    cardsInBrowser,
    readDetail,
    // Whether a listing's text is already in RAM (a read that needs no request).
    hasDetail: (url) => now() - (details.get(url)?.at ?? -Infinity) < CACHE_MS,
    detail,
    /** @param {string} url @param {any} [read] */
    async readPage(url, {wanted = (urls) => urls, progress = (_step) => {}, ...options} = {}) {
      if (cardsInBrowser && !options.readCardsInBrowser)
        throw Error("This site's results pages are read in the browser during a scan.");
      const page = await (cardsInBrowser ? options.readCardsInBrowser : readCards)(url, options);
      const want = new Set(wanted(page.jobs.map((job) => job.url))),
        total = page.jobs.filter((card) => want.has(card.url)).length,
        jobs = [],
        unavailable = [];
      let done = 0;
      for (const card of page.jobs) {
        if (!want.has(card.url)) {
          jobs.push(card);
          continue;
        }
        progress({
          step: 'listing',
          done: done++,
          total,
          title: card.title ?? null,
          company: card.company ?? null,
        });
        try {
          jobs.push({...card, ...(await readDetail(card.url, options))});
        } catch (error) {
          if (stopsPage(error, options.signal)) throw error;
          if ([404, 410].includes(error?.status)) continue;
          unavailable.push({
            url: card.url,
            message: String(error?.message ?? error).slice(0, 1000),
          });
        }
      }
      return {...page, jobs, unavailable};
    },
  };
}
