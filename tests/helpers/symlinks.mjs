import {mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

// Windows lets an account create symlinks only with Developer Mode or elevation. Tests that
// need symlinks skip there instead of failing on the missing privilege.
function probe() {
  if (process.platform !== 'win32') return false;
  const directory = mkdtempSync(path.join(tmpdir(), 'symlink-probe-'));
  try {
    writeFileSync(path.join(directory, 'target'), '');
    symlinkSync(path.join(directory, 'target'), path.join(directory, 'link'));
    return false;
  } catch {
    return 'this Windows account cannot create symlinks (enable Developer Mode)';
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
}
export const symlinkSkip = probe();
