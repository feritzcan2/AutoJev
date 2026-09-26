# Jev inside Jobloop

Jev is a browser tool for the existing Jobloop agent. The agent plans the task,
reviews Jev's proposed action and supplies exact text when the operation is
TYPE_TEXT. There is no separate text-generation model or OpenRouter dependency.

Set `TYPESAFE_API_KEY` in the repository's ignored `.env.jev` file (or the app's
environment). `TYPESAFE_MODEL` defaults to `jev-latest`. The application reads
only those settings; it never passes the key to the agent or renderer.

In Jobloop select **Agent → Tarayıcı → Jev · mevcut Chrome’da yeni pencere**, then restart the
candidate's agent. It receives these MCP tools:

- `browser_jev_open` / `browser_jev_tabs` / `browser_jev_observe`
- `browser_jev_screenshot`: inspect the visible form before escalating input failures
- `browser_jev_next`: propose one action, without executing it
- `browser_jev_act`: execute the reviewed decision once; the agent supplies `text`
- `browser_jev_upload`: upload an observed file input from this candidate's workspace

Jev opens a new window in the selected existing Chrome profile and reuses its
signed-in session. Choose the profile in Agent settings. Chrome must already be
running with remote debugging enabled in `chrome://inspect/#remote-debugging`;
accept Chrome's connection prompt when shown. The app does not change this
security setting automatically or fall back to an empty profile. Only windows
created for this candidate and their popups are exposed to the agent. Existing
personal tabs are not exposed. Disconnecting Jobloop leaves Chrome open.
Source checkpoints focus the exact tab while the connection is alive; restarting
the whole app does not restore ownership of previous task tabs automatically.

Decisions are tied to the current candidate, agent session, observed page and a
single-use decision ID. Stale or covered targets are rejected. Execution failures
after input are marked uncertain and must be observed before retrying. Jev's
DONE is not proof of submission; Jobloop's existing record_submission workflow
and candidate/source permissions still apply. The Jobloop agent reviews every
proposed action; this integration does not autonomously loop over clicks.

The decision engine and DOM reader are based on the pinned upstream revision in
`vendor/jev-ultrafast/UPSTREAM.json` (MIT). The TypeSafe policy is adapted to Node
and runs over Jobloop-managed Chrome through Playwright/CDP. Python, Browser
Harness daemon setup and a second API key are not required. Visible page state,
the goal and recent actions are sent to TypeSafe. Unsupported frames/Shadow DOM
and complex keyboard widgets still need another browser integration.

## Normal Jobloop use

Run `pnpm start` from the normal Jobloop checkout, using its existing data directory.
Choose the existing candidate, then **Agent → Tarayıcı → Jev · mevcut Chrome’da yeni pencere**
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
pnpm test:jev:existing # shared login, new windows, candidate scope and safe disconnect
pnpm test:jev        # real Chrome + mocked TypeSafe decisions; no paid calls
pnpm test:jev:live   # real TypeSafe, same MCP tools, synthetic text supplied by test harness
```

The live MCP smoke test is distinct from running the real Jobloop agent in the
demo. It checks the provider, observed actions and resulting DOM directly.
