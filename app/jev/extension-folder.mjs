import {cp, mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {homedir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {extensionDirectory} from '../system/runtime-paths.mjs';

const execFileAsync = promisify(execFile);
// Chrome keeps loading an unpacked extension from the folder the user chose.
// The app keeps one copy in its own folder so app updates and moves of the
// app bundle do not break that path; the copy follows the bundled files.
let prepared = null;
export const installedExtensionDirectory = () => prepared ?? extensionDirectory();

async function files(directory, prefix = '') {
  const entries = await readdir(path.join(directory, prefix), {withFileTypes: true});
  const out = [];
  for (const entry of entries) {
    const name = path.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...(await files(directory, name)));
    else if (entry.isFile()) out.push(name);
  }
  return out;
}

export async function prepareExtensionFolder({source = extensionDirectory(), target}) {
  const wanted = await files(source);
  await mkdir(target, {recursive: true});
  const present = await files(target).catch(() => []);
  for (const name of wanted) {
    const [next, old] = await Promise.all([
      readFile(path.join(source, name)),
      readFile(path.join(target, name)).catch(() => null),
    ]);
    if (!old?.equals(next)) await cp(path.join(source, name), path.join(target, name));
  }
  for (const name of present)
    if (!wanted.includes(name)) await rm(path.join(target, name), {force: true});
  prepared = target;
  return target;
}

export function resetExtensionFolder() {
  prepared = null;
}

// Once the extension is on the Chrome Web Store, Chrome offers it to every
// profile on its next start when this per-user entry exists ("New extension
// added"). Chrome reads it only for extensions hosted on the Web Store.
const STORE_UPDATE_URL = 'https://clients2.google.com/service/update2/crx';
export async function registerExternalExtension({
  extensionId,
  platform = process.platform,
  home = homedir(),
  write = writeFile,
  run = execFileAsync,
}) {
  if (platform === 'darwin') {
    const directory = path.join(
      home,
      'Library/Application Support/Google/Chrome/External Extensions',
    );
    await mkdir(directory, {recursive: true});
    await write(
      path.join(directory, `${extensionId}.json`),
      JSON.stringify({external_update_url: STORE_UPDATE_URL}),
    );
    return true;
  }
  if (platform === 'win32') {
    await run('reg', [
      'add',
      `HKCU\\Software\\Google\\Chrome\\Extensions\\${extensionId}`,
      '/v',
      'update_url',
      '/t',
      'REG_SZ',
      '/d',
      STORE_UPDATE_URL,
      '/f',
    ]);
    return true;
  }
  return false;
}
