import test from 'node:test';
import assert from 'node:assert/strict';
import linkedin, {linkedInAddress} from '../app/site-extensions/linkedin.mjs';
import {siteReaderFor} from '../app/site-extensions/index.mjs';

test('LinkedIn searches and postings are told apart under every address', () => {
  for (const search of [
    'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=go&location=Germany',
    'https://www.linkedin.com/jobs/search/?keywords=go',
    'https://www.linkedin.com/jobs/search-results/?keywords=go',
  ])
    assert.equal(linkedInAddress(search).kind, 'search', search);
  assert.deepEqual(
    linkedInAddress(
      'https://de.linkedin.com/jobs/view/senior-backend-engineer-at-acme-4012345678?trk=x',
    ),
    {
      kind: 'detail',
      id: '4012345678',
      url: 'https://de.linkedin.com/jobs/view/senior-backend-engineer-at-acme-4012345678?trk=x',
    },
  );
  assert.equal(linkedInAddress('https://www.linkedin.com/jobs/view/4012345678/').id, '4012345678');
  assert.equal(
    linkedInAddress('https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4012345678').id,
    '4012345678',
  );
  for (const other of [
    'https://www.linkedin.com/feed/',
    'https://linkedin.example.com/jobs/view/4012345678',
    'http://www.linkedin.com/jobs/view/4012345678',
    'not a url',
  ])
    assert.equal(linkedInAddress(other), null, other);
});

test('LinkedIn is read only in the browser: no HTTP reader serves its pages', () => {
  assert.equal(linkedin.http, undefined);
  assert.equal(siteReaderFor('https://www.linkedin.com/jobs/view/4012345678/'), null);
  assert.equal(
    linkedin.dom.listing.open('https://de.linkedin.com/jobs/view/x-at-acme-4012345678?trk=a'),
    'https://www.linkedin.com/jobs/view/4012345678/',
  );
});
