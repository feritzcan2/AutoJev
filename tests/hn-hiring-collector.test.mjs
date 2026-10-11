import test from 'node:test';
import assert from 'node:assert/strict';
import hn, {
  hnHiringSearchUrl,
  latestHiringThread,
  parseHnHiringPage,
  readHnHiringPage,
  readHnHiringDetail,
} from '../app/site-extensions/hn-hiring.mjs';
import {recipeReplay} from '../app/sources/recipe.mjs';

const api = 'https://hn.algolia.com/api/v1/search';
const latest = `${api}?tags=comment%2Cstory_latest&query=backend+remote&hitsPerPage=50&page=0`;
const thread = '49922569';
const comment = (id, overrides = {}) => ({
  objectID: id,
  author: 'nbraga',
  comment_text:
    'Chronograph (chronograph.pe) | Platform Engineer | Full-Time | Remote (US) | $175,000 - $215,000 USD + equity<p>We help venture funds &amp; lenders.<p>Apply: <a href="https:&#x2F;&#x2F;example.com">https:&#x2F;&#x2F;example.com</a>',
  created_at: '2026-10-10T13:55:55Z',
  parent_id: Number(thread),
  story_id: Number(thread),
  ...overrides,
});
const response = (hits, {page = 0, nbPages = 3, nbHits = 120} = {}) => ({
  hits,
  page,
  nbPages,
  nbHits,
  hitsPerPage: 50,
});
const threads = {
  hits: [
    {objectID: '49922568', title: 'Ask HN: Who wants to be hired? (October 2026)'},
    {objectID: thread, title: 'Ask HN: Who is hiring? (October 2026)'},
    {objectID: '49522897', title: 'Ask HN: Who is hiring? (September 2026)'},
  ],
};

test('Hacker News addresses become one comment search page of a thread', () => {
  assert.equal(hn.matches('https://news.ycombinator.com/'), true);
  assert.equal(hn.matches('https://news.ycombinator.com.evil.test/'), false);
  assert.equal(
    hnHiringSearchUrl('https://news.ycombinator.com/?q=backend remote'),
    latest,
    'the front page means the newest thread; q becomes the Algolia query',
  );
  assert.equal(
    hnHiringSearchUrl(`https://news.ycombinator.com/item?id=${thread}`),
    `${api}?tags=comment%2Cstory_${thread}&hitsPerPage=50&page=0`,
  );
  assert.equal(
    hnHiringSearchUrl(`${api}?tags=comment,story_${thread}&query=berlin&page=2&hitsPerPage=1000`),
    `${api}?tags=comment%2Cstory_${thread}&query=berlin&hitsPerPage=50&page=2`,
  );
  const replay = recipeReplay(
    {entry: {kind: 'url_template', template: hn.search.template}, pagination: 'url_param'},
    {query: 'backend remote'},
  );
  assert.equal(hnHiringSearchUrl(replay.searches[0].url), latest);
  for (const bad of [
    'https://news.ycombinator.com/item?id=abc',
    'https://news.ycombinator.com/user?id=whoishiring',
    `${api}?tags=comment&query=x`,
    'https://hn.algolia.com/api/v1/items/1',
    `${api}?tags=comment,story_1&page=-1`,
    'http://news.ycombinator.com/',
  ])
    assert.throws(() => hnHiringSearchUrl(bad), undefined, bad);
});

test('the newest Who is hiring thread is picked over the other monthly threads', () => {
  assert.equal(latestHiringThread(threads), thread);
  assert.throws(() => latestHiringThread({hits: [threads.hits[0]]}), /No Who is hiring/);
  assert.throws(() => latestHiringThread({}), /malformed/);
});

test('a page maps top-level comments to listings and pins later pages to its thread', () => {
  const page = parseHnHiringPage(latest, thread, response([comment('50033036')]));
  assert.deepEqual(
    [page.page, page.totalPages, page.complete, page.nextUrl],
    [
      1,
      3,
      false,
      `${api}?tags=comment%2Cstory_${thread}&query=backend+remote&hitsPerPage=50&page=1`,
    ],
  );
  const [job] = page.jobs;
  assert.equal(job.url, 'https://news.ycombinator.com/item?id=50033036');
  assert.equal(
    job.title,
    'Chronograph (chronograph.pe) | Platform Engineer | Full-Time | Remote (US) | $175,000 - $215,000 USD + equity',
  );
  const detail = hn.collector.detail(job);
  assert.deepEqual(detail.listing.fields, {
    company: 'Chronograph (chronograph.pe)',
    postedAt: '2026-10-10T13:55:55Z',
  });
  assert.match(
    detail.text,
    /equity\n\nWe help venture funds & lenders\.\n\nApply: https:\/\/example\.com/,
  );
  assert.deepEqual(detail.cells, {company: 'Chronograph (chronograph.pe)'});

  const plain = parseHnHiringPage(
    latest,
    thread,
    response([comment('1', {comment_text: 'We are hiring Rust engineers in NYC.<p>Details.'})]),
  ).jobs[0];
  assert.equal(plain.company, '', 'no company is guessed without the pipe format');

  const last = parseHnHiringPage(
    latest.replace('page=0', 'page=2'),
    thread,
    response([comment('2')], {page: 2}),
  );
  assert.deepEqual([last.page, last.complete, last.nextUrl], [3, true, null]);
});

test('malformed, partial or foreign pages are errors, not empty results', () => {
  assert.throws(() => parseHnHiringPage(latest, thread, {hits: []}), /malformed/);
  assert.throws(() => parseHnHiringPage(latest, thread, response([], {page: 1})), /malformed/);
  assert.throws(() => parseHnHiringPage(latest, thread, response([])), /incomplete/);
  assert.throws(
    () => parseHnHiringPage(latest, thread, response([comment('3', {parent_id: 50000000})])),
    /outside the requested thread/,
  );
  assert.throws(
    () => parseHnHiringPage(latest, thread, response([comment('4', {comment_text: ''})])),
    /text missing/,
  );
  assert.deepEqual(
    parseHnHiringPage(latest, thread, response([], {nbPages: 0, nbHits: 0})).jobs,
    [],
  );
});

test('reads resolve the newest thread, filter replies, pass the signal and report failures', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({url, options});
    if (url.includes('search_by_date')) return Response.json(threads);
    if (url.includes('/items/'))
      return Response.json({
        id: 50033036,
        type: 'comment',
        text: comment('x').comment_text,
        created_at: '2026-10-10T13:55:55.000Z',
        parent_id: Number(thread),
        story_id: Number(thread),
      });
    return Response.json(response([comment('50033036')], {nbPages: 1}));
  };
  const page = await readHnHiringPage(latest, {fetch});
  assert.equal(page.url, latest, 'the page keeps the address it was asked for');
  assert.equal(page.jobs.length, 1);
  const search = new URL(calls[1].url);
  assert.equal(search.searchParams.get('tags'), `comment,story_${thread}`);
  assert.equal(search.searchParams.get('numericFilters'), `parent_id=${thread}`);
  assert.ok(calls.every((c) => c.options.signal instanceof AbortSignal));

  calls.length = 0;
  await readHnHiringPage(page.url.replace('story_latest', `story_${thread}`), {fetch});
  assert.equal(calls.length, 1, 'a pinned thread needs no thread lookup');

  const read = await readHnHiringDetail('https://news.ycombinator.com/item?id=50033036', {fetch});
  assert.equal(read.url, 'https://news.ycombinator.com/item?id=50033036');
  assert.equal(read.company, 'Chronograph (chronograph.pe)');
  assert.equal(calls.at(-1).url, 'https://hn.algolia.com/api/v1/items/50033036');

  await assert.rejects(
    readHnHiringDetail('https://news.ycombinator.com/item?id=1', {
      fetch: async () => Response.json({id: 1, type: 'story', title: 'x'}),
    }),
    /not a job comment/,
  );
  await assert.rejects(
    readHnHiringDetail('https://news.ycombinator.com/item?id=1', {
      fetch: async () =>
        Response.json({id: 1, type: 'comment', text: null, parent_id: 5, story_id: 5}),
    }),
    /text missing/,
  );
  const failure = await readHnHiringPage(latest, {
    fetch: async () => new Response('', {status: 429}),
  }).catch((e) => e);
  assert.match(failure.message, /HTTP 429/);
  assert.equal(failure.status, 429);
  await assert.rejects(
    readHnHiringPage(latest, {
      fetch: async () => new Response('<html>', {headers: {'content-type': 'text/html'}}),
    }),
    /other than JSON/,
  );
  await assert.rejects(readHnHiringDetail('https://news.ycombinator.com/', {fetch}), /single/);
});
