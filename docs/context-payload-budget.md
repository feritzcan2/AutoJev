# Agent context payloads

Context optimization is an output projection, not a database migration. Full records stay in the store and UI. `list_applications(jobId)` provides full job details when needed. No candidate facts, free-text preferences, consent scopes, proof, uncertain-send state, duplicate guards or reply actions are truncated.

## Current projections

### Exact document text and record lookup

Jev document responses omit viewport prose only when every line is already in
the complete document text (allowing whitespace differences). Any viewport-only
content keeps the full viewport text. Complete current control maps remain in
each response; the duplicate `elements` list is omitted when those maps exist.
The internal guarded browser snapshot is unchanged.

`get_workspace_records` accepts a literal `query` over titles, companies,
locations, URLs, summaries and table cells. Filtering and pagination happen in
the app. Lists return record identities, current states, table fields and score
metadata. The tool explicitly requires an `itemId` read for the full proposal,
evidence and uncertainties before judging or acting. Template output contains
the table's record contract rather than unrelated setup/mail instructions.
Full record reads preserve all stored values and use exact context fragments
when they exceed the existing byte limit. No saved data is removed.

Replay of complete parseable responses from the 2026-10-01 08:20–09:20 run:
103 document responses shrank from 933,851 to 727,664 serialized characters
(22.1%); one record-list response shrank from 26,495 to 3,985 (85%). Partial
and provider-spilled responses were excluded. These measurements describe
payload size, not whole-session token or billing savings.

Validation: `tests/jev-document-context.test.mjs`,
`tests/workspace-record-reading.test.mjs`, and
`node scripts/smoke-document-context.mjs` cover exact text, viewport-only facts,
current control IDs, workspace isolation, filtered pagination and full-record
recovery. This projection does not change compaction thresholds or restart
running sessions.

The full suite passed (734 tests), as did syntax checks, build and the isolated
document-context Chrome smoke. The older `smoke-jev-reading.mjs` stops at its
expectation that an ordinary trial click must be rejected without a reserved
proposal; the current automation interaction contract allows that click. Its
document-reading assertions passed before that unrelated assertion.

Web automation context now has a 16,000-byte serialized response limit. Small
`get_automation_context` responses keep their existing shape. Larger responses
return exact JSON fragments, with `context.id` and `context.nextOffset` for
`read_automation_context_part`. Agents read every fragment before acting. The
cache belongs to one workflow and is separate from browser snapshots; fetching
new context replaces it. This avoids provider spill-file reads and shell
permission requests while retaining the complete context projection. Saved
criteria, permissions and scan recovery data are not shortened to fit the limit.

- Completed setup: status/stage/mode/needsTurn/error only. Active setup and profile improvement retain full context. A historical `mode=improve` with `needsTurn=false` is not active improvement.
- Assigned application/verification: omit fit prose and rank dimensions/strengths/evidence; retain rank decision, score, gaps, blockers and uncertainties, plus all operational job fields.
- Answered questions: retain exact answers, field labels/help/scope and selected option labels. Unanswered fields retain their full schemas. Free-text answers without structured values retain all options.
- Profile: only UI workspace name and provider agent settings are omitted; facts and their provenance remain intact.
- Current-job tab lists carry identity; the full checkpoint remains on the job.
- Application tasks load their application skill directly. Campaign coordination skill is not a mandatory prerequisite. Detailed question rules load only before the first question.
- Jev retains existing map deltas and full recovery observations. Unchanged history is omitted from deltas; changed history carries the last action. Existing control/action/fill ID contracts are preserved rather than replaced with lossy summaries.

## Measurement

Run `node scripts/audit-context-startup.mjs /path/to/session.jsonl 1000000`.
The report contains per-request input tokens (including cached input), first 10% crossing, tool output bytes, screenshot counts, full-result file read counts and task-context before/after bytes. It supports both browser_jev and historical browser_jev_original tool names without needing either backend to be connected. It never prints candidate content. Bytes are not token estimates; transcript alone cannot accurately split hidden provider/system/schema overhead.

Historical replay of Ferit's f77d86ee session: four task packets shrink from 32069/30177/39832/37495 bytes to 25202/22899/34964/32105 bytes (12–24%). This is payload savings, not measured whole-session token or latency improvement. Live before/after runs are still needed after an authorized restart. The current checkout does not contain the old jev-original backend; no runtime changes were made to an absent backend.

## Regression gates

`npm test`, `npm run check`, `npm run build`, plus the Jev blockers and choice Chrome smoke tests. Test reply scope, false consent, exact facts, uncertainty, duplicate proof and setup isolation. In live comparison, reject a change if it introduces missing-fact questions, repeated fetches, incorrect decisions or unsafe resubmission. No automatic app restart or live submission is part of payload optimization.

## Claude startup and targeted recovery

App-managed workspaces generate a small CLAUDE.md with `@AGENTS.md`. Shared rules remain in AGENTS.md; existing Claude-specific additions are preserved. Claude's documented relative import loads those rules without a separate discovery read. Startup revision context-v4 no longer demands the campaign skill before an application. Files update at the next app-managed launch, not inside a running candidate session.

Recovery is an index plus seven condition-specific files (roughly 0.6–1.8 KB each). The model reads only the observed failure's procedure, rather than the entire recovery document. Control observations include owner-bound fieldId and recommendedTool when supported. Invalid/stale batch-fill responses include a full current observation. Successful task reports now include an explicit end-turn completion receipt and avoid echoing the full campaign.

`node scripts/audit-startup-inventory.mjs /candidate/workspace` reports static instruction/schema bytes and enabled user-plugin count, without secrets. Local measurement: generated AGENTS.md 3181 bytes, JobLoop tool catalog 27402 bytes, Jev catalog 13484 bytes, five enabled user plugins. Deferred schemas are not necessarily present in the first request; these are not token attribution measurements. The ~54K first-request token cost remains unallocated provider/plugin/tool overhead. User plugins were not disabled, and no live performance reduction is claimed without a fresh measured session.

## Self-contained control state

Jev action and observe responses now use `observationMode=compact` with `controlMaps=replace`. The four current control/target/field/scroll lists replace previous lists in full; old IDs are never retained by the consumer. Exact question/consent wording, values, guards and selection verification are unchanged. Duplicate `elements` are omitted; unchanged prose is marked `textUnchanged=true` and is not new outcome evidence. Fresh changed text is returned verbatim. `missing_baseline` no longer forces full prose because current control maps need no baseline. Explicit `context_loss` still restores prose; new owner/URL and technical recovery retain full observations. Legacy map-delta clients remain supported by the smoke consumer.

Validation for this revision: 24 focused tests, Jev blockers/choice Chrome smokes, syntax check and build passed. Full-suite run encountered unrelated MCP `store is not defined` and agent-restart failures in the shared checkout; it was terminated after hanging. No app restart or live application mutation was performed.

## Rank document observations

Assigned Jev rank tasks now receive rendered document text (including below-fold text and visible frames) on open/observe/action responses. Application control/field/credential payloads are removed from rank responses; current permitted link/tab targets and scroll targets remain, with original server-side guards unchanged. Reading is bounded at 60,000 characters with explicit truncation/unread-frame flags and viewport fallback; snapshot-only text (e.g. shadow content) is retained as viewport evidence. Unchanged document text is omitted; owner/URL changes and context_loss restore it. Lazy-loaded content still requires targeted inspection when requirements are missing. Application task observations are unaffected.

Uncertain/submitting task contexts now provide conditional confirmation/validation/continuation guidance; rejected state transitions explicitly discourage trying another reset state. No submission permissions or state guards were relaxed.

Validation: 35 targeted tests, isolated Chrome rank smoke, syntax check and build passed. Fixture rank response 1,314 bytes versus 26,163 bytes for the application observation; unchanged rank reread 749 bytes. This is a synthetic payload measurement, not a live throughput claim. No running app/worker was restarted.
