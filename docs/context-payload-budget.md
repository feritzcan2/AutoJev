# Agent context payloads

Context optimization is an output projection, not a database migration. Full records stay in the store and UI. `list_applications(jobId)` provides full job details when needed. No candidate facts, free-text preferences, consent scopes, proof, uncertain-send state, duplicate guards or reply actions are truncated.

## Current projections

### Write receipts and one scan queue

`record_automation_result` returns a short record reference instead of echoing
the saved summary, proposal, legacy application and proof. It preserves the
record identity, current state, duplicate flag, review requirement, digests,
score, gaps and uncertainties. Protected records still return their existing
state. Full details remain available through `get_automation_result`; large
reads now use the same exact 16,000-byte fragments as workspace record reads.
Reservation and outcome responses keep their existing contracts.

Agent-facing scan results show pending URLs once, in `queue` or
`scanWork.queue`, with 25 URLs by default. `get_scan_queue` supports every
remaining page and explicitly requested batches up to 100. Counts for all
searches, the selected search, exact checkpoint cursor, dates and cutoff proof
remain visible. The store, UI and durable recovery queues are unchanged.

Document tool responses omit the extra link index only when every label and
URL already appears verbatim beside its card in the full document text. Links
with additional metadata or without an exact inline representation keep their
index. Fresh action handles, visible prose, consent values, loading information
and browser-side observations remain unchanged.

Replay of the first hour's complete parseable tool results measured serialized
UTF-8 bytes: 72 record responses 253,344 → 88,454 (65.1% smaller), 118 scan
responses 234,094 → 183,074 (21.8%), and 103 full document responses
1,084,359 → 990,974 (8.6%). Replaying the later İrem monitoring sample measured
68.7%, 15.7% and 7.2% respectively (26/17/47 responses). Partial documents
were excluded. These are additional response-size measurements, not billing
or whole-context savings; no conversation history or compaction setting changes.

Validation: 742 tests passed, including durable multi-search pagination,
exact full-record recovery, protected duplicate records, review requirements
and current browser handles. Syntax checks, build and the isolated Chrome
document smoke passed; the smoke made no submissions.

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

`node scripts/audit-startup-inventory.mjs /candidate/workspace` reports static instruction/schema bytes and enabled user-plugin count, without secrets. Measurement after the 2026-10-02 instruction restructuring: generated AGENTS.md 6.2 KB (was 15.0 KB), web-run role profile 4.9 KB (9.1 KB in Jev mode, was 13.8 KB with the Jev block delivered twice), web-interview 5.3 KB, web-trial 0.9 KB. The Jev block is appended once and only when the workspace browser mode is Jev. Deferred schemas are not necessarily present in the first request; these are not token attribution measurements. The ~54K first-request token cost remains unallocated provider/plugin/tool overhead. User plugins were not disabled, and no live performance reduction is claimed without a fresh measured session.

## Unchanged page text is not resent

The automation worker compares each new observation's rendered document text and links with the previous snapshot of the same URL. When they are identical, the response keeps the previous `snapshot.id`, omits the text and sets `textUnchanged=true`; only the fresh control maps, readiness and navigation are returned. Evidence, observation records and `browser_read_part`/`browser_search` keep working on the retained snapshot. A changed page or a different URL returns the full text as before.

## Self-contained control state

Jev action and observe responses now use `observationMode=compact` with `controlMaps=replace`. The four current control/target/field/scroll lists replace previous lists in full; old IDs are never retained by the consumer. Exact question/consent wording, values, guards and selection verification are unchanged. Duplicate `elements` are omitted; unchanged prose is marked `textUnchanged=true` and is not new outcome evidence. Fresh changed text is returned verbatim. `missing_baseline` no longer forces full prose because current control maps need no baseline. Explicit `context_loss` still restores prose; new owner/URL and technical recovery retain full observations. Legacy map-delta clients remain supported by the smoke consumer.

Validation for this revision: 24 focused tests, Jev blockers/choice Chrome smokes, syntax check and build passed. Full-suite run encountered unrelated MCP `store is not defined` and agent-restart failures in the shared checkout; it was terminated after hanging. No app restart or live application mutation was performed.

## Rank document observations

Assigned Jev rank tasks now receive rendered document text (including below-fold text and visible frames) on open/observe/action responses. Application control/field/credential payloads are removed from rank responses; current permitted link/tab targets and scroll targets remain, with original server-side guards unchanged. Reading is bounded at 60,000 characters with explicit truncation/unread-frame flags and viewport fallback; snapshot-only text (e.g. shadow content) is retained as viewport evidence. Unchanged document text is omitted; owner/URL changes and context_loss restore it. Lazy-loaded content still requires targeted inspection when requirements are missing. Application task observations are unaffected.

Uncertain/submitting task contexts now provide conditional confirmation/validation/continuation guidance; rejected state transitions explicitly discourage trying another reset state. No submission permissions or state guards were relaxed.

Validation: 35 targeted tests, isolated Chrome rank smoke, syntax check and build passed. Fixture rank response 1,314 bytes versus 26,163 bytes for the application observation; unchanged rank reread 749 bytes. This is a synthetic payload measurement, not a live throughput claim. No running app/worker was restarted.

## Delegated Jev tasks

With the Jev browser, `browser_jev_run` runs five routine operations inside the
application: `prepare_search`, `scan_results`, `collect_details`,
`classify_results`, and `fill_form`. All provider agents receive the same tools
and delegation instructions. Search and form values come from the main agent's
verified facts; Jev matches observed fields and options. It cannot invent values,
upload files, accept consent or submit an application through this task runner.

Pass observed addresses as `url`/`urls` to `collect_details`, or omit them to read
the assigned record/current pending queue. No earlier Jev task is required. A
scan's `taskId` can also be passed as `fromTaskId`. Classification accepts the
detail task ID or selects the latest collected details in the same search.
Intermediate browser observations stay in SQLite. The
main agent receives a short result index and reads exact original text through
`read_jev_evidence`; final scores and records remain its responsibility. Missing
details and low-confidence exclusions stay uncertain. Jev usage is stored per
task as calls, input tokens and output tokens.

Each call checkpoints after at most 12 work units or roughly 25 seconds, plus
the current operation. `status: continue` requires resuming the same `taskId`;
it never means the source is complete. IDs are scoped to the workspace, assigned
queue task and saved search. Sources keep discovered details pending until the
main agent processes them. Failed verification or changed page state returns
`needs_agent`. Form fields are checked again before reporting completion.

Schema 13 creates the task/evidence tables with an automatic upgrade backup.
Backup/restore preserves evidence and makes interrupted tasks resumable.
`pnpm test:jev:tasks` exercises all five operations in isolated Chrome using
synthetic TypeSafe decisions. The fixture covers the five operations, direct URL
collection and recovery feedback with 14 parent tool responses, 23 Jev decisions
and zero submissions. These are workflow checks;
actual spending and task quality still require measurement on live runs.

Schema 15 retains per-page scan receipts: original pagination controls/quotes,
page report and queue checkpoint status, evidence IDs, and continuation decisions.
`read_jev_task(pageOffset)` pages through these receipts without reopening a board.
Unverified chronology remains explicit and requires full coverage; the receipt
does not invent dates, certify a cutoff, or complete the parent source.

Source discovery removes observed same-route filter actions and home/logo links,
then gives Jev bounded exact card context and current candidate criteria. An
explicit card/title conflict can be excluded at 85% confidence without opening
the detail, asking the parent to read it, or creating a zero-score record.
Missing facts and adjacent roles remain candidates. Receipts distinguish
rejected listings from navigation controls. Confirmed
individual listing links precede explicitly uncertain leads in the parent index
and detail collection. Missing or low-confidence decisions remain pending. Fresh
checkpoints also retire observed non-listing controls from older queues. Original
documents stay available as evidence; only relevant details need main-model reads.
Checkpoints add only the current page's candidates, preserving observed aliases;
earlier pages are not written again. Known Stepstone/Startup Insider category
routes and employer board roots are deferred during detail collection.

Source finding tools omit record-only IDs, action URLs and proposals from their
schema. Assigned-record tools retain those fields and their existing checks.

Schema 16 marks scans that bind each TypeSafe question explicitly to its link.
Question-map keys are transport IDs and are not visible to the inference model
([API contract](https://docs.typesafe.ai/api)). Older ambiguous scans retain all
work/evidence but require fresh discovery before automatic detail expansion.

Delegation guidance is delivered in the native agent role and each fresh/resumed
launch, as well as AGENTS.md. A handoff gives operation-specific next steps.
Marketing/legal navigation is excluded from listing discovery; failed detail
pages leave their evidence/queue intact while other details continue. Successful
redirects preserve the requested address as observed, so processing the original
queued URL does not require reopening it repeatedly.

Saved Jev evidence also supplies discovery URLs after a worker restart within the same app process, scoped
to the same workspace, durable queue task and selected search. These URLs may
be followed or added to pending work. They do not create fresh observations,
permit retiring unread work, or prove availability/submission.

The restart
regression in `tests/jev-tasks.test.mjs` checks discovery reuse without granting
current evidence or crossing task/search ownership.

`collect_details` classifies each successfully collected listing within the
same RAM task. Unavailable URLs remain pending while the successful items
keep their assessments. A repeated `classify_results` reuses those assessments
under the same saved user criteria. Changed criteria invalidate assessments,
while retaining the original evidence. Long documents are classified in exact
30,000-character fragments with a saved offset. Only visible substantive or
uninspectable frames count as unread; hidden and one-pixel frames are excluded.
Jev exclusions need an initial decision and independent binary confirmation,
each with at least 85% confidence. The confirmation call also selects a reason;
competing reason labels do not reduce confidence in the exclusion itself.
Neither step requires a quotation match. Unread frames alone do not override a
supported conflict. Unverified exclusions and conflicting fragments stay uncertain.

A page identified with high confidence as a results board is deferred for an
explicitly selected `scan_results` task. Detail collection does not recursively
expand company boards or location filters. Existing child tasks and their
evidence are retained. Stepstone variants of the same company board are treated
as navigation; actual pagination and unknown detail routes remain available.

Every 20 assessed details creates a RAM review batch. Source scans also review
the final group of 1–19 details through the same reject/defer flow. The default handoff
contains five items; `read_jev_task` pages through the batch. Collection cannot
open item 21 until `reviewedBatchId` acknowledges the batch. The parent saves
suitable records, or supplies `review` decisions with a short reason: `reject`
retires an unsuitable listing without a record; `defer` keeps it pending. New detail tasks return
the pending review. Missing review decisions do not count as repeated tool
failures. Acknowledgement never completes source coverage.

Each batch index includes a 1-based `item` number that stays fixed across index
pages and detail refreshes. Reviews use `{item, decision, reason}`; legacy URL
selectors still work. The current `reviewedBatchId` scopes the numbers, which
restart at 1 in the next group. Confirmed Jev exclusions at 85% or higher need
only acknowledgement, so the parent omits them from `review`. Invalid selectors
identify the offending entry; missing decisions list item numbers instead of
long URLs. These corrections preserve the queue and do not count as repeated
tool failures. Task data and numbering remain in RAM.

Review indices now omit long URLs and repeated exclusion metadata by default;
`view:details` restores them when needed. For a listing that needs assessment,
`read_jev_brief` uses Jev to select source sections for duties, requirements,
location, work mode and compensation. It retains uncertain sections and copies
the selected text exactly. Mandatory/preferred wording, exceptions, remote-work
limits and estimated-versus-employer pay remain source statements. The parent
requests original sections only for missing or conflicting information.
Selection progress and briefs live in RAM, expire with evidence changes, and
can be polled while work continues. An unavailable brief returns an explicit
fallback. Four synthetic live cases retained all checked essential facts and
the same fit decisions with 72–75% less listing text; this is not a guarantee
for every live page.

OpenCode context monitoring reads its existing SQLite messages in read-only
mode and includes cached input once. The app uses the selected model's reported
capacity, detects completed native summaries and supports context renewal at
task boundaries. Launch-specific OpenCode configuration enables native automatic
compaction and tool-output pruning at the configured input budget. It keeps the
reported context/output limits. Busy sessions use native compaction; idle manual
delivery still respects terminal readiness. Threshold changes take effect on
the next OpenCode session. A real OpenCode test with a local model fixture
verified automatic compaction while three ordered tool steps completed.
References: [TypeSafe API](https://api.typesafe.ai/openapi.json),
[OpenCode compaction](https://opencode.ai/docs/config/#compaction),
[OpenCode input budget](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/session/overflow.ts).

An access barrier defers only that host's pending details. Other hosts and
saved searches continue, including URLs beyond the first 100 queue entries.
The source can enter a shared site wait after its remaining reachable work is
handled. A premature access stop returns guidance without a tool-failure strike.

Source detail reads get at most three attempts: open, observe the same page,
then reopen the original URL in a fresh read-only tab. A changed page is never
captured as the original detail. Failed URLs stay pending with a five-minute
RAM wait shared by fresh helpers in the same assigned task. Site barriers use
their existing retry deadline. Assigned record/form workflows are unaffected.

Raw evidence, helper tasks and assessments remain in RAM. Restarting the app
expires them; durable pending URLs are read again. Within the process, changed
criteria or classifier versions refresh assessments from their saved text.

The helper advances transport slices automatically until review, a real issue
or completion. Polling waits for the same helper; it does not launch more work.
Text-highlight and known tracking URL variants share one read and assessment,
while job-selection parameters and SPA routes remain distinct. Observed aliases
are retired together when their listing is reviewed.

A shared access barrier stops collection before classification. Its source run
waits even when the blocked host differs from the configured source URL. Other
sources remain schedulable. The host gate controls retry timing and one recovery
probe; repeated calls do not extend the wait.

Parallel provider calls are serialized inside each workflow, with cancellation
and authorization checked again when the queued call starts. Other workers have
their own queues. Transient document-context errors invalidate the private
browser handle and retry a complete read up to three times while the page and
browser remain open; navigation, clicks, form edits and submissions are never
repeated by this recovery path.

## Versioned task context and queue receipts

Task workers receive `contextReuse.versions` for exact rules/profile/answer
sections. On a resumed conversation they may pass `knownVersions` only for
sections fully read and still in context. Matching sections are omitted; changed
sections replace prior values, including empty arrays/null. Fresh sessions and
context loss omit acknowledgements and receive every section. Hashes include
workspace identity. Current run, assigned record, queue, browser handles and
recovery state are always returned. This changes tool projections only.

Jev queue reads and scan write receipts default to counts and exact checkpoints.
`collect_details` resolves the pending URLs internally. Explicit
`get_scan_queue(view="entries")` still pages through the complete durable queue.
Continuing Jev calls and scan handoffs return progress plus an index reference;
`read_jev_task` retains all candidates, partial successes and original evidence.

Rendered pagination now includes the visible non-link current page inside a
named pagination region. The app records an explicit pagination number or
numbered title during observation. `report_scan_page(snapshotId)` uses that
observation directly; unnumbered pages return a no-number receipt with guidance
to continue actual pagination/scrolling. It never infers totals from item counts
or URLs. Legacy manual reports retain their quote validation.

Explicit worker restart clears both worker history and the run conversation
reference, so source retries cannot revive the retired provider session. Queues,
Jev task/evidence IDs, records and retained tab checkpoints are preserved.

Replay of the two İrem OpenCode sessions on 2026-10-01 measured serialized
characters (not tokens or billing): Google task context 77,305 → 45,248 across
two packets; queue responses 73,841 → 4,564; Jev responses 80,728 → 33,651.
Stepstone context 63,741 → 38,982; queues 25,784 → 2,929; Jev responses
53,477 → 38,838. Exact omitted sections were checked against the retained
baseline. First context packets still contain the full saved rules.

Validation: 819 JavaScript tests, 9 Rust tests, syntax/build/vendor checks and
isolated Chrome Jev smoke passed (5 operations, 17 tool calls, 25 synthetic Jev
decisions, zero submissions). Regression cases cover restored context after
compaction, changed permissions, false consent, cross-workspace versions,
complete 135-URL queue recovery, unnumbered pages and provider restart with
retained source work/evidence. These checks do not establish live fit quality or
whole-session cost savings.

Validation for schema 17: 827 JavaScript tests, 9 Rust tests, vendor verification,
syntax check and build passed. The isolated Chrome smoke exercised five
operations with 17 tool calls, 22 synthetic Jev decisions and zero submissions.
The 105-item source test verifies five review barriers, rejects unsaved records
and preserves the final five pending URLs.

On resume, context lists pending review batches and collected detail tasks before
child scans. An index with legacy assessments requests a Jev refresh before
exposing old assessment items. Refresh reuses exact saved text. A read-only replay
of six stored SumUp details through the real Jev API used 10 decisions: the
Amsterdam on-site role had a verified exclusion quote; the other five remained
uncertain. This is a behavior check, not a general accuracy or cost benchmark.

## Workflow contract and interrupted tool recovery

Task conversations store a digest of the scoped tool schemas and workflow
instructions. A changed or missing digest starts a fresh provider conversation
while keeping the durable task, queue, answers and retained tabs. Independent
workspace chat keeps its existing conversation. Failure counters reset once on
an actual contract change, and otherwise survive interruption.

Schema 20 removes the disk tables for raw browser text and Jev helper tasks.
Both stores now live in process memory; the browser cache is limited to 64
snapshots per workspace, each at most one million characters. Same-task reads
can reuse these texts while the app is open. Closing the app expires all helper
and evidence IDs. The durable parent queue, saved findings, scores and answers
remain; pending listing pages are read again after restart. Native task
conversations start fresh after process-memory expiry, without resetting their
failure counters. A completed/blocked parent releases its temporary stores.
An unknown snapshot ID can still recover a same-record snapshot in memory,
returning a corrected ID and resetting the cursor. This never installs current
browser controls, creates a fresh observation or authorizes a send. Scoring accepts the agent’s integer score directly. Only score is required;
notes, quotations, evidence and scorecards are optional. Missing quotes never
reject scores or source-method notes. Ranking guidance remains in the prompt.

Jev calls wait at most 15 seconds per response while the helper continues in the
background. `read_jev_task` polls that same helper; duplicate launch requests
reuse its ID. Browser/queue mutations and parent completion wait for it to finish.
Source workers now share the persistent three-failure guard used by record
workers. Related schema or scorecard errors share a counter even when the agent
changes the affected field or listing. A successful corrected operation clears
its counter; a blocked task does not automatically relaunch.
