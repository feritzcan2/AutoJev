import test from 'node:test';
import assert from 'node:assert/strict';
import {
  jobPostingListing,
  jobPostingPage,
  jobPostingHtml,
} from '../app/site-extensions/job-posting.mjs';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const body =
  'Du entwickelst unsere Plattform weiter und arbeitest eng mit dem Produktteam. '.repeat(4);
const posting = (job) =>
  JSON.stringify({'@context': 'https://schema.org', '@type': 'JobPosting', ...job});
const page = (job, extra = {}) => ({
  url: 'https://jobs.example/role-1',
  title: 'Software Engineer (m/w/d) - Feste Anstellung, Vollzeit',
  headings: ['Software Engineer (m/w/d)'],
  jobPostings: [posting(job)],
  ...extra,
});
const base = {
  title: 'Software Engineer (m/w/d)',
  description: `&lt;p&gt;Über uns: IT&amp;amp;I GmbH&lt;/p&gt;&lt;ul&gt;&lt;li&gt;${body}&lt;/li&gt;&lt;/ul&gt;`,
  hiringOrganization: {'@type': 'Organization', name: 'Arvana GmbH'},
  jobLocation: {
    '@type': 'Place',
    address: {streetAddress: 'Berlin', addressLocality: 'Berlin', addressCountry: 'de'},
  },
  employmentType: ['FULL_TIME'],
  datePosted: '2026-10-09T04:16:18Z',
  validThrough: '2026-11-08T05:16:18Z',
};

test('a shown JobPosting gives the listing text and only the facts it states', () => {
  const listing = jobPostingListing(page(base), NOW);
  assert.deepEqual(listing.fields, {
    company: 'Arvana GmbH',
    location: 'Berlin, de',
    employmentType: 'FULL_TIME',
    postedAt: '2026-10-09T04:16:18Z',
    validThrough: '2026-11-08T05:16:18Z',
  });
  assert.match(
    listing.text,
    /^Software Engineer \(m\/w\/d\) @ Arvana GmbH\ncompany: Arvana GmbH\n[\s\S]*\n\nÜber uns: IT&I GmbH\n• Du entwickelst/,
  );
  assert.ok(!listing.text.includes('<'));
});

test('remote work, region and pay appear only when the posting states them', () => {
  const listing = jobPostingListing(
    page({
      ...base,
      description: `<p>${body}</p>`,
      jobLocationType: 'TELECOMMUTE',
      applicantLocationRequirements: [{'@type': 'Country', name: 'Germany'}],
      baseSalary: {currency: 'EUR', value: {minValue: 60000, maxValue: 75000, unitText: 'YEAR'}},
    }),
    NOW,
  );
  assert.equal(listing.fields.workMode, 'remote');
  assert.equal(listing.fields.remoteRegion, 'Germany');
  assert.equal(listing.fields.salary, '60000–75000 EUR per year');
  assert.equal(jobPostingListing(page(base), NOW).fields.workMode, undefined);
});

test('a posting inside an @graph is found', () => {
  const graph = JSON.stringify({'@graph': [{'@type': 'WebPage'}, JSON.parse(posting(base))]});
  assert.ok(jobPostingListing({...page(base), jobPostings: [graph]}, NOW));
});

test('a posting the page does not show, an expired one, several, a teaser or broken data stay unused', () => {
  for (const [label, value] of [
    ['other title', page({...base, title: 'Data Analyst'})],
    ['expired', page({...base, validThrough: '2026-10-01T00:00:00Z'})],
    ['several', {...page(base), jobPostings: [posting(base), posting({...base, title: 'Other'})]}],
    ['teaser', page({...base, description: 'Spannende Aufgaben warten.'})],
    ['broken', {...page(base), jobPostings: ['{"@type":"JobPosting",']}],
    ['none', {...page(base), jobPostings: []}],
  ])
    assert.equal(jobPostingListing(value, NOW), null, label);
});

test('the shown title matches whole words across soft hyphens and case', () => {
  const listing = jobPostingListing(
    page(
      {...base, title: 'Sach­be­ar­bei­tung Compliance'},
      {title: 'SACHBEARBEITUNG COMPLIANCE in Berlin | Jobs', headings: []},
    ),
    NOW,
  );
  assert.ok(listing);
  assert.equal(
    jobPostingListing(
      page({...base, title: 'Engineer'}, {title: 'Engineering Lead', headings: []}),
      NOW,
    ),
    null,
  );
});

test('fetched HTML gives the same inputs: title, h1s and the posting blocks', () => {
  const html = `<html><head><title>Software Engineer (m/w/d) - Feste Anstellung | Board</title><script type="application/ld+json">{"@type":"Organization","name":"Board"}</script><script data-ch type='application/ld+json'>${posting(base)}</script></head><body><h1 class="x">Software <b>Engineer</b> (m/w/d)</h1><h1>Second</h1><svg><title>icon</title></svg></body></html>`;
  const input = jobPostingHtml(html);
  assert.equal(input.title, 'Software Engineer (m/w/d) - Feste Anstellung | Board');
  assert.deepEqual(input.headings, ['Software Engineer (m/w/d)', 'Second']);
  assert.equal(input.jobPostings.length, 1, 'only blocks that mention a posting');
  const read = jobPostingPage(
    {url: 'https://jobs.example/role-1', browser: 'Board reader', ...input},
    NOW,
  );
  assert.equal(read.browser, 'Board reader');
  assert.equal(read.title, 'Software Engineer (m/w/d) @ Arvana GmbH');
  assert.equal(read.listing.fields.company, 'Arvana GmbH');
  assert.equal(
    jobPostingPage(
      {url: 'https://jobs.example/x', ...jobPostingHtml('<html><h1>None</h1></html>')},
      NOW,
    ),
    null,
  );
});

test('a JobPosting with raw line breaks and tabs in its strings is still read', () => {
  // Seen on a job board (2026-10-16): the block is not strict JSON, but browsers read it.
  const block = posting({...base, title: 'Software Engineer (m/w/d)'}).replace(
    '"description":"',
    '"description":"Line one\n\tLine \\"two\\"\r\n',
  );
  assert.throws(() => JSON.parse(block));
  const listing = jobPostingListing(page(base, {jobPostings: [block]}), NOW);
  assert.match(listing.text, /Line one\s+Line "two"/);
  assert.equal(listing.fields.company, 'Arvana GmbH');
  // A block that is broken otherwise stays unread.
  assert.equal(jobPostingListing(page(base, {jobPostings: [block.slice(0, -1)]}), NOW), null);
});

test('a country list of nearly every code names the codes left out; a shorter list stays whole', () => {
  const dn = new Intl.DisplayNames(['en'], {type: 'region'});
  const codes = [];
  for (let a = 65; a < 91; a++)
    for (let b = 65; b < 91; b++) {
      const code = String.fromCharCode(a, b);
      if (dn.of(code) !== code) codes.push(code);
    }
  // Every ISO code but North Korea and Iran, one country entry each, plus Kosovo.
  const all = codes.filter(
    (c) =>
      !/^(AC|AN|BU|CP|CQ|CS|DD|DG|DY|EA|EU|EZ|FX|HV|IC|NH|QO|RH|SU|TA|TP|UK|UN|VD|XA|XB|XK|YD|YU|ZR|ZZ)$/.test(
        c,
      ),
  );
  assert.equal(all.length, 249);
  const country = (name) => ({'@type': 'Country', name});
  const region = (list) =>
    jobPostingListing(page({...base, applicantLocationRequirements: list.map(country)}), NOW).fields
      .remoteRegion;
  assert.equal(
    region([...all.filter((c) => c !== 'KP' && c !== 'IR'), 'XK']),
    'All ISO countries except IR, KP and XK (248 listed)',
  );
  assert.equal(region(all), 'All ISO countries (249 listed)');
  const eu = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE'];
  assert.equal(region(eu), eu.join(', '));
  // Many codes but far from every country: the list itself is the information.
  const half = all.slice(0, 150);
  assert.equal(region(half), half.join(', '));
});
