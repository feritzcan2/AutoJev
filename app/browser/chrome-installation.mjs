// @ts-check
import {access, stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';

export async function findExecutable(
  name,
  {env = process.env, platform = process.platform, accessImpl = access, statImpl = stat} = {},
) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  const extensions = platform === 'win32' ? ['.exe', '.com', '.cmd', '.bat'] : [''];
  for (const directory of pathValue
    .split(platform === 'win32' ? ';' : ':')
    .filter((value) => value && paths.isAbsolute(value)))
    for (const extension of extensions) {
      const file = paths.join(directory, name + extension);
      try {
        await accessImpl(file, platform === 'win32' ? constants.F_OK : constants.X_OK);
        if ((await statImpl(file)).isFile()) return file;
      } catch {}
    }
  return null;
}
export async function findChrome({
  env = process.env,
  platform = process.platform,
  home = homedir(),
  accessImpl = access,
  statImpl = stat,
} = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  // Windows names are case-insensitive (ProgramFiles), but a copied env object is not.
  const envValue = (name) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
  const candidates =
    platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          paths.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
        ]
      : platform === 'win32'
        ? ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA']
            .map(envValue)
            .filter(Boolean)
            .map((dir) => paths.join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe'))
        : [];
  for (const file of candidates)
    try {
      await accessImpl(file, platform === 'win32' ? constants.F_OK : constants.X_OK);
      if ((await statImpl(file)).isFile()) return file;
    } catch {}
  if (platform === 'linux')
    for (const name of ['google-chrome', 'google-chrome-stable']) {
      const file = await findExecutable(name, {env, platform, accessImpl, statImpl});
      if (file) return file;
    }
  return null;
}
