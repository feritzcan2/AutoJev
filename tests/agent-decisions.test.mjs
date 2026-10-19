import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {WebTasks} from '../app/automation/web-template.mjs';
import {automationWorkflow} from '../app/automation/worker.mjs';
import {scopedAutomationTools} from '../app/automation/tools.mjs';
import {automationPrompt} from '../app/automation/prompts.mjs';
import {runJevTask} from '../app/jev/tasks.mjs';
import {buildJevBrief} from '../app/jev/brief.mjs';
import {webAgentProfile} from '../app/agents/automation-profiles.mjs';
import {withAgentDefaults} from '../app/agents/settings.mjs';
import {collectReadiness} from '../app/system/readiness.mjs';

// With agent decisions no model is asked: tasks pause and hand what they read
// to the agent, whose next call carries the decision.
const url = 'https://example.test/list';
const page = (extra = {}) => ({
  url,
  title: 'Homes',
  text: 'Results page',
  links: [
    {url: url + '/1', text: 'Two rooms in Berlin'},
    {url: url + '/2', text: 'Studio in Munich'},
    {url: url + '/3', text: 'Saved searches'},
    {url: url + '/4', text: 'Flat in Berlin Mitte'},
  ],
  pagination: [{text: '1', url, current: true}],
  ...extra,
});
function fixture(t, {decisions = 'agent'} = {}) {
  const core = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(core);
  t.after(() => core.close());
  const a = db.create('housing', {
    goal: 'Berlin homes',
    criteria: {location: 'Berlin', budget: '2000', requirements: '2 rooms'},
    sources: [url],
  });
  db.review(a.id);
  const controller = new AbortController(),
    calls = [],
    asked = [],
    checkpoints = [];
  let current = page();
  const ports = {
    authorize: async () => {},
    assertActive: () => {},
    searchId: 'default',
    decisions,
    browser: async (name, args) => {
      calls.push({name, args});
      if (args.url && args.url !== url)
        return {url: args.url, title: 'Home', text: 'Two rooms, rent 1500. '.repeat(20)};
      return current;
    },
    evaluate: async (state, questions) => {
      asked.push(questions);
      throw Error('No model may be asked with agent decisions.');
    },
    checkpoint: async (_page, urls, options) => {
      checkpoints.push({urls, options});
      return {saved: true};
    },
  };
  const run = (input) =>
    runJevTask({
      store: db.jevTasks,
      owner: a.id,
      taskId: 'assigned',
      input,
      ports,
      criteria: a.criteria,
      signal: controller.signal,
    });
  return {
    core,
    db,
    a,
    ports,
    calls,
    asked,
    checkpoints,
    run,
    setPage: (value) => {
      current = value;
    },
  };
}

test('a results page pauses for the agent to choose its listings, then for the next page', async (t) => {
  const f = fixture(t);
  const first = await f.run({operation: 'scan_results', url});
  assert.equal(first.status, 'needs_agent');
  assert.equal(first.issue.reason, 'links_ready');
  assert.deepEqual(
    first.linkSelection.links.map((l) => [l.item, l.title]),
    [
      [1, 'Two rooms in Berlin'],
      [2, 'Studio in Munich'],
      [3, 'Saved searches'],
      [4, 'Flat in Berlin Mitte'],
    ],
  );
  assert.match(first.next, /selected=\[item numbers/);
  // Resuming without an answer repeats the same pending choice.
  const again = await f.run({taskId: first.taskId});
  assert.equal(again.linkSelection.id, first.linkSelection.id);
  assert.equal(f.checkpoints.length, 0, 'nothing is queued before the agent chooses');

  const chosen = await f.run({
    taskId: first.taskId,
    reviewedBatchId: first.linkSelection.id,
    selected: [1, 4],
    review: [{item: 2, decision: 'reject', reason: 'Munich is outside the wanted city.'}],
  });
  assert.equal(chosen.status, 'needs_agent');
  assert.equal(chosen.issue.reason, 'pagination_choice');
  assert.deepEqual(chosen.paginationChoice.options, {});
  assert.equal(chosen.confirmedListings, 2);
  assert.equal(f.checkpoints.length, 1);
  const {urls, options} = f.checkpoints[0];
  assert.deepEqual(urls, [url + '/1', url + '/4']);
  assert.deepEqual(options.rejectedUrls, [url + '/2']);
  assert.deepEqual(options.navigationUrls, [url + '/3']);
  assert.equal(options.rejected[0].reason, 'Munich is outside the wanted city.');
  assert.equal(options.decidedBy, 'agent');

  const done = await f.run({taskId: first.taskId, next: 'end'});
  assert.equal(done.status, 'completed');
  const saved = f.db.jevTasks.get(f.a.id, 'assigned', first.taskId);
  assert.equal(saved.pages[0].continuation.method, 'agent');
  assert.ok(saved.items.every((i) => i.discovery.by === 'agent'));
  assert.equal(f.asked.length, 0);
});

test('the agent pagination choice opens the offered page and is refused when the entry changed', async (t) => {
  const f = fixture(t),
    more = {text: 'More homes', url: url + '?page=2'};
  f.setPage(page({links: [{url: url + '/1', text: 'Two rooms'}], pagination: [more]}));
  const first = await f.run({operation: 'scan_results', url});
  const choice = await f.run({
    taskId: first.taskId,
    reviewedBatchId: first.linkSelection.id,
    selected: [1],
  });
  assert.equal(choice.issue.reason, 'pagination_choice');
  assert.deepEqual(choice.paginationChoice.options, {0: {text: 'More homes', url: more.url}});
  await assert.rejects(f.run({taskId: first.taskId, next: '7'}), /offered options: 0, scroll, end/);
  // The same page now shows a different control under the offered key.
  f.setPage(
    page({links: [{url: url + '/1', text: 'Two rooms'}], pagination: [{...more, text: 'Older'}]}),
  );
  const changed = await f.run({taskId: first.taskId, next: '0'});
  assert.equal(changed.issue.reason, 'pagination_action_unconfirmed');

  const g = fixture(t);
  g.setPage(page({links: [{url: url + '/1', text: 'Two rooms'}], pagination: [more]}));
  const scan = await g.run({operation: 'scan_results', url});
  await g.run({taskId: scan.taskId, reviewedBatchId: scan.linkSelection.id, selected: [1]});
  g.ports.browser = async (name, args) => {
    g.calls.push({name, args});
    return args.url === more.url
      ? {url: more.url, title: 'Homes 2', text: 'Page 2', links: [{url: url + '/9', text: 'Nine'}]}
      : page({links: [{url: url + '/1', text: 'Two rooms'}], pagination: [more]});
  };
  const next = await g.run({taskId: scan.taskId, next: '0'});
  assert.ok(g.calls.some((c) => c.name === 'open' && c.args.url === more.url));
  assert.equal(next.issue.reason, 'links_ready');
  assert.deepEqual(
    next.linkSelection.links.map((l) => l.url),
    [url + '/9'],
  );
  assert.equal(f.asked.length + g.asked.length, 0);
});

test('a page that states its end needs no pagination choice; extension card facts reach the selection', async (t) => {
  const card = 'Two rooms · Acme Homes · Berlin · 2026-10-15';
  // A site extension read this page's pagination and found no next page.
  const f = fixture(t);
  f.setPage(
    page({
      links: [{url: url + '/1', text: 'Two rooms', listing: true, siteCard: card}],
      paginationBy: 'example',
    }),
  );
  const first = await f.run({operation: 'scan_results', url});
  assert.equal(first.linkSelection.links[0].card, card);
  const done = await f.run({
    taskId: first.taskId,
    reviewedBatchId: first.linkSelection.id,
    selected: [1],
  });
  assert.equal(done.status, 'completed');
  const method = (fx, id) =>
    fx.db.jevTasks.get(fx.a.id, 'assigned', id).pages[0].continuation.method;
  assert.equal(method(f, first.taskId), 'site_extension');

  // The last page of a page count the page shows.
  const g = fixture(t);
  g.setPage(
    page({
      links: [{url: url + '/1', text: 'Two rooms'}],
      pagination: [{text: '3 of 3', url, current: true}],
    }),
  );
  const last = await g.run({operation: 'scan_results', url});
  const ended = await g.run({
    taskId: last.taskId,
    reviewedBatchId: last.linkSelection.id,
    selected: [1],
  });
  assert.equal(ended.status, 'completed');
  assert.equal(method(g, last.taskId), 'observed_page_count');
  assert.equal(f.asked.length + g.asked.length, 0);
});

test('a next results page that lands on another host is reported, not offered as listings', async (t) => {
  const f = fixture(t),
    next = {text: '2', url: url + '?page=2'},
    results = page({
      links: [{url: url + '/1', text: 'Two rooms'}],
      pagination: [{text: '1', url, current: true}, next],
    });
  f.ports.browser = async (name, args) => {
    f.calls.push({name, args});
    return args.url === next.url
      ? {
          url: 'https://accounts.example.org/login',
          title: 'Sign in',
          text: 'Sign in to see more results',
          links: [{url: 'https://accounts.example.org/terms', text: 'Terms'}],
        }
      : results;
  };
  const first = await f.run({operation: 'scan_results', url});
  const moved = await f.run({
    taskId: first.taskId,
    reviewedBatchId: first.linkSelection.id,
    selected: [1],
  });
  assert.ok(f.calls.some((c) => c.name === 'open' && c.args.url === next.url));
  assert.equal(moved.issue.reason, 'page_changed');
  assert.equal(moved.issue.url, 'https://accounts.example.org/login');
  assert.equal(moved.linkSelection, undefined);
  assert.equal(f.checkpoints[0].urls[0], url + '/1');
  assert.match(moved.next, /NEW scan_results at issue.expected/);
});

test('invalid or stale link choices are refused without changing the pending selection', async (t) => {
  const f = fixture(t);
  const first = await f.run({operation: 'scan_results', url}),
    id = first.linkSelection.id,
    resume = (extra) => f.run({taskId: first.taskId, reviewedBatchId: id, ...extra});
  await assert.rejects(resume({selected: [5]}), /within 1–4/);
  await assert.rejects(
    resume({selected: [1], review: [{item: 1, decision: 'reject', reason: 'x'}]}),
    /already chosen/,
  );
  await assert.rejects(
    resume({review: [{item: 2, decision: 'defer', reason: 'later'}]}),
    /decision "reject"/,
  );
  await assert.rejects(
    f.run({taskId: first.taskId, reviewedBatchId: 'stale', selected: [1]}),
    /stale or misspelled/,
  );
  await assert.rejects(f.run({taskId: first.taskId, selected: [1]}), /reviewedBatchId/);
  await assert.rejects(f.run({taskId: first.taskId, next: 'end'}), /pending pagination choice/);
  const still = await f.run({taskId: first.taskId});
  assert.equal(still.linkSelection.id, id);
});

test('read listings wait in review batches for the agent; nothing is judged or pre-rejected', async (t) => {
  const f = fixture(t);
  f.ports.reviewFinalBatch = true;
  f.ports.resolveDetails = () => [{url: url + '/1'}, {url: url + '/4'}];
  const result = await f.run({operation: 'collect_details'});
  assert.equal(result.status, 'needs_agent');
  assert.equal(result.issue.reason, 'batch_ready');
  assert.deepEqual(
    result.items.map((i) => i.assessment),
    [
      {decision: 'uncertain', confidence: 0, reason: 'agent_review'},
      {decision: 'uncertain', confidence: 0, reason: 'agent_review'},
    ],
  );
  assert.match(result.next, /No listing is judged before you/);
  assert.equal(f.asked.length, 0);
});

test('a trial detail read has no batch and its save tool offers no score', async (t) => {
  const f = fixture(t);
  f.ports.resolveDetails = () => [{url: url + '/1'}];
  const result = await f.run({operation: 'collect_details'});
  assert.equal(result.status, 'completed');
  assert.match(result.next, /read, not judged/);
  assert.doesNotMatch(result.next, /already classified/);
  const run = {kind: 'trial', sourceUrl: url, operation: 'trial'},
    template = {fields: [], records: {}, recordOperations: {score: {}}};
  const save = scopedAutomationTools({run, template, collecting: false, agentDecides: true}).find(
    (tool) => tool.name === 'record_automation_result',
  );
  assert.equal(save.inputSchema.properties.assessment, undefined);
  assert.equal(save.inputSchema.properties.score, undefined);
  assert.match(save.description, /saves no score/);
});

test('form operations are left to the agent and a task keeps its decision setting', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.run({operation: 'prepare_search', url, answers: [{key: 'q', label: 'What', value: 'x'}]}),
    /does not fill search forms/,
  );
  await assert.rejects(
    f.run({operation: 'fill_form', url, answers: [{key: 'n', label: 'Name', value: 'Ada'}]}),
    /does not match answers to form fields/,
  );
  assert.equal(f.db.jevTasks.list(f.a.id, 'assigned').length, 0);
  const task = f.db.jevTasks.create(f.a.id, 'assigned', {operation: 'scan_results', url});
  task.decisions = 'jev';
  f.db.jevTasks.save(task);
  await assert.rejects(f.run({taskId: task.id}), /decision setting changed/);

  const jev = fixture(t, {decisions: 'jev'});
  const scan = jev.db.jevTasks.create(jev.a.id, 'assigned', {operation: 'scan_results', url});
  await assert.rejects(jev.run({taskId: scan.id, next: 'end'}), /paused for agent decisions/);
});

test('a brief without a model returns the original listing text in pages', async (t) => {
  const f = fixture(t),
    task = f.db.jevTasks.create(f.a.id, 'assigned', {operation: 'collect_details'}),
    text = 'Requirement: German C1. Rent 1500 EUR. '.repeat(400),
    evidence = f.db.jevTasks.evidence(task, {url: url + '/1', title: 'One', text});
  const brief = await buildJevBrief({
    store: f.db.jevTasks,
    owner: f.a.id,
    taskId: 'assigned',
    evidenceId: evidence.id,
    criteria: f.a.criteria,
    evaluate: null,
  });
  assert.equal(brief.status, 'ready');
  assert.equal(brief.coverage.selectedCharacters, text.length);
  assert.ok(brief.nextOffset > 0);
  assert.equal(
    brief.sections.map((s) => s.text).join(''),
    text.slice(0, brief.sections.at(-1).endOffset),
  );
});

test('the decision setting defaults to the agent, is validated, and selects the agent instructions', (t) => {
  assert.equal(withAgentDefaults({provider: 'claude'}).decisions, 'agent');
  const core = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(core);
  t.after(() => core.close());
  const a = db.create('housing', {goal: 'Berlin homes', criteria: {}, sources: [url]});
  assert.throws(
    () => db.save(a.id, {agentSettings: {provider: 'codex', decisions: 'model'}}),
    /Invalid decision setting/,
  );
  db.save(a.id, {agentSettings: {provider: 'codex', decisions: 'agent'}});
  assert.equal(db.get(a.id).agentSettings.decisions, 'agent');

  const jev = webAgentProfile('run', {provider: 'codex', decisions: 'jev'}).instructions,
    agent = webAgentProfile('run', {provider: 'codex', decisions: 'agent'}).instructions;
  assert.match(jev, /## Jev managed browser/);
  assert.match(agent, /## Managed browser \(agent decisions\)/);
  assert.match(agent, /links_ready/);
  assert.doesNotMatch(agent, /prepare_search/);
});

test('agent decisions narrow the tools and prompts to what the agent decides itself', () => {
  const run = {kind: 'trial', sourceUrl: url, operation: 'trial'},
    template = {fields: [], records: {}};
  const names = (tools) => tools.map((t) => t.name);
  const jev = scopedAutomationTools({run, template, collecting: false}),
    agent = scopedAutomationTools({run, template, collecting: false, agentDecides: true});
  assert.ok(names(jev).includes('save_jev_profile'));
  assert.ok(!names(agent).includes('save_jev_profile'));
  const tool = agent.find((t) => t.name === 'browser_run_task');
  assert.deepEqual(tool.inputSchema.properties.operation.enum, [
    'scan_results',
    'classify_results',
    'collect_details',
  ]);
  assert.ok(tool.inputSchema.properties.selected && tool.inputSchema.properties.next);
  assert.ok(!tool.inputSchema.properties.answers);
  assert.match(
    agent.find((t) => t.name === 'read_listing_brief').description,
    /original listing text/,
  );

  const prompt = automationPrompt(run, null, {agentDecides: true});
  assert.match(prompt, /you make the listing decisions/);
  assert.match(prompt, /enter its answers yourself with browser_interact/);
  assert.doesNotMatch(prompt, /prepare_search|save_jev_profile/);
  assert.match(automationPrompt(run), /prepare_search/);
  // A trial has no scan queue to complete.
  assert.doesNotMatch(prompt, /complete_scan_search/);
  assert.doesNotMatch(automationPrompt(run), /complete_scan_search/);
});

test('readiness needs no TypeSafe key when the agent makes the listing decisions', async () => {
  const options = {
    findExecutable: async () => '/bin/codex',
    inspectLogin: async () => ({id: 'login', label: 'Agent session', state: 'ready', detail: ''}),
    findChrome: async () => '/chrome',
    listChromeProfiles: async () => [{directory: 'Default'}],
    chromePortAvailable: async () => true,
    existingChromeEndpoint: async () => 'ws://127.0.0.1:9222/devtools/browser/x',
    jevStatus: async () => {
      throw Error('the key is not read');
    },
  };
  const agent = await collectReadiness({provider: 'codex', decisions: 'agent'}, options);
  const check = agent.checks.find((c) => c.id === 'jev');
  assert.equal(check.state, 'ready');
  assert.match(check.detail, /no TypeSafe key is needed/);
  const jev = await collectReadiness(
    {provider: 'codex', decisions: 'jev'},
    {...options, jevStatus: async () => ({})},
  );
  assert.equal(jev.checks.find((c) => c.id === 'jev').state, 'error');
  await assert.rejects(collectReadiness({provider: 'codex', decisions: 'x'}, options), /Invalid/);
});

const source = 'https://board.test/jobs',
  template = 'https://board.test/jobs/search?q={query}&l={location}&sort=date',
  expected = 'https://board.test/jobs/search?q=Find+homes&l=Berlin&sort=date',
  settle = () => new Promise((resolve) => setImmediate(resolve));
test('a recipe is verified from the listings the agent selected; no automatic check runs', async (t) => {
  const store = new WorkspaceDatabase(':memory:'),
    db = new AutomationStore(store);
  const a = db.create('housing', {
    goal: 'Find homes',
    criteria: {location: 'Berlin', budget: '2000', requirements: '2 rooms'},
    sources: [source],
  });
  db.save(a.id, {agentSettings: {provider: 'codex', decisions: 'agent'}});
  db.review(a.id);
  const launches = [],
    runtime = new WebTasks(db, {
      launch: async (run) => {
        launches.push(run);
        return {close: async () => {}};
      },
    });
  t.after(async () => {
    await runtime.close();
    store.close();
  });
  db.enable(a.id);
  await runtime.tick();
  await settle();
  const trial = launches[0],
    opened = [];
  const browser = {
    hasPage: () => opened.length > 0,
    evaluateJev: async () => {
      throw Error('No model may be asked with agent decisions.');
    },
    async call(_id, name, args) {
      const target = args.url ?? opened.at(-1);
      if (name === 'browser_navigate') opened.push(target);
      const value =
        target === expected
          ? {
              url: target,
              title: 'Results',
              text: 'Jobs for you',
              links: [
                {url: source + '/view/a', text: 'Job A'},
                {url: source + '/view/b', text: 'Job B'},
              ],
              pagination: [],
            }
          : {url: target, title: 'Board', text: 'Nothing here', links: [], pagination: []};
      return {
        jevPage: value,
        pageContext: {url: target, tabId: 'owned'},
        content: [{type: 'text', text: 'Page URL: ' + target + '\n' + JSON.stringify(value)}],
      };
    },
  };
  const flow = automationWorkflow({
    db,
    run: trial,
    signal: new AbortController().signal,
    browser,
    report: (...args) => runtime.report(...args),
  });
  assert.ok(!flow.tools.some((tool) => tool.name === 'save_jev_profile'));
  const recipe = {entry: {kind: 'url_template', template}, terms: ['Find homes']};
  await assert.rejects(
    flow.call(a.id, trial.id, 'save_source_recipe', recipe),
    /Recipe not checked yet: run browser_run_task scan_results at .*no check was used/,
  );
  await assert.rejects(
    flow.call(a.id, trial.id, 'save_source_recipe', {
      entry: {kind: 'search_form', url: source, fields: [{key: 'query', label: 'What'}]},
    }),
    /cannot replay a search form/,
  );
  assert.equal(opened.length, 0, 'no page is opened for a check');
  assert.equal(db.run(trial.id).recipeChecks ?? 0, 0);

  const scan = await flow.call(a.id, trial.id, 'browser_run_task', {
    operation: 'scan_results',
    url: expected,
  });
  assert.equal(scan.issue.reason, 'links_ready');
  await flow.call(a.id, trial.id, 'browser_run_task', {
    taskId: scan.taskId,
    reviewedBatchId: scan.linkSelection.id,
    selected: [1],
  });
  const saved = await flow.call(a.id, trial.id, 'save_source_recipe', recipe);
  assert.equal(saved.status, 'verified');
  assert.equal(saved.reused, true);
  assert.equal(saved.listings, 1);
});

test('a continued collector conversation is told its earlier background read is over', () => {
  const run = {
    kind: 'run',
    collector: 'cli',
    sourceUrl: 'https://jobs.example/list',
    recordId: null,
  };
  assert.doesNotMatch(automationPrompt(run), /earlier turn is over/);
  const resumed = automationPrompt({...run, continuation: {reason: 'task_retry', runId: 'r1'}});
  assert.match(resumed, /background_read status from an earlier turn is over/);
  assert.match(resumed, /Start this turn by calling collect_source_page/);
});
