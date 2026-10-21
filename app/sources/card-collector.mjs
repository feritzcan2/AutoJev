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
// app passes that read as options.readCardsInBrowser. When the results page
// shows one listing at a time beside its cards (dom.pane), the app passes
// options.readListingInPane(url) -> {status, job}: the wanted listings are
// read from the open results page first, and only those its pane did not show
// are opened on their own pages afterwards, so the results page stays open
// while its cards are clicked.
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
  /** @param {string} url */
  const saved = (url) => {
    const read = details.get(url);
    return read && now() - read.at < CACHE_MS ? read.job : null;
  };
  const keep = (url, job) => {
    if (details.size >= CACHE_MAX) details.delete(details.keys().next().value);
    details.set(url, {job, at: now()});
    return job;
  };
  /** @param {string} url @param {any} [options] */
  const readDetail = async (url, options = {}) => {
    const job = saved(url);
    if (job) return job;
    const read = options.readListing ?? (listingIn === 'browser' ? null : readListing);
    if (!read) throw Error("This site's listings are read in the browser during a scan.");
    return keep(url, await read(url, options));
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
        cards = page.jobs.filter((card) => want.has(card.url)),
        read = new Map(),
        gone = new Set(),
        unavailable = [];
      // The listing being read and how many are finished.
      const step = (card) =>
        progress({
          step: 'listing',
          done: read.size + gone.size + unavailable.length,
          total: cards.length,
          title: card.title ?? null,
          company: card.company ?? null,
        });
      // The pane of the open results page first, while that page is open.
      let pane = cardsInBrowser ? options.readListingInPane : null;
      for (const card of cards) {
        if (!pane || saved(card.url)) continue;
        step(card);
        try {
          const shown = await pane(card.url, options);
          if (shown.status === 'read') read.set(card.url, keep(card.url, shown.job));
          // A pane this page lacks or a click that left it ends pane reads.
          else if (['unsupported', 'left_results'].includes(shown.status)) pane = null;
        } catch (error) {
          if (stopsPage(error, options.signal)) throw error;
          pane = null;
        }
      }
      // Then every other wanted listing on its own page (or from RAM).
      for (const card of cards) {
        if (read.has(card.url)) continue;
        if (!saved(card.url)) step(card);
        try {
          read.set(card.url, await readDetail(card.url, options));
        } catch (error) {
          if (stopsPage(error, options.signal)) throw error;
          if ([404, 410].includes(error?.status)) gone.add(card.url);
          else
            unavailable.push({
              url: card.url,
              message: String(error?.message ?? error).slice(0, 1000),
            });
        }
      }
      const jobs = page.jobs
        .filter((card) => !gone.has(card.url) && (!want.has(card.url) || read.has(card.url)))
        .map((card) => (read.has(card.url) ? {...card, ...read.get(card.url)} : card));
      return {...page, jobs, unavailable};
    },
  };
}
