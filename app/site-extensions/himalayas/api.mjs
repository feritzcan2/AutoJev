// Explicit Himalayas integration. No browser or model participates in collection.
import {parse} from 'node-html-parser';
import {setTimeout as pause} from 'node:timers/promises';

const origin = 'https://himalayas.app';
const searchParameters = new Set([
  'q',
  'country',
  'worldwide',
  'exclude_worldwide',
  'seniority',
  'employment_type',
  'company',
  'timezone',
  'sort',
  'page',
]);
export const isHimalayasUrl = (value) => {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      ['himalayas.app', 'www.himalayas.app'].includes(u.hostname) &&
      !u.port &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
};

export function himalayasApiUrl(value) {
  if (!isHimalayasUrl(value)) throw Error('A valid HTTPS address is required for Himalayas.');
  const input = new URL(value),
    path = input.pathname.replace(/\/$/, '');
  const country = path.match(/^\/jobs\/countries\/([^/]+)$/)?.[1];
  if (!['', '/jobs', '/jobs/api', '/jobs/api/search'].includes(path) && !country)
    throw Error(
      'This Himalayas search address is not supported yet; an API search recipe is required.',
    );
  const browse = path === '/jobs/api',
    url = new URL(browse ? '/jobs/api' : '/jobs/api/search', origin);
  for (const [key, value] of input.searchParams) {
    if (key.startsWith('utm_')) continue;
    if (!(browse ? ['limit', 'cursor'].includes(key) : searchParameters.has(key)))
      throw Error(`Desteklenmeyen Himalayas filtresi: ${key}`);
    if (url.searchParams.has(key)) throw Error(`Tekrarlanan Himalayas filtresi: ${key}`);
    if (value) url.searchParams.set(key, value);
  }
  if (country) {
    if (
      url.searchParams.has('country') &&
      url.searchParams.get('country') !== decodeURIComponent(country)
    )
      throw Error('Conflicting Himalayas country filters.');
    url.searchParams.set('country', decodeURIComponent(country));
  }
  if (browse) url.searchParams.set('limit', '20');
  else {
    if (!url.searchParams.has('sort')) url.searchParams.set('sort', 'recent');
    if (!url.searchParams.has('page')) url.searchParams.set('page', '1');
    if (
      !/^[1-9]\d*$/.test(url.searchParams.get('page')) ||
      !Number.isSafeInteger(Number(url.searchParams.get('page')))
    )
      throw Error('Invalid Himalayas page number.');
  }
  url.searchParams.sort();
  return url.href;
}

const plain = (html) => {
  const root = parse(html);
  for (const el of root.querySelectorAll('script,style,noscript')) el.remove();
  return root.structuredText.replace(/\u00a0/g, ' ').trim();
};
const date = (value) => {
  const n = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(n) && !Number.isNaN(new Date(n).getTime())
    ? new Date(n).toISOString()
    : null;
};
function jobRecord(job) {
  if (
    !job ||
    typeof job.title !== 'string' ||
    !job.title.trim() ||
    typeof job.description !== 'string' ||
    !job.description.trim()
  )
    throw Error('A Himalayas listing title or description is missing; the page is not complete.');
  const url = new URL(job.guid);
  if (!isHimalayasUrl(url.href) || !/^\/companies\/[^/]+\/jobs\/[^/]+\/?$/.test(url.pathname))
    throw Error('The Himalayas listing address could not be verified.');
  url.hash = '';
  for (const key of [...url.searchParams.keys()])
    if (key.startsWith('utm_')) url.searchParams.delete(key);
  const description = plain(job.description);
  if (!description) throw Error('The Himalayas listing description could not be read.');
  const locations = job.locationRestrictions;
  if (
    locations !== undefined &&
    (!Array.isArray(locations) ||
      locations.some((v) => typeof v !== 'string' && typeof v?.name !== 'string'))
  )
    throw Error('The Himalayas location data changed.');
  const location = locations
      ? locations.map((v) => (typeof v === 'string' ? v : v.name)).join(', ') || 'Worldwide'
      : '',
    company = typeof job.companyName === 'string' ? job.companyName : '';
  return {
    url: url.href,
    title: job.title.trim().slice(0, 300),
    company,
    location,
    description,
    summary: (
      (typeof job.excerpt === 'string' && plain(job.excerpt)) ||
      [job.title, company, location].filter(Boolean).join(' · ')
    ).slice(0, 6000),
    publishedAt: date(job.pubDate),
    expiresAt: date(job.expiryDate),
    employmentType: typeof job.employmentType === 'string' ? job.employmentType : null,
    salary: {
      min: job.minSalary ?? null,
      max: job.maxSalary ?? null,
      currency: job.currency ?? null,
      period: job.salaryPeriod ?? null,
    },
    timezoneRestrictions: job.timezoneRestrictions ?? null,
  };
}

export function parseHimalayasPage(value, data) {
  const url = new URL(himalayasApiUrl(value)),
    browse = url.pathname === '/jobs/api';
  if (
    !data ||
    !Array.isArray(data.jobs) ||
    !Number.isSafeInteger(data.totalCount) ||
    data.totalCount < 0 ||
    !Number.isSafeInteger(data.limit) ||
    data.limit < 1 ||
    data.limit > 20 ||
    !Number.isSafeInteger(data.offset) ||
    data.offset < 0 ||
    data.jobs.length > data.limit
  )
    throw Error('Invalid Himalayas API response format; an empty result was not accepted.');
  if (
    data.nextCursor !== undefined &&
    (typeof data.nextCursor !== 'string' || !data.nextCursor || data.nextCursor.length > 2000)
  )
    throw Error('Invalid Himalayas continuation cursor.');
  const jobs = data.jobs.map(jobRecord),
    page = browse ? null : Number(url.searchParams.get('page'));
  if (!browse && data.offset !== (page - 1) * data.limit)
    throw Error('Himalayas returned a different page than the one requested.');
  let nextUrl = null;
  if (browse && data.nextCursor) {
    const next = new URL(url);
    next.searchParams.set('cursor', data.nextCursor);
    nextUrl = himalayasApiUrl(next.href);
  }
  if (!browse && data.offset + data.limit < data.totalCount) {
    const next = new URL(url);
    next.searchParams.set('page', String(page + 1));
    nextUrl = himalayasApiUrl(next.href);
  }
  if (!jobs.length && (nextUrl || data.totalCount > data.offset))
    throw Error('Himalayas results are incomplete; listings are pending despite an empty page.');
  if (nextUrl === url.href) throw Error('Himalayas pagination did not advance.');
  return {
    url: url.href,
    jobs,
    totalCount: data.totalCount,
    offset: data.offset,
    limit: data.limit,
    page,
    totalPages: browse ? null : Math.max(1, Math.ceil(data.totalCount / data.limit)),
    nextUrl,
    complete: nextUrl === null,
  };
}

export async function readHimalayasPage(
  value,
  {
    fetch = globalThis.fetch,
    signal,
    timeoutMs = 15000,
    wait = (ms, signal) => pause(ms, undefined, {signal}),
  } = {},
) {
  const url = himalayasApiUrl(value);
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      const requestSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);
      const response = await fetch(url, {
        headers: {Accept: 'application/json'},
        redirect: 'error',
        signal: requestSignal,
      });
      if (!response.ok) {
        const retryAfter = response.headers.get('retry-after'),
          seconds =
            retryAfter && /^\d+$/.test(retryAfter)
              ? Number(retryAfter)
              : retryAfter
                ? Math.max(0, (Date.parse(retryAfter) - Date.now()) / 1000)
                : null;
        const error = Object.assign(
          Error(`Himalayas API HTTP ${response.status}; the scan is not complete.`),
          {
            status: response.status,
            retryable: response.status === 429 || response.status >= 500,
            retryMs: Number.isFinite(seconds) ? seconds * 1000 : 1000 * (attempt + 1),
          },
        );
        await response.body?.cancel();
        throw error;
      }
      if (!response.headers.get('content-type')?.includes('application/json')) {
        await response.body?.cancel();
        throw Error('Himalayas returned content other than JSON.');
      }
      let bytes = 0;
      const parts = [];
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) throw Error('The Himalayas API page exceeded the size limit.');
        parts.push(chunk);
      }
      return parseHimalayasPage(url, JSON.parse(Buffer.concat(parts).toString('utf8')));
    } catch (error) {
      signal?.throwIfAborted();
      const retryable =
        error.retryable || error.name === 'TimeoutError' || error.name === 'TypeError';
      if (!retryable || attempt >= 2 || (error.retryMs ?? 0) > 30000) throw error;
      await wait(Math.max(250, error.retryMs ?? 1000 * (attempt + 1)), signal);
    }
  }
}

// Each page is acknowledged by the consumer before another request starts.
// A page budget yields an explicit incomplete result, never a successful end.
export async function collectHimalayas(
  {searches, maxPages = 1000},
  {onPage, signal, readPage = readHimalayasPage} = {},
) {
  if (
    !Array.isArray(searches) ||
    !searches.length ||
    searches.length > 5 ||
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 10000
  )
    throw Error('Invalid Himalayas collection request.');
  let pages = 0,
    count = 0;
  const seenPages = new Set(),
    seenJobs = new Set();
  for (const search of searches) {
    let url = search.nextUrl === null ? null : himalayasApiUrl(search.nextUrl ?? search.url);
    while (url) {
      signal?.throwIfAborted();
      if (pages >= maxPages) return {complete: false, pages, count};
      if (seenPages.has(url)) throw Error('Himalayas returned the same result page again.');
      seenPages.add(url);
      const page = await readPage(url, {signal});
      signal?.throwIfAborted();
      const jobs = page.jobs.filter((j) => {
        if (seenJobs.has(j.url)) return false;
        seenJobs.add(j.url);
        return true;
      });
      await onPage?.({...page, searchId: search.id, jobs});
      pages++;
      count += jobs.length;
      url = page.nextUrl;
    }
  }
  return {complete: true, pages, count};
}
