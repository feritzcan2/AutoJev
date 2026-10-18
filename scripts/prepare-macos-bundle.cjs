const {chmod, lstat, readdir} = require('node:fs/promises');
const path = require('node:path');
const verifyUniversalInputs = require('./verify-universal-inputs.cjs');

// Build hosts may use umask 077. Distributed code must be readable and
// executable by every installing account, before its signature is sealed.
async function normalizePermissions(file) {
  const metadata = await lstat(file);
  if (metadata.isSymbolicLink()) return;
  if (!metadata.isDirectory() && !metadata.isFile()) return;
  const mode = metadata.isDirectory() || metadata.mode & 0o111 ? 0o755 : 0o644;
  await chmod(file, mode);
  if (metadata.isDirectory())
    for (const name of await readdir(file)) await normalizePermissions(path.join(file, name));
}

module.exports = async (context) => {
  await verifyUniversalInputs(context);
  if (context.electronPlatformName !== 'darwin') return;
  await normalizePermissions(
    path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`),
  );
};
