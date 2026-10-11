# AutoJev · Web automations

AutoJev is a desktop app that manages personal web tasks through automations set
up with templates and an assistant. The job-search interface keeps its workspace
selector, the **Applications** table, and the Sources, Agent, Background work and
Files pages. Job search, home search and appointment tracking share this layout.
The agent learns what you need by asking questions and adapts the profile and the
table columns to the automation. All templates share the same record store, task
queue, 1–8 worker infrastructure, Agent terminal and browser management. A template
defines the questions, columns, statuses and action steps.

The job-search template uses the existing JobLoop candidate profiles, CVs,
applications and Telegram connections. Other automations have their own
conversation, sources, browser settings, permissions and result history. Reusable
templates can be saved and shared as a JSON file. The interface is in English.

Use **Sources → Add source** to add a site address, or **Find with the agent** to
research sources. Each source carries an editable working instruction, an optional
skill text and a search recipe. The agent reads the source instruction and scans the
source through the Chrome instance managed by Jev.

Among the job-search sources, **Himalayas** uses the same site-extension registry
as StepStone. StepStone reads the listings on the open page; the Himalayas extension
uses a dedicated CLI to fetch, from the official API, the listings and full
descriptions for the country and query in the search recipe. The source agent
fetches one page with `collect_source_page`, then scores the listings that pass the
shared Jev screening and saves them to the table. The next page is not fetched until
the review batch is approved. No listing tabs are opened for the scan.
Older unscored CLI records are evaluated under the same identity when they are seen
again; rejected ones are stored with their reasons. The progress note in the source
details shows the collected, rejected, pending and saved counts. Older
`/jobs/countries/germany?q=...` recipes are converted to an API search with the same
filters. If the API does not support a custom filter, a clear error is shown.

The collector can also be run from source on its own:

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

**Getting started:** New workspace → choose a template → talk to the Agent → save
the profile → run once or on a schedule. The first run of a source scanned by the
agent is an automatic trial. The agent checks search, pagination, detail reading
and access through the Chrome instance managed by Jev; later runs do a normal scan
with the current criteria. For scheduling, the app and the computer must stay on.
The app's former name is JobLoop; the distribution ID and data folder are kept for
compatibility with existing JobLoop installations.

## Installation

Use the package for your operating system from the
[Releases](https://github.com/feritzcan2/AutoJev/releases) page:

| System | Package | Architecture |
| --- | --- | --- |
| macOS | DMG / ZIP | Universal: Apple Silicon and Intel |
| Windows | NSIS installer EXE | x64 |
| Linux | AppImage / DEB | x64 |

The current release is [v0.1.2](https://github.com/feritzcan2/AutoJev/releases/tag/v0.1.2).
It contains shared workspaces, automation templates and the local changes collected
during release preparation (`1320b7e`).
The macOS package is signed with a Developer ID and notarized; the Windows EXE is
not code-signed in this release. On request, tests were not run for this release;
native build, signing and package integrity checks were applied.

If you got stuck at profile preparation in 0.1.0, close the app, install the new
package and open it again. The saved profile and CV are kept; preparation is retried.

### Before you start

1. Install [Codex CLI](https://github.com/openai/codex),
   [Claude Code](https://code.claude.com/docs/en/overview) or
   [OpenCode](https://opencode.ai) (1.18.33–1.x) and sign in with your own account
   in the terminal. Provider usage is subject to your account's pricing and data
   terms.
2. Install Google Chrome for general web automations. In the Agent settings you can
   choose a separate browser or Jev. The separate browser opens its own profile for
   each automation; use the **Open browser** button to sign in to your accounts.
   When using Jev, open `chrome://inspect/#remote-debugging` in your existing Chrome
   and allow the connection request. In the agent's own browser mode, enable the
   tools inside the agent.
3. If you will use Jev, save the TypeSafe API key under **Configuration → Jev** and
   test the connection. Sources are scanned through the selected browser.
4. Open a job search with the **New workspace** button and check the workspace
   profile. Add the candidate profile and CV; choose the application permission and
   preferences.

The portal membership password is stored to **create new job-site accounts** on
behalf of that candidate. Each candidate's record is separate. It does not assume
it is the password of an existing account.

## Automatic CAPTCHA solving

Under **Configuration → CAPTCHA**, save the CapSolver API key, check the connection
and balance, and turn on automatic solving. The daily limit on solve requests is
shared by all workspaces; it resets each UTC day and is kept when the app is
reopened. Each new round of an image CAPTCHA counts as a separate request.

The app checks for a visible and active verification; it does not send a paid
request for a script, a hidden widget or old error text alone. Supported are
reCAPTCHA v2 image selection, eligible reCAPTCHA v2/Turnstile token flows, and
CAPTCHA text images clearly associated with an answer field. Solving runs in the
same tab; other workers keep working. If the task is stopped or the page changes,
the old answer is not applied.

While automatic solving is on, full-page verification in reading tabs is examined
too. If the sitekey and result callback of a visible, active Turnstile widget are
verified, the CapSolver token API is used. Explicit render parameters are captured
while the page loads; missed parameters of an existing page are not guessed and no
automatic reload is done. The answer is given once, only to the verification
callback of a reading tab without a form. After the API answer, the app separately
verifies that the block is gone and the page content can be read. Other workers are
not held in the queue while it waits.

If API details are missing, a visible Cloudflare box can be tried once; this local
attempt sends no paid API request. Cloudflare's managed Challenge flow, which
requires `chlPageData`, is not sent to the Turnstile API; if a proxy/clearance
integration is not supported, the reason is reported. The shared wait is kept on
real rate limits.

Forms that may submit require the existing action permission. An API answer alone
does not show that the site accepted the verification. Unsupported puzzles,
persistent full-page access blocks and rejected answers ask for intervention in the
current tab. The key is stored encrypted and is not included in portable backups.
CAPTCHA images and temporary solving data are kept in RAM; during solving the
relevant data is sent to CapSolver.

## Data and updates

- With **Configuration → Data and backups → Open existing data folder** you can
  choose an AutoJev data folder that contains `jobloop.sqlite`. The app restarts
  and uses the records in that folder on later launches too. For exported backups,
  use **Restore from backup**.
- Profiles, CVs and application history are in the app's local data folder.
  When the Agent, Jev and Telegram are used, the relevant data is sent to external
  services.
- With **Configuration → Data and backups** you can export candidates and documents
  and restore from a backup. Passwords and API keys saved by the app are removed
  from portable backups; secrets typed by hand into text are not stripped.
  Backups contain personal data, so keep them in a safe place.
- Checking for and downloading updates starts from the **Updates** section. Before
  installing, you are asked to stop tasks and a backup is taken automatically.
  Linux DEB installations are updated from the releases page; in-app updates are
  for AppImage.

## Running from source

Requirements: Node.js 22.22.3+, pnpm 10.14.0, Rust 1.90.0, and your operating
system's native build tools. Windows needs the MSVC tools, macOS needs the Xcode
Command Line Tools.

```sh
git clone https://github.com/feritzcan2/AutoJev.git
cd AutoJev
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

Contributing: [CONTRIBUTING](CONTRIBUTING.md).

## Support and license

Report bugs through [Issues](https://github.com/feritzcan2/AutoJev/issues).
Do not share CVs, candidate data, bot tokens or raw terminal logs.
For security vulnerabilities, use the private channel in [SECURITY](SECURITY.md).

AutoJev is offered under GPL-3.0-or-later and commercial license options; see
[LICENSE](LICENSE). Third-party components are subject to their own licenses:
[notices](THIRD_PARTY_NOTICES.md).

### OpenCode

OpenCode can be selected in the Agent settings. It uses the same OpenCode Go models
as TermLoop and the `default`, `plan` and `bypassPermissions` permissions. Session
resume, MCP tools and agent instructions are supported. Setup uses
`opencode auth login`; status tracking requires OpenCode 1.18.33–1.x. OpenCode v2
launch settings are recognised, but v2 cannot yet be used in AutoJev automations
because it has no status tracking or session resume.
OpenCode manages its own context compaction; AutoJev context thresholds and the
local plain-text conversation transcript currently apply to Claude/Codex. The
OpenCode conversation is shown in the agent terminal.

Real CLI/MCP test with a local mock model: `pnpm engine:build && node scripts/smoke-opencode.mjs`.
