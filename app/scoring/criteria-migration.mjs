// @ts-check
import {sourceScanScope} from '../sources/scan.mjs';

// Job-search workspaces used to save four fixed scoring weights as criteria
// fields. Scoring is now one rubric text for every template, so the saved
// weights move into criteria.ranking instead of being dropped.
const LEGACY_WEIGHTS = [
  ['weight_technical', 'teknik yetkinlik'],
  ['weight_experience', 'deneyim'],
  ['weight_role', 'rol'],
  ['weight_preferences', 'tercihler'],
];
function foldWeights(criteria) {
  if (
    !criteria ||
    typeof criteria !== 'object' ||
    !LEGACY_WEIGHTS.some(([key]) => Object.hasOwn(criteria, key))
  )
    return false;
  const weights = LEGACY_WEIGHTS.filter(([key]) => String(criteria[key] ?? '').trim()).map(
    ([key, label]) => `${label} %${String(criteria[key]).trim()}`,
  );
  for (const [key] of LEGACY_WEIGHTS) delete criteria[key];
  const ranking = [String(criteria.ranking ?? '').trim(), `Ağırlıklar: ${weights.join(', ')}.`]
    .filter(Boolean)
    .join('\n\n');
  if (weights.length && ranking.length <= 6000) criteria.ranking = ranking;
  return true;
}

export function foldScoringWeights(db) {
  if (db.prepare('PRAGMA user_version').get().user_version >= 35) return;
  const exists = (table) =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!exists('automations')) return;
  db.exec('SAVEPOINT fold_scoring_weights');
  try {
    for (const row of db.prepare('SELECT id,data FROM automations').all()) {
      const value = JSON.parse(row.data);
      if (value.templateId !== 'job-search') continue;
      const before = (value.sources ?? []).map((url) => [url, sourceScanScope(value, url)]);
      if (
        ![value.criteria, value.planDraft?.plan?.criteria, value.profileUpdate?.plan?.criteria]
          .map(foldWeights)
          .some(Boolean)
      )
        continue;
      // Scan scopes fingerprint the criteria; keep saved scans and seen listings.
      const scopes = before
        .map(([url, old]) => [old, sourceScanScope(value, url)])
        .filter(([old, scope]) => old !== scope);
      const remap = (data) =>
        scopes.reduce((text, [old, scope]) => text.replaceAll(old, scope), data);
      db.prepare('UPDATE automations SET data=? WHERE id=?').run(
        remap(JSON.stringify(value)),
        row.id,
      );
      for (const [table, owner] of [
        ['automation_runs', 'automation_id'],
        ['workspace_tasks', 'workspace_id'],
      ]) {
        if (!exists(table)) continue;
        for (const saved of db
          .prepare(`SELECT id,data FROM ${table} WHERE ${owner}=?`)
          .all(row.id)) {
          const data = remap(saved.data);
          if (data !== saved.data)
            db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(data, saved.id);
        }
      }
      if (exists('scan_seen_listings'))
        for (const [old, scope] of scopes)
          db.prepare(
            'UPDATE OR REPLACE scan_seen_listings SET scope_key=? WHERE workspace_id=? AND scope_key=?',
          ).run(scope, row.id, old);
    }
    db.exec('RELEASE fold_scoring_weights');
  } catch (error) {
    db.exec('ROLLBACK TO fold_scoring_weights; RELEASE fold_scoring_weights');
    throw error;
  }
}
