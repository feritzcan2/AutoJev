import test from 'node:test';
import assert from 'node:assert/strict';
import franceTravail, {
  franceTravailApiUrl,
  parseFranceTravailPage,
  readFranceTravailPage,
  readFranceTravailDetail,
} from '../app/site-extensions/france-travail.mjs';
import {siteExtensionFor, siteExtensionKind} from '../app/site-extensions/index.mjs';

const api = 'https://api.francetravail.io/partenaire/offresdemploi/v2/offres';
const credentials = {clientId: 'PAR_app_123', clientSecret: 'secret-value'};
const offer = (id, overrides = {}) => ({
  id,
  intitule: 'Développeur Full Stack (H/F)',
  description: 'Vous développez nos applications.\nStack : Node.js, React.',
  dateCreation: '2026-10-15T09:12:00.000Z',
  lieuTravail: {libelle: '75 - Paris 11e Arrondissement'},
  entreprise: {nom: 'ACME SAS'},
  typeContrat: 'CDI',
  typeContratLibelle: 'Contrat à durée indéterminée',
  dureeTravailLibelleConverti: 'Temps plein',
  salaire: {libelle: 'Annuel de 42000.00 Euros à 50000.00 Euros sur 12 mois'},
  experienceLibelle: '2 ans',
  contact: {urlPostulation: 'https://careers.acme.test/apply/1'},
  ...overrides,
});
const json = (body, {status = 200, range = null} = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json', ...(range ? {'content-range': range} : {})},
  });
// A fetch that answers the token request, then the given API responses.
function server(...responses) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({url: String(url), init});
    if (String(url).includes('/access_token'))
      return json({access_token: 'token-1', token_type: 'Bearer', expires_in: 1499});
    return responses.shift();
  };
  return {fetch, calls};
}

test('France Travail search addresses become one API page', () => {
  assert.equal(
    siteExtensionFor('https://candidat.francetravail.fr/offres/recherche'),
    franceTravail,
  );
  assert.equal(siteExtensionKind('https://candidat.francetravail.fr/', 'job-search').kind, 'api');
  assert.equal(
    franceTravailApiUrl(
      'https://candidat.francetravail.fr/offres/recherche?motsCles=d%C3%A9veloppeur&tri=1&departement=75&page=3&offresPartenaires=true',
    ),
    `${api}/search?motsCles=d%C3%A9veloppeur&sort=1&departement=75&range=100-149`,
    'tri becomes sort, the page a range, unknown site parameters are dropped',
  );
  assert.equal(
    franceTravailApiUrl(`${api}/search?motsCles=java&range=50-99&publieeDepuis=7`),
    `${api}/search?motsCles=java&publieeDepuis=7&sort=1&range=50-99`,
    'an API address keeps its range; newest first is the default sort',
  );
  assert.equal(
    franceTravailApiUrl('https://candidat.francetravail.fr/offres/recherche?page=23'),
    `${api}/search?sort=1&range=1100-1149`,
    'the last page the API serves ends at 1149',
  );
  for (const bad of [
    'https://candidat.francetravail.fr/offres/recherche?page=24',
    `${api}/search?range=13-62`,
    'https://candidat.francetravail.fr/offres/recherche/detail/201ABCD',
    'https://francetravail.fr.evil.test/offres/recherche',
    'http://candidat.francetravail.fr/offres/recherche',
  ])
    assert.throws(() => franceTravailApiUrl(bad), undefined, bad);
});

test('France Travail pages give full offers, the range total and the next page', () => {
  const page = parseFranceTravailPage(
    `${api}/search?motsCles=dev&sort=1&range=0-49`,
    {resultats: [offer('201ABCD'), offer('201ABCE', {contact: {}, salaire: {}})]},
    'offres 0-49/120',
  );
  assert.equal(page.totalPages, 3);
  assert.equal(page.nextUrl, `${api}/search?motsCles=dev&sort=1&range=50-99`);
  assert.equal(page.complete, false);
  assert.equal(
    page.jobs[0].url,
    'https://candidat.francetravail.fr/offres/recherche/detail/201ABCD',
  );
  const detail = franceTravail.collector.detail(page.jobs[0]);
  assert.match(detail.text, /Stack : Node\.js, React\./);
  assert.deepEqual(detail.listing.fields, {
    company: 'ACME SAS',
    location: '75 - Paris 11e Arrondissement',
    employmentType: 'Contrat à durée indéterminée',
    hours: 'Temps plein',
    salary: 'Annuel de 42000.00 Euros à 50000.00 Euros sur 12 mois',
    experience: '2 ans',
    postedAt: '2026-10-15T09:12:00.000Z',
    applyUrl: 'https://careers.acme.test/apply/1',
  });
  assert.deepEqual(
    Object.keys(franceTravail.collector.detail(page.jobs[1]).listing.fields).sort(),
    ['company', 'employmentType', 'experience', 'hours', 'location', 'postedAt'],
    'a fact the offer does not state stays out',
  );
  const last = parseFranceTravailPage(
    `${api}/search?sort=1&range=100-149`,
    {resultats: [offer('201ABCF')]},
    'offres 100-100/101',
  );
  assert.equal(last.nextUrl, null);
  assert.equal(last.complete, true);
  assert.equal(
    parseFranceTravailPage(`${api}/search?sort=1&range=0-49`, null, null).complete,
    true,
    '204 No Content on the first page is a search without offers',
  );
  assert.throws(
    () => parseFranceTravailPage(`${api}/search?sort=1&range=50-99`, null, null),
    /not complete/,
  );
  assert.throws(
    () => parseFranceTravailPage(`${api}/search?sort=1&range=0-49`, {resultats: []}, null),
    /malformed/,
  );
  assert.throws(
    () =>
      parseFranceTravailPage(`${api}/search?sort=1&range=0-49`, {resultats: []}, 'offres 0-49/80'),
    /incomplete/,
  );
  assert.throws(
    () =>
      parseFranceTravailPage(
        `${api}/search?sort=1&range=0-49`,
        {resultats: [{id: '201ABCD'}]},
        'offres 0-0/1',
      ),
    /title is missing/,
  );
});

test('France Travail reads with a token from the saved application', async () => {
  const signal = new AbortController().signal;
  const {fetch, calls} = server(
    json({resultats: [offer('201ABCD')]}, {status: 206, range: 'offres 0-0/1'}),
  );
  const page = await readFranceTravailPage(
    'https://candidat.francetravail.fr/offres/recherche?motsCles=dev',
    {fetch, signal, credentials},
  );
  assert.equal(page.jobs.length, 1);
  assert.equal(calls[0].init.method, 'POST');
  assert.match(calls[0].init.body, /grant_type=client_credentials/);
  assert.match(calls[0].init.body, /client_id=PAR_app_123/);
  assert.match(calls[0].init.body, /scope=api_offresdemploiv2\+o2dsoffre/);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer token-1');
  assert.ok(calls.every((c) => c.init.signal instanceof AbortSignal));
  assert.ok(!page.url.includes('secret'), 'no credential reaches the page address');

  await assert.rejects(
    readFranceTravailPage(`${api}/search?range=0-49`, {fetch, credentials: null}),
    /Site accounts/,
  );
  const refused = async () => new Response('{}', {status: 401});
  await assert.rejects(
    readFranceTravailPage(`${api}/search?range=0-49`, {fetch: refused, credentials}),
    /refused the saved API application/,
  );
  const blocked = server(new Response('', {status: 429}));
  await assert.rejects(
    readFranceTravailPage(`${api}/search?range=0-49`, {fetch: blocked.fetch, credentials}),
    (error) => error.status === 429 && /HTTP 429/.test(error.message),
  );
});

test('France Travail reads one offer by its listing address', async () => {
  const url = 'https://candidat.francetravail.fr/offres/recherche/detail/201ABCD';
  const {fetch, calls} = server(json(offer('201ABCD')));
  const job = await readFranceTravailDetail(url, {fetch, credentials});
  assert.equal(calls[1].url, `${api}/201ABCD`);
  assert.equal(job.url, url);
  assert.equal(job.company, 'ACME SAS');
  const gone = server(new Response(null, {status: 204}));
  await assert.rejects(
    readFranceTravailDetail(url, {fetch: gone.fetch, credentials}),
    /stays pending/,
  );
  await assert.rejects(
    readFranceTravailDetail('https://candidat.francetravail.fr/offres/recherche', {credentials}),
    /single France Travail offer/,
  );
});
