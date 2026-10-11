import {createServer} from 'node:http';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {writeFile, rm} from 'node:fs/promises';
import path from 'node:path';

// Development-only control channel: a local script can invoke the same IPC
// handlers the window uses (start a record run, answer a question, mark a
// record submitted) through the same maintenance gate. Loopback only, bearer
// token in a 0600 file next to the app data, browser requests refused.
export async function startDevControl({directory, handlers, invoke}) {
  const token = randomBytes(32).toString('hex'),
    expected = Buffer.from(token),
    file = path.join(directory, 'dev-control.json');
  const authorized = (header) => {
    const given = Buffer.from(String(header ?? '').replace(/^Bearer /, ''));
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const server = createServer(async (req, res) => {
    const reply = (code, body) => {
      const payload = JSON.stringify(body ?? null);
      res.writeHead(code, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
      res.end(payload);
    };
    if (req.headers.origin || !authorized(req.headers.authorization))
      return reply(403, {error: 'Forbidden'});
    if (req.method === 'GET' && req.url === '/handlers')
      return reply(200, {handlers: [...handlers.keys()].sort()});
    if (req.method !== 'POST' || req.url !== '/invoke') return reply(404, {error: 'Not found'});
    let size = 0;
    const parts = [];
    for await (const part of req) {
      size += part.length;
      if (size > 1024 * 1024) return reply(413, {error: 'Too large'});
      parts.push(part);
    }
    let name, args;
    try {
      ({name, args = []} = JSON.parse(Buffer.concat(parts)));
    } catch {
      return reply(400, {error: 'Invalid JSON'});
    }
    const fn = handlers.get(name);
    if (!fn || !Array.isArray(args)) return reply(400, {error: 'Unknown handler: ' + name});
    try {
      return reply(200, {result: (await invoke(name, () => fn(...args))) ?? null});
    } catch (error) {
      return reply(500, {error: error.message});
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await writeFile(
    file,
    JSON.stringify({
      endpoint: `http://127.0.0.1:${server.address().port}`,
      token,
      pid: process.pid,
    }),
    {mode: 0o600},
  );
  return {
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await rm(file, {force: true});
    },
  };
}
