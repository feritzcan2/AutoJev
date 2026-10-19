import {readdir, readFile, writeFile, copyFile, mkdir, stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const assetsByPlatform = {
  macos: [
    `jobloop-macos-universal-${version}.dmg`,
    `jobloop-macos-universal-${version}.zip`,
    'latest-mac.yml',
  ],
  linux: [
    `jobloop-linux-x86_64-${version}.AppImage`,
    `jobloop-linux-amd64-${version}.deb`,
    'latest-linux.yml',
  ],
  windows: [`jobloop-windows-x64-${version}.exe`, 'latest.yml'],
};
const platforms = (process.env.JOBLOOP_RELEASE_PLATFORMS || 'macos,linux,windows').split(',');
const allowed = new Set([
  ...platforms.flatMap((platform) => assetsByPlatform[platform] ?? []),
  `jobloop-source-${version}.tar.gz`,
]);
const blockmaps = new Set(
  [...allowed]
    .filter((name) => /\.(zip|dmg|exe|AppImage)$/.test(name))
    .map((name) => `${name}.blockmap`),
);
const directory = path.resolve(process.argv[2] ?? 'release-assets');
if (process.argv.includes('--collect')) {
  await mkdir(directory, {recursive: true});
  const names = await readdir('release');
  const platformAssets =
    assetsByPlatform[{darwin: 'macos', linux: 'linux', win32: 'windows'}[process.platform]];
  if (!platformAssets) throw Error(`Unsupported release platform: ${process.platform}`);
  for (const name of platformAssets)
    if (!names.includes(name)) throw Error(`Missing native release asset: ${name}`);
  for (const name of names)
    if (allowed.has(name) || blockmaps.has(name))
      await copyFile(path.join('release', name), path.join(directory, name));
} else {
  const names = (await readdir(directory)).sort();
  for (const name of allowed)
    if (!names.includes(name)) throw Error(`Missing release asset: ${name}`);
  for (const name of names)
    if (!allowed.has(name) && !blockmaps.has(name))
      throw Error(`Unexpected release asset: ${name}`);
  const lines = [];
  for (const name of names) {
    if (!(await stat(path.join(directory, name))).isFile()) throw Error(`Non-file asset: ${name}`);
    lines.push(
      `${createHash('sha256')
        .update(await readFile(path.join(directory, name)))
        .digest('hex')}  ${name}`,
    );
  }
  await writeFile(path.join(directory, 'SHA256SUMS'), lines.join('\n') + '\n');
  console.log(`Verified and checksummed ${names.length} release assets`);
}
