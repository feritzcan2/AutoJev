import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {isHimalayasUrl} from './api.mjs';

export function himalayasJobIdentity(value) {
  if (!isHimalayasUrl(value)) throw Error('Invalid Himalayas listing address.');
  const url = new URL(value),
    match = url.pathname.match(/^\/companies\/([^/]+)\/jobs\/([^/]+)\/?$/);
  if (!match) throw Error('A single Himalayas listing address is required.');
  return {company_slug: decodeURIComponent(match[1]), job_slug: decodeURIComponent(match[2])};
}

// Official public, read-only detail endpoint. No model, credentials or profile
// is involved: https://himalayas.app/docs/remote-jobs-mcp#get_job_details
export async function readHimalayasDetail(
  url,
  {signal, timeoutMs = 20000, fetch = globalThis.fetch} = {},
) {
  const args = himalayasJobIdentity(url),
    abort = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  abort.throwIfAborted();
  const client = new Client({name: 'autojev-collector', version: '1.0.0'});
  const transport = new StreamableHTTPClientTransport(new URL('https://mcp.himalayas.app/mcp'), {
    fetch: (value, options) =>
      fetch(value, {
        ...options,
        redirect: 'error',
        signal: AbortSignal.any([abort, ...(options?.signal ? [options.signal] : [])]),
      }),
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({name: 'get_job_details', arguments: args}, undefined, {
      signal: abort,
      timeout: timeoutMs,
    });
    abort.throwIfAborted();
    const text = (result.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    // The documented tool returns a Markdown detail, not the feed's JSON job.
    // A not-found/error/loading response must never become an assessed listing.
    const title = text.match(/^#\s+([^\n]+)/)?.[1]?.trim(),
      description = text.split(/^## Job Description\s*$/m)[1]?.trim();
    if (result.isError || !title || !description || text.length > 8 * 1024 * 1024)
      throw Error('The Himalayas listing detail could not be read; the address stays pending.');
    // The detail's Location line is the applicant location restriction.
    const location = text.match(/^\*\*Location:\*\*[ \t]*([^\n]+)/m)?.[1]?.trim() ?? '';
    return {url, title: title.slice(0, 300), description: text, company: '', location};
  } finally {
    await client.close();
  }
}
