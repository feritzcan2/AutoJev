# Development

Technical notes for running AutoJob from source and working on it. For what the
app does and how to install it, see the [README](../README.md). For contribution
rules, see [CONTRIBUTING](../CONTRIBUTING.md).

## Running from source

Requirements: Node.js 22.22.3+, pnpm 10.14.0, Rust 1.90.0, and your operating
system's native build tools. Windows needs the MSVC tools, macOS needs the Xcode
Command Line Tools.

```sh
git clone https://github.com/feritzcan2/AutoJob.git
cd AutoJob
corepack enable
pnpm bootstrap
pnpm start
```

The TermLoop Rust modules and terminal packages that are needed live in
`vendor/termloop`, pinned to a commit with a SHA-256 manifest; a neighbouring
TermLoop repository is not required. The Jev key can be saved from the app; the
development alternative is the `.env.jev.example` file. Do not add real keys to Git.

```sh
pnpm vendor:verify
pnpm check
pnpm test
pnpm build
pnpm engine:build
pnpm test:ui
pnpm test:automations
pnpm test:automations:jev
```

The app's former name is JobLoop; the distribution ID and data folder are kept for
compatibility with existing JobLoop installations.

## How automations are built

All templates (job search, home search, appointment tracking, custom) share the
same record store, task queue, 1–8 worker infrastructure, Agent terminal and
browser management. A template defines the questions, columns, statuses and action
steps. Reusable templates can be saved and shared as a JSON file.

Each source carries an editable working instruction, an optional skill text and a
search recipe. The agent reads the source instruction and scans the source through
the Chrome instance managed by Jev. The first run of a source scanned by the agent
is an automatic trial: the agent checks search, pagination, detail reading and
access; later runs do a normal scan with the current criteria.

Site-specific knowledge lives in site extensions; see
[site-extensions.md](site-extensions.md).

## Listing decisions: agent or Jev

**Agent settings → Listing decisions** defaults to **This agent**, which needs no
TypeSafe key. With **This agent** the managed browser still reads pages, keeps the
queue and follows observed page numbers, but no model is called by Jev. Each results
page pauses so the worker agent chooses the listings to read, the agent picks the
next page when the page numbers do not show it, and every read listing waits in a
review batch for the agent's decision. The agent fills search forms itself, and a
search recipe is verified from the listings the agent selected at its address
(`url_template` only). This uses more of the agent's context than Jev.

To let Jev decide instead, switch it to **Jev (TypeSafe key)**, save the TypeSafe
API key under **Configuration → Jev** and test the connection.

## Himalayas collector

**Himalayas** uses the same site-extension registry as StepStone. StepStone reads
the listings on the open page; the Himalayas extension uses a dedicated CLI to
fetch, from the official API, the listings and full descriptions for the country
and query in the search recipe. The source agent fetches one page with
`collect_source_page`, then scores the listings that pass the shared Jev screening
and saves them to the table. The next page is not fetched until the review batch is
approved. No listing tabs are opened for the scan.

Older unscored CLI records are evaluated under the same identity when they are seen
again; rejected ones are stored with their reasons. The progress note in the source
details shows the collected, rejected, pending and saved counts. Older
`/jobs/countries/germany?q=...` recipes are converted to an API search with the same
filters. If the API does not support a custom filter, a clear error is shown.

The collector can also be run on its own:

```sh
pnpm collect --source himalayas --query backend --country DE
pnpm collect --source himalayas --all
```

The output is NDJSON pages followed by a final completion notice. `--max-pages 1000`
is the default limit of one CLI call; when the limit is reached, the exit code is 2
and `complete:false` is returned. The app uses the CLI with one-page calls per
review batch. Requests have timeouts, transient errors are retried at most twice,
and a stop request closes the child process. On a permanent error the source is
reported as incomplete; a rerun continues from the saved page. Raw API content and
full descriptions stay in RAM; a restarted app fetches them again. The source name
and the original listing link are kept on the record. The
[Himalayas API](https://himalayas.app/docs/remote-jobs-api) is cached; results are
not guaranteed to be up to the minute.

Listings that disappear from the results page on a reread are fetched by their IDs
from inside the CLI through the official
[single-job detail service](https://himalayas.app/docs/remote-jobs-mcp)
(`--detail-url LISTING_URL`). This uses no model. Addresses that cannot be read stay
in the queue while the other listings, pages and searches move on. A full scan is
not reported as successful until the gaps are resolved; a failed single-job query is
not retried within the same run. Collector error cards do not ask for a browser tab.

## OpenCode

OpenCode can be selected in the Agent settings. It uses the same OpenCode Go models
as TermLoop and the `default`, `plan` and `bypassPermissions` permissions. Session
resume, MCP tools and agent instructions are supported. Setup uses
`opencode auth login`; status tracking requires OpenCode 1.18.33–1.x. OpenCode v2
launch settings are recognised, but v2 cannot yet be used in AutoJob automations
because it has no status tracking or session resume.

OpenCode manages its own context compaction; AutoJob context thresholds and the
local plain-text conversation transcript currently apply to Claude/Codex. The
OpenCode conversation is shown in the agent terminal.

Real CLI/MCP test with a local mock model:
`pnpm engine:build && node scripts/smoke-opencode.mjs`.

## Data folder

- **Configuration → Data and backups → Open existing data folder** chooses an
  AutoJob data folder that contains `jobloop.sqlite`. The app restarts and uses the
  records in that folder on later launches too. For exported backups, use
  **Restore from backup**.
- Passwords and API keys saved by the app are removed from portable backups;
  secrets typed by hand into text are not stripped.
- Linux DEB installations are updated from the releases page; in-app updates are
  for AppImage.
