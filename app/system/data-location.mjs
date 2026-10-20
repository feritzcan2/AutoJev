// @ts-check
import {randomUUID, createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {
  mkdir,
  readdir,
  lstat,
  realpath,
  readFile,
  rename,
  rm,
  rmdir,
  copyFile,
  chmod,
  open,
} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync, backup} from 'node:sqlite';

const settingsName = 'data-location.json',
  pendingName = 'pending-data-location.json',
  markerName = '.loop-storage.json';
const directories = [
  'candidates',
  'automations',
  'background',
  'browsers',
  'plugins',
  'backups',
  'imports',
];
const files = ['data-version.json', 'backup-owner.json', 'telegram.json'];
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const exists = async (file) => {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
};
async function json(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function save(file, value) {
  const temporary = file + '.' + randomUUID() + '.tmp',
    handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}
async function checkedDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory))
    throw Error('Choose a valid data folder.');
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw Error('The data location must be a real folder.');
  return realpath(directory);
}
export async function currentDataDirectory(bootstrapDirectory) {
  const saved = await json(path.join(bootstrapDirectory, settingsName));
  if (!saved) return checkedDirectory(bootstrapDirectory);
  if (saved.version !== 1) throw Error('Could not read the data location setting.');
  const directory = await checkedDirectory(saved.directory);
  if (!(await exists(path.join(directory, 'jobloop.sqlite'))))
    throw Error('Database not found in the selected data folder: ' + directory);
  return directory;
}
export async function requestDataLocation({bootstrapDirectory, dataDirectory, destination}) {
  const source = await checkedDirectory(dataDirectory),
    target = await checkedDirectory(destination);
  if (source === target) return {changed: false, directory: source};
  if (
    inside(source, target) ||
    inside(target, source) ||
    inside(target, await realpath(bootstrapDirectory))
  )
    throw Error('Choose an empty folder that is not nested with the current data folder.');
  if ((await readdir(target)).length)
    throw Error('The selected folder must be empty. Its files were not changed.');
  if (await exists(path.join(source, 'pending-restore.json')))
    throw Error('Finish the pending restore first.');
  if (await exists(path.join(bootstrapDirectory, pendingName)))
    throw Error('A restart is pending to change the data folder.');
  const request = {version: 1, id: randomUUID(), source, destination: target};
  await save(path.join(bootstrapDirectory, pendingName), request);
  return {changed: true, directory: target, restartRequired: true};
}
async function existingDataDirectory(directory, {allowPendingLocation = false} = {}) {
  const target = await checkedDirectory(directory);
  if (await exists(path.join(target, 'manifest.json')))
    throw Error('This is a backup folder. Use the Restore from backup option.');
  const file = path.join(target, 'jobloop.sqlite');
  if (!(await exists(file)))
    throw Error(
      'jobloop.sqlite was not found in the selected folder. Choose an existing AutoJob data folder.',
    );
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw Error('The database must be a real file.');
  if (
    (await exists(path.join(target, 'pending-restore.json'))) ||
    (!allowPendingLocation && (await exists(path.join(target, pendingName))))
  )
    throw Error(
      'The selected folder has a pending restore or data location change. Finish that first.',
    );
  const db = new DatabaseSync(file, {readOnly: true});
  try {
    checkDatabase(db);
  } finally {
    db.close();
  }
  return target;
}
export async function requestExistingDataLocation({
  bootstrapDirectory,
  dataDirectory,
  destination,
}) {
  const source = await checkedDirectory(dataDirectory),
    target = await checkedDirectory(destination);
  if (source === target) return {changed: false, directory: source};
  if (await exists(path.join(source, 'pending-restore.json')))
    throw Error('Finish the pending restore first.');
  if (await exists(path.join(bootstrapDirectory, pendingName)))
    throw Error('A restart is pending to change the data folder.');
  await existingDataDirectory(target);
  await save(path.join(bootstrapDirectory, pendingName), {
    version: 1,
    id: randomUUID(),
    mode: 'open',
    source,
    destination: target,
  });
  return {changed: true, directory: target, restartRequired: true};
}
async function digest(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
async function copyTree(source, target) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    throw Error('Could not move linked file: ' + source);
  }
  if (info.isDirectory()) {
    await mkdir(target, {recursive: true, mode: 0o700});
    for (const entry of await readdir(source)) {
      if (
        [
          'runtime',
          'node_modules',
          'SingletonLock',
          'SingletonCookie',
          'SingletonSocket',
          'RunningChromeVersion',
          'DevToolsActivePort',
        ].includes(entry)
      )
        continue;
      await copyTree(path.join(source, entry), path.join(target, entry));
    }
  } else if (info.isFile()) {
    await mkdir(path.dirname(target), {recursive: true, mode: 0o700});
    await copyFile(source, target);
    await chmod(target, 0o600 | (info.mode & 0o100));
    if ((await digest(source)) !== (await digest(target)))
      throw Error('File verification failed: ' + source);
  } else throw Error('Unsupported data file: ' + source);
}
function checkDatabase(db) {
  if (
    db.prepare('PRAGMA quick_check').get().quick_check !== 'ok' ||
    db.prepare('PRAGMA foreign_key_check').get()
  )
    throw Error('Could not verify the moved database.');
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('workspaces','candidates')",
      )
      .get()
  )
    throw Error('Loop database not found.');
}
export function relocatePaths(db, source, destination) {
  const rewrite = (value) => {
    if (typeof value === 'string')
      return inside(source, value) ? destination + value.slice(source.length) : value;
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
    return value;
  };
  const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
  db.exec('BEGIN');
  try {
    for (const {name} of db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()) {
      const columns = db
        .prepare(`PRAGMA table_info(${quote(name)})`)
        .all()
        .filter((c) => c.type.toUpperCase() === 'TEXT')
        .map((c) => c.name);
      for (const column of columns)
        for (const row of db
          .prepare(
            `SELECT rowid AS record_row,${quote(column)} AS value FROM ${quote(name)} WHERE ${quote(column)} IS NOT NULL`,
          )
          .all()) {
          let value = row.value,
            changed;
          try {
            changed = JSON.stringify(rewrite(JSON.parse(value)));
          } catch {
            changed = rewrite(value);
          }
          if (changed !== value)
            db.prepare(`UPDATE ${quote(name)} SET ${quote(column)}=? WHERE rowid=?`).run(
              changed,
              row.record_row,
            );
        }
    }
    checkDatabase(db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
// Called before opening the app database, after the previous process has shut down.
// The original data remains intact; only a verified destination becomes active.
export async function resolveDataDirectory({bootstrapDirectory}) {
  const current = await currentDataDirectory(bootstrapDirectory),
    pendingFile = path.join(bootstrapDirectory, pendingName),
    request = await json(pendingFile);
  if (!request) return current;
  if (request.mode === 'open') {
    if (
      request.version !== 1 ||
      !/^[a-f0-9-]{36}$/.test(request.id) ||
      ![request.source, request.destination].includes(current) ||
      typeof request.destination !== 'string' ||
      !path.isAbsolute(request.destination)
    )
      throw Error('The pending data location choice is invalid.');
    // When returning to the bootstrap folder, its pending request is this switch.
    const destination = await existingDataDirectory(request.destination, {
      allowPendingLocation: request.destination === (await realpath(bootstrapDirectory)),
    });
    if (destination !== request.destination)
      throw Error('The location of the selected data folder changed.');
    await save(path.join(bootstrapDirectory, settingsName), {version: 1, directory: destination});
    await rm(pendingFile, {force: true});
    return destination;
  }
  if (
    current === request.destination &&
    (await json(path.join(current, markerName)))?.id === request.id
  ) {
    await rm(pendingFile, {force: true});
    return current;
  }
  if (
    request.version !== 1 ||
    !/^[a-f0-9-]{36}$/.test(request.id) ||
    request.source !== current ||
    typeof request.destination !== 'string' ||
    !path.isAbsolute(request.destination) ||
    inside(current, request.destination) ||
    inside(request.destination, current)
  )
    throw Error('The pending data move record is invalid.');
  const destination = request.destination,
    stage = destination + '.loop-moving-' + request.id;
  const marker = {version: 1, id: request.id, source: current, directory: destination};
  const installed = await json(path.join(destination, markerName));
  if (installed?.id !== request.id) {
    if (await exists(destination)) {
      if (
        (await checkedDirectory(destination)) !== destination ||
        (await readdir(destination)).length
      )
        throw Error('The target folder changed or is not empty; existing data is kept.');
    }
    if (await exists(stage)) {
      const prior = await json(path.join(stage, markerName));
      if (prior?.id !== request.id) throw Error('Could not verify the move folder.');
      await rm(stage, {recursive: true});
    }
    await mkdir(stage, {mode: 0o700});
    await save(path.join(stage, markerName), marker);
    try {
      const sourceDb = new DatabaseSync(path.join(current, 'jobloop.sqlite'), {readOnly: true});
      try {
        checkDatabase(sourceDb);
        await backup(sourceDb, path.join(stage, 'jobloop.sqlite'));
      } finally {
        sourceDb.close();
      }
      await chmod(path.join(stage, 'jobloop.sqlite'), 0o600);
      for (const name of [...directories, ...files])
        if (await exists(path.join(current, name)))
          await copyTree(path.join(current, name), path.join(stage, name));
      const moved = new DatabaseSync(path.join(stage, 'jobloop.sqlite'));
      try {
        relocatePaths(moved, current, destination);
        moved.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } finally {
        moved.close();
      }
      if (await exists(destination)) {
        if ((await readdir(destination)).length)
          throw Error('Files were added to the target folder; the move was stopped.');
        await rmdir(destination);
      }
      await rename(stage, destination);
    } catch (error) {
      throw new Error('Could not move the data; the old folder was kept. ' + error.message, {
        cause: error,
      });
    }
  }
  const verify = new DatabaseSync(path.join(destination, 'jobloop.sqlite'), {readOnly: true});
  try {
    checkDatabase(verify);
  } finally {
    verify.close();
  }
  await save(path.join(bootstrapDirectory, settingsName), {version: 1, directory: destination});
  await rm(pendingFile, {force: true});
  return destination;
}

export async function cancelDataLocation(bootstrapDirectory) {
  const file = path.join(bootstrapDirectory, pendingName),
    request = await json(file);
  if (
    request &&
    request.mode !== 'open' &&
    /^[a-f0-9-]{36}$/.test(request.id) &&
    typeof request.destination === 'string' &&
    path.isAbsolute(request.destination)
  ) {
    const stage = request.destination + '.loop-moving-' + request.id;
    if ((await json(path.join(stage, markerName)))?.id === request.id)
      await rm(stage, {recursive: true, force: true});
  }
  await rm(file, {force: true});
}
