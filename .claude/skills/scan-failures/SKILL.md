---
name: scan-failures
description: Triage jobloop source scans that ended failed, blocked or timed out, from their Sentry issues, and fix the ones caused by the app. Use when the user asks to check, triage or fix failed scans, scan errors or Sentry issues of jobloop ("taramalara bak", "başarısız taramaları çöz", "sentry'ye bak", "check failed scans").
---

# Failed scan triage

When a source scan run ends `failed`, `blocked` or `timeout`, the app sends one
Sentry event (`app/system/scan-failure-report.mjs`, hooked in `AutomationStore.putRun`).
Interrupted, partial and completed runs and record work (applications) are not sent.

- Organization `agentloop-22`, project `jobloop` (ID `4512290640101456`), API `https://de.sentry.io`
- API token: macOS Keychain service `ai.termloop.sentry.api` (shared with TermLoop Mobile)
- Helper: `scripts/sentry-scans.sh` (in this skill folder)

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
  `pageProgress`, `scanStats`, `continuation`

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
