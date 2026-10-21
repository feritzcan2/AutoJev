// @ts-check
import {appendFile, mkdir, rename, stat} from 'node:fs/promises';
import path from 'node:path';

// Tab lifecycle log: one JSON line per Jev tab opened, labelled, kept or
// closed, and per finished run's close decision, so a tab left open can be
// traced to the run and the decision that kept it. It holds no page content:
// URLs keep only their origin and path. Two files of at most 4 MB each.
const MAX_BYTES = 4 * 1024 * 1024;
let file = null,
  size = 0,
  writes = Promise.resolve();

export function configureTabLog(target) {
  file = target;
  writes = writes
    .then(async () => {
      await mkdir(path.dirname(target), {recursive: true, mode: 0o700});
      size = await stat(target).then(
        (s) => s.size,
        () => 0,
      );
    })
    .catch(() => {});
}

export function tabLogFile() {
  return file;
}

export function shortUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol.startsWith('http') ? url.origin + url.pathname : url.protocol;
  } catch {
    return '';
  }
}

export function logTab(event, fields = {}) {
  if (!file) return;
  const target = file,
    line = JSON.stringify({at: new Date().toISOString(), event, ...fields}) + '\n';
  writes = writes
    .then(async () => {
      if (size + line.length > MAX_BYTES) {
        await rename(target, target.replace(/\.jsonl$/, '.1.jsonl')).catch(() => {});
        size = 0;
      }
      await appendFile(target, line, {mode: 0o600});
      size += Buffer.byteLength(line);
    })
    .catch(() => {});
}
