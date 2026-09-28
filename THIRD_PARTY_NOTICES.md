# Third-party notices

JobLoop includes and adapts the following source components. Their original
notices remain in the repository and distribution. The JobLoop commercial
licensing option does not remove third-party license obligations.

| Component | Source / revision | License / notice |
| --- | --- | --- |
| TermLoop Rust engine modules, terminal-wire and terminal-surface | [feritzcan2/termloop](https://github.com/feritzcan2/termloop), `652b54d7decc84e9e380ca0f247ad6b7dd1ffe0b` | GPL-3.0-or-later; upstream also offers commercial licensing. `vendor/termloop/LICENSE` and `UPSTREAM.json` |
| ai-job-search source tools and skills | [MadsLorentzen/ai-job-search](https://github.com/MadsLorentzen/ai-job-search), `120f476a089358363ceaf2528f52edf2854994bd` | MIT, Copyright 2026 Mads Lorentzen. `vendor/ai-job-search/LICENSE` |
| jev-ultrafast snapshot and adapted browser code | [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast), `1231850a0bf1a0c0341fe408ef1668dbbfdfac46` | MIT, Copyright 2026 Browser Use. `vendor/jev-ultrafast/LICENSE` |
| JetBrains Mono terminal font | Included through TermLoop terminal-surface | SIL Open Font License 1.1, `vendor/termloop/clients/terminal-surface/src/assets/fonts/OFL.txt` |

Electron, Chromium, Node.js, xterm.js, Playwright, Model Context Protocol SDK,
electron-updater, WebSocket and source-tool dependencies retain their upstream
notices in their installed packages or Electron's license files. JavaScript
versions are fixed in `pnpm-lock.yaml`; Rust versions in `engine/Cargo.lock`.
Source-tool dependency versions are recorded in their vendored Bun lockfiles.
The bundled source CLIs also include Bunli and OpenTUI code and OpenTUI's native
libraries under their MIT licenses; corresponding notices ship with the bundles.

The matching JobLoop release tag contains the application source, build scripts,
TermLoop source subset, package provenance and license texts. Use that tag to
reproduce a release; see `docs/releasing.md`.
