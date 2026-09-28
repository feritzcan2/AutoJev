# Jev inside Jobloop

Jev is a browser tool for the existing Jobloop agent. The agent plans the task,
reviews Jev's proposed action and supplies exact text when the operation is
TYPE_TEXT. There is no separate text-generation model or OpenRouter dependency.

Set `TYPESAFE_API_KEY` in the repository's ignored `.env.jev` file (or the app's
environment). `TYPESAFE_MODEL` defaults to `jev-latest`. The application reads
only those settings; it never passes the key to the agent or renderer.

In Jobloop select **Agent → Tarayıcı → Jev · mevcut Chrome’da tek pencere**, then restart the
candidate's agent. It receives these MCP tools:

- `browser_jev_open` / `browser_jev_tabs` / `browser_jev_observe`
- `browser_jev_fill_fields`: fill up to 20 observed ordinary text fields with verified agent-supplied answers in one call; no TypeSafe call or submission
- `browser_jev_screenshot`: inspect the visible form before escalating input failures
- `browser_jev_next`: propose one action, without executing it
- `browser_jev_act`: execute the reviewed decision once; the agent supplies `text`
- `browser_jev_upload`: upload an observed file input from this candidate's workspace

Jev keeps one dedicated window per candidate and selected existing Chrome profile,
reusing its signed-in session. A small Jobloop home tab anchors new application
tabs to that exact window even when a personal Chrome window is focused. Ordinary
window.open popups become tabs while preserving opener/privacy flags. Existing
drafts in older windows are preserved; new work uses the retained Jobloop window. Choose the profile in Agent settings. Chrome must already be
running with remote debugging enabled in `chrome://inspect/#remote-debugging`;
accept Chrome's connection prompt when shown. The app does not change this
security setting automatically or fall back to an empty profile. Only windows
created for this candidate and their popups are exposed to the agent. Existing
personal tabs are not exposed. Disconnecting Jobloop leaves Chrome open.

An unanswered connection prompt keeps the same WebSocket handshake pending,
including when approval is delayed for 15 minutes or longer. Background retries
and the reconnect button reuse that pending attempt. No approval deadline is set:
replacing a timed-out handshake creates another Chrome permission prompt. Closing
Jobloop or resetting the candidate/profile cancels the pending handshake. Actual
connection failures still use the existing retry backoff. This behavior is covered
by `tests/jev-connection.test.mjs` with a local server that delays approval and a
simulated 15-minute wait; `scripts/smoke-jev-existing.mjs` checks real Chrome CDP
connections and draft recovery in an isolated profile.

The agent's **Yeniden başlat** button starts a fresh conversation while retaining
the existing Chrome connection. While a new agent is waiting for Chrome approval,
the button is disabled; the queued start keeps its unanswered connection request.
Closing and reopening the whole Jobloop app creates a new connection and can
require Chrome approval again.

New foreground agents wait for the app's Jev Chrome connection to become ready
before any provider session starts. This includes ranking, source searches,
applications, resumed tasks and profile improvement. While permission is pending,
the app shows a centered “Chrome izni bekleniyor” dialog over a dimmed background,
with two steps and an illustrative Chrome Allow prompt. Approval closes the dialog
and resumes the queued start automatically. Escape or “Arka planda bekle” minimizes
the dialog to a reminder without cancelling the wait; the reminder reopens it.
The dialog also offers cancellation and reconnect controls. Stopping the
campaign cancels the queued start. An unanswered approval consumes no agent turns
or task retries. Connection failures show the reason and a reconnect action.
Covered by `tests/browser-start-gate.test.mjs` and `scripts/smoke-browser-start.mjs`.

Source-search tab IDs and their task bindings are saved in the same registry.
`browser_jev_tabs` exposes `searchTaskId` and `jobId`, so a fresh agent can find
the interrupted search's tabs while excluding application drafts. Search recovery
instructions require observing these tabs (or the source's saved checkpoint)
before opening replacements, preserving the current page and filters while Chrome
stays open. Completed search tasks still close their finished research tabs. The
existing-Chrome smoke test verifies task bindings, the same tab IDs, URL and filter
value after closing and recreating the client, with no new tabs or windows.

Candidate/profile-scoped tab IDs, home/window identity, job bindings and hashes
of last observed URLs are saved locally. Once submission proof is saved or a job
is skipped, owned tabs for that job close automatically. Prepared/blocked/uncertain
forms, source tabs, ambiguously shared tabs and manually navigated tabs stay open.
Cleanup never searches for tabs by URL and never opens Chrome just to close tabs;
disconnected cleanup is retried on the next browser tool call. After a disconnect or app
restart, tools and checkpoint buttons reconnect to the exact surviving tabs without
reloading their forms. Pending action decisions are discarded on reconnect. Older
saved checkpoints migrate by exact ID after checking the selected Chrome profile.
Closed tabs and tabs from a different Chrome process cannot be restored by matching
a URL; the agent must check saved submission evidence before recovering a task.

Before filling an application the agent prepares a compact, source-backed answer plan
from the current task/profile, saved replies and CV. It reuses known answers across
fields, refreshing changed evidence and checking current policy before questions or
submission. Browser results already contain fresh observations; redundant observe
calls are unnecessary.

Observations expose `fillFields` with single-use, session-bound `fieldId` values.
`browser_jev_fill_fields({tabId, fields: [{fieldId, text}, ...]})` writes those exact
ordinary text fields sequentially, checks each target/value, and returns per-field
results plus one fresh observation. It stops when state changes or a write cannot
be verified; earlier writes are retained, with no rollback or automatic retry.
Autocomplete, dropdowns, password fields, checkboxes, uploads and submission stay
outside this tool. It does not generate answers or establish candidate authorization.

Decisions are tied to the current candidate, agent session, observed page and a
single-use decision ID. Stale or covered targets are rejected. Execution failures
after input are marked uncertain and must be observed before retrying. Jev's
DONE is not proof of submission; Jobloop's record_submission workflow
and candidate/source permissions still apply. A successful record_submission
atomically saves proof and completes the matching active application task. Its
completion.taskReported receipt tells the agent to end the turn without redundant
status/report calls; the scheduler waits for provider Idle before the next task. The Jobloop agent reviews every
proposed action; this integration does not autonomously loop over clicks.

The decision engine and DOM reader are based on the pinned upstream revision in
`vendor/jev-ultrafast/UPSTREAM.json` (MIT). The TypeSafe policy is adapted to Node
and runs over Jobloop-managed Chrome through Playwright/CDP. Python, Browser
Harness daemon setup and a second API key are not required. Visible page state,
the goal and recent actions are sent to TypeSafe. Unsupported frames/Shadow DOM
and complex keyboard widgets still need another browser integration.

## Normal Jobloop use

Run `pnpm start` from the normal Jobloop checkout, using its existing data directory.
Choose the existing candidate, then **Agent → Tarayıcı → Jev · mevcut Chrome’da tek pencere**
and select the candidate's signed-in Chrome profile. The saved setting applies to the
next agent launch. Existing running agents retain their current tools until restarted.
Do not use `pnpm demo:jev` for a normal campaign: that command deliberately creates a
separate temporary candidate and a bounded demonstration source.

For a source that should search through Jev, choose **browser** as that source's
search method. Sources configured for CLI tools keep their existing tool workflow;
Jev handles browser steps and configured browser fallbacks. The scheduler, source
intervals, deduplication, candidate facts, authorization and application policy are
unchanged. There is no three-listing limit in the regular integration.

Real signed-in LinkedIn search has been exercised end to end. Screenshot, upload,
selection and stale-action behavior have browser smoke coverage; arbitrary employer
application forms, frames and submission confirmation still require site-specific
verification. Jev does not expand the candidate's existing submission authority.

## Demo

```sh
pnpm demo:jev
```

For a real, search-only LinkedIn run instead of the synthetic page:

```sh
pnpm demo:jev --linkedin
```

This creates a separate **LinkedIn · Jev** workspace with only LinkedIn enabled,
searches Senior Python + Remote and asks the agent to inspect up to three real
listings. No candidate qualifications are inferred and no applications are sent.
The selected existing Chrome profile supplies the LinkedIn login. Login or access
barriers are reported instead of bypassed.

This builds and opens **the actual Jobloop app** with an isolated synthetic
candidate, Jev preselected, and only a local job-board source enabled. Click
**Agent’ı başlat**. The normal Jobloop agent then asks Jev to filter Python jobs
by Remote + Senior, supplies its own text, verifies Atlas Labs and Northstar and
reports the result. Synthetic listings are not saved as real applications.
The existing agent provider must already be signed in. Only TypeSafe adds an API
key requirement. This performs paid model calls under the configured providers.

Checks:

```sh
pnpm test
pnpm check
pnpm test:jev:existing # shared login, scoped windows, reconnect and draft recovery
pnpm test:jev        # real Chrome + mocked TypeSafe decisions; no paid calls
pnpm test:jev:performance # nested modal, compact output, exact select and retry guards
pnpm test:jev:live   # real TypeSafe, same MCP tools, synthetic text supplied by test harness
```

The live MCP smoke test is distinct from running the real Jobloop agent in the
demo. It checks the provider, observed actions and resulting DOM directly.

Form navigation uses session-bound `controls` and `scrollTargets` IDs returned
by observations. `browser_jev_reveal` reveals an observed field without clicking
it; `browser_jev_scroll` scrolls the selected container and verifies progress.
An open dialog excludes the background document from scroll targets. Native
dropdowns with more than 20 options use `browser_jev_select_option` with a unique
exact label/value from the agent's verified answer plan. It reveals the control,
checks visibility and current option identity, selects once, and verifies the
result. Custom dropdowns still use the reviewed next/act flow.

Open, the first observation, and URL/session-owner changes return full observations.
Subsequent observe and mutation results return deltas with `baseObservationId`,
changed `elements`/`controls`, `removedElements`/`removedControls`, and changed text
or links. Merge controls/scrollTargets by controlId, clickTargets by targetId,
and fillFields by fieldId when mapDeltas=true; delete IDs in removedControls/removedScrollTargets/
removedClickTargets/removedFillFields. Omitted entries are unchanged. Used click
and fill IDs are consumed; unaffected IDs can survive a fresh observation only
when their session, document, node and semantic guards match. Upload maps remain
complete replacements. Without mapDeltas=true, legacy click/scroll/fill maps
also replace their previous maps completely. Observe still reads
the live page; use `full:true` to rebuild state after losing the baseline.
Reuse fresh action results instead of automatically observing again. Next returns only a compact
decision and target context; never truncate tool JSON or field IDs. Unchanged
scrolls return `no_progress`. Mutations without an observed effect are uncertain;
identical retries on unchanged state are blocked, including reworded Jev goals.
This does not authorize consent or submission; candidate/source checks remain
with the Jobloop agent. Task startup uses one authoritative `get_task_context`.

### Autocomplete without model round trips

`browser_jev_autocomplete({tabId, controlId, text?, option})` uses the latest
`controls` entry marked `autocomplete: true`. It optionally types a verified
query, waits up to 2.5 seconds for associated suggestions, selects a unique exact
label, and verifies the visible value and closed dropdown. It supports ARIA
listboxes and field-scoped plain div dropdowns; unrelated matching page text is
never used. It does not write hidden selection fields or submit forms.

`needs_selection` returns the observed suggestions. Duplicate matches, covered
controls, replaced inputs, or rejected selections cannot report verified success.
Failed selection retries remain blocked even if the query argument is omitted.
Stale control/field IDs return fresh maps without writing, so an additional
`observe` is unnecessary. Reuse IDs only within their current agent session.

Run `pnpm test:jev:autocomplete` for an isolated real-Chrome test of the observed
Lever markup and ARIA variants. It never changes the live Midas application.

### Complete native dropdown options

`browser_jev_list_options({tabId, controlId})` reads all options of the observed
native select in one call, including exact labels/values, selected/disabled state
and groups. It does not open, scroll or change the form. Reuse this complete list
with `browser_jev_select_option` rather than guessing a translated name.
Optional `query` ignores case and accents; `limit` and `offset` enable pagination
only when requested. A failed exact selection returns `needs_selection` with
fresh controls and points to the list tool.

`pnpm test:jev:options` covers a 237-option fixture with the actual Midas Bilkent
label, full-list defaults, optional filtering/paging and selection guards.
