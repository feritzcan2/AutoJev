import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {
  chromeDataError,
  chromeUserDataDirectory,
  readChromeLocalState,
} from '../browser/chrome-profiles.mjs';
import {findChrome} from '../browser/chrome-installation.mjs';
import {extensionDirectory} from '../system/runtime-paths.mjs';
import {EXTENSION_ID} from './extension.mjs';
// A cold Chrome process stays alive. Never wait for process exit; cancelling a
// connection must not terminate the user's newly opened Chrome.
const exec = (file, args, {signal, windowsHide}) =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(file, args, {windowsHide, detached: true, stdio: 'ignore'});
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });

export function extensionMissingMessage(directory = extensionDirectory()) {
  return (
    'The AutoJob Chrome extension is not installed and enabled in the selected profile. In Chrome, ' +
    'open chrome://extensions, turn on Developer mode and choose “Load unpacked” with this folder: ' +
    directory
  );
}

// Chrome records installed extensions in the profile's preference files; an
// unpacked extension has a settings record but no Extensions/<id> directory.
export async function extensionInstalledInProfile(
  profile,
  {directory = chromeUserDataDirectory(), extensionId = EXTENSION_ID} = {},
) {
  if (!/^[\w -]{1,100}$/.test(profile)) return false;
  for (const file of ['Preferences', 'Secure Preferences']) {
    let prefs;
    try {
      prefs = JSON.parse(await readFile(path.join(directory, profile, file), 'utf8'));
    } catch (error) {
      // A blocked Chrome data folder needs the user's permission, not the extension.
      const blocked = chromeDataError(error);
      if (blocked !== error) throw blocked;
      continue;
    }
    const record = prefs?.extensions?.settings?.[extensionId];
    if (record && typeof record === 'object' && Object.keys(record).length)
      return record.state !== 0;
  }
  return false;
}

export async function resolveChromeProfile(selected) {
  if (selected?.directory) {
    if (!/^[\w -]{1,100}$/.test(selected.directory)) throw Error('Invalid Chrome profile.');
    return selected.directory;
  }
  const state = await readChromeLocalState();
  return state.profile?.last_used ?? 'Default';
}

// Opens a URL in the selected regular Chrome profile, starting Chrome when it
// is closed. The AutoJev extension closes its own connect page afterwards.
export async function openChromeUrl(
  url,
  selected,
  {
    directory = chromeUserDataDirectory(),
    findChromeImpl = findChrome,
    execImpl = exec,
    signal,
  } = {},
) {
  signal?.throwIfAborted();
  const state = await readChromeLocalState(directory);
  const profile = selected?.directory ?? state.profile?.last_used ?? 'Default';
  if (!/^[\w -]{1,100}$/.test(profile) || !state.profile?.info_cache?.[profile])
    throw Error('The selected existing Chrome profile was not found.');
  const args = [`--profile-directory=${profile}`, url];
  const executable = await findChromeImpl();
  if (!executable)
    throw Error('Google Chrome was not found. Install Chrome and open it at least once.');
  signal?.throwIfAborted();
  await execImpl(executable, args, {windowsHide: true, signal});
}
