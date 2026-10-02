# Personal web automations

The desktop keeps the original job-search workspace layout: the sidebar workspace
selector, **Başvurular** table, **Kaynaklar**, **Agent**, **Arka plan işleri**,
**Dosyalar** and profile pages. Existing job searches and generic automations share
the selector and navigation. Job searches retain their CVs, application state,
providers, browser modes, workers and Telegram settings. All templates use the shared
workspace, agent session, browser and scheduler services. Domain-specific task selection
stays in template extensions; see [the architecture](workspace-architecture.md).
**Yeni çalışma alanı** opens **Template’ler**, with job search, housing,
appointment monitoring/booking and custom workflows.

## Create and run

1. Choose a template. Housing, appointments and custom workflows create independent
   automation records; they do not create candidate profiles or require a CV.
2. Describe the goal on the **Agent** page. Each turn reads saved messages and answers,
   updates the plan and records its reply. Sending also saves edits on the setup
   profile as a draft; missing required fields do not block the conversation. Plain
   text in the source field is sent as a source request, not granted browser access.
   The interview can research public search pages and official sites through up to
   12 managed navigation/snapshot steps. Research does not allow form interaction,
   activate a source or replace setup review and the first source trial.
   Observed detail pages on saved source origins can be kept in the existing table
   as **Araştırma örneği** while personal criteria are still missing. These samples
   require a detail-page observation in the same turn, contain no action proposal,
   and cannot enter the action queue or replace live results and their approvals.
   A later normal scan must evaluate them before they become actionable findings.
   Progress and errors appear next to Send. **Agent ekranını aç** takes you directly
   to provider login or permission prompts.
3. Review **Çalışma alanı profili**: goal, criteria, source URLs, workflow, personal facts,
   action permission. Scan intervals are configured per source on Sources. Sources should link directly to the relevant results where possible.
4. Save the setup and run once or enable a schedule. There is no workspace-wide
   trial gate. Each source gets an automatic trial the first time it is dispatched.
   That trial opens only its assigned source, reads it
   and can save sample results. It can search, filter, paginate and dismiss cookies
   through `browser_interact`. The agent is instructed not to send external actions
   during a trial; browser tools do not enforce that distinction.
   The assigned source must have a fresh browser observation.
   The agent checks search/filtering, pagination, representative details and access.
   A successful trial
   ends that source turn; its next scheduled turn performs the normal workflow.
   Failed trials block only that source. Trial samples cannot trigger actions.
   The model must report access barriers as blocked, even if a login page is readable.
5. Check each source’s trial and scheduling status on **Kaynaklar**. New sources
   start with their own trial; existing source trials remain saved. The app and
   computer must remain awake and open.
   Missed intervals produce one subsequent run, not a backlog. Up to three generic
   automations run at once. Job-search workers retain their existing limits.

**Başvurular** shows findings in the existing table style, with search, filters,
stars, sorting and ten rows per page. **Detay** expands the full summary, action
proposal and observed evidence. The table loads the latest 500 records and displays
a notice when older records are omitted; JSON export includes the complete history.
**Arka plan işleri** uses the original run list and terminal layout. **Agent** keeps
the original activity panel, worker terminal, controls and inline settings. Type
directly in the terminal: while a provider is running, keystrokes go to its session;
when idle, Enter sends the typed request as a new conversation turn. Provider
settings save automatically and apply to the next launch. The optional conversation
panel keeps messages and attachments available.
Successive completed scans resume the conversation saved for that source, even
when a different worker handles the next turn or the app has reopened. Each turn
reads the current saved criteria, scan plan and progress; past completion and
blocker reports do not establish the current result. Changed search scope or
incompatible agent settings start a fresh conversation. Context renewal at the
configured threshold, rejected history, a failed previous scan and **Yeniden başlat**
also start fresh while preserving saved findings and scan progress. Source trials
and new record tasks keep their separate conversation rules.
System notifications announce completed runs and blockers when the app is not
focused. Telegram is available for all workspaces. Its record actions use the same
queue as the desktop, including verification of uncertain outcomes. Card fields
and status labels come from the workspace table and template.

## Agent-controlled tables

Ask the agent to add, rename, reorder or remove columns, or populate existing rows
from their saved details. For example: “Kira, oda, m² ve WBS koşulunu ayrı sütunlarda
göster.” The page layout stays the same. The worker uses `configure_workspace_table`
and `update_workspace_cells` in every template, including job searches; new findings can include cells with
`record_automation_result`.

Each workspace stores a validated table definition with 2–10 columns. Source and
title remain present. Custom columns support text, numbers, money, dates and web
links. Status, last activity and action controls are owned by the application.
These table tools accept data only; they do not execute HTML, scripts or SQL.
Column and cell edits preserve plan revision, trial evidence and action approvals.
Only an active worker for that workspace can invoke its table tools. Opening a
table conversation pauses scheduled work, as other setup conversations do.

## Permission and recovery

- **Bul ve bildir:** browse, search, filter and record results without sending.
- **Hazırla, onayımı bekle:** prepare proposals. The user can approve an individual
  proposal; the next run can execute that exact proposal. Editing its URL or text
  removes that approval.
- **Otomatik uygula:** the worker can reserve and execute prepared actions
  under the saved source permission.

All UI interaction uses `browser_interact` or the Jev decision tools in every mode.
No result, approval or action reservation is required before a browser interaction.
There is no separate browsing permission tool or button/keyword classifier.
The agent assesses authorization from user instructions, the saved mode and the
assigned task. Tool availability does not itself authorize an external action.

`reserve_automation_action` is required in an execute task before any external
submission or document upload. It persists the attempt durably for duplicate and
outcome tracking; the upload tool refuses to run without it. It does not grant browser access.
Daily and total action quotas and workspace expiry dates are not used.
`record_automation_outcome` verifies the recorded attempt against a fresh observation.
Session/workspace isolation, cancellation, browser-step limits and timeouts remain
enforced. Whether a page proves success remains the agent's responsibility.

The separate browser mode gives each automation a persistent Chrome profile.
Jev connects to the selected existing Chrome profile and uses the Jev configuration
in Settings. Select the engine and Chrome profile in the original Agent settings
panel. Changing either pauses the automation. Changing the browser engine resets
source trials; they run automatically when those sources are next dispatched.
Existing-account login may use credentials already filled by the selected browser:
Jev exposes `savedLogin.ready` and password-filled booleans without exposing passwords.
The agent may click the observed login button once, including during trial or verification.
Missing credentials, failed login and MFA require an evidence-backed question form;
the agent cannot close a reported login blocker with only a summary. Passwords and
verification codes are never requested in chat. Sources are task
starting points, not a browser-origin allowlist. Task-relevant links and redirects
can be followed without changing the plan; the agent assesses scope and authority.
Read-only navigation may still cause a website to log page visits or serve redirects;
the app does not claim HTTP-level isolation of website side effects.

The generic web workflow does not yet expose the job-search template's account
credential vault, password-fill tool or verification-mail browser step. Connecting
Gmail alone does not enable automatic signups in housing or custom workflows.
See [the Amsterdam live test](amsterdam-housing-live-test.md) for the observed limits.

Managed MCP checks govern tools supplied by the app. Installed CLI providers retain
their own permission settings and capabilities; the app instructs them to use the
managed browser for website interactions, with packaged source CLIs also available
through the provider's native terminal tool. Source instructions and the CLI command
are included in assignedSource. This is not an OS sandbox for arbitrary provider shell,
connector or browser tools. Use trusted providers and review their permissions.
The worker explicitly approves its named app tools for the provider session, so
reading context, saving a draft and reporting a result do not require repeated
terminal approvals. The browser action and budget gates still run on every call;
other provider tools keep their configured permissions.
App-created automation directories set Codex folder trust for each launch.
This avoids a hidden folder-trust prompt without
changing provider permission modes or the user's global trust configuration.

A successful trial confirms current access to representative results.
Later scans use the current workspace criteria, source query and saved progress.
A trial does not certify a portal's
booking flow, future availability, message delivery or payment support. Appointment
automation defaults to observation; automatic booking requires user-selected action
permission and a working site-specific flow. CAPTCHA and other access barriers are
handed to the user. Payments and cancellation are outside the default template.

Profile changes require a new review but preserve trials for retained sources.
The original trial runs remain unchanged. Legacy workspace-wide skips do not
count as source evidence. Changing source scheduling does not silently resume an automation. Blocked, failed and timed-out scheduled
runs suspend automatic retries. Editing a plan through chat pauses scheduling.
Stopping or restarting during a reserved action preserves an uncertain outcome.
An explicit goal-completed report ends scheduling.

## Reusable templates

**Template olarak kaydet** opens a review dialog for a title, description and workflow.

Templates may define `defaultSources`: named starting URLs with scan intervals,
enabled flags and source queries. The shared workspace creation
flow copies these presets once. Explicit source lists (including an empty list)
take precedence; editing or removing sources never restores the presets. The job
search template supplies 10 enabled sources and four disabled Denmark sources.
Template export/import preserves these presets separately from private workspace
source lists.
The template contains question definitions, workflow steps and table columns; it starts each new
automation with empty answers and its declared starting sources. The user reviews workflow text for
personal details before sharing it. Template export/import uses a bounded, validated
`loop-template` JSON document, not executable code. Imported and saved templates
default to observation and require setup review. Each source is automatically
trialled on its first turn in the new instance.

Example templates can be imported from **Template’ler**:

- [Germany housing search](examples/germany-housing.loop-template.json) asks for
  location, budget and housing requirements. It distinguishes cold and warm rent,
  extra costs, WBS and household restrictions, and records findings without sending
  applications. Each new instance starts with empty criteria and sources.
- [İzmir / Greece visa appointments](examples/izmir-greece-visa.loop-template.json)
  requires accessible appointment data before monitoring can be enabled.

## Data and implementation

- `automation-templates.mjs`: built-in templates and bounded schema validation.
- `automation-store.mjs`: templates, instances, conversations, results, reservations,
  run state, review revisions and trial evidence in SQLite.
- `workspace-scheduler.mjs`: one application scheduler for all template policies.
- `task-runs.mjs`: bounded task lifecycle for web templates.
- `web-template.mjs`: interview, trial and scheduled web task policy.
- `agent-sessions.mjs`: shared provider processes, terminals, resume and context tracking.
- `workspace-store.mjs`: common workspace identity, settings, conversations and table schema.
- `automation-worker.mjs`: isolated worker workspace and scoped MCP tools, using the
  existing provider engine.
- `automation-browser.mjs`: adapts the separate browser and existing Jev engine to
  the same scoped workflow tools.
- `automation-services.mjs`: Electron IPC, documents, exports and lifecycle hooks.
- `src/automations.js`: template catalog and shared workspace pages.
- `src/automation-results.js`: typed table columns, filters, sorting and row actions.
- `src/worker-pane.js`: shared worker frame for job searches and generic automations.
- `src/terminal-conversation.js`: editable terminal prompt when no provider is running.

Data schema version 4 migrates both workspace types into the common settings,
conversation and table-schema store. Earlier result cells, stars, plans and application
records keep their IDs and state. No legacy candidate rows are renamed or repurposed.
Documents live under `automations/workspaces/<id>/documents`; browser
profiles and run files live separately under `automations/`. Backups include the
database and automation workspace documents, excluding browser profiles and temporary
runtime credentials. Restore pauses automations, removes item approvals, invalidates
trial evidence and marks interrupted sends uncertain. Deleting an automation removes
its records, browser profile, documents and all retained run directories.

## Validation

```sh
pnpm check
pnpm test
pnpm build
pnpm engine:build
pnpm test:automations
pnpm test:automations:jev
pnpm test:ui
```

The automation smoke test uses real Electron IPC, SQLite, scoped MCP and a dedicated
Chrome against a temporary local listing/form server. Provider calls are controlled
test inputs, with no external accounts, messages or applications. It verifies template
selection through the original workspace shell, interview persistence, typed table
edits, search, independent settings/profile drafts, terminal typing in idle and active
sessions, persistent Jev selection, trial write denial, proposal
approval, a single form submission with evidence, reload, scheduling/pause and plan invalidation. It saves
screenshots in a temporary directory and prints its location.

The Jev integration test runs real Chrome against a local form with controlled model
decisions. It checks observed targets, field input, option selection, action approval,
a single verified submission and duplicate prevention.

## Template sözleşmesi ve ortak kuyruk

Sürüm 2 tanımları soru türlerini, kayıt durumlarını, sınıflandırma butonlarını ve bağımlı işlem adımlarını içerir. Bütün alanlarda 1–8 worker kullanılabilir. Kayıtlar `workspace_records`, görevler `workspace_tasks`, worker’lar `workspace_workers` içinde tutulur. [Mimari ve uzantı sınırları](workspace-architecture.md), [kodsuz eklenen araba template’i](examples/car-search.loop-template.json).

## İlan puanlama

İş arama kurulumu **Puanlama kriterleri** alanını içerir. Agent, CV ve tercihlere
göre kriterleri, toplamı %100 olan ağırlıkları ve varsa başvuru alt sınırını önerir;
kullanıcı bunları kurulum kartında kontrol eder. Kriterler profilden değiştirilebilir. **Agent ile kaynak bul** üzerinden açılan
sohbette de “Puanlama kriterlerimi belirle / güncelle” diyebilirsin; agent değişikliği
profil taslağına yazar, kurulum kartını kaydedince uygulanır.

İlanı bulan agent, yeni kaydı eklemeden önce aynı kriterlerle değerlendirir. Puan,
gerekçe, eşleşmeler, eksikler, belirsizlikler ve gözlenen ilan kanıtı kayıtla birlikte
saklanır. Değerlendirilemeyen ilanlarda sayı yerine neden gösterilir. Araştırma ve
deneme örnekleri puanlanmaz.

Kayıt menüsündeki **Puanla / Yeniden puanla**, seçilen ilanı mevcut worker kuyruğuna
ekler. Puanlama başvuru taslağını veya onayını değiştirmez. Puanın üzerine tıklayarak
gerekçeyi ve kullanılan kriterleri açabilirsin. Profil değişirse eski değerlendirme
işaretlenir; yeniden puanlama kullanıcı isteğiyle başlar. Eski çalışma alanlarında
puanlama kriterleri yoksa önce profilde belirlenmelidir.

Puanlama, hazırlama, uygulama ve doğrulama görevlerinde aynı işlem aynı hatayla
**3 kez** başarısız olursa uygulama ilgili agent oturumunu kapatır. Rapor vermeden ve hiç tarayıcı adımı atmadan duran bir kaynak oturumu da **5 kez** üst üste yeniden başlatıldıktan sonra kaynak `blocked` olur; ilerleme korunur ve **Tekrar dene** ile sürer. Hata hem kayıtta
hem müdahale uyarısında gösterilir; diğer worker'lar çalışmaya devam eder. Araç
parametrelerinin doğrulama hataları da sayılır. Araya başka araç çağrıları girmesi
veya gerekçenin değiştirilmesi sayacı sıfırlamaz; yalnızca ilgili işlemin başarılı
olması sıfırlar. Tarayıcı işlemleri sayfa ve eyleme göre ayrılır. Sayaç görevle
saklanır, oturumun tekrar açılmasıyla kaybolmaz. Kullanıcı **Tekrar dene** ile yeni
görev başlatabilir. Sonucu belirsiz gönderimlerde önce doğrulama gerekir.

Kontroller: `node --test tests/record-scoring.test.mjs tests/record-tool-guard.test.mjs` ve
`pnpm build && node scripts/smoke-record-scoring.mjs`.
