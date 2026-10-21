# Contributing

See [docs/development.md](docs/development.md) for setup.

Describe the behaviour of your change and the related verification in the PR
description. Use synthetic candidates, job listings and keys in tests; do not wire
tests that submit applications to real sites into CI. Preserve the task, browser
tab and candidate scope of concurrent workers.

```sh
pnpm vendor:verify
pnpm check
pnpm test
pnpm build
cargo test --locked --manifest-path engine/Cargo.toml --target-dir engine/target
```

For interface changes, run the relevant `scripts/smoke-*.mjs` scenario and check the
screen. For packaging changes, run `pnpm package:ci` and `pnpm test:packaged` on your
own operating system. Interface tests on Linux need Xvfb.

## Code layout

`app/main.mjs` sets up the app; the other modules live in folders by responsibility:

| Folder | Contents |
| --- | --- |
| `workspaces/` | Workspaces, storage, scheduler, documents |
| `automation/` | Agent turns: worker, tool calls, task context, recovery |
| `sources/` | Source scanning, recipes, collectors, trial runs |
| `records/` | Records, identity, record operations (prepare/apply) |
| `scoring/` | Scoring policy, thresholds, score record |
| `jev/` | Jev: page reading, decisions, form filling, task queue |
| `browser/` | Chrome connection, tabs, evidence, site access wait |
| `captcha/` | Verification page detection |
| `agents/` | Claude/Codex/OpenCode sessions, context, tool server |
| `channels/` | Notification channels (Telegram) |
| `templates/` | Template contract and catalog; `job-search/` holds everything specific to job search |
| `site-extensions/` | Site-specific readers (only on user request) |
| `system/` | Settings, backup, updates, maintenance |

The `extension/` folder at the repository root is the AutoJob Chrome extension
that Jev connects through (`chrome.debugger`). Packaging copies it as the `extension`
resource folder, and the user loads it into Chrome unpacked.

New text and rules specific to job search go under `templates/job-search/`, not
into the core folders. Formatting is kept with `pnpm format`; files that start with
`// @ts-check` are type-checked by `pnpm check`.
Method groups of large classes (`automation/store/`, `automation/web-template/`)
are kept in separate files and attached with `Object.assign(Class.prototype, ...)`.

All text in the app is English: UI, Telegram, notices, errors, agent-facing text,
comments and docs. Do not add Turkish strings.

If the data format changes, bump the version in
`app/system/data-management-schema.mjs` and add tests for backing up, upgrading and
restoring old data. Preserve source repository links and vendor licenses; do not
edit `vendor/termloop` files by hand or bypass the checksum verification.

CI verifies the exact commit on three operating systems. A public release needs
successful CI evidence for the same commit. Fork PRs have no access to private
runners or release secrets.

## Releases

To release, bump `version` in `package.json` and push it to `main`. When CI passes
for that commit, the release workflow tags it `v<version>`, builds signed macOS
and Windows packages, and publishes the GitHub Release that the in-app updater
reads. Pushes that leave the version unchanged release nothing. Pushing a `v*` tag
yourself or running the workflow manually still works; a manual run with
`platforms` set to `linux` still builds Linux packages.
