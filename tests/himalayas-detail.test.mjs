import test from 'node:test';
import assert from 'node:assert/strict';
import {readHimalayasDetail, himalayasJobIdentity} from '../app/himalayas-detail.mjs';
import {collectionArguments} from '../app/collect-cli.mjs';

const url = 'https://himalayas.app/companies/synthetic/jobs/backend-engineer-123';
function transport(result, requests = []) {
  return async (value, options) => {
    assert.equal(String(value), 'https://mcp.himalayas.app/mcp');
    if (options.method === 'GET') return new Response('', {status: 405});
    const r = JSON.parse(options.body);
    requests.push(r);
    if (r.id == null) return new Response(null, {status: 202});
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: r.id,
        result:
          r.method === 'initialize'
            ? {
                protocolVersion: '2024-11-05',
                capabilities: {tools: {}},
                serverInfo: {name: 'synthetic', version: '1'},
              }
            : result,
      }),
      {headers: {'content-type': 'application/json'}},
    );
  };
}
test('single-detail lookup uses the observed identity, accepts short content, and sends no profile', async () => {
  const requests = [],
    job = await readHimalayasDetail(url + '/?utm_source=test', {
      fetch: transport(
        {
          content: [
            {
              type: 'text',
              text: '# Backend engineer\n**Location:** Remote\n## Job Description\nBuild APIs.',
            },
          ],
        },
        requests,
      ),
    });
  assert.equal(job.title, 'Backend engineer');
  assert.match(job.description, /Build APIs/);
  assert.deepEqual(requests.find((r) => r.method === 'tools/call').params, {
    name: 'get_job_details',
    arguments: {company_slug: 'synthetic', job_slug: 'backend-engineer-123'},
  });
  assert.deepEqual(collectionArguments(['--detail-url', url]), {detailUrl: url});
  for (const bad of [
    'https://himalayas.app/jobs',
    'https://evil.test/companies/synthetic/jobs/backend',
    'https://himalayas.app:123/companies/a/jobs/b',
    'https://x:y@himalayas.app/companies/a/jobs/b',
  ])
    assert.throws(() => himalayasJobIdentity(bad));
  assert.throws(() => collectionArguments(['--detail-url', url, '--all']));
});
test('missing, malformed and incomplete tool responses do not become valid listings', async () => {
  for (const result of [
    {isError: true, content: [{type: 'text', text: 'Not found'}]},
    {content: [{type: 'text', text: '# Backend engineer'}]},
    {content: [{type: 'text', text: '# Backend engineer\n## Job Description\n'}]},
    {content: []},
  ])
    await assert.rejects(readHimalayasDetail(url, {fetch: transport(result)}), /okunamadı/);
});
test('detail requests are cancellable and a never-completing connection times out', async () => {
  const controller = new AbortController();
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const fetch = (_u, {signal}) =>
    new Promise((_, reject) => {
      entered();
      signal.addEventListener('abort', () => reject(signal.reason), {once: true});
    });
  const pending = readHimalayasDetail(url, {signal: controller.signal, fetch});
  await started;
  controller.abort();
  await assert.rejects(pending);
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(readHimalayasDetail(url, {timeoutMs: 10, fetch}), /timeout/i);
  } finally {
    clearTimeout(keepAlive);
  }
});
