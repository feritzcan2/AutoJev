// @ts-check
// Job Bank Canada site extension (HTTP reader; per-site extensions requested
// 2026-10-05). The Government of Canada job board answers plain HTTP: search
// pages list 25 result cards with the result count, and each posting marks
// its facts and description with schema.org RDFa (no ld+json), both for Job
// Bank's own postings and for most of those taken from partner boards (some
// partners leave the description empty). Links carry
// a per-session ;jsessionid= that is stripped so listing addresses stay
// stable. Observed 2026-10-16. Everything after the read stays generic.
import {decode, htmlText, inlineText, listingPage} from './listing.mjs';
import {siteFetch, isMissing, readerPage, htmlPage, htmlTitle, pageEntries} from './http.mjs';

const CRAWL_DELAY_MS = 5000;
const BROWSER = 'Job Bank reader';
const ORIGIN = 'https://www.jobbank.gc.ca';
export const JOBBANK_PAGE_SIZE = 25;
const isHost = (host) => /^(?:www\.)?jobbank\.gc\.ca$/.test(host);
export const isJobBankUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && isHost(u.hostname) && !u.port;
  } catch {
    return false;
  }
};
const postingUrl = (id) => `${ORIGIN}/jobsearch/jobposting/${id}`;

// Which page this address is: a search (with its page number), a posting
// (/jobsearch/jobposting/<id>), or none. The session id is dropped.
export function jobBankRequest(value) {
  if (!isJobBankUrl(value)) return null;
  const url = new URL(value);
  url.pathname = url.pathname.replace(/;jsessionid=[^/]*/gi, '');
  url.hash = '';
  if (/^\/jobsearch\/jobsearch\/?$/.test(url.pathname)) {
    const page = url.searchParams.get('page') ?? '1';
    return /^[1-9]\d*$/.test(page) ? {kind: 'search', number: Number(page), url: url.href} : null;
  }
  const id = url.pathname.match(/^\/jobsearch\/jobposting\/(\d+)\/?$/)?.[1];
  return id ? {kind: 'detail', id, url: postingUrl(id)} : null;
}

// Screen-reader labels ("Location", "This link will open in a new window") and
// hidden spans are not what the page shows.
const visible = (html) =>
  inlineText(
    html.replace(/<span\b[^>]*class="[^"]*\b(?:wb-inv|hidden)\b[^"]*"[^>]*>[^<]*<\/span>/gi, ' '),
  );
const part = (html, name) =>
  html.match(new RegExp(`<li class="${name}">([\\s\\S]*?)</li>`))?.[1] ?? '';
const MONTHS =
  'january february march april may june july august september october november december'.split(
    ' ',
  );
// "October 15, 2026" as 2026-10-15; other text stays as it is.
const isoDate = (text) => {
  const m = text.match(/\b([A-Z][a-z]+) (\d{1,2}), (\d{4})\b/);
  const month = m ? MONTHS.indexOf(m[1].toLowerCase()) + 1 : 0;
  return month ? `${m[3]}-${String(month).padStart(2, '0')}-${m[2].padStart(2, '0')}` : text;
};

// {jobs, total} of a results page, or null when the page has no result count
// or a card without its posting link and title (a changed or foreign page).
export function parseJobBankSearch(html) {
  const count = html.match(/<span\b[^>]*id="results-count"[^>]*>\s*(\d[\d,]*)\s*</)?.[1];
  if (!count) return null;
  const jobs = [];
  for (const block of html.split(/<article\b/).slice(1)) {
    const card = block.split('</article>')[0];
    const id = card.match(/href="\/jobsearch\/jobposting\/(\d+)[;?"]/)?.[1];
    const title = visible(card.match(/<span class="noctitle">([\s\S]*?)<\/span>/)?.[1] ?? '');
    if (!id || !title) return null;
    jobs.push({
      url: postingUrl(id),
      title,
      company: visible(part(card, 'business')),
      location: visible(part(card, 'location')),
      salary: visible(part(card, 'salary')).replace(/^Salary\s*/, ''),
      postedAt: isoDate(visible(part(card, 'date'))),
      workplace: visible(card.match(/<span class="telework">([\s\S]*?)<\/span>/)?.[1] ?? ''),
      source: inlineText(
        card.match(/job-source-icon-\d+"><span class="wb-inv">([^<]*)</)?.[1] ?? '',
      ),
    });
  }
  return {jobs, total: Number(count.replace(/,/g, ''))};
}

const cardFacts = (job) =>
  [
    job.company,
    job.location,
    job.workplace,
    job.salary,
    job.postedAt && `posted ${job.postedAt}`,
    job.source && `via ${job.source}`,
  ]
    .filter(Boolean)
    .join(' · ');

// A results page lists its postings as listing links. The page count comes
// from the stated total (the "Show more" button stays on the last page too);
// the next page is the same address with page=N+1.
export function jobBankSearchPage(url, request, html) {
  const parsed = parseJobBankSearch(html);
  if (!parsed)
    throw Object.assign(
      Error('Job Bank results page could not be read: it has no result count or result cards.'),
      {url},
    );
  const {jobs, total} = parsed,
    number = request.number,
    pages = Math.max(1, Math.ceil(total / JOBBANK_PAGE_SIZE));
  // A page within the stated count without cards is a broken page, not the end.
  if (!jobs.length && total && number <= pages)
    throw Object.assign(
      Error(`Job Bank results page ${number} of ${pages} came without result cards.`),
      {url},
    );
  const unique = [...new Map(jobs.map((job) => [job.url, job])).values()];
  const lines = [`Job Bank job search results, page ${number} of ${pages} (${total} results)`];
  for (const job of unique) {
    lines.push(`Link: ${job.title} — ${job.url}`);
    const facts = cardFacts(job);
    if (facts) lines.push(facts);
  }
  if (!unique.length)
    lines.push(
      total
        ? 'This results page has no job cards: the search has no further results.'
        : 'This search has no results.',
    );
  const next = new URL(request.url);
  next.searchParams.set('page', String(number + 1));
  return readerPage({
    browser: BROWSER,
    url,
    title: htmlTitle(html) || 'Job Bank jobs',
    text: lines.join('\n'),
    links: unique.map((job) => ({
      text: job.title,
      url: job.url,
      listing: true,
      siteCard: [job.title, cardFacts(job)].filter(Boolean).join(' · '),
    })),
    pagination: pageEntries(url, number, pages, number < pages ? next.href : null),
  });
}

const VOID = new Set(['meta', 'link', 'img', 'input', 'br', 'hr']);
// The elements of `html` whose RDFa property list names `name`, in order:
// their property list, content attribute and inner HTML.
export function rdfaElements(html, name) {
  const found = [];
  for (const m of html.matchAll(
    /<([a-z][a-z0-9]*)\b([^>]*?)\sproperty=(["'])([^"']*)\3([^>]*)>/gi,
  )) {
    const properties = m[4].trim().split(/\s+/);
    if (!properties.includes(name)) continue;
    const tag = m[1].toLowerCase(),
      start = (m.index ?? 0) + m[0].length,
      content = `${m[2]} ${m[5]}`.match(/\scontent=(["'])([^"']*)\1/)?.[2] ?? null;
    let inner = '';
    if (!VOID.has(tag) && !m[0].endsWith('/>')) {
      const tags = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
      tags.lastIndex = start;
      let depth = 1,
        t;
      while (depth && (t = tags.exec(html)))
        if (t[1]) depth--;
        else if (!t[0].endsWith('/>')) depth++;
      inner = html.slice(start, t ? t.index : html.length);
    }
    found.push({properties, content: content === null ? null : decode(content), inner});
  }
  return found;
}
const rdfaInner = (html, name) => rdfaElements(html, name)[0]?.inner ?? '';

// Job Bank's own descriptions are plain text; partner postings carry theirs
// as HTML escaped once or more (talent.com once, agcareers three times).
const NAMED = {
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  bull: '•',
  middot: '·',
  laquo: '«',
  raquo: '»',
  deg: '°',
  copy: '©',
  reg: '®',
  trade: '™',
  eacute: 'é',
  Eacute: 'É',
  egrave: 'è',
  Egrave: 'È',
  ecirc: 'ê',
  euml: 'ë',
  agrave: 'à',
  Agrave: 'À',
  acirc: 'â',
  ccedil: 'ç',
  Ccedil: 'Ç',
  icirc: 'î',
  iuml: 'ï',
  ocirc: 'ô',
  ugrave: 'ù',
  ucirc: 'û',
  uuml: 'ü',
  oelig: 'œ',
};
function unescaped(text) {
  for (let i = 0; i < 3 && !/<[a-z!/]/i.test(text) && /&(?:amp|lt);/.test(text); i++)
    text = decode(text);
  return text.replace(/&([a-z]+);/gi, (entity, name) => NAMED[name] ?? entity);
}

// The posting the page marks up, or null when it has no RDFa title. The
// posting's markup starts at its title, after the site header's own RDFa.
export function parseJobBankPosting(html) {
  const start = html.search(/\sproperty=["']title["']/);
  if (start < 0) return null;
  const posting = html.slice(html.lastIndexOf('<', start)),
    title = visible(rdfaInner(posting, 'title'));
  if (!title) return null;
  const description = htmlText(unescaped(rdfaInner(posting, 'description')));
  const address = rdfaInner(posting, 'address');
  const location = ['addressLocality', 'addressRegion']
    .map((name) => visible(rdfaInner(address, name)))
    .filter(Boolean)
    .join(', ');
  // The page shows the hidden currency sign through its own styles, not the unit code.
  const pay = rdfaInner(posting, 'baseSalary')
    .replace(/<span\b[^>]*property=["']unitText["'][^>]*>[^<]*<\/span>/gi, '')
    .replace(/<span\b[^>]*property=["']currency["'][^>]*>([^<]*)<\/span>/gi, '$1');
  const terms = rdfaInner(posting, 'employmentType')
    .split(/<[^>]+>/)
    .map((piece) => decode(piece).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const until = rdfaElements(posting, 'validThrough')[0];
  const apply = posting.match(/<a\b[^>]*\bid="externalJobLink"[^>]*>/i)?.[0];
  return {
    title,
    description,
    company: visible(rdfaInner(rdfaInner(posting, 'hiringOrganization'), 'name')),
    fields: {
      location,
      salary: visible(pay).replace(/\$ (?=\d)/g, '$'),
      employmentType: terms,
      // The language of work is the only qualification marked up on its own.
      languages: rdfaElements(posting, 'qualification')
        .filter((element) => element.properties.length === 1)
        .map((element) => visible(element.inner)),
      postedAt: isoDate(visible(rdfaInner(posting, 'datePosted')).replace(/^Posted on\s*/i, '')),
      validThrough: (until?.content ?? visible(until?.inner ?? '')).match(/\d{4}-\d{2}-\d{2}/)?.[0],
      // The title the partner board published, beside Job Bank's occupation title.
      originalTitle: visible(
        (posting.match(/<span class="source-title-inner">([\s\S]*?)<\/p>/)?.[1] ?? '').replace(
          /<span class="orig-title-label">[\s\S]*?<\/span>/,
          '',
        ),
      ),
      applyUrl: apply ? decode(apply.match(/\shref="([^"]*)"/)?.[1] ?? '') : '',
    },
  };
}

const GONE = 'This Job Bank posting is no longer advertised; it has expired or has been removed.';
const gonePage = (url) => readerPage({browser: BROWSER, url, title: 'Job Bank job', text: GONE});

// A posting through its RDFa description and facts. Without a description
// (some partner postings show only the facts and a link to the partner board)
// the page has no listing; a page without the posting's markup is read as its
// visible text.
export function jobBankDetailPage(url, html) {
  if (!html.trim()) return gonePage(url);
  const job = parseJobBankPosting(html);
  if (!job)
    return readerPage({
      browser: BROWSER,
      url,
      title: htmlTitle(html) || 'Job Bank job',
      text: htmlPage(html),
    });
  return listingPage({
    browser: BROWSER,
    url,
    title: job.company ? `${job.title} @ ${job.company}` : job.title,
    description: job.description,
    fields: {company: job.company, ...job.fields},
    notes: job.description
      ? []
      : [
          job.fields.applyUrl
            ? 'Job Bank shows no description for this posting; the full posting is at applyUrl.'
            : 'Job Bank shows no description for this posting.',
        ],
  });
}

export async function readJobBank(url, options = {}) {
  const request = jobBankRequest(url);
  if (!request) throw Error('Job Bank reader does not handle this address');
  // robots.txt asks for Crawl-delay: 5; the shared pacing keeps that spacing.
  const response = await siteFetch(request.url, {
    ...options,
    site: 'Job Bank',
    url,
    minIntervalMs: CRAWL_DELAY_MS,
  });
  if (request.kind === 'search') {
    if (isMissing(response))
      throw Object.assign(Error(`Job Bank results page was not found (HTTP ${response.status}).`), {
        url,
      });
    return jobBankSearchPage(url, request, await response.text());
  }
  // An expired or removed posting redirects to /jobsearch/jobpostingexpired (410).
  if (isMissing(response) || /\/jobpostingexpired\b/.test(response.url ?? '')) return gonePage(url);
  return jobBankDetailPage(url, await response.text());
}

const PROVINCES = {
  AB: 'Alberta',
  BC: 'British Columbia',
  MB: 'Manitoba',
  NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador',
  NS: 'Nova Scotia',
  NT: 'Northwest Territories',
  NU: 'Nunavut',
  ON: 'Ontario',
  PE: 'Prince Edward Island',
  QC: 'Québec',
  SK: 'Saskatchewan',
  YT: 'Yukon',
};

export default {
  id: 'jobbank-ca',
  matches: isJobBankUrl,
  http: {handles: (url) => Boolean(jobBankRequest(url)), read: readJobBank},
  // The search address and the filters of the page's own filter links
  // (data-url), each checked over HTTP on 2026-10-16 against the page's counts.
  // sort=D is date posted, newest first across pages; sort=M is best match.
  search: {
    template: `${ORIGIN}/jobsearch/jobsearch?searchstring={query}&sort=D`,
    ordering: 'newest_first',
    pagination: 'url_param',
    filters: [
      {param: 'fage', label: 'Date posted', values: {2: 'Last 48 hours', 30: 'Last 30 days'}},
      {param: 'fprov', label: 'Province or territory', values: PROVINCES},
      {param: 'fskl', label: 'Work location', values: {15141: 'Remote', 100000: 'Hybrid'}},
      {param: 'fper', label: 'Hours of work', values: {F: 'Full time', P: 'Part time'}},
      {
        param: 'fter',
        label: 'Terms of employment',
        values: {P: 'Permanent', T: 'Term or contract', S: 'Seasonal', C: 'Casual'},
      },
      {
        param: 'flg',
        label: 'Language at work',
        values: {E: 'English', F: 'French', B: 'English and French'},
      },
      {param: 'fsrc', label: 'Job source', values: {16: 'Posted on Job Bank (verified) only'}},
    ],
    notes:
      'Canada. 25 results per page via &page=N; the page states its result count. sort=D lists by date posted, newest first across pages (day precision: postings added during a scan can shift a few results to the next page); sort=M is best match. Use searchstring for the keywords: term= without the site\'s occupation codes ignores the keyword. locationstring is ignored over plain HTTP, so narrow by province with fprov (AB, BC, MB, NB, NL, NS, NT, NU, ON, PE, QC, SK, YT). fage=2|30 limits to the last 48 hours or 30 days ("developer" on 2026-10-16: 261 in all, 225 last 30 days, 43 last 48 hours). fskl=15141 remote, fskl=100000 hybrid; fper=F|P; fter=P|T|S|C; flg=E|F|B; fsrc=16 keeps Job Bank\'s own verified postings (most results come from partner boards such as Talent.com). Postings are /jobsearch/jobposting/<id>.',
  },
};
