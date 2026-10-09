import {readFile, stat, realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {documentPath} from './artifacts.mjs';
import {workspaceDirectory} from './workspace-paths.mjs';
const cache = new Map(),
  MAX_TEXT = 300000;
const source = (text, extra = {}) => ({
  text,
  digest: createHash('sha256').update(text).digest('hex'),
  ...extra,
});
export function scoringSources(automation, documents) {
  const profile = automation.referenceData?.profile ?? {};
  const facts = [
    automation.facts,
    profile.facts,
    ...Object.values(profile.learnedFacts ?? {}).map((x) => x.value),
  ]
    .filter((x) => typeof x === 'string')
    .join('\n');
  // Preferences are the workspace goal and its saved criteria, whatever the template.
  const criteria = Object.entries(automation.criteria ?? {})
    .filter(
      ([key, value]) =>
        !['ranking', 'score_threshold', 'save_score_threshold'].includes(key) &&
        typeof value === 'string',
    )
    .map(([, value]) => value);
  return {
    facts: source(facts),
    preferences: source(
      [automation.goal, ...criteria, automation.instructions].filter(Boolean).join('\n'),
    ),
    ...(documents ? {documents} : {}),
  };
}
async function documentText(file) {
  const info = await stat(file);
  if (info.size > 10 * 1024 * 1024) throw Error('metin kontrolü için en fazla 10 MB olmalı');
  const key = JSON.stringify([file, info.size, info.mtimeMs]);
  if (cache.has(key)) return cache.get(key);
  let text;
  const extension = path.extname(file).toLowerCase();
  if (['.txt', '.md'].includes(extension)) text = await readFile(file, 'utf8');
  else if (extension === '.pdf') {
    const {getDocument} = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = getDocument({
      data: new Uint8Array(await readFile(file)),
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
    });
    try {
      const pdf = await loading.promise;
      if (pdf.numPages > 40) throw Error('en fazla 40 sayfa olmalı');
      const pages = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i),
          content = await page.getTextContent();
        pages.push(
          content.items
            .map((x) => (typeof x.str === 'string' ? x.str + (x.hasEOL ? '\n' : ' ') : ''))
            .join(''),
        );
        page.cleanup();
      }
      text = pages.join('\n');
    } finally {
      await loading.destroy();
    }
  } else throw Error('bu biçimden metin alınamadı');
  if (cache.size >= 32) cache.delete(cache.keys().next().value);
  cache.set(key, text);
  return text;
}
// Profile documents are the legacy profile CV and every document the user added
// to this workspace. Files agents prepared under documents/ are not user facts.
export async function loadScoringDocuments(db, id) {
  const saved = [db.get(id).referenceData?.profile?.cvPath, ...db.userDocuments(id)].filter(
    Boolean,
  );
  if (!saved.length)
    return source('', {unavailable: 'Kayıtlı belge yok; doğrulanmayan bilgiyi unknown bırak.'});
  const root = await realpath(workspaceDirectory(db.store.directory, db.store.workspaces.get(id))),
    files = [...new Set(saved.map((file) => path.resolve(root, file)))];
  const parts = [],
    paths = [],
    skipped = [];
  let length = 0;
  for (const file of files) {
    const label = path.relative(root, file).startsWith('..')
      ? path.basename(file)
      : path.relative(root, file);
    try {
      const requested = await realpath(file),
        safe = await documentPath(root, path.relative(root, requested)),
        text = (await documentText(safe)).trim();
      if (length + text.length > MAX_TEXT) throw Error('toplam belge metni sınırı aşıldı');
      parts.push(`## ${label}\n${text}`);
      paths.push(label);
      length += text.length;
    } catch (error) {
      skipped.push(`${label} (${error.code === 'ENOENT' ? 'dosya bulunamadı' : error.message})`);
    }
  }
  return source(parts.join('\n\n'), {
    paths,
    ...(skipped.length
      ? {
          unavailable: `Okunamayan belgeler: ${skipped.join('; ')}. Bu belgelerdeki bilgiler unknown kalır.`,
        }
      : {}),
  });
}
