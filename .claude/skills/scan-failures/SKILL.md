---
name: scan-failures
description: Triage jobloop source scans that ended failed, blocked or timed out, from their Sentry issues, and fix the ones caused by the app. Use when the user asks to check, triage or fix failed scans, scan errors or Sentry issues of jobloop ("taramalara bak", "başarısız taramaları çöz", "sentry'ye bak", "check failed scans").
---

# Failed scan triage

When a source scan run ends `failed`, `blocked` or `timeout`, the app sends one
Sentry event (`app/system/scan-failure-report.mjs`, hooked in `AutomationStore.putRun`).
Interrupted, partial and completed runs and record work (applications) are not sent.
Reports are on by default; Configuration → Diagnostics → "Send anonymous usage and error reports" turns
them off (stored in `<data>/scan-reports.json`). No events from this machine can mean it is off.

- Organization `agentloop-22`, project `jobloop` (ID `4512290640101456`), API `https://de.sentry.io`
- API token: macOS Keychain service `ai.termloop.sentry.api` (shared with TermLoop Mobile)
- Helper: `scripts/sentry-scans.sh` (in this skill folder)

## Usage analytics

The same switch also sends anonymous usage (`app/system/usage-report.mjs`): one Release
Health session per app start (`did` = a random install id, errors = failed scans) and one
`usage.daily` log line per day with counts (`scan_*`, `trial_*`, `execute_*` = applications,
`records_found`, `workspaces`, `sources`, `providers`, `os`, `install_id`).

- `scripts/sentry-scans.sh users 14d` — sessions and unique installs per release per day
- `scripts/sentry-scans.sh usage 14d` — the daily count lines; count distinct `install_id`
  for active installs, and installs whose `scan_total` stays 0 for drop-off
- `execute_blocker_<category>` counts why applications stopped (`needs_answer`,
  `needs_login`, `technical`, ...); other record tasks get `<operation>_blocker_<category>`.
- Every scan and application event carries the same `install_id` tag, so an event's
  country (`geo.country_code`, from the connection) maps to the install's usage lines.
- Exclude the user's own machines: `environment: development` is the repo build.
- Not real users: release `0.0.0-check` (a manual check) and the six 0.1.13 entries of
  2026-10-21 07:33–07:42 UTC (CI smoke runs before CI turned diagnostics off).

## Security

Never print the token or put it in a file, URL, command transcript or answer.
The helper reads it from Keychain. The DSN in the app is public and is not the token.

Events carry only the site host, app status codes, tags and scrubbed text. Do not add
profile, CV, page text, full URLs, search terms or raw IDs to the event.

## What an event contains

- Title: `scan <status> (<stop kind>) <site>: <code>`
- Grouping (fingerprint): site + status + stop kind + code
- `code`: `tool:<name>` when a tool failed repeatedly, otherwise the first app code
  (`site_wait`, `checkbox_not_ready`, `collector_details_unavailable`, ...), else `none`
- Tags: `site`, `status`, `kind` (run/trial), `stop_kind` (access/technical/user_input/none),
  `code`, `collector`, `model`, `provider`, `retry_exhausted`, `recovered_after_crash`,
  `environment` (development = the user's repo build), `release` (app version)
- Extra: scrubbed `summary`, `stopEvidence`, `toolFailure`, `durationMs`, `browserSteps`,
  `pageProgress`, `scanStats`, `continuation`, and `deliveryFailure` when the task
  message never reached the agent: the engine delivery state and the last three scrubbed
  lines of the agent terminal (a first-run prompt, a login request, a full composer)
- Failures the app ended without a stop reason (`stop_kind: none`) group across sites;
  their `code` is the summary's first sentence

## Application reports

Applications (execute tasks) that end failed, blocked or timed out send an event with
logger `jobloop.application` (`app/system/application-failure-report.mjs`), but only
when the app might fix the cause: blocker category `technical`, `site_problem`, or no
blocker (the app ended the run). Stops that need the user (`needs_answer`,
`needs_login`, `needs_code`, `needs_payment`, `verification`) or exclude them
(`not_eligible`, `listing_closed`) appear only in the daily counts.

- Title: `application <status> (<category>) <form_site>: <code>`
- Tags: `site` (listing source host), `form_site` (`listing_site`, a known applicant
  system domain such as `myworkdayjobs.com`, or `employer_site`), `category`, `step`
  (`not_opened`, `before_submit`, `submitted_<outcome>`), `code` (`tool:<name>` or an
  app code), `model`, `provider`, `install_id`
- Extra: the blocker `reason` (scrubbed), the app's own summary only when there was no
  blocker, `toolFailure`, `durationMs`, `browserSteps`, `agentTokens`
- List them: `scripts/sentry-scans.sh list 14d "is:unresolved logger:jobloop.application"`.
  To reproduce, open a public listing on the same applicant system in your own browser.

## Workflow

1. `scripts/sentry-scans.sh list 14d` lists the unresolved issues, most frequent first.
2. For each issue, `scripts/sentry-scans.sh latest <issue-id>` shows its newest event.
   Use `events <issue-id>` to see whether all events have the same cause.
3. If the event came from this machine (`environment: development`), read the full run
   locally for more detail (read only):
   ```sh
   sqlite3 -readonly ~/Desktop/"Loop Verileri"/jobloop.sqlite \
     "SELECT data FROM automation_runs WHERE json_extract(data,'$.status')='<status>' \
      AND json_extract(data,'$.sourceUrl') LIKE '%<site>%' ORDER BY rowid DESC LIMIT 3"
   ```
   The agent transcript is under `~/.claude/projects/…candidates-<workspaceId>/<conversation.nativeId>.jsonl`.
4. Decide the class of the issue:

   | Class | Typical sign | Action |
   | --- | --- | --- |
   | App bug | `technical`, `tool:*`, app error text, a check that refuses a correct state, a lost Jev task, page progress that does not match the page | Fix it |
   | Agent protocol | the agent stopped without saving, skipped a step, repeated the same call | Fix the tool text, guidance or code gate |
   | Shared wait or recovery | `access` with `checkbox_not_ready` or `document_changed`, retries that never resume | Fix it if the shared mechanism misbehaves |
   | Site refuses | sign-in wall, rate limit, HTTP 403, a captcha that needs a person | Ignore it; not fixable in the app |
   | Needs the user | `user_input` with a real open question | Ignore it, unless the question exists only because of an app bug |

5. Fix the app bugs:
   - Follow CLAUDE.md: the fix must use shared browser behavior. Never tie it to the
     site's domain, URL pattern, CSS class or fixed page text. Site-specific code
     belongs only in `app/site-extensions/`, through the `site-extension` skill.
   - Add a test with synthetic data, then run `pnpm check` and `pnpm test`.
   - Do not restart the app; the user restarts it.
6. Update Sentry:
   - Fixed: `scripts/sentry-scans.sh resolve <issue-id>`. A new event reopens it as a
     regression. An event sent before the user restarted the app with the fix
     is not a regression: compare its time with the fix time.
   - Not fixable: `scripts/sentry-scans.sh ignore <issue-id>`. It comes back if it escalates.
   - Not sure: leave it unresolved and ask the user.
7. Report to the user: one line per issue with its short ID, class, and what you did
   (fixed in which files, ignored with which reason, or the open question).
