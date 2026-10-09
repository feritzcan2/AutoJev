// @ts-check
// Workspaces imported from the former job-application app keep their source
// rows in the old tables. Deleting such a workspace removes those rows too.
export function removeImportedWorkspace(sql, id) {
  if (
    !sql
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_imports'")
      .get() ||
    !sql.prepare('SELECT 1 FROM workspace_imports WHERE workspace_id=?').get(id)
  )
    return;
  for (const {name} of sql
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()) {
    if (!/^[a-z_]+$/.test(name)) continue;
    if (
      sql
        .prepare(`PRAGMA table_info(${name})`)
        .all()
        .some((c) => c.name === 'candidate_id')
    )
      sql.prepare(`DELETE FROM ${name} WHERE candidate_id=?`).run(id);
  }
  sql.prepare('DELETE FROM candidates WHERE id=?').run(id);
  sql
    .prepare('UPDATE workspace_imports SET data=? WHERE workspace_id=?')
    .run('{"deleted":true}', id);
}
