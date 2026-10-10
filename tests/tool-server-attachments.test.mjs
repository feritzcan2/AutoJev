import test from 'node:test';
import assert from 'node:assert/strict';
import {startToolServer, toolResponse} from '../app/agents/tool-server.mjs';

test('binary attachments on a tool result become their own content parts', () => {
  const image = {type: 'image', mimeType: 'image/jpeg', data: 'aGVsbG8='};
  const response = toolResponse({submission: {outcome: 'unknown'}, attachments: [image]});
  assert.deepEqual(response.content, [
    {type: 'text', text: JSON.stringify({submission: {outcome: 'unknown'}})},
    image,
  ]);
  // Results without usable binary parts are unchanged, including the field itself.
  for (const value of [
    {done: true},
    {done: true, attachments: []},
    {done: true, attachments: [{type: 'image'}]},
    'plain',
    null,
  ])
    assert.deepEqual(toolResponse(value), {content: [{type: 'text', text: JSON.stringify(value)}]});
});

test('the MCP server returns an attached image beside the JSON text', async (t) => {
  const image = {type: 'image', mimeType: 'image/jpeg', data: 'aGVsbG8='};
  const protocol = {
    tools: [
      {
        name: 'shot',
        description: 'Returns an image',
        inputSchema: {type: 'object', properties: {}, additionalProperties: false},
      },
    ],
    call: async () => ({seen: true, attachments: [image]}),
  };
  const exchanges = [];
  const server = await startToolServer({
    resolve: () => protocol,
    assertOwner: () => {},
    onExchange: (_grant, event) => exchanges.push(event),
  });
  t.after(() => server.close());
  const token = server.grant('workspace', 'session');
  const response = await fetch(server.endpoint, {
    method: 'POST',
    headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {name: 'shot', arguments: {}},
    }),
  });
  const {result} = await response.json();
  assert.deepEqual(result.content, [{type: 'text', text: JSON.stringify({seen: true})}, image]);
  assert.deepEqual(exchanges.at(-1).result.content, result.content);
});
