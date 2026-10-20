// @ts-check
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';

export function chromeUserDataDirectory({
  platform = process.platform,
  home = homedir(),
  env = process.env,
} = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  return platform === 'darwin'
    ? paths.join(home, 'Library/Application Support/Google/Chrome')
    : platform === 'win32'
      ? paths.join(env.LOCALAPPDATA || paths.join(home, 'AppData/Local'), 'Google/Chrome/User Data')
      : paths.join(env.XDG_CONFIG_HOME || paths.join(home, '.config'), 'google-chrome');
}
// macOS privacy protection answers EPERM for Chrome's data folder until the app
// has Full Disk Access. Say so instead of a raw error or "connection is off".
export function chromeDataError(error, {platform = process.platform} = {}) {
  if (error?.code !== 'EPERM' || platform !== 'darwin') return error;
  return Object.assign(
    Error(
      "macOS blocked AutoJob from reading Chrome's data folder. Open System Settings > Privacy & Security > Full Disk Access, turn on AutoJob, then quit and reopen AutoJob.",
    ),
    {code: 'CHROME_DATA_BLOCKED'},
  );
}
export async function readChromeLocalState(directory = chromeUserDataDirectory()) {
  try {
    return JSON.parse(await readFile(path.join(directory, 'Local State'), 'utf8'));
  } catch (error) {
    throw chromeDataError(error);
  }
}
export async function listChromeProfiles({directory = chromeUserDataDirectory()} = {}) {
  let state;
  try {
    state = await readChromeLocalState(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    if (error.code === 'CHROME_DATA_BLOCKED') throw error;
    throw Error('Could not read the Chrome profiles.');
  }
  return Object.entries(state.profile?.info_cache ?? {})
    .filter(
      ([directory, profile]) =>
        /^[\w -]{1,100}$/.test(directory) &&
        typeof profile?.name === 'string' &&
        profile.name.trim(),
    )
    .map(([directory, profile]) => ({directory, name: profile.name.trim().slice(0, 300)}))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
}
