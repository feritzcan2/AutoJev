import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {
  SiteCredentials,
  siteCredentialValues,
  useSiteCredentials,
} from '../app/sources/site-credentials.mjs';

const store = (decrypt = (value) => value.slice(4)) =>
  new SiteCredentials(new DatabaseSync(':memory:'), {encrypt: (value) => `enc:${value}`, decrypt});

test('Site accounts list the extensions that need one and keep their values encrypted', () => {
  const credentials = store();
  const before = credentials.status();
  assert.deepEqual(before.map((s) => s.site).sort(), ['adzuna', 'france-travail']);
  assert.ok(before.every((s) => !s.saved && !s.configured && s.fields.length === 2));
  const after = credentials.save('france-travail', {clientId: 'PAR_app', clientSecret: 'secret-1'});
  assert.equal(after.find((s) => s.site === 'france-travail').configured, true);
  const row = credentials.db.prepare('SELECT ciphertext FROM site_credentials').get();
  assert.match(row.ciphertext, /^enc:/);
  assert.ok(!JSON.stringify(after).includes('secret-1'), 'status never returns a value');
  // An empty field keeps the saved value; a new one replaces it.
  credentials.save('france-travail', {clientId: '', clientSecret: 'secret-2'});
  assert.deepEqual(credentials.values('france-travail'), {
    clientId: 'PAR_app',
    clientSecret: 'secret-2',
  });
  assert.throws(() => credentials.save('adzuna', {appId: 'abcd1234'}), /Enter the App key/);
  assert.throws(() => credentials.save('adzuna', {appId: 'a b c d', appKey: 'k'}), /valid App ID/);
  assert.throws(() => credentials.save('adzuna', {token: 'x'}), /Invalid Adzuna credentials/);
  assert.throws(() => credentials.save('linkedin', {}), /no account settings/);
  credentials.remove('france-travail');
  assert.equal(credentials.values('france-travail'), null);
});

test('Collector reads get the saved values; a locked keychain is an error', () => {
  const credentials = store();
  credentials.save('adzuna', {appId: 'abcd1234', appKey: 'key-0123456789'});
  useSiteCredentials(credentials);
  try {
    assert.deepEqual(siteCredentialValues('adzuna'), {appId: 'abcd1234', appKey: 'key-0123456789'});
    assert.equal(siteCredentialValues('france-travail'), null);
    const locked = store(() => {
      throw Error('locked');
    });
    locked.db.prepare('INSERT INTO site_credentials VALUES(?,?)').run('adzuna', 'enc:{}');
    useSiteCredentials(locked);
    assert.throws(() => siteCredentialValues('adzuna'), /Could not unlock the Adzuna credentials/);
    assert.match(locked.status().find((s) => s.site === 'adzuna').error, /unlock/);
  } finally {
    useSiteCredentials(null);
  }
});
