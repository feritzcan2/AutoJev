import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, appendFile, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  transcriptMessage,
  TranscriptReader,
  claudeProjectDirectory,
} from '../app/agent-transcript.mjs';
import {DatabaseSync} from 'node:sqlite';
import {AgentSessions} from '../app/agent-sessions.mjs';

test('Claude assistant and user text records become chat messages; tools and sidechains do not', () => {
  const id = '11111111-1111-1111-1111-111111111111';
  assert.deepEqual(
    transcriptMessage(
      'claude',
      {
        type: 'assistant',
        uuid: 'a',
        timestamp: '2026-09-30T10:00:00.000Z',
        sessionId: id,
        message: {
          content: [
            {type: 'text', text: 'Şu an 13. sayfadayım.'},
            {type: 'tool_use', name: 'x'},
          ],
        },
      },
      id,
    ),
    {id: 'a', role: 'agent', text: 'Şu an 13. sayfadayım.', at: '2026-09-30T10:00:00.000Z'},
  );
  assert.equal(
    transcriptMessage(
      'claude',
      {
        type: 'assistant',
        uuid: 'b',
        sessionId: id,
        message: {content: [{type: 'tool_use', name: 'x'}]},
      },
      id,
    ),
    null,
  );
  assert.equal(
    transcriptMessage(
      'claude',
      {
        type: 'assistant',
        uuid: 'c',
        sessionId: id,
        isSidechain: true,
        message: {content: [{type: 'text', text: 'alt'}]},
      },
      id,
    ),
    null,
  );
  assert.deepEqual(
    transcriptMessage(
      'claude',
      {
        type: 'user',
        uuid: 'd',
        timestamp: 't',
        sessionId: id,
        message: {role: 'user', content: 'Berlin’e odaklan'},
      },
      id,
    ),
    {id: 'd', role: 'user', text: 'Berlin’e odaklan', at: 't'},
  );
  assert.equal(
    transcriptMessage(
      'claude',
      {
        type: 'user',
        uuid: 'e',
        sessionId: id,
        message: {role: 'user', content: [{type: 'tool_result', content: 'x'}]},
      },
      id,
    ),
    null,
  );
  assert.equal(
    transcriptMessage(
      'claude',
      {
        type: 'user',
        uuid: 'f',
        sessionId: id,
        message: {role: 'user', content: '<local-command-stdout>x</local-command-stdout>'},
      },
      id,
    ),
    null,
  );
  assert.equal(
    transcriptMessage(
      'claude',
      {
        type: 'user',
        uuid: 'g',
        sessionId: id,
        message: {role: 'user', content: 'Read AGENTS.md and go.'},
      },
      id,
      new Set(['Read AGENTS.md and go.']),
    ).role,
    'task',
  );
});

test('Codex agent and user messages become chat messages', () => {
  assert.deepEqual(
    transcriptMessage(
      'codex',
      {
        timestamp: 't',
        type: 'event_msg',
        payload: {type: 'agent_message', message: 'Sırayla açıyorum.'},
      },
      'x',
    ),
    {id: 't:agent_message', role: 'agent', text: 'Sırayla açıyorum.', at: 't'},
  );
  assert.deepEqual(
    transcriptMessage(
      'codex',
      {timestamp: 't2', type: 'event_msg', payload: {type: 'user_message', message: 'devam'}},
      'x',
    ),
    {id: 't2:user_message', role: 'user', text: 'devam', at: 't2'},
  );
  assert.equal(
    transcriptMessage(
      'codex',
      {timestamp: 't', type: 'event_msg', payload: {type: 'token_count'}},
      'x',
    ),
    null,
  );
});

test('Codex response items expose public replies without reasoning, tool output or internal channels', () => {
  const record = {
    timestamp: '2026-10-05T08:00:00Z',
    type: 'response_item',
    payload: {
      type: 'message',
      id: 'msg_reply',
      role: 'assistant',
      phase: 'commentary',
      content: [{type: 'output_text', text: 'Profilini inceliyorum.'}],
    },
  };
  assert.deepEqual(transcriptMessage('codex', record, 'x'), {
    id: 'msg_reply',
    role: 'agent',
    text: 'Profilini inceliyorum.',
    at: record.timestamp,
  });
  for (const phase of ['final_answer', undefined])
    assert.equal(
      transcriptMessage('codex', {...record, payload: {...record.payload, phase}}, 'x').text,
      'Profilini inceliyorum.',
    );
  for (const patch of [
    {type: 'reasoning'},
    {type: 'function_call'},
    {role: 'developer'},
    {channel: 'analysis'},
    {phase: 'analysis'},
    {content: [{type: 'reasoning_text', text: 'PRIVATE'}]},
  ])
    assert.equal(
      transcriptMessage('codex', {...record, payload: {...record.payload, ...patch}}, 'x'),
      null,
    );
});

test('Codex native replies are read after app reopening, mirrored formats deduplicate and concurrent polls do not lose messages', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-chat-')),
    id = '33333333-3333-3333-3333-333333333333',
    file = path.join(root, `rollout-test-${id}.jsonl`);
  t.after(() => rm(root, {recursive: true, force: true}));
  const at = '2026-10-05T08:00:00.000Z',
    native = {
      type: 'response_item',
      timestamp: at,
      payload: {
        type: 'message',
        id: 'one',
        role: 'assistant',
        phase: 'final_answer',
        content: [{type: 'output_text', text: 'Yanıt burada.'}],
      },
    },
    mirror = {
      type: 'event_msg',
      timestamp: at,
      payload: {type: 'agent_message', message: 'Yanıt burada.'},
    };
  await writeFile(
    file,
    [{type: 'session_meta', payload: {id, cwd: root}}, native, mirror]
      .map(JSON.stringify)
      .join('\n') + '\n',
  );
  const fallback = {provider: 'codex', nativeId: id, cwd: root, codexRoot: root},
    agents = new AgentSessions({
      root,
      data: root,
      createEngine: () => {
        throw Error('Reading chat must not start a provider');
      },
    });
  t.after(() => agents.close());
  const [a, b] = await Promise.all([
    agents.transcript('workspace', 'conversation', fallback),
    agents.transcript('workspace', 'conversation', fallback),
  ]);
  assert.deepEqual(a.messages, b.messages);
  assert.equal(a.messages.length, 1);
  assert.equal(a.messages[0].text, 'Yanıt burada.');
  assert.equal(agents.sessions.size, 0);
  assert.deepEqual(
    (await agents.transcript('workspace', 'main')).messages,
    [],
    'The source worker has a different transcript',
  );
  const nextAt = '2026-10-05T08:00:01.000Z';
  await appendFile(
    file,
    [
      {...mirror, timestamp: nextAt},
      {...native, timestamp: nextAt, payload: {...native.payload, id: 'two'}},
    ]
      .map(JSON.stringify)
      .join('\n') + '\n',
  );
  const next = await agents.transcript('workspace', 'conversation');
  assert.equal(
    next.messages.length,
    2,
    'A repeated answer is retained; only its opposite-format copy is hidden',
  );
  const other = await agents.transcript('other', 'conversation', {
    ...fallback,
    cwd: path.join(root, 'other'),
  });
  assert.deepEqual(
    other.messages,
    [],
    'Workspace verification also applies to restored transcripts',
  );
});

test('Claude project directories encode the workspace path the way Claude Code does', () => {
  assert.equal(
    claudeProjectDirectory('/Users/me/Projects/job.loop'),
    '-Users-me-Projects-job-loop',
  );
});

test('reader tails the transcript incrementally, verifies the workspace, and keeps the latest messages', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'transcript-')),
    cwd = path.join(root, 'work'),
    id = '22222222-2222-2222-2222-222222222222';
  await mkdir(cwd);
  const dir = path.join(root, 'projects', claudeProjectDirectory(cwd));
  await mkdir(dir, {recursive: true});
  const file = path.join(dir, `${id}.jsonl`);
  const line = (uuid, text, role = 'assistant') =>
    JSON.stringify({
      type: role,
      uuid,
      timestamp: '2026-09-30T10:00:00.000Z',
      sessionId: id,
      cwd,
      message: {role, content: [{type: 'text', text}]},
    }) + '\n';
  await writeFile(file, line('1', 'ilk'));
  const reader = new TranscriptReader({
    provider: 'claude',
    nativeId: id,
    cwd,
    claudeRoot: path.join(root, 'projects'),
    limit: 2,
  });
  assert.deepEqual(
    (await reader.read()).map((m) => m.text),
    ['ilk'],
  );
  await appendFile(file, line('2', 'iki') + line('3', 'üç'));
  assert.deepEqual(
    (await reader.read()).map((m) => m.text),
    ['iki', 'üç'],
  );
  // A transcript whose records name another workspace is never trusted, even when the file name matches.
  const elsewhere = path.join(root, 'elsewhere'),
    otherDir = path.join(root, 'projects', claudeProjectDirectory(elsewhere));
  await mkdir(otherDir, {recursive: true});
  await writeFile(path.join(otherDir, `${id}.jsonl`), line('9', 'yabancı'));
  const other = new TranscriptReader({
    provider: 'claude',
    nativeId: id,
    cwd: elsewhere,
    claudeRoot: path.join(root, 'projects'),
  });
  assert.deepEqual(await other.read(), []);
});

test('OpenCode live text updates in place, excludes reasoning and verifies the exact workspace', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'opencode-transcript-')),
    file = path.join(root, 'opencode.db'),
    id = 'ses_12345678901234567890';
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  db.exec(
    'CREATE TABLE session(id TEXT,directory TEXT); CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,data TEXT);',
  );
  db.prepare('INSERT INTO session VALUES(?,?)').run(id, root);
  db.prepare('INSERT INTO message VALUES(?,?,?,?)').run(
    'm',
    id,
    1000,
    JSON.stringify({role: 'assistant'}),
  );
  const part = db.prepare('INSERT INTO part VALUES(?,?,?,?,?)');
  part.run('text', 'm', id, 1000, JSON.stringify({type: 'text', text: 'İlk cümle'}));
  part.run(
    'reasoning',
    'm',
    id,
    1001,
    JSON.stringify({type: 'reasoning', text: 'PRIVATE REASONING'}),
  );
  part.run(
    'tool',
    'm',
    id,
    1002,
    JSON.stringify({
      type: 'tool',
      tool: 'jobloop_get_workspace_records',
      state: {status: 'running', output: 'PRIVATE OUTPUT'},
    }),
  );
  const reader = new TranscriptReader({
    provider: 'opencode',
    nativeId: id,
    cwd: root,
    opencodeFile: file,
  });
  assert.deepEqual(
    (await reader.read()).map((m) => m.text),
    ['İlk cümle'],
  );
  assert.equal(reader.activity.tool, 'jobloop_get_workspace_records');
  db.prepare('UPDATE part SET data=? WHERE id=?').run(
    JSON.stringify({type: 'text', text: 'İlk cümle. Devamı geldi.'}),
    'text',
  );
  assert.deepEqual(
    (await reader.read()).map((m) => m.text),
    ['İlk cümle. Devamı geldi.'],
  );
  assert.ok(!JSON.stringify(reader.messages).includes('PRIVATE'));
  assert.ok(!JSON.stringify(reader.activity).includes('PRIVATE'));
  const other = new TranscriptReader({
    provider: 'opencode',
    nativeId: id,
    cwd: path.join(root, 'other'),
    opencodeFile: file,
  });
  assert.deepEqual(await other.read(), []);
});
