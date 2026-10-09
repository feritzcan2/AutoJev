import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadScoringDocuments, scoringSources} from '../app/scoring/profile.mjs';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'score-documents-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, 'candidates/one/documents'), {recursive: true});
  const a = {
      facts: 'Verified profile fact.',
      referenceData: {profile: {cvPath: path.join(root, 'candidates/one/CV.txt')}},
    },
    added = [];
  const db = {
    get: () => a,
    userDocuments: () => added,
    store: {directory: root, workspaces: {get: () => ({id: 'one', storagePath: 'candidates/one'})}},
  };
  return {root, a, db, added};
}
function pdf(text) {
  const stream = `BT /F1 12 Tf 20 80 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let value = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(value.length);
    value += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = value.length;
  return (
    value +
    'xref\n0 6\n0000000000 65535 f \n' +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, '0') + ' 00000 n \n')
      .join('') +
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  );
}
test('profile documents use the workspace storage path and refresh changed files', async (t) => {
  const {a, db} = await fixture(t);
  await writeFile(a.referenceData.profile.cvPath, 'Five years of compliance experience.');
  const first = await loadScoringDocuments(db, 'one');
  assert.deepEqual(first.paths, ['CV.txt']);
  assert.match(first.text, /## CV.txt\nFive years/);
  assert.equal(first.unavailable, undefined);
  await writeFile(a.referenceData.profile.cvPath, 'Seven years of compliance program ownership.');
  const next = await loadScoringDocuments(db, 'one');
  assert.notEqual(next.digest, first.digest);
  assert.equal(scoringSources(a, next).facts.text, 'Verified profile fact.');
  assert.equal(scoringSources(a).documents, undefined);
});
test('documents the user added are read, including PDFs, without a legacy CV path', async (t) => {
  const {root, a, db, added} = await fixture(t);
  delete a.referenceData.profile.cvPath;
  assert.equal((await loadScoringDocuments(db, 'one')).text, '');
  assert.match((await loadScoringDocuments(db, 'one')).unavailable, /Kayıtlı belge yok/);
  await writeFile(
    path.join(root, 'candidates/one/documents/cv.pdf'),
    pdf('Five years of compliance experience.'),
  );
  await writeFile(path.join(root, 'candidates/one/documents/notes.md'), 'German C1');
  await writeFile(
    path.join(root, 'candidates/one/documents/cover-letter.txt'),
    'Agent prepared letter',
  );
  added.push('documents/cv.pdf', 'documents/notes.md');
  const value = await loadScoringDocuments(db, 'one');
  assert.deepEqual(value.paths, ['documents/cv.pdf', 'documents/notes.md']);
  assert.match(value.text, /## documents\/cv.pdf\nFive years of compliance experience\./);
  assert.match(value.text, /## documents\/notes.md\nGerman C1/);
  assert.doesNotMatch(
    value.text,
    /Agent prepared letter/,
    'files the agents prepared are not user facts',
  );
});
test('unreadable, missing, foreign and symlinked documents are reported as unknown without reading them', async (t) => {
  const {root, a, db, added} = await fixture(t),
    foreign = path.join(root, 'other.txt');
  await writeFile(foreign, 'Another workspace private facts.');
  await writeFile(
    path.join(root, 'candidates/one/documents/photo.png'),
    Buffer.from([137, 80, 78, 71]),
  );
  await symlink(foreign, path.join(root, 'candidates/one/documents/link.txt'));
  await writeFile(path.join(root, 'candidates/one/documents/ok.txt'), 'Readable fact.');
  a.referenceData.profile.cvPath = foreign;
  added.push(
    'documents/photo.png',
    'documents/link.txt',
    'documents/missing.pdf',
    'documents/ok.txt',
  );
  const value = await loadScoringDocuments(db, 'one');
  assert.deepEqual(value.paths, ['documents/ok.txt']);
  assert.match(value.text, /Readable fact/);
  assert.doesNotMatch(value.text, /private facts/);
  assert.match(value.unavailable, /other.txt \(Bu dosya görüntülenemez\)/);
  assert.match(value.unavailable, /photo.png \(bu biçimden metin alınamadı\)/);
  assert.match(value.unavailable, /link.txt \(Bu dosya görüntülenemez\)/);
  assert.match(value.unavailable, /missing.pdf \(dosya bulunamadı\)/);
});
test('the store lists only documents the user added with the document control', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'user-documents-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const core = new WorkspaceDatabase(path.join(directory, 'state.sqlite'));
  t.after(() => core.close());
  const db = new AutomationStore(core),
    a = db.create('job-search', {goal: 'Find work'});
  db.message(a.id, 'system', 'Kullanıcı bir belge ekledi: documents/cv.pdf (CV.pdf).', {
    document: 'documents/cv.pdf',
  });
  db.message(a.id, 'assistant', 'Saved documents/cover-letter.txt');
  assert.deepEqual(db.userDocuments(a.id), ['documents/cv.pdf']);
});
