import test from 'node:test';
import assert from 'node:assert/strict';
import adzuna, {
  adzunaApiUrl,
  parseAdzunaPage,
  readAdzunaPage,
} from '../app/site-extensions/adzuna.mjs';
import {siteExtensionFor, siteExtensionKind} from '../app/site-extensions/index.mjs';
import {replayUrl} from '../app/sources/recipe.mjs';

const api = 'https://api.adzuna.com/v1/api/jobs';
const credentials = {appId: 'abcd1234', appKey: 'key-0123456789'};
const job = (id, overrides = {}) => ({
  id: String(id),
  title: 'Senior <strong>Software</strong> Engineer',
  description: 'We are looking for a senior engineer to join our platform team…',
  created: '2026-10-15T08:00:00Z',
  company: {display_name: 'Acme Ltd'},
  location: {display_name: 'London, UK'},
  category: {label: 'IT Jobs'},
  contract_time: 'full_time',
  contract_type: 'permanent',
  salary_min: 70000,
  salary_max: 85000,
  salary_is_predicted: '0',
  redirect_url: `https://www.adzuna.co.uk/jobs/land/ad/${id}?se=x&v=y`,
  ...overrides,
});
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

test('Adzuna addresses become one API page of one country', () => {
  assert.equal(siteExtensionFor(`${api}/gb/search/1`), adzuna);
  assert.equal(siteExtensionKind(`${api}/gb/search/1`, 'job-search').kind, 'api');
  assert.equal(
    adzunaApiUrl(`${api}/GB/search/2?what=developer&app_id=leak&max_days_old=7&utm_source=x`),
    `${api}/gb/search/2?what=developer&max_days_old=7&sort_by=date&results_per_page=50`,
    'the country is lowercase, credentials and unknown parameters are dropped',
  );
  // The template takes the workspace country; an empty one is not a search.
  const filled = replayUrl(`${api}/{country}/search/1?what={query}&sort_by=date`, {
    country: 'DE',
    query: 'Entwickler',
  });
  assert.equal(
    adzunaApiUrl(filled),
    `${api}/de/search/1?what=Entwickler&sort_by=date&results_per_page=50`,
  );
  assert.throws(
    () => adzunaApiUrl(replayUrl(`${api}/{country}/search/1?what={query}`, {query: 'x'})),
    /workspace country/,
  );
  assert.throws(() => adzunaApiUrl(`${api}/tr/search/1`), /does not serve/);
  for (const bad of [
    `${api}/gb/search/0`,
    `${api}/gb/categories`,
    'https://www.adzuna.co.uk/jobs/search?q=x',
    'https://api.adzuna.com.evil.test/v1/api/jobs/gb/search/1',
  ])
    assert.throws(() => adzunaApiUrl(bad), undefined, bad);
});

test('Adzuna listings are cards with a teaser, never a full listing', () => {
  const page = parseAdzunaPage(`${api}/gb/search/1?what=dev`, {
    results: [job(5001), job(5002, {salary_is_predicted: '1', company: {}})],
    count: 120,
  });
  assert.equal(page.totalPages, 3);
  assert.equal(page.nextUrl, `${api}/gb/search/2?what=dev&sort_by=date&results_per_page=50`);
  assert.equal(page.jobs[0].url, 'https://www.adzuna.co.uk/details/5001');
  assert.equal(page.jobs[0].title, 'Senior Software Engineer');
  const card = adzuna.collector.detail(page.jobs[0]);
  assert.equal(card.listing, undefined, 'a 500-character teaser is not the listing text');
  assert.match(card.text, /Teaser from the Adzuna API/);
  assert.match(card.text, /salary: 70000–85000/);
  const estimated = adzuna.collector.detail(page.jobs[1]);
  assert.doesNotMatch(estimated.text, /salary:/, "Adzuna's estimate is not a stated salary");
  assert.doesNotMatch(estimated.text, /company:/);
  const last = parseAdzunaPage(`${api}/gb/search/3?what=dev`, {results: [job(5003)], count: 101});
  assert.equal(last.nextUrl, null);
  assert.equal(last.complete, true);
  assert.equal(parseAdzunaPage(`${api}/gb/search/1`, {results: [], count: 0}).complete, true);
  assert.throws(() => parseAdzunaPage(`${api}/gb/search/1`, {results: []}), /malformed/);
  assert.throws(
    () => parseAdzunaPage(`${api}/gb/search/1`, {results: [], count: 80}),
    /incomplete/,
  );
});

test('Adzuna reads with the saved key without exposing it', async () => {
  const calls = [],
    signal = new AbortController().signal;
  const fetch = async (url, init) => {
    calls.push({url: String(url), init});
    return json({results: [job(5001)], count: 1});
  };
  const page = await readAdzunaPage(`${api}/gb/search/1?what=dev`, {fetch, signal, credentials});
  const sent = new URL(calls[0].url);
  assert.equal(sent.searchParams.get('app_id'), 'abcd1234');
  assert.equal(sent.searchParams.get('app_key'), 'key-0123456789');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.ok(!page.url.includes('app_'), 'the page address carries no credential');
  assert.ok(!(page.nextUrl ?? '').includes('app_'));
  await assert.rejects(readAdzunaPage(`${api}/gb/search/1`, {fetch}), /Site accounts/);
  await assert.rejects(
    readAdzunaPage(`${api}/gb/search/1`, {fetch: async () => json({}, 401), credentials}),
    (error) => error.status === 401 && /check the saved app ID/.test(error.message),
  );
  await assert.rejects(
    readAdzunaPage(`${api}/gb/search/1`, {
      fetch: async () => new Response('<html>', {headers: {'content-type': 'text/html'}}),
      credentials,
    }),
    /other than JSON/,
  );
});
