// Design preview: launches the app against a seeded, throwaway data folder and
// saves screenshots of each page. No agent starts; provider calls are stubbed.
// Usage: node scripts/design-preview.mjs [outDir] [--fresh]
import {createRequire} from 'node:module';
import {mkdtemp, mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
const require = createRequire(import.meta.url),
  {_electron: electron} = createRequire(require.resolve('@playwright/mcp/package.json'))(
    'playwright',
  );
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  args = process.argv.slice(2),
  fresh = args.includes('--fresh'),
  out = path.resolve(args.find((a) => !a.startsWith('--')) ?? 'design-shots'),
  data = await mkdtemp(path.join(os.tmpdir(), 'jobloop-design-'));
await mkdir(out, {recursive: true});

if (!fresh) {
  const store = new WorkspaceDatabase(path.join(data, 'jobloop.sqlite')),
    db = new AutomationStore(store),
    a = db.create('job-search', {
      title: 'Sara Kaya',
      goal: 'Senior backend and platform roles in Berlin or remote in the EU',
      criteria: {
        preferences: 'Senior Backend Engineer, Platform Engineer · Berlin or remote (EU)',
        country: 'DE',
        location: 'Berlin, Germany',
        experience: '7 years · Go, Python, Postgres, Kubernetes · English C2, German B1',
        constraints: 'Minimum €80k',
        application_facts: 'Notice period: 1 month',
      },
    });
  const source = db.get(a.id).sources[0],
    now = Date.now(),
    jobs = [
      ['Staff Platform Engineer', 'Larkspur', 'Berlin or remote (EU)', 94, 'found'],
      ['Senior Backend Engineer, Payments', 'Quayside Pay', 'Remote (CET ±2)', 88, 'found'],
      ['Infrastructure Engineer', 'Tidewater', 'Munich · hybrid', 84, 'prepared'],
      ['Backend Engineer (Python)', 'Fernhill Health', 'Hamburg · hybrid', 76, 'found'],
      ['Go Developer', 'Brightmoor', 'Remote (DE)', 71, 'completed'],
      ['Site Reliability Engineer', 'Kestrel Labs', 'Berlin', 68, 'completed'],
      ['Frontend Engineer', 'Mosaic', 'Berlin', 41, 'dismissed'],
    ];
  jobs.forEach(([title, company, location, score, status], i) => {
    db.putResult({
      automationId: a.id,
      key: 'job-' + i,
      url: 'https://jobs.example.com/' + i,
      sourceUrl: source,
      title,
      status,
      cells: {company, location, score: String(score)},
      assessment: {
        status: 'scored',
        score,
        eligibility: score > 60 ? 'verified' : 'mismatch',
        summary: `Strong match on backend depth; ${location.includes('hybrid') ? 'hybrid, you asked for remote' : 'location fits'}.`,
        strengths: ['Go and Kubernetes experience match', 'Seniority fits'],
        gaps: score < 80 ? ['German B2 preferred'] : [],
        scoredAt: now - i * 3600_000,
      },
      createdAt: now - i * 3600_000,
      updatedAt: now - i * 3600_000,
    });
  });
  if (args.includes('--review'))
    db.putRun({
      id: 'interview-1',
      automationId: a.id,
      kind: 'interview',
      workerId: 'conversation',
      status: 'completed',
      summary: 'Profile filled from the CV',
      startedAt: now - 120_000,
      finishedAt: now - 60_000,
    });
  db.askQuestion(a.id, {text: 'What is your notice period?'});
  db.askQuestion(a.id, {text: 'Do you need visa sponsorship to work in Germany?'});
  store.close();
}

const application = await electron.launch({
  executablePath: process.env.JOBLOOP_ELECTRON_BINARY || require('electron'),
  args: [root],
  env: {...process.env, JOBLOOP_DATA_DIR: data},
});
const shots = [];
try {
  const page = await application.firstWindow({timeout: 30000});
  page.on('pageerror', (e) => console.error('UI_ERROR', e.message));
  await application.evaluate(
    async (_, url) => {
      const vm = process.getBuiltinModule('node:vm'),
        load = vm.runInThisContext('(url)=>import(url)', {
          importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
        }),
        {Engine} = await load(url),
        request = Engine.prototype.request;
      Engine.prototype.request = function (op, args = {}) {
        if (['start', 'resize', 'message', 'stop'].includes(op)) return Promise.resolve({});
        return request.call(this, op, args);
      };
    },
    pathToFileURL(path.join(root, 'app/agents/engine.mjs')).href,
  );
  await page.setViewportSize({width: 1440, height: 900});
  await page.waitForTimeout(2500);
  const shot = async (name) => {
    const file = path.join(out, name + '.png');
    await page.screenshot({path: file, fullPage: false});
    shots.push(file);
  };
  if (args.includes('--dump')) {
    const snap = await page.evaluate(async () => {
      const list = await window.jobloop.workspaces();
      return window.jobloop.workspaceSnapshot(list[0].id);
    });
    (await import('node:fs')).writeFileSync(path.join(out, 'snapshot.json'), JSON.stringify(snap, null, 1));
  }
  if (args.includes('--review')) {
    await page.evaluate(async () => {
      const list = await window.jobloop.workspaces();
      localStorage.setItem('onboarding:' + list[0].id, 'cv');
    });
    await page.reload();
    await page.waitForTimeout(2500);
  }
  await shot('00-start');
  if (fresh || args.includes('--review')) {
    await page.setViewportSize({width: 1440, height: 1400});
    await shot('00-start-tall');
  } else if (await page.evaluate(() => document.body.classList.contains('jl-simple'))) {
    const navs = await page.$$eval('.jl-nav', (b) => b.map((n) => n.textContent.trim()));
    for (const [i, label] of navs.entries()) {
      await page.locator('.jl-nav').nth(i).click();
      await page.waitForTimeout(500);
      await shot(String(i + 1).padStart(2, '0') + '-' + label.replace(/[^a-z]+/gi, '-').toLowerCase());
      if (i === 0)
        for (const tab of ['In progress', 'Applied', 'Skipped']) {
          await page.locator('.jl-tab', {hasText: tab}).click();
          await page.waitForTimeout(300);
          await shot('01-jobs-' + tab.replace(/\s+/g, '-').toLowerCase());
        }
    }
    await page.locator('.jl-nav').first().click();
    await page.locator('.jl-tab').first().click();
    await page.locator('.jl-job-title').first().click();
    await page.locator('.jl-check').nth(0).check();
    await page.locator('.jl-check').nth(1).check();
    await page.waitForTimeout(300);
    await shot('10-jobs-selected');
  } else {
    const views = await page.$$eval('aside nav button[data-view]', (b) =>
      b.filter((n) => !n.hidden && n.offsetParent).map((n) => n.dataset.view),
    );
    for (const [i, view] of views.entries()) {
      await page.click(`aside nav button[data-view="${view}"]`);
      await page.waitForTimeout(700);
      await shot(String(i + 1).padStart(2, '0') + '-' + view);
    }
  }
} finally {
  await application.close();
}
console.log(shots.join('\n'));
