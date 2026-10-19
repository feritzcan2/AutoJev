import {after} from 'node:test';
import {rm} from 'node:fs/promises';

// t.after hooks run in registration order, so a directory removed there goes before the
// test's own close() hooks, and Windows cannot delete a SQLite file that is still open.
// Directories registered here are removed once every test in the file has finished.
const directories = new Set();
after(() =>
  Promise.all(
    [...directories].map((directory) =>
      rm(directory, {recursive: true, force: true, maxRetries: 5}),
    ),
  ),
);
export function removeAfterTests(directory) {
  directories.add(directory);
}
