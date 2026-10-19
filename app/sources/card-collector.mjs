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
// options.readListing. Without it (a recipe check, a record read) the site's
// own HTTP listing reader is used.
//
// A site with cardsInBrowser ({open(url), read(page, url)}) has a second way to
// its result pages: when its API refuses (a site wait or a used-up budget),
// the same page is read in the user's browser (options.readCardsInBrowser) and
// the search keeps its position.
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
 *   readCards: (url: string, options?: any) => Promise<{url: string, jobs: any[], page: number, totalPages: number | null, nextUrl: string | null, complete: boolean}>,
 *   readListing: (url: string, options?: any) => Promise<any>,
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
  readCards,
  readListing,
  detail,
  acceptsQuery = () => false,
  listingIn = 'http',
  cardsInBrowser = null,
  now = Date.now,
}) {
  const readDetail = async (url, options = {}) => {
    const saved = details.get(url);
    if (saved && now() - saved.at < CACHE_MS) return saved.job;
    const job = await (options.readListing ?? readListing)(url, options);
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
    detail,
    async readPage(url, {wanted = (urls) => urls, progress = () => {}, ...options} = {}) {
      let page;
      try {
        page = await readCards(url, options);
      } catch (error) {
        if (error?.code !== 'SITE_WAIT' || !cardsInBrowser || !options.readCardsInBrowser)
          throw error;
        options.signal?.throwIfAborted();
        page = await options.readCardsInBrowser(url, options);
      }
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
