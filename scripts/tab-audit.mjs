// Tab leak audit of the running development app (macOS).
//   node scripts/tab-audit.mjs            summary + every tab that is not plainly kept
//   node scripts/tab-audit.mjs --all      every tab
//   node scripts/tab-audit.mjs --json     raw result
// Reads the app's tab list with its close-rule verdicts (dev control
// browser-tab-audit), Chrome's own windows and tabs (AppleScript), and the
// tab lifecycle log for the tabs worth a look. Changes nothing.
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const flags = new Set(process.argv.slice(2));
const directory =
  process.env.JOBLOOP_DATA_DIR ?? path.join(os.homedir(), 'Library/Application Support/JobLoop');
const {endpoint, token} = JSON.parse(
  await readFile(path.join(directory, 'dev-control.json'), 'utf8'),
);
const response = await fetch(endpoint + '/invoke', {
  method: 'POST',
  headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
  body: JSON.stringify({name: 'browser-tab-audit', args: []}),
});
const body = await response.json();
if (!response.ok) {
  console.error(body.error ?? body);
  console.error('The running app predates browser-tab-audit; it needs a restart.');
  process.exit(1);
}
const {log, workspaces} = body.result;

// Chrome's view: every window and tab of every profile.
let chrome = [];
try {
  const out = execFileSync(
    'osascript',
    [
      '-e',
      `tell application "Google Chrome"
set out to ""
repeat with w in windows
repeat with t in tabs of w
set out to out & (id of w) & (character id 9) & (URL of t) & linefeed
end repeat
end repeat
return out
end tell`,
    ],
    {encoding: 'utf8'},
  );
  chrome = out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [windowId, ...url] = line.split('\t');
      return {windowId, url: url.join('\t')};
    });
} catch (error) {
  console.warn('Could not read Chrome tabs:', error.message.split('\n')[0]);
}

const home = /^http:\/\/127\.0\.0\.1:\d+\/jev\/[\w-]+\/home$/;
const tracked = workspaces.flatMap((w) => w.tabs.map((t) => ({...t, workspaceId: w.workspaceId})));
const trackedUrls = new Map();
for (const t of tracked) trackedUrls.set(t.url, (trackedUrls.get(t.url) ?? 0) + 1);
// Windows holding an AutoJob home page are AutoJob windows; a tab there that
// no workspace tracks is an orphan (an earlier app or Chrome run, a lost popup).
const jevWindows = new Set(chrome.filter((t) => home.test(t.url)).map((t) => t.windowId));
const liveHomes = new Set(tracked.filter((t) => t.role === 'home').map((t) => t.url));
const orphans = [];
for (const t of chrome) {
  if (!jevWindows.has(t.windowId)) continue;
  const left = trackedUrls.get(t.url) ?? 0;
  if (left > 0) trackedUrls.set(t.url, left - 1);
  else orphans.push({...t, reason: home.test(t.url) ? 'old_home_page' : 'untracked'});
}

const entries = await (log ? readFile(log, 'utf8') : Promise.resolve(''))
  .then((text) =>
    text
      .trim()
      .split('\n')
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      }),
  )
  .catch(() => []);

if (flags.has('--json')) {
  console.log(JSON.stringify({workspaces, chrome, orphans, log}, null, 2));
  process.exit(0);
}

const count = (list, key) =>
  Object.entries(Object.groupBy(list, (x) => x[key] ?? '-'))
    .map(([k, v]) => `${k}=${v.length}`)
    .join(' ');
console.log(
  `Chrome: ${chrome.length} tabs in ${new Set(chrome.map((t) => t.windowId)).size} windows (${jevWindows.size} AutoJob windows)`,
);
console.log(`App: ${tracked.length} tracked tabs — ${count(tracked, 'verdict')}`);
for (const w of workspaces)
  console.log(
    `  ${w.workspaceId} ${w.connected ? `window ${w.windowId}` : 'not connected'}: ${w.tabs.length} tabs — ${count(w.tabs, 'reason')}`,
  );
console.log(`Orphans in AutoJob windows: ${orphans.length}`);
for (const o of orphans) console.log(`  [${o.reason}] window ${o.windowId} ${o.url.slice(0, 140)}`);

const shown = flags.has('--all') ? tracked : tracked.filter((t) => t.verdict !== 'keep');
for (const t of shown) {
  console.log(
    `\n[${t.verdict}] ${t.reason}  tab ${t.tabId}  ws ${t.workspaceId.slice(0, 8)}  ${t.role}`,
  );
  console.log(`  ${t.url.slice(0, 160)}`);
  if (t.runId)
    console.log(
      `  run ${t.runId} ${t.runKind ?? ''} ${t.runStatus ?? ''} finished ${t.runFinishedAt ?? '-'}${t.recordId ? ` record ${t.recordId}` : ''}`,
    );
  for (const e of entries.filter((e) => e.tab === t.tabId).slice(-8))
    console.log(`    ${e.at} ${e.event} ${e.reason ?? ''} ${e.run ?? ''} ${e.url ?? ''}`);
  const ends = entries.filter((e) => e.event === 'run_end' && e.run === t.runId);
  for (const e of ends)
    console.log(
      `    ${e.at} run_end status=${e.status} record=${e.record ?? '-'} closeTabs=${e.closeTabs}${e.pendingQuestion ? ' pendingQuestion' : ''}`,
    );
  for (const e of entries.filter(
    (e) => e.event === 'finish' && e.runs?.includes(t.runId) && t.tabId in (e.retained ?? {}),
  ))
    console.log(`    ${e.at} finish retained: ${e.retained[t.tabId]}`);
}
console.log(`\nLog: ${log} (${entries.length} entries)`);
