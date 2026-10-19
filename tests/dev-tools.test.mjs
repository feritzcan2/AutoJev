import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {WebTasks} from '../app/automation/web-template.mjs';
import {automationWorkflow} from '../app/automation/worker.mjs';
import {AgentTrace} from '../app/system/agent-trace.mjs';
import {registerDevTools} from '../app/system/dev-tools.mjs';
import {SITE_EXTENSIONS} from '../app/site-extensions/index.mjs';
import {listingPage} from '../app/site-extensions/listing.mjs';
import {extensionBench} from '../app/sources/extension-bench.mjs';

const source = 'https://example.test/jobs',
  url = source + '/developer',
  settle = () => new Promise((resolve) => setImmediate(resolve));

test('the trace keeps every exchange of a run, masks secrets and stays bounded', () => {
  let now = 1000;
  const changed = [],
    trace = new AgentTrace({now: () => now++, changed: (id) => changed.push(id)}),
    grant = {workspaceId: 'w', sessionId: 'run-1', workerId: 'main'};
  trace.session({
    workspaceId: 'w',
    sessionId: 'run-1',
    kind: 'launch',
    title: 'Session start message',
    parts: [{key: 'launch-prompt', title: 'Start message', source: 'system', text: 'Scan it'}],
  });
  trace.tool(grant, {kind: 'tool_catalog', name: 'tools/list', result: {tools: [{name: 'a'}]}});
  trace.tool(grant, {
    name: 'read_listing_brief',
    args: {evidenceId: 'e1', apiKey: 'k-123'},
    result: {
      content: [
        {type: 'text', text: '{"sections":[1]}'},
        {type: 'image', mimeType: 'image/png'},
      ],
    },
    ms: 12,
  });
  trace.tool(grant, {
    name: 'credential_vault_read',
    args: {site: 'x'},
    result: {content: [{type: 'text', text: 'hunter2'}]},
  });
  trace.tool(grant, {
    name: 'record_automation_score',
    args: {score: 101},
    result: {isError: true, content: [{type: 'text', text: 'bad score'}]},
  });
  trace.jev('w', 'run-1', {
    state: {listing: {text: 'x'.repeat(250000)}},
    questions: {fit: {}},
    answers: {fit: {choice: 'possible', confidence: 0.9}},
    ms: 5,
  });
  const run = trace.events('w', 'run-1');
  assert.deepEqual(
    run.events.map((e) => [e.type, e.name ?? e.kind]),
    [
      ['prompt', 'launch'],
      ['prompt', 'tools'],
      ['tool', 'read_listing_brief'],
      ['tool', 'credential_vault_read'],
      ['tool', 'record_automation_score'],
      ['jev', undefined],
    ],
  );
  assert.equal(run.events[0].parts[0].text, 'Scan it');
  const brief = run.events[2];
  assert.match(brief.args.text, /"apiKey": "\[masked\]"/);
  assert.match(brief.args.text, /"evidenceId": "e1"/);
  assert.match(brief.output.text, /"sections"/);
  assert.match(brief.output.text, /\[image image\/png\]/);
  assert.equal(brief.ms, 12);
  assert.doesNotMatch(JSON.stringify(run.events[3]), /hunter2/);
  assert.equal(run.events[4].error, true);
  assert.equal(run.events[5].state.truncated, true);
  assert.deepEqual(run.counts, {prompt: 2, tool: 3, jev: 1, error: 1});
  assert.equal(changed.at(-1), 'w');
  assert.doesNotThrow(() => structuredClone(run));
  // Old runs give way to new ones.
  for (let i = 2; i <= 45; i++)
    trace.tool({...grant, sessionId: 'run-' + i}, {name: 'x', args: {}, result: {}});
  assert.equal(trace.runs('w').length, 40);
  assert.equal(trace.events('w', 'run-1'), null);
  assert.equal(trace.runs('w')[0].runId, 'run-45');
});

function fixture(t) {
  const core = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(core);
  const a = db.create('job-search', {
    goal: 'Find jobs',
    criteria: {preferences: 'Remote JavaScript', ranking: 'Skills 60, role 40.'},
    sources: [source],
  });
  db.review(a.id);
  const seed = db.begin(a.id, 'run'),
    item = db.record(a.id, seed.id, {
      url,
      title: 'Developer',
      summary: 'Saved listing',
      assessment: {score: 70},
    });
  db.finish(a.id, seed.id, 'completed', 'Saved');
  const launches = [],
    runtime = new WebTasks(db, {
      launch: async (run) => {
        launches.push(run);
        return {close: async () => {}};
      },
    });
  t.after(async () => {
    await runtime.close();
    core.close();
  });
  const handlers = new Map();
  registerDevTools({
    handle: (name, fn) => handlers.set(name, fn),
    trace: new AgentTrace(),
    db,
    runtime,
  });
  const call = (run, name, args) =>
    automationWorkflow({db, run, signal: {aborted: false}, browser: {}, report: () => {}}).call(
      a.id,
      run.id,
      name,
      args,
    );
  return {db, id: a.id, item, runtime, launches, handlers, call};
}

test('a trial score runs the scoring agent but leaves the record unchanged', async (t) => {
  const f = fixture(t);
  await f.handlers.get('dev-trial-score')(f.id, f.item.id);
  await settle();
  const run = f.launches.at(-1);
  assert.equal(run.recordOperation, 'score');
  assert.equal(run.request.dryRun, true);
  assert.deepEqual(f.handlers.get('dev-trial-scores')(f.id, f.item.id).queued.length, 1);
  const saved = await f.call(run, 'record_automation_score', {
    score: 55,
    summary: 'Skills match, role is adjacent.',
    eligibility: 'verified',
  });
  assert.equal((saved.content ? JSON.parse(saved.content[0].text) : saved).score, 55);
  // The record keeps its assessment and cells.
  const record = f.db.result(f.id, f.item.id);
  assert.equal(record.assessment.score, 70);
  assert.deepEqual(record.cells, f.item.cells);
  const {scores} = f.handlers.get('dev-trial-scores')(f.id, f.item.id);
  assert.equal(scores.length, 1);
  assert.equal(scores[0].assessment.score, 55);
  assert.equal(scores[0].runId, run.id);
  assert.equal(scores[0].run.dryRun, true);
  // The trial score completes the task as a saved score would.
  f.runtime.report(f.id, run.id, 'completed', 'Scored');
  await f.runtime.finish(f.id, 'completed', 'Scored', run.workerId);
  assert.equal(f.db.run(run.id).status, 'completed');
  assert.equal(f.db.result(f.id, f.item.id).assessment.score, 70);
});

test('a real score task is not merged with a queued trial score', async (t) => {
  const f = fixture(t);
  await f.handlers.get('dev-trial-score')(f.id, f.item.id);
  await assert.rejects(f.runtime.runRecord(f.id, f.item.id, 'score'), /already queued or running/);
});

test('the bench asks Jev the scan questions with the workspace criteria and applies the scan rules', async (t) => {
  const core = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(core);
  t.after(() => core.close());
  const a = db.create('job-search', {
    goal: 'Find backend roles',
    criteria: {preferences: 'Go. Only backend roles. No design work.'},
    sources: [source],
  });
  const extension = {
    id: 'bench-jev',
    matches: (value) => new URL(value).hostname === 'jev.bench.test',
    http: {
      handles: () => true,
      read: async (address) =>
        listingPage({
          url: address,
          title: 'Frontend Designer',
          description: 'Design marketing pages in Figma.',
          fields: {company: 'Acme'},
        }),
    },
  };
  SITE_EXTENSIONS.unshift(extension);
  t.after(() => SITE_EXTENSIONS.splice(SITE_EXTENSIONS.indexOf(extension), 1));
  const requests = [];
  const answer = (choice, probabilities) => ({
    choice,
    confidence: probabilities[choice],
    probabilities,
  });
  const fetchImpl = async (target, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const keys = Object.keys(body.questions),
      answers = {};
    // The why question: the option whose text names the conflict.
    const pick = (criteria, needle) => {
      const keys = Object.keys(criteria),
        chosen = keys.find((k) => criteria[k].includes(needle)) ?? 'none',
        rest = (1 - 0.7) / (keys.length - 1);
      return answer(chosen, Object.fromEntries(keys.map((k) => [k, k === chosen ? 0.7 : rest])));
    };
    for (const key of keys)
      answers[key] =
        key === 'rule'
          ? pick(body.questions.rule.criteria, 'No design work')
          : key === 'passage'
            ? pick(body.questions.passage.criteria, 'Figma')
            : key === 'fit0'
              ? answer('unrelated_role', {
                  keep: 0.2,
                  hard_constraint: 0.05,
                  qualification: 0.05,
                  unrelated_role: 0.7,
                })
              : key === 'fit'
                ? answer('mismatch', {
                    possible: 0.03,
                    mismatch: 0.9,
                    uncertain: 0.05,
                    incomplete: 0.01,
                    results: 0.01,
                  })
                : key === 'support'
                  ? answer('uncertain', {supported: 0.4, uncertain: 0.6})
                  : answer('unrelated_role', {
                      none: 0.1,
                      hard_constraint: 0.1,
                      qualification: 0.1,
                      unrelated_role: 0.6,
                      not_listing: 0.1,
                    });
    return Response.json({answers, usage: {input_tokens: 10, output_tokens: 2}});
  };
  const bench = extensionBench({
    browser: {options: () => ({config: async () => ({apiKey: 'test-key', fetchImpl})})},
    db,
  });
  const read = await bench.jev(a.id, 'https://jev.bench.test/job/1');
  const j = read.jev;
  assert.equal(j.criteria.goal, 'Find backend roles');
  assert.deepEqual(
    j.asked.map((q) => q.step),
    ['card', 'detail', 'proof', 'why'],
  );
  // Extension card rule: 1 - keep = 0.8 stays below 85%, so the card is kept.
  assert.equal(j.card.rule, 'extension_card');
  assert.equal(j.card.eliminated, false);
  assert.equal(j.card.reason, 'unrelated_role');
  // The detail mismatch is not proven, so it is left to the agent.
  assert.equal(j.detail.decision, 'uncertain');
  assert.equal(j.detail.proof.supported, false);
  assert.match(j.notes.join(' '), /not proven/);
  assert.equal(requests[0].state.links.link0.text, 'Frontend Designer');
  assert.match(requests[1].state.listing.text, /Design marketing pages/);
  // Bench only: the saved rule and the listing passage behind the exclusion.
  assert.equal(j.why.basis, 'detail');
  assert.equal(j.why.reason, 'unrelated_role');
  assert.deepEqual(
    [j.why.rule.top[0].source, j.why.rule.top[0].text],
    ['criteria.preferences', 'No design work.'],
  );
  assert.match(j.why.passage.top[0].text, /Figma/);
  assert.ok(
    Object.values(requests[3].questions.rule.criteria).includes('goal: Find backend roles'),
  );
  assert.equal(requests[3].questions.rule.criteria.none, 'None of these options is contradicted.');
  assert.doesNotThrow(() => structuredClone(read));
});

test('a run’s Jev requests reach the trace with their answers or error', async () => {
  const {automationBrowser} = await import('../app/browser/automation-browser.mjs');
  const traced = [],
    reply = {
      fit: {choice: 'possible', confidence: 0.9, probabilities: {possible: 0.9, other: 0.1}},
    };
  let fail = false;
  const fetchImpl = async () =>
    fail ? new Response('down', {status: 500}) : Response.json({answers: reply, usage: {}});
  const browser = automationBrowser(
    {options: () => ({config: async () => ({apiKey: 'k', fetchImpl})})},
    {traceJev: (entry) => traced.push(entry)},
  );
  const questions = {
    fit: {type: 'choice', instructions: 'x', criteria: {possible: 'a', other: 'b'}},
  };
  await browser.evaluateJev('w', {listing: 'text'}, questions);
  fail = true;
  await assert.rejects(browser.evaluateJev('w', {listing: 'text'}, questions), /HTTP 500/);
  assert.equal(traced.length, 2);
  assert.deepEqual(traced[0].answers, reply);
  assert.deepEqual(traced[0].state, {listing: 'text'});
  assert.match(traced[1].error, /HTTP 500/);
  assert.ok(Number.isFinite(traced[1].ms));
});

test('a trial score also reads a submitted record, but not one being submitted', async (t) => {
  const f = fixture(t);
  f.db.markSubmitted(f.id, f.item.id);
  assert.equal(f.db.result(f.id, f.item.id).status, 'completed');
  // An ordinary score of a closed record stays refused.
  await assert.rejects(f.runtime.runRecord(f.id, f.item.id, 'score'), /cannot be submitted again/);
  await f.handlers.get('dev-trial-score')(f.id, f.item.id);
  await settle();
  const run = f.launches.at(-1);
  assert.equal(run.request.dryRun, true);
  await f.call(run, 'record_automation_score', {score: 40, summary: 'Seniority too low.'});
  const record = f.db.result(f.id, f.item.id);
  assert.equal(record.status, 'completed');
  assert.equal(record.assessment.score, 70);
  assert.equal(f.handlers.get('dev-trial-scores')(f.id, f.item.id).scores[0].assessment.score, 40);
  f.runtime.report(f.id, run.id, 'completed', 'Scored');
  await f.runtime.finish(f.id, 'completed', 'Scored', run.workerId);
  assert.equal(f.db.run(run.id).status, 'completed');
  assert.equal(f.db.result(f.id, f.item.id).status, 'completed');
  // A record in the middle of a submission is left alone.
  f.db.putResult({...f.db.result(f.id, f.item.id), status: 'executing'});
  await assert.rejects(f.handlers.get('dev-trial-score')(f.id, f.item.id), /being submitted/);
});
