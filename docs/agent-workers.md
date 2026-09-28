# Agent workers

An existing candidate starts with **Worker 1**. On the Agent page,
click **Worker ekle** to add up to eight workers. New workers join a running campaign
immediately. Each worker has its own terminal, provider conversation, context
management and workspace. Provider/model settings come from the candidate profile.

Terminals appear side by side. Drag the divider, or focus it and use the arrow keys,
to resize them. Additional panes scroll horizontally. Each pane shows its assigned
job or source and offers Start, Stop, Restart and Remove. The page header controls
all workers. Worker 1 is retained for onboarding and the existing single-worker flow.

## Scheduling and recovery

Every worker searches, ranks listings and processes applications from the shared
queue. Existing workers with a saved role are upgraded automatically. Candidate
authorization and source settings determine which application actions are allowed.

Workers share candidate facts, questions, listings, retries and the application
target. A persisted task reserves its job or search source before a provider is
started. Other workers skip that reservation. Listings discovered in an unfinished
search stay with that search until it finishes. Submission slots count pending or
uncertain sends, and the target is checked again before recording `submitting`.

Stopping one worker leaves the others running. An interrupted send becomes
`uncertain` and is verified before any new submission. Task reservations survive
app restart, and worker conversations and task-context reviews are stored separately.
Terminal output is replayed while the desktop process is running, as before.

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
