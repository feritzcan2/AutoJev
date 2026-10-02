# Agent workers

## Instruction layers

Every automation session receives the same small set of layers, in this order:

1. **AGENTS.md** (`AUTOMATION_INSTRUCTIONS`, about 6 KB): shared rules for every
   task — start-of-turn steps, Turkish user-facing language, authority and
   secrets, browser basics, CAPTCHA handling, recording findings, finishing.
   It contains no role-, template- or site-specific text.
2. **Role profile** as the provider system prompt: `web-interview`, `web-trial`
   or `web-run`. Each describes only its own task. The user can edit it per
   workspace on Agent → Talimatlar.
3. **Jev block** (`JEV_TASK_INSTRUCTIONS`): appended once to the role profile,
   only when the workspace browser mode is Jev. Playwright sessions never see it.
4. **First message** (`automationPrompt`): the assigned task, continuation state
   and, for Jev source work, a short delegation reminder.
5. **Context** from `get_automation_context`: saved criteria, assigned source or
   record, `scanInstructions`/`scanPlan` for source scans, `scoringPolicy` for
   templates with a scoring operation. Detailed coverage rules live here, not in
   the system prompt.

Changing any instruction text changes the protocol hash, so resumed
conversations start fresh after an update.

## Workspace conversations

In a configured web workspace, **Agent ile geliştir** opens a conversation that
runs alongside the source and record workers. Sending a message keeps their
sessions, queue and schedules running. The **Sohbet** terminal has its own history
and browser tabs and does not use one of the eight worker slots. After a reply,
the provider stays open in **Mesaj bekliyor**. Follow-ups go directly to that live
session instead of closing and resuming the provider for each message.
**Sohbeti kapat** closes only that conversation; the page header still stops the
whole workspace. Application shutdown and provider exit also end the live process.

The sidebar’s **Kurulum agenti** page shows one conversation timeline with an
always-visible composer. **Agent ile geliştir**, source suggestions and conversation
form links open this page. The selected page survives reloads, and switching pages
does not stop or recreate sessions. Source and record workers stay on **Agent**.
Enter sends; Shift+Enter adds a line. While a reply is running, the next message can
be drafted without losing it when updates arrive. Provider text updates in the same
bubble, with current tool activity and elapsed time shown below. OpenCode text is
read from its session database; hidden reasoning and tool output stay out of chat.
The **Sohbet** and **Terminal** tabs switch between the conversation and its terminal
in the same area. They preserve drafts, scroll position and the live session. The
selected tab is saved per workspace; form links always open **Sohbet**. Worker terminals
and settings remain on **Agent**. Sending a
message keeps focus in chat, and scrolling up preserves the reader's position.
Unanswered conversation forms appear inside that timeline, with **Formu aç**
linking directly to them. Source interventions remain visible on **Agent**. New questions preserve values and focus in forms already being
edited; submitted answers remain in the conversation.
The chat timeline includes messages explicitly marked as conversation or linked to
an interview run or its form. Recent run timestamps never determine membership.
Old messages without a confirmed origin remain in saved history and are omitted
from setup chat. Exact run links are resolved from durable storage even after a
run leaves the recent-run window.

Opening a chat reads compact current profile context and the latest user message.
Old messages, source-worker reports, answered setup forms, full template workflows
and table rows are not replayed. The provider retains its own conversation history.
Profile or permission changes trigger a context refresh on the next message;
current records are looked up only when needed for the request.

Questions raised in this conversation do not block source scans or record tasks.
Profile changes are proposed as a draft. Chat shows **Taslağı incele ve kaydet**
above the timeline, linking to **Çalışma alanı profili**. **Profili kaydet** stays
visible at the top of the profile and is available while workers run. Saving
validates the profile, stops the current workers, applies and reviews the profile,
then resumes enabled tracking with the new criteria. The setup conversation stays
open. Completed source trials retain their original result, run and timestamp;
profile edits restart ordinary scans without repeating those trials. New sources
still receive their own first trial. A durable pending update prevents old work from starting during this switch
or after an application restart. If stopping fails, the update remains visible for
retry and the active profile is unchanged. Paused tracking stays paused.
Initial setup uses the same dedicated conversation
worker from its first message; Worker 1 remains available for source tasks.

Source addresses are managed on **Kaynaklar**. Adding or removing a source keeps
the profile review, other source workers, and their scan progress. A source with
an active task must be stopped before removal. New sources still require their
own first trial. The profile form contains workflow instructions and criteria;
its save action cannot change source addresses.

The setup agent saves source suggestions separately from profile changes,
including during onboarding. Chat links to **Kaynak önerilerini incele**; the
Sources page lists additions and removals and lets the user apply or discard
them. Saving either draft preserves the other. Existing combined profile drafts
are split when loaded. A profile can be saved before sources are chosen; the
next step then opens Sources.

The setup page has its own provider, model, reasoning and permission settings.
They are pinned independently of source-worker settings. Saving an unchanged
selection keeps the current session. A changed launch selection or **Yeniden
başlat** opens a new setup conversation without stopping source workers. Closing
chat or restarting the desktop app preserves its native provider identity; the
next message resumes it. Context compaction keeps that identity, and automatic
context rotation is disabled for setup. Rejected resume attempts show an error
and retain the saved identity instead of silently starting fresh. Existing
interview identities from Worker 1 are adopted once, without adopting its source
conversations. Pending form answers resume the same setup conversation.

Conversation launches carry the current user message directly. Fresh sessions,
resumes and resume recovery do not receive old messages, summaries, worker reports
or result samples automatically. The default context contains current workspace
rules and the current request. Full profile, template and saved question details
are available through explicit `get_automation_context(section: ...)` calls.
`get_workspace_history` searches saved messages or run summaries in this workspace,
with bounded pages and optional record or message/run IDs. Agents should use it
only when the current question needs historical evidence. History remains saved;
it is not replayed into every conversation.

An existing candidate starts with **Worker 1**. On the Agent page,
click **Worker ekle** to add up to eight workers. New workers join a running campaign
immediately. Each worker has its own terminal, provider conversation, context
management and workspace. Provider/model settings come from the candidate profile.

Terminals appear side by side. Drag the divider, or focus it and use the arrow keys,
to resize them. Additional panes scroll horizontally. Each pane shows its assigned
job or source and offers Start, Stop, Restart and Remove. The page header controls
all workers. Worker 1 is retained as the first source/task worker.

## Scheduling and recovery

Every worker searches, ranks listings and processes applications from the shared
queue. Existing workers with a saved role are upgraded automatically. Candidate
authorization and source settings determine which application actions are allowed.

User-requested scoring, preparation, applications and verification take priority
over queued source searches, even when those searches were queued earlier. Each
scheduler tick assigns eligible user requests across all workspaces before
starting background work. Running source trials can share the worker pool with
record tasks. Active tasks finish normally; the next available compatible worker
takes the user request. Browser ownership, pending answers and authorization
checks still apply, and queued background work resumes when capacity is available.

Workers share candidate facts, questions, listings, retries and the application
target. A persisted task reserves its job or search source before a provider is
started. Other workers skip that reservation. Listings discovered in an unfinished
search stay with that search until it finishes. Submission slots count pending or
uncertain sends, and the target is checked again before recording `submitting`.

Stopping one worker leaves the others running. An interrupted send becomes
`uncertain` and is verified before any new submission. Task reservations survive
app restart, and worker conversations and task-context reviews are stored separately.
Terminal output is replayed while the desktop process is running, as before.

Source scans retain their provider conversation across completed cycles, technical
interruptions, access blockers and a later start after a manual stop. Creating a
new queue task or assigning a different worker does not reset that conversation.
An unfinished scan resumes its saved checkpoint and tabs. Stopping still prevents
automatic relaunch; reusing history does not schedule work. The latest inserted
source run selects the conversation, even if the system clock moves backwards.
Changed search scope or incompatible provider settings, context rotation, rejected
resume and a missing saved identity can still require a fresh conversation.

## Browser ownership

Jev shares the candidate's Chrome connection. Browser operations are queued, while
agent reasoning runs concurrently. A worker sees and operates only on its task's
tabs; saved source tabs can be recovered when their prior task is no longer active.
Queued requests from stopped sessions or superseded tasks are rejected.

Separate Chrome mode uses a profile per worker. Unfinished forms stay assigned to
that worker; it can be stopped but cannot be removed until those applications are
finished. Native provider browser tools use the candidate's existing browser and
the worker's task/tab instructions; JobLoop cannot enforce tab ownership inside
tools owned by the provider.

## Validation

`node --test tests/worker-pool.test.mjs` checks reservations, shared queues and limits,
candidate isolation, conversation/review persistence, scoped MCP calls, browser
ownership and cancellation during startup. `node scripts/smoke-worker-splits.mjs`
uses real Electron IPC, scheduling, MCP and terminal rendering with synthetic
provider output; it does not launch providers or submit applications.
