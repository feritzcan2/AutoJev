// Development tools UI: the agent trace dialog lists a run's instructions,
// tool calls and Jev requests and opens on the saved score; the record's
// developer section queues a trial score and compares it with the saved one;
// the extension bench shows a listing's Jev triage.
//   node scripts/smoke-dev-tools.mjs [screenshot-prefix]
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const require = createRequire(import.meta.url),
  {_electron: electron} = createRequire(require.resolve('@playwright/mcp/package.json'))(
    'playwright',
  );
const data = await mkdtemp(path.join(os.tmpdir(), 'dev-tools-')),
  env = {...process.env, JOBLOOP_DATA_DIR: data, JOBLOOP_DIAGNOSTICS: 'off'},
  shots = process.argv[2] ?? null;
delete env.ELECTRON_RUN_AS_NODE;
const entry = path.join(data, 'entry.js'),
  bundle = path.join(data, 'dev-tools.mjs');
await writeFile(
  entry,
  `export {openAgentTrace} from ${JSON.stringify(path.resolve('src/agent-trace.js'))};
export {recordDevPanel} from ${JSON.stringify(path.resolve('src/record-dev-panel.js'))};
export {extensionBenchPanel} from ${JSON.stringify(path.resolve('src/extension-bench.js'))};`,
);
await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  outfile: bundle,
  loader: {'.css': 'empty'},
});
const app = await electron.launch({
  executablePath: require('electron'),
  args: [process.cwd()],
  env,
});
try {
  const page = await app.firstWindow();
  await page.setViewportSize({width: 1280, height: 1000});
  await page.evaluate(async (url) => {
    const {openAgentTrace, recordDevPanel, extensionBenchPanel} = await import(url);
    const block = (value) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      return {text, characters: text.length, truncated: false};
    };
    const events = [
      {
        seq: 1,
        at: Date.now() - 9000,
        type: 'prompt',
        kind: 'launch',
        title: 'Session start message',
        parts: [{key: 'launch-prompt', title: 'Start message', ...block('Score the record.')}],
      },
      {
        seq: 2,
        at: Date.now() - 8000,
        type: 'tool',
        name: 'read_listing_brief',
        ms: 840,
        error: false,
        args: block({evidenceId: 'e1'}),
        output: block({sections: [{category: 'requirements', text: '5+ years Go'}]}),
      },
      {
        seq: 3,
        at: Date.now() - 7000,
        type: 'jev',
        ms: 410,
        error: null,
        usage: {input_tokens: 900, output_tokens: 12},
        questions: ['fit'],
        state: block({listing: {text: 'Backend role'}}),
        instructions: block({fit: {type: 'choice'}}),
        answers: block({fit: {choice: 'possible', confidence: 0.91}}),
      },
      {
        seq: 4,
        at: Date.now() - 6000,
        type: 'tool',
        name: 'record_automation_score',
        ms: 12,
        error: false,
        args: block({itemId: 'r1', score: 64, summary: 'Go matches; seniority unclear.'}),
        output: block({itemId: 'r1', saved: true, score: 64}),
      },
    ];
    const run = {
      runId: 'run-1',
      startedAt: Date.now() - 9000,
      lastAt: Date.now() - 6000,
      counts: {prompt: 1, tool: 2, jev: 1, error: 0},
      dropped: 0,
      events,
      run: {
        id: 'run-1',
        kind: 'run',
        recordOperation: 'score',
        dryRun: true,
        status: 'completed',
        summary: 'Scored',
      },
    };
    let trials = [];
    window.calls = [];
    const api = {
      agentTraceRuns: async () => [{...run, events: events.length}],
      agentTraceRun: async (id, runId) => (runId === 'run-1' ? run : null),
      onAgentTraceChange: () => () => {},
      devTrialScore: async (id, itemId) => {
        window.calls.push(['trial', id, itemId]);
        trials = [
          {
            taskId: 't1',
            runId: 'run-1',
            at: Date.now(),
            assessment: {
              score: 64,
              eligibility: 'verified',
              summary: 'Go matches; seniority unclear.',
              strengths: ['Go'],
              gaps: [],
              uncertainties: ['Seniority'],
            },
          },
        ];
        return {id: 't1', state: 'pending'};
      },
      devTrialScores: async () => ({scores: trials, queued: []}),
      extensionBenchStatus: async () => ({available: true}),
      extensionBenchRead: async () => {
        throw Error('not used');
      },
      extensionBenchListing: async (id, address) => listing(address),
      extensionBenchJev: async (id, address) => ({
        ...listing(address),
        jev: {
          criteria: {goal: 'Find backend roles'},
          card: {
            rule: 'extension_card',
            text: 'Backend Engineer',
            answer: {
              choice: 'keep',
              confidence: 0.8,
              probabilities: {keep: 0.8, unrelated_role: 0.2},
            },
            keep: 0.8,
            reason: 'unrelated_role',
            confidence: 0.2,
            eliminated: false,
          },
          detail: {
            characters: 120,
            decision: 'possible',
            proof: null,
            fragments: [
              {
                offset: 0,
                end: 120,
                answer: {choice: 'possible', confidence: 0.92},
                decision: 'possible',
              },
            ],
          },
          notes: [],
          why: {
            basis: 'detail',
            reason: 'hard_constraint',
            offered: {rules: 12, passages: 20},
            rule: {
              top: [
                {
                  key: 'r3',
                  probability: 0.81,
                  source: 'criteria.location',
                  text: 'Only roles in Germany or remote EU.',
                },
                {key: 'none', probability: 0.1, text: null},
              ],
            },
            passage: {
              top: [{key: 'p2', probability: 0.77, text: 'This role is on-site in Chicago, IL.'}],
            },
          },
          asked: [
            {
              step: 'card',
              ms: 300,
              usage: {input_tokens: 800, output_tokens: 10},
              state: {},
              questions: {},
              answers: {},
            },
          ],
          thresholds: {confidence: 0.85, keepFloor: 0.3},
        },
      }),
      openLink: async () => {},
    };
    const listing = (address) => ({
      url: address,
      at: Date.now(),
      version: 0,
      extension: {id: 'bench', kind: 'http'},
      transport: 'http',
      notes: [],
      applied: true,
      title: 'Backend Engineer',
      readiness: null,
      listings: [],
      otherLinks: 0,
      otherLinkSample: [],
      pagination: [],
      listing: {fields: {company: 'Acme'}, description: {text: 'Build Go services.', length: 18}},
      text: {text: 'Backend Engineer', length: 16},
    });
    window.devApi = api;
    window.openAgentTrace = openAgentTrace;
    const main = document.createElement('main');
    main.style.cssText = 'grid-column:1/-1;display:grid;gap:24px;padding:24px';
    document.body.replaceChildren(main);
    const panel = recordDevPanel(api, {workspace: () => 'w', recordId: 'r1'});
    panel.update({id: 'r1', assessment: {score: 72, runId: 'run-1'}});
    main.append(panel.element);
    const bench = extensionBenchPanel(api, {scope: () => 'w'});
    main.append(bench.element);
    window.bench = bench;
  }, pathToFileURL(bundle).href);

  // Trial score: queued, then listed against the saved 72.
  await page.getByRole('button', {name: 'Trial score'}).click();
  await page.getByText('-8 vs saved 72').waitFor();
  assert.deepEqual(await page.evaluate(() => window.calls), [['trial', 'w', 'r1']]);

  // The score's trace opens on the call that saved it.
  await page.getByRole('button', {name: 'Trace of this score'}).click();
  const dialog = page.locator('dialog.agent-trace');
  await dialog.getByText('Agent trace · run · score (trial score) · completed').waitFor();
  await dialog.getByText('Output the agent received', {exact: false}).first().waitFor();
  assert.ok(
    await dialog
      .locator('li[data-type="tool"] details[open]')
      .getByText('record_automation_score')
      .isVisible(),
  );
  await dialog.getByRole('button', {name: 'Jev', exact: true}).click();
  assert.equal(await dialog.locator('.agent-trace-event').count(), 1);
  await dialog.getByText('912 tokens', {exact: false}).waitFor();
  await dialog.getByRole('button', {name: 'All', exact: true}).click();
  if (shots) await page.screenshot({path: shots + '-trace.png'});
  await dialog.getByRole('button', {name: 'Close'}).click();

  // Bench: a listing's Jev triage.
  await page.locator('.extension-bench input[type=url]').fill('https://jobs.bench.test/job/1');
  await page.getByRole('button', {name: 'Read as listing'}).click();
  await page.getByRole('button', {name: 'Jev triage'}).click();
  await page.getByText('Card: kept').waitFor();
  await page.getByText('Detail: Kept for the agent to assess').waitFor();
  // Hovering a chip explains the answer, the rule and its outcome.
  const tips = await page.$$eval('.extension-bench-jev-result .extension-bench-chip', (chips) =>
    chips.map((c) => c.dataset.tip),
  );
  assert.match(tips[0], /CARD STAGE/);
  assert.match(tips[0], /Probabilities: keep 80%, unrelated_role 20%/);
  assert.match(tips[0], /exclusion likelihood is 20%/);
  assert.match(tips[0], /→ KEPT/);
  assert.match(tips[1], /Text 0–120: possible 92%/);
  assert.match(tips[1], /→ KEPT as potentially relevant/);
  assert.match(
    tips[1],
    /Rule or fact contradicted: 81% · criteria.location: Only roles in Germany/,
  );
  await page
    .getByText('Why: hard_constraint · bench-only question (detail), not asked in scans')
    .waitFor();
  await page.getByText('77% · This role is on-site in Chicago, IL.').waitFor();
  // The explanation box opens on hover, stays open after a click and closes on Escape.
  const card = page.locator('.extension-bench-jev-result .extension-bench-chip').first(),
    box = page.locator('.extension-bench-tip');
  await card.hover();
  await box.getByText('CARD STAGE', {exact: false}).waitFor();
  console.log(
    'top',
    await page.evaluate(() => {
      const n = document.elementFromPoint(300, 700);
      return (
        n.className +
        ' / ' +
        n.tagName +
        ' / ' +
        getComputedStyle(n.closest('.extension-bench-tip') ?? n).opacity
      );
    }),
  );
  console.log(
    JSON.stringify(
      await box.evaluate((b) => ({
        rect: b.getBoundingClientRect(),
        hidden: b.hidden,
        display: getComputedStyle(b).display,
        pos: getComputedStyle(b).position,
        z: getComputedStyle(b).zIndex,
        parent: b.parentElement.tagName,
        h: innerHeight,
      })),
    ),
  );
  console.log(
    'style',
    JSON.stringify(
      await box.evaluate((b) => {
        const c = getComputedStyle(b),
          d = getComputedStyle(document.body),
          h = getComputedStyle(document.documentElement);
        return {
          vis: c.visibility,
          color: c.color,
          bg: c.backgroundColor,
          cv: c.contentVisibility,
          clip: c.clipPath,
          tr: c.transform,
          text: b.textContent.slice(0, 40),
          bodyContain: d.contain,
          bodyTr: d.transform,
          bodyOverflow: d.overflow,
          bodyFilter: d.filter,
          htmlContain: h.contain,
          bodyH: document.body.getBoundingClientRect().height,
          bodyPos: d.position,
        };
      }),
    ),
  );
  if (shots) await page.screenshot({path: shots + '-tip.png'});
  await card.click();
  await page.mouse.move(5, 5);
  assert.equal(await box.isVisible(), true);
  await page.keyboard.press('Escape');
  await box.waitFor({state: 'hidden'});
  console.log(tips.join('\n\n'));
  if (shots) await page.screenshot({path: shots + '-panels.png', fullPage: true});
  console.log('Development tools UI works.');
} finally {
  await app.close();
}
