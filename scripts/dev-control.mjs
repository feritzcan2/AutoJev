// Invoke a handler of the running development app.
//   node scripts/dev-control.mjs --list
//   node scripts/dev-control.mjs automation-record-run '"<workspace>"' '"<record>"' '"execute"' '{"direct":true}'
import {readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const directory =
  process.env.JOBLOOP_DATA_DIR ?? path.join(os.homedir(), 'Library/Application Support/JobLoop');
const {endpoint, token} = JSON.parse(
  await readFile(path.join(directory, 'dev-control.json'), 'utf8'),
);
const [name, ...rest] = process.argv.slice(2);
const headers = {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'};
const response =
  name === '--list'
    ? await fetch(endpoint + '/handlers', {headers})
    : await fetch(endpoint + '/invoke', {
        method: 'POST',
        headers,
        body: JSON.stringify({name, args: rest.map((value) => JSON.parse(value))}),
      });
const body = await response.json();
console.log(JSON.stringify(body, null, 2));
if (!response.ok) process.exitCode = 1;
