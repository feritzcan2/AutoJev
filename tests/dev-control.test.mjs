import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, stat, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startDevControl} from '../app/system/dev-control.mjs';

test('the dev control channel invokes registered handlers only with its token', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dev-control-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const calls = [],
    gated = [];
  const control = await startDevControl({
    directory,
    handlers: new Map([['echo', (...args) => (calls.push(args), {args})]]),
    invoke: (name, fn) => (gated.push(name), fn()),
  });
  const file = path.join(directory, 'dev-control.json');
  // Windows has no POSIX permission bits.
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  const {endpoint, token} = JSON.parse(await readFile(file, 'utf8'));
  const post = (body, headers = {Authorization: 'Bearer ' + token}) =>
    fetch(endpoint + '/invoke', {method: 'POST', headers, body: JSON.stringify(body)});
  const ok = await post({name: 'echo', args: ['a', 1]});
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), {result: {args: ['a', 1]}});
  assert.deepEqual(gated, ['echo']);
  assert.equal((await post({name: 'echo'}, {})).status, 403);
  assert.equal(
    (await post({name: 'echo'}, {Authorization: 'Bearer ' + token, Origin: 'https://x.test'}))
      .status,
    403,
  );
  assert.equal((await post({name: 'missing'})).status, 400);
  assert.equal(calls.length, 1);
  await control.close();
  await assert.rejects(stat(file));
});
