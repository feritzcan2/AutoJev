import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {collectHimalayas, himalayasApiUrl} from './api.mjs';
import {readHimalayasDetail, himalayasJobIdentity} from './detail.mjs';

export function collectionArguments(args) {
  const flags = new Map();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (
      ![
        '--source',
        '--query',
        '--country',
        '--all',
        '--url',
        '--detail-url',
        '--max-pages',
        '--help',
      ].includes(key) ||
      flags.has(key)
    )
      throw Error(`Invalid option: ${key}`);
    if (['--all', '--help'].includes(key)) flags.set(key, true);
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw Error(`${key} needs a value.`);
      flags.set(key, value);
    }
  }
  if (flags.has('--help')) return null;
  if ((flags.get('--source') ?? 'himalayas') !== 'himalayas')
    throw Error('Supported source: himalayas');
  if (flags.has('--detail-url')) {
    if ([...flags.keys()].some((k) => !['--source', '--detail-url'].includes(k)))
      throw Error('--detail-url cannot be combined with search options.');
    himalayasJobIdentity(flags.get('--detail-url'));
    return {detailUrl: flags.get('--detail-url')};
  }
  if (
    (flags.has('--all') &&
      (flags.has('--query') || flags.has('--country') || flags.has('--url'))) ||
    (flags.has('--url') && (flags.has('--query') || flags.has('--country')))
  )
    throw Error('Do not combine --all, --url and search filters.');
  const url = new URL(
    flags.get('--url') ?? `https://himalayas.app/jobs/api${flags.has('--all') ? '' : '/search'}`,
  );
  if (flags.has('--query')) url.searchParams.set('q', flags.get('--query'));
  if (flags.has('--country')) url.searchParams.set('country', flags.get('--country'));
  const maxPages = Number(flags.get('--max-pages') ?? 1000);
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10000)
    throw Error('--max-pages must be between 1 and 10000.');
  return {searches: [{id: 'collector-1', url: himalayasApiUrl(url.href)}], maxPages};
}

const send = (message) =>
  new Promise((resolve, reject) =>
    process.send(message, (error) => (error ? reject(error) : resolve())),
  );
async function collect(input, options) {
  if (!input.detailUrl) return collectHimalayas(input, options);
  const job = await readHimalayasDetail(input.detailUrl, {signal: options.signal});
  await options.onPage({url: job.url, jobs: [job], complete: true});
  return {complete: true, pages: 1, count: 1};
}
async function main() {
  const controller = new AbortController(),
    stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    if (process.argv.slice(2).includes('--worker')) {
      if (!process.send) throw Error('The collector worker IPC channel is missing.');
      process.once('disconnect', stop);
      const [request] = await once(process, 'message', {signal: controller.signal});
      if (request?.type !== 'start') throw Error('The collector start request is missing.');
      const result = await collect(request.input, {
        signal: controller.signal,
        onPage: async (page) => {
          const ack = once(process, 'message', {signal: controller.signal});
          await send({type: 'page', page});
          const [message] = await ack;
          if (message?.type !== 'ack') throw Error('The collector page could not be saved.');
        },
      });
      await send({type: 'done', result});
    } else {
      const input = collectionArguments(process.argv.slice(2));
      if (!input) {
        process.stdout.write(
          'Usage: node app/site-extensions/himalayas/cli.mjs --source himalayas [--query backend --country DE | --all | --url URL] [--max-pages 1000]\nSingle detail: --detail-url URL\nOutputs NDJSON page records and a final completion receipt; exit 2 means more pages remain.\n',
        );
        return;
      }
      const result = await collect(input, {
        signal: controller.signal,
        onPage: async (page) => {
          if (!process.stdout.write(JSON.stringify({type: 'page', page}) + '\n'))
            await once(process.stdout, 'drain', {signal: controller.signal});
        },
      });
      process.stdout.write(JSON.stringify({type: 'done', result}) + '\n');
      if (!result.complete) process.exitCode = 2;
    }
  } catch (error) {
    const message = controller.signal.aborted
      ? 'Collection was cancelled; it is not complete.'
      : error.message;
    if (process.send && process.connected) await send({type: 'error', message}).catch(() => {});
    else process.stderr.write(message + '\n');
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    if (process.connected) process.disconnect();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
