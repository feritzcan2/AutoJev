// @ts-check
import path from 'node:path';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export function runtimeResourceRoot({root = defaultRoot} = {}) {
  return /(?:^|[/\\])app(?:-(?:arm64|x64))?\.asar$/.test(root) ? `${root}.unpacked` : root;
}
// The Chrome extension must stay a plain directory: Chrome loads it from disk.
export function extensionDirectory({
  root = defaultRoot,
  resourcesPath = process.resourcesPath,
} = {}) {
  if (/(?:^|[/\\])app(?:-(?:arm64|x64))?\.asar$/.test(root))
    return path.join(resourcesPath ?? path.dirname(root), 'extension');
  return path.join(root, 'extension');
}
export function engineBinaryPath({
  root = defaultRoot,
  resourcesPath = process.resourcesPath,
  platform = process.platform,
  exists = existsSync,
} = {}) {
  const binary = platform === 'win32' ? 'jobloop-engine.exe' : 'jobloop-engine';
  if (/(?:^|[/\\])app(?:-(?:arm64|x64))?\.asar$/.test(root))
    return path.join(resourcesPath ?? path.dirname(root), 'engine', binary);
  const debug = path.join(root, 'engine/target/debug', binary),
    release = path.join(root, 'engine/target/release', binary);
  return exists(debug) ? debug : release;
}
