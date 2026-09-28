# Agent context payloads

Context optimization is an output projection, not a database migration. Full records stay in the store and UI. `list_applications(jobId)` provides full job details when needed. No candidate facts, free-text preferences, consent scopes, proof, uncertain-send state, duplicate guards or reply actions are truncated.

## Current projections

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

Candidate and background workspaces now generate a small CLAUDE.md with `@AGENTS.md`. Shared rules remain in AGENTS.md; existing Claude-specific additions are preserved. Claude's documented relative import loads those rules without a separate discovery read. Startup revision context-v4 no longer demands the campaign skill before an application. Files update at the next app-managed launch, not inside a running candidate session.

Recovery is an index plus seven condition-specific files (roughly 0.6–1.8 KB each). The model reads only the observed failure's procedure, rather than the entire recovery document. Control observations include owner-bound fieldId and recommendedTool when supported. Invalid/stale batch-fill responses include a full current observation. Successful task reports now include an explicit end-turn completion receipt and avoid echoing the full campaign.

`node scripts/audit-startup-inventory.mjs /candidate/workspace` reports static instruction/schema bytes and enabled user-plugin count, without secrets. Local measurement: generated AGENTS.md 3181 bytes, JobLoop tool catalog 27402 bytes, Jev catalog 13484 bytes, five enabled user plugins. Deferred schemas are not necessarily present in the first request; these are not token attribution measurements. The ~54K first-request token cost remains unallocated provider/plugin/tool overhead. User plugins were not disabled, and no live performance reduction is claimed without a fresh measured session.

## Self-contained control state

Jev action and observe responses now use `observationMode=compact` with `controlMaps=replace`. The four current control/target/field/scroll lists replace previous lists in full; old IDs are never retained by the consumer. Exact question/consent wording, values, guards and selection verification are unchanged. Duplicate `elements` are omitted; unchanged prose is marked `textUnchanged=true` and is not new outcome evidence. Fresh changed text is returned verbatim. `missing_baseline` no longer forces full prose because current control maps need no baseline. Explicit `context_loss` still restores prose; new owner/URL and technical recovery retain full observations. Legacy map-delta clients remain supported by the smoke consumer.

Validation for this revision: 24 focused tests, Jev blockers/choice Chrome smokes, syntax check and build passed. Full-suite run encountered unrelated MCP `store is not defined` and agent-restart failures in the shared checkout; it was terminated after hanging. No app restart or live application mutation was performed.

## Rank document observations

Assigned Jev rank tasks now receive rendered document text (including below-fold text and visible frames) on open/observe/action responses. Application control/field/credential payloads are removed from rank responses; current permitted link/tab targets and scroll targets remain, with original server-side guards unchanged. Reading is bounded at 60,000 characters with explicit truncation/unread-frame flags and viewport fallback; snapshot-only text (e.g. shadow content) is retained as viewport evidence. Unchanged document text is omitted; owner/URL changes and context_loss restore it. Lazy-loaded content still requires targeted inspection when requirements are missing. Application task observations are unaffected.

Uncertain/submitting task contexts now provide conditional confirmation/validation/continuation guidance; rejected state transitions explicitly discourage trying another reset state. No submission permissions or state guards were relaxed.

Validation: 35 targeted tests, isolated Chrome rank smoke, syntax check and build passed. Fixture rank response 1,314 bytes versus 26,163 bytes for the application observation; unchanged rank reread 749 bytes. This is a synthetic payload measurement, not a live throughput claim. No running app/worker was restarted.
