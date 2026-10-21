---
name: sekme-leak
description: Audit the Chrome tabs and windows the running jobloop app opened, find the ones that should already be closed (tab leaks), trace why from the tab lifecycle log, and fix the close rule. Use when the user asks about open/leaked Chrome tabs or windows ("sekme-leak", "açık sekmelere bak", "kapanması gereken sekme var mı", "Chrome'da çok pencere kaldı", "tab leak", "check open tabs").
---

# Tab leak audit

Goal: in the long run no Jev tab or window stays open after its work ended. The
app closes tabs when a run finishes (`afterFinish` in `app/automation/web-template.mjs`
→ `BrowserTools.finishAutomationRun` → `JevBrowser.closeFinishedAutomationRunTabs`),
when the user skips, marks applied or deletes a record (`closeRecordTabs`, `closeAll`,
matched by run and by `record:<id>` label; `closeEndedRecordTabs` in `services.mjs`
repeats this on every Chrome connection and every 5 minutes, so a close missed while
Chrome was away still happens, and also closes stopped applications after 3 h — see
`closableRecordIds` in `app/browser/tab-audit.mjs`), for
Chrome error tabs, when a workspace is deleted (`resetCandidate(id, {closeTabs: true})`),
and on quit (`browser.close({closeTabs: true})`; a killed app closes nothing, its tabs are
restored on the next connection of that workspace). Finished tabs
become blank spares (at most 2 per workspace) instead of closing, so a minimized
window stays minimized.

## 1. Run the audit

```sh
node scripts/tab-audit.mjs          # summary + tabs that are not plainly kept
node scripts/tab-audit.mjs --all    # every tab
node scripts/tab-audit.mjs --json   # raw data
```

It reads three things and changes nothing:

- the app's tabs with close-rule verdicts — dev control handler `browser-tab-audit`
  (unpackaged app only; an "Unknown handler" error means the running app predates it
  and needs a restart — ask the user, never restart it yourself)
- Chrome's own windows and tabs over AppleScript (all profiles, matched by URL)
- the tab lifecycle log `<data>/logs/tabs.jsonl` (+ `tabs.1.jsonl` after 4 MB);
  data dir is `directory` in `~/Library/Application Support/JobLoop/data-location.json`
  (on this Mac `~/Desktop/Loop Verileri`)

## 2. Read the verdicts (`app/browser/tab-audit.mjs`)

| verdict | meaning | reasons |
| --- | --- | --- |
| `keep` | still has work | `home`, `spare`, `run_running`, `question`, `verification`, `record_prepared/executing/uncertain`, `record_task_open`, `task_open`, `source_resume_<status>` (next run of that source reuses or closes it), `user_tab` |
| `leak` | a rule should already have closed it | `run_missing`, `record_missing`, `record_completed/dismissed`, `newer_source_run_completed`, `source_finished`, `spare_not_blank`, a completed run (`run_completed`, `record_found_run_completed`) |
| `stale` | kept on purpose, no queued work; record tabs of a stopped application (`found`, no task, no question) auto-close `STALE_RECORD_TAB_MS` (3 h) after the run ended — one still open later is a leak | `record_found_run_blocked/failed/interrupted` with no open task, `no_run_label` |

**Orphans** are Chrome tabs in an AutoJob window (one holding a
`127.0.0.1:<port>/jev/<id>/home` page) that no workspace tracks, and home pages of
an earlier relay port. Typical causes: a workspace deleted before 2026-10-21 (its whole window stays), Chrome restored an old session (a new Chrome
run, so the extension cannot hand the tabs back), an app crash before quit closed
tabs, or a popup that was never tracked. More than one AutoJob window per connected
workspace is also worth reporting.

## 3. Trace a leak from the log

Each line is `{at, event, workspace, tab, run, key, url, ...}`; URLs keep only
origin + path. Events:

- `open` (tracked tab; `opener` for popups / new tabs), `claim` (run label set)
- `run_end` — the finish decision: `status`, `record`, `closeTabs`, `pendingQuestion`, `runs`
- `finish` — the close pass: `closed` ids and `retained` `{tabId: reason}` with
  `pending_question`, `verification`, `left_page` (moved to another origin), `form`
  (a non-disposable page), `close_failed`
- `finish_deferred` — the close pass was skipped (Jev busy, not opened, disconnected); nothing retries it
- `spare` (navigated to about:blank for reuse), `closed` with `reason`:
  `run_finished`, `record_closed`, `source_reset`, `agent`, `error_tab`, `user`,
  `outside` (user, site or Chrome closed it)
- `disconnected`, `quit` (tabs closed on app quit; `failed` ids)

```sh
L="$(jq -r .directory ~/Library/Application\ Support/JobLoop/data-location.json)/logs/tabs.jsonl"
grep '"tab":"<TAB_ID>"' "$L"; grep '"run":"<RUN_ID>"' "$L"
```

Run status, record status and tasks: copy
`jobloop.sqlite*` to the scratchpad and query `automation_runs`, `workspace_records`,
`workspace_tasks` (see memory `run-diagnosis-data-locations`).

Questions to answer per leak: which `run_end` had `closeTabs=false` and why (run not
completed, record still waiting, a question)? Was there a `finish` at all, did it
retain the tab (which reason), or was it `finish_deferred`? Was the tab ever claimed
(no `claim` → unlabelled, so no rule matches it)?

## 4. Report and fix

Report to the user: counts (Chrome tabs/windows, tracked, keep/leak/stale, orphans),
then each leak/stale/orphan with workspace, run, record, URL and the log reason.

Fixes follow CLAUDE.md: a general close rule, never a site-, URL- or title-specific
exception. Keep tabs that still hold user work (prepared forms, verification,
questions). Add or extend a test (`tests/completed-tab-cleanup.test.mjs`,
`tests/browser-tab-maintenance.test.mjs`, `tests/tab-audit.test.mjs`) and keep
`judgeTab` in step with the real close rules. Do not close the user's tabs yourself
unless they ask; the app UI's tab list (`close-workspace-tabs`) closes tracked ones.
