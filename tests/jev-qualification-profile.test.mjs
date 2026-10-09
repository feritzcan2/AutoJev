import test from 'node:test';
import assert from 'node:assert/strict';
import {
  jevProfileStatus,
  jevProfileView,
  saveJevProfile,
} from '../app/jev/qualification-profile.mjs';
import {jevCriteria} from '../app/jev/triage.mjs';
import {scopedAutomationTools} from '../app/automation/tools.mjs';

const memoryDb = (automation) => {
  let saved = automation;
  return {get: () => saved, put: (a) => (saved = a), now: () => 1000};
};
const automation = {
  id: 'w',
  goal: 'Backend roles',
  facts: 'German C1',
  referenceData: {profile: {facts: 'Nine years backend. '.repeat(400)}},
};
const cv = {text: 'CV text. '.repeat(2000), digest: 'cv-1'};

test('Jev reads the short profile only while its sources are unchanged', () => {
  const db = memoryDb(automation);
  assert.equal(jevProfileStatus(db.get(), cv), 'missing');
  saveJevProfile(db, 'w', 'German C1; 9 years backend; EU work permit', 'agent', cv);
  assert.equal(jevProfileStatus(db.get(), cv), 'current');
  const short = jevCriteria(db.get(), cv).userProfile;
  assert.equal(short.qualifications.text, 'German C1; 9 years backend; EU work permit');
  assert.equal(short.currentFacts.text, 'German C1');
  assert.equal(short.documents, undefined);
  assert.ok(JSON.stringify(short).length < 1000);

  const newCv = {...cv, digest: 'cv-2'};
  assert.equal(jevProfileStatus(db.get(), newCv), 'stale');
  assert.match(jevCriteria(db.get(), newCv).userProfile.documents.text, /CV text/);
  assert.equal(jevProfileStatus({...db.get(), facts: 'German B2'}, cv), 'stale');
  assert.match(
    jevCriteria(db.get(), {text: '', unavailable: 'unreadable'}).userProfile.documents.unavailable,
    /unreadable/,
  );
});

test('an agent keeps the user edited profile until its sources change', () => {
  const db = memoryDb(automation);
  saveJevProfile(db, 'w', 'User wording', 'user', cv);
  assert.deepEqual(saveJevProfile(db, 'w', 'Agent wording', 'agent', cv).saved, false);
  assert.equal(db.get().jevProfile.text, 'User wording');
  const newCv = {...cv, digest: 'cv-2'};
  assert.equal(saveJevProfile(db, 'w', 'Agent wording', 'agent', newCv).saved, true);
  assert.deepEqual(
    {...jevProfileView(db.get(), newCv), at: null},
    {status: 'current', text: 'Agent wording', by: 'agent', at: null},
  );
  assert.throws(() => saveJevProfile(db, 'w', ' ', 'agent', newCv), /boş/);
  assert.throws(() => saveJevProfile(db, 'w', 'x'.repeat(3001), 'user', newCv), /3000/);
  saveJevProfile(db, 'w', '', 'user', newCv);
  assert.equal(
    db.get().jevProfile,
    undefined,
    'an empty user save returns Jev to the full profile',
  );
});

test('only source trials and scans may write the Jev profile', () => {
  const names = (run) =>
    scopedAutomationTools({run, template: {fields: [], records: {}}, collecting: false}).map(
      (t) => t.name,
    );
  assert.ok(names({kind: 'run', sourceUrl: 'https://a.example/jobs'}).includes('save_jev_profile'));
  assert.ok(
    names({kind: 'trial', sourceUrl: 'https://a.example/jobs'}).includes('save_jev_profile'),
  );
  assert.ok(
    !names({
      kind: 'run',
      sourceUrl: 'https://a.example/jobs',
      recordId: 'r',
      recordOperation: 'score',
    }).includes('save_jev_profile'),
  );
  assert.ok(!names({kind: 'interview'}).includes('save_jev_profile'));
});
