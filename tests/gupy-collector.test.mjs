import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import gupy, {
  gupyApiUrl,
  gupyListingJob,
  isGupyUrl,
  parseGupyPage,
  readGupyDetail,
  readGupyPage,
} from '../app/site-extensions/gupy.mjs';
import {siteSearchRecipe, withSearchFilters} from '../app/site-extensions/search.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/gupy/${name}`, import.meta.url), 'utf8');
const api = 'https://portal.gupy.io/api/job-search/jobs';
const search = `${api}?jobName=desenvolvedor&sortBy=publishedDate&sortOrder=desc&limit=10&offset=0`;
// Three postings trimmed from a real page (2026-10-16).
const real = JSON.parse(fixture('jobs-page.json')).data;
const job = (id, overrides = {}) => ({
  ...real[0],
  id,
  jobUrl: `https://carreiramarcopolo.gupy.io/job/eyJqb2JJZCI6${id}?jobBoardSource=gupy_portal`,
  ...overrides,
});
const response = (jobs, {offset = 0, total = 471} = {}) => ({
  data: jobs,
  pagination: {total, limit: 10, offset},
});
const ten = (offset = 0) => Array.from({length: 10}, (_, i) => job(1000 + offset + i));

test('Gupy search addresses become one newest-first API page with the known filters', () => {
  assert.equal(gupy.matches('https://portal.gupy.io/'), true);
  assert.equal(gupyApiUrl('https://portal.gupy.io/?q=desenvolvedor'), search);
  assert.equal(gupyApiUrl('https://portal.gupy.io/job-search/term=desenvolvedor'), search);
  assert.equal(
    gupyApiUrl(
      'https://portal.gupy.io/job-search/term=desenvolvedor%20java&workplaceTypes[]=remote,hybrid&jobTypes[]=vacancy_type_effective&state=S%C3%A3o%20Paulo&pwd=true&page=3',
    ),
    `${api}?jobName=desenvolvedor+java&workplaceType=remote%2Chybrid&type=vacancy_type_effective&state=S%C3%A3o+Paulo&isPWD=true&sortBy=publishedDate&sortOrder=desc&limit=10&offset=0`,
    'the portal page keeps its search in the path; its own page size does not carry over',
  );
  assert.equal(
    gupyApiUrl(
      'https://portal.gupy.io/job-search/term=desenvolvedor?workplaceTypes[]=remote&utm_source=x',
    ),
    `${api}?jobName=desenvolvedor&workplaceType=remote&sortBy=publishedDate&sortOrder=desc&limit=10&offset=0`,
  );
  assert.equal(
    gupyApiUrl(`${api}?jobName=dev&city=Curitiba&city=Recife&limit=100&offset=20&isPWD=false`),
    `${api}?jobName=dev&city=Curitiba%2CRecife&sortBy=publishedDate&sortOrder=desc&limit=10&offset=20`,
    'a repeated list filter becomes the comma list the API reads; the page size is the reader’s',
  );
  assert.equal(
    gupyApiUrl('https://portal.gupy.io/'),
    `${api}?sortBy=publishedDate&sortOrder=desc&limit=10&offset=0`,
  );
  for (const bad of [
    `${api}?jobName=x&workplaceType=onsite`,
    `${api}?jobName=x&type=vacancy_type_unknown`,
    `${api}?jobName=x&state=S%C3%A3o+Paulo&state=Paran%C3%A1`,
    `${api}?jobName=x&foo=bar`,
    `${api}?jobName=x&sortOrder=asc`,
    `${api}?offset=15`,
    `${api}?offset=10000`,
    'https://portal.gupy.io/job-search/term=x&salary=10',
    'https://portal.gupy.io/companies',
    'https://zenvia.gupy.io/jobs/12542291',
    'http://portal.gupy.io/',
    'not a url',
  ])
    assert.throws(() => gupyApiUrl(bad), undefined, bad);
});

test('matches the portal and company listing hosts only', () => {
  for (const ok of [
    'https://portal.gupy.io/job-search/term=java',
    'https://zenvia.gupy.io/jobs/12542291',
    'https://carreiramarcopolo.gupy.io/jobs/12735629?jobBoardSource=gupy_portal',
  ])
    assert.equal(isGupyUrl(ok), true, ok);
  for (const bad of [
    'https://portal.gupy.io.evil.test/',
    'https://evilgupy.io/jobs/1',
    'https://zenvia.gupy.io.evil.test/jobs/1',
    'https://a.b.gupy.io/jobs/1',
    'https://www.gupy.io/jobs/1',
    'https://zenvia.gupy.io/',
    'https://zenvia.gupy.io/job/eyJqb2JJZCI6MX0=',
    'https://portal.gupy.io:8443/',
    'http://zenvia.gupy.io/jobs/1',
  ])
    assert.equal(isGupyUrl(bad), false, bad);
});

test('a page maps postings to their listing address with the stated facts only', () => {
  const page = parseGupyPage(search, response(real));
  assert.deepEqual(
    [page.page, page.totalPages, page.complete, page.nextUrl],
    [1, 48, true, null],
    'a short page is the last one whatever the total says',
  );
  assert.deepEqual(
    page.jobs.map((j) => j.url),
    [
      'https://carreiramarcopolo.gupy.io/jobs/12735629',
      'https://zenvia.gupy.io/jobs/12542291',
      'https://globalhitss.gupy.io/jobs/12719093',
    ],
  );
  const detail = gupy.collector.detail(page.jobs[0]);
  assert.equal(detail.url, 'https://carreiramarcopolo.gupy.io/jobs/12735629');
  assert.deepEqual(detail.listing.fields, {
    company: 'Marcopolo S.A',
    location: 'Caxias do Sul, Rio Grande do Sul',
    workMode: 'on-site',
    employmentType: 'permanent employee (CLT)',
    postedAt: '2026-10-16T10:53:31.059Z',
    deadline: '2026-11-16T00:00:00.000Z',
    disabilities: 'Also open to people with disabilities (PcD)',
  });
  assert.match(detail.text, /^DESENVOLVEDOR DE SISTEMAS - BANCO MONEO\/UNIDADE ANA RECH\n/);
  assert.match(detail.text, /Você é apaixonado por tecnologia/);
  assert.deepEqual(detail.cells, {
    company: 'Marcopolo S.A',
    location: 'Caxias do Sul, Rio Grande do Sul',
  });
  assert.deepEqual(
    Object.keys(gupy.collector.detail(page.jobs[1]).listing.fields),
    ['company', 'workMode', 'employmentType', 'postedAt', 'deadline', 'disabilities'],
    'a remote posting states no city',
  );
  const sparse = parseGupyPage(
    search,
    response([
      job(7, {
        type: 'vacancy_type_talent_pool',
        workplaceType: undefined,
        disabilities: false,
        applicationDeadline: null,
        city: '',
        state: '',
        description: 'Banco de talentos&nbsp;para&amp;dev.\r\n\r\n\r\nVenha!',
      }),
    ]),
  ).jobs[0];
  const read = gupy.collector.detail(sparse);
  assert.deepEqual(Object.keys(read.listing.fields), ['company', 'postedAt']);
  assert.match(read.text, /Talent pool posting/);
  assert.match(read.text, /Banco de talentos para&dev\.\n\nVenha!$/);
});

test('full pages continue by offset; the last page and the window end stop', () => {
  const first = parseGupyPage(search, response(ten()));
  assert.deepEqual(
    [first.page, first.complete, first.nextUrl],
    [1, false, search.replace('offset=0', 'offset=10')],
  );
  const full = parseGupyPage(
    search.replace('offset=0', 'offset=460'),
    response(ten(460), {offset: 460, total: 100}),
  );
  assert.equal(
    full.nextUrl,
    search.replace('offset=0', 'offset=470'),
    'the total never ends a scan',
  );
  const last = parseGupyPage(
    search.replace('offset=0', 'offset=470'),
    response([job(1)], {offset: 470}),
  );
  assert.deepEqual([last.page, last.complete, last.nextUrl], [48, true, null]);
  const deep = parseGupyPage(
    search.replace('offset=0', 'offset=9990'),
    response(ten(9990), {offset: 9990, total: 84000}),
  );
  assert.equal(deep.nextUrl, null, 'the API refuses offset+limit above 10000');
  assert.equal(deep.totalPages, 1000);
  const end = parseGupyPage(
    search.replace('offset=0', 'offset=480'),
    response([], {offset: 480, total: 471}),
  );
  assert.deepEqual([end.jobs, end.complete], [[], true]);
  assert.deepEqual(parseGupyPage(search, response([], {total: 0})).jobs, []);
});

test('postings of closed company accounts are left out and named', () => {
  const page = parseGupyPage(
    search,
    response([
      ...ten().slice(0, 9),
      job(2724028, {
        name: 'Pessoa Desenvolvedora Backend Pl',
        jobUrl: 'https://q2bank&66802&inactive.gupy.io/job/eyJqb2JJZCI6MjcyNDAyOH0=',
      }),
    ]),
  );
  assert.equal(page.jobs.length, 9);
  assert.deepEqual(page.skipped, [
    {id: 2724028, title: 'Pessoa Desenvolvedora Backend Pl', reason: 'inactive company account'},
  ]);
  assert.equal(page.complete, false, 'the page was full');
});

test('malformed or partial pages are errors, not empty results', () => {
  assert.throws(() => parseGupyPage(search, {data: []}), /malformed/);
  assert.throws(() => parseGupyPage(search, {message: 'Failed to fetch jobs'}), /malformed/);
  assert.throws(() => parseGupyPage(search, response(real, {offset: 10})), /malformed/);
  assert.throws(
    () => parseGupyPage(search, {data: real, pagination: {total: 100, limit: 20, offset: 0}}),
    /malformed/,
  );
  assert.throws(() => parseGupyPage(search, response([])), /incomplete/);
  assert.throws(() => parseGupyPage(search, response([job(1, {description: null})])), /missing/);
  assert.throws(
    () => parseGupyPage(search, response([job(1, {jobUrl: 'https://evil.test/job/x'})])),
    /missing/,
  );
});

test('page reads go to the API with the caller signal and report failures', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({url, options});
    return Response.json(response(real));
  };
  const controller = new AbortController();
  const page = await readGupyPage('https://portal.gupy.io/?q=desenvolvedor', {
    fetch,
    signal: controller.signal,
  });
  assert.equal(page.jobs.length, 3);
  assert.equal(calls[0].url, search);
  assert.equal(calls[0].options.redirect, 'error');
  controller.abort();
  assert.equal(calls[0].options.signal.aborted, true, 'the caller signal reaches the request');

  const failure = await readGupyPage(search, {
    fetch: async () => Response.json({message: 'Failed to fetch jobs'}, {status: 400}),
  }).catch((e) => e);
  assert.match(failure.message, /HTTP 400/);
  assert.equal(failure.status, 400);
  const blocked = await readGupyPage(search, {
    fetch: async () => new Response('', {status: 429}),
  }).catch((e) => e);
  assert.equal(blocked.status, 429);
  await assert.rejects(
    readGupyPage(search, {
      fetch: async () => new Response('<html>', {headers: {'content-type': 'text/html'}}),
    }),
    /other than JSON/,
  );
});

test('a listing read takes the page data with its sections and stated facts', async () => {
  const url = 'https://zenvia.gupy.io/jobs/12542291?jobBoardSource=gupy_portal',
    calls = [];
  const read = await readGupyDetail(url, {
    fetch: async (target, options) => {
      calls.push({target, options});
      return new Response(fixture('listing.html'));
    },
  });
  assert.equal(calls[0].target, 'https://zenvia.gupy.io/jobs/12542291');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(read.url, url, 'the read keeps the address it was asked for');
  const page = gupy.collector.detail(read);
  assert.deepEqual(page.listing.fields, {
    company: 'Venha trabalhar na Zenvia',
    location: 'Brasil',
    workMode: 'remote',
    employmentType: 'permanent employee (CLT)',
    postedAt: '2026-10-15T20:48:51.813Z',
    deadline: '2026-10-22',
    disabilities: 'Also open to people with disabilities (PcD)',
  });
  assert.match(page.text, /^Buscamos um\(a\) Desenvolvedor/m);
  assert.match(page.text, /\n\nResponsibilities\nSeus desafios[^\n]*\n• Participação/);
  assert.match(page.text, /\n\nRequirements and qualifications\n/);
  assert.match(page.text, /\n\nAdditional information\n/);
  assert.doesNotMatch(page.text, /Vagas|Etapas/, 'no page chrome');
  assert.doesNotMatch(page.text, /no longer shows it/);
});

test('a removed or foreign listing has no listing', async () => {
  const url = 'https://stefanini.gupy.io/jobs/12729953';
  for (const [status, message] of [
    [307, /redirects \(HTTP 307\).*not public or has closed/],
    [404, /no longer published \(HTTP 404\)/],
  ])
    await assert.rejects(
      readGupyDetail(url, {
        fetch: async () =>
          new Response('', {
            status,
            headers: status === 307 ? {location: '/candidates/signin'} : {},
          }),
      }),
      message,
    );
  const html = fixture('listing.html');
  assert.equal(gupyListingJob(html, 'https://zenvia.gupy.io/jobs/999'), null, 'another id');
  await assert.rejects(
    readGupyDetail('https://zenvia.gupy.io/jobs/12542291', {
      fetch: async () => new Response('<html><body>Página não encontrada</body></html>'),
    }),
    /no listing data/,
  );
  const closed = gupyListingJob(
    html.replace('"status":"published"', '"status":"closed"'),
    'https://zenvia.gupy.io/jobs/12542291',
  );
  assert.match(gupy.collector.detail(closed).text, /no longer shows it as published/);
  const empty = gupy.collector.detail({...closed, description: ''});
  assert.equal(empty.listing, undefined, 'without a description it stays an ordinary page');
  await assert.rejects(readGupyDetail('https://portal.gupy.io/', {}), /single Gupy listing/);
});

test('the site search keeps its sort and newest-first order in an agent recipe', () => {
  const agent = siteSearchRecipe(gupy.search, {
    entry: {
      kind: 'url_template',
      template: withSearchFilters(`${api}?jobName={query}`, {workplaceType: 'remote'}),
    },
    pagination: 'none',
  });
  assert.deepEqual(agent.changed, ['template', 'pagination', 'ordering']);
  const filled = agent.recipe.entry.template.replace('{query}', 'analista');
  assert.equal(
    gupyApiUrl(filled),
    `${api}?jobName=analista&workplaceType=remote&sortBy=publishedDate&sortOrder=desc&limit=10&offset=0`,
  );
  assert.equal(agent.recipe.ordering, 'newest_first');
  for (const filter of gupy.search.filters)
    for (const value of Object.keys(filter.values ?? {x: 1}))
      if (filter.values)
        assert.doesNotThrow(() => gupyApiUrl(`${api}?${filter.param}=${value}`), filter.param);
});
