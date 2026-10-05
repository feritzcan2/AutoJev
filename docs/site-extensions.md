# JobLoop site extension architecture

Status: proposed design for the rewrite. Site extensions are a first-class product requirement and part of the [main architecture](architecture.md). Developers should be able to add support for a job board, employer site, or applicant tracking system without editing business modules or rebuilding browser and recovery logic.

Use one capability-based SDK for all sites. Each extension contains the knowledge specific to that site; a shared host runs it through controlled browser, HTTP, model, and execution services. All authored text and code are English. Model instructions remain in the central prompt package.

## Responsibilities and dependency direction

```text
Core use case
  -> Core port
  -> Site gateway adapter
  -> Site host and capability resolver
  -> Selected extension or generic reader
  -> Shared browser, HTTP and model services
```

This is an invocation path. At source level, extensions import the SDK, the host imports the SDK, and the gateway implements core ports. The composition root supplies implementations and the extension catalog. Core knows the requested operation and its normalized result, never the name of the site.

| Component | Owns |
| --- | --- |
| Site SDK | Manifest schemas, optional capability interfaces, normalized result types, scoped context contracts, contract test helpers |
| Site host | Registration, compatibility checks, resolution, bounded invocation, result validation, fallback decisions and diagnostics |
| Site extension | Supported hosts and routes, endpoint knowledge, selectors, parsers, identities, form mapping and receipt interpretation |
| Shared adapters | Browser sessions, HTTP transport, document access, model invocation and external action execution |
| Core and runtime | Candidate facts, fit, application authority, state transitions, task queue, persistence, budgets, retries and recovery |

No extension owns a scheduler, worker pool, database table, retry loop, candidate score, or submission policy. The host delegates timing and retry decisions to the same runtime used by generic automation. Its services enforce the current task and tab scope.

## Extension layout

```text
packages/
  site-sdk/src/
    manifest.ts
    context.ts
    results.ts
    capabilities/
    testing/                    # Separate public test-kit export
    index.ts
  site-host/src/
    registry.ts
    resolver.ts
    host.ts
    fallback-policy.ts
    ports/
    index.ts
  adapters/src/sites/
    site-gateway.ts
    context-factory.ts

extensions/
  catalog.ts
  sites/
    example-board/
      manifest.ts
      index.ts
      discovery.ts
      job-reader.ts
      application.ts
      tracking.ts
      identity.ts
      selectors.ts
      parsers/
      fixtures/
      tests/

packages/prompts/src/sites/
  example-board/
    interpret-form.md
    definition.ts
```

An extension creates only the files required by its capabilities. A read-only integration may need just a manifest, reader, parser, and tests. Pure parsing and identity functions are separate from operations that call host services.

`extensions/catalog.ts` explicitly registers built-in modules. Adding a site changes its folder, this composition catalog, and any corresponding central prompt entries. There is no site switch statement in discovery, scoring, submission, or scheduling.

A site extension is an application module, not a Chrome extension. The first version bundles repository-maintained extensions. SDK restrictions and lint rules establish boundaries for trusted code; they are not a security sandbox for arbitrary downloaded JavaScript. Third-party installation and its execution isolation are a separate future design.

## Manifest and configuration

Every extension declares:

| Field | Meaning |
| --- | --- |
| `id` and `version` | Stable integration identity and implementation version |
| `sdkVersion` | Supported SDK contract version |
| `matchers` | Explicit hosts, route scopes, and optional observed page requirements |
| `capabilities` | Implemented operations and supported search filters |
| `transports` | Browser, HTTP, or API access required per capability |
| `networkOrigins` | Origins required by each transport, including declared redirects |
| `configurationSchema` | Typed settings and their version; secrets are references |
| `promptIds` | Optional IDs from the central prompt registry |
| `checkpointVersion` | Format of the extension's bounded continuation metadata |

The host checks that declared capabilities have matching handlers and schemas. Configuration belongs to the source or application binding and is validated before execution. Extensions cannot add arbitrary persistence tables. Credential values are supplied only through scoped host services.

The source UI shows the resolved extension, version, capabilities, and latest structured issue. Disabling an extension prevents new invocations; active work stops at a controlled boundary and retains its checkpoint or uncertain submission hold. A different handler cannot silently take over an active send.

Matching uses parsed URLs and exact hostname boundaries. A matcher for `example.com` cannot match `example.com.other.test`. Wildcards, localized domains, tenant routes, query parameters, and SPA fragments have explicit fixtures. Domain knowledge belongs in the manifest and extension identity code, not in the host.

## Capability contract

Extensions implement only the operations they support. A job reader does not need a stub submitter.

| Capability | Input | Output |
| --- | --- | --- |
| `search.discover` | Search criteria and optional checkpoint | One bounded page or batch of job references and coverage evidence |
| `job.read` | Observed job reference | Structured job facts, availability, identity evidence, source provenance |
| `application.inspect` | Current application observation | Form fields, requirements, document slots, page stage, observed next steps |
| `application.planStep` | Fresh inspection and authorized answer/document bindings | One bounded action plan or a required input |
| `application.observeReceipt` | Current application attempt and fresh observation | Evidence of submitted, explicitly not submitted, or unknown outcome |
| `application.readStatus` | Known application identity | Observed employer status or unknown status with provenance |

An application-capable extension follows inspect, plan, execute, and reobserve steps. It does not receive a free-running `apply()` method that can submit or retry on its own.

The SDK exposes small interfaces along these lines; this is a contract sketch, not implemented code:

```typescript
interface SiteExtension {
  manifest: SiteManifest;
  discovery?: DiscoveryCapability;
  jobReader?: JobReaderCapability;
  applicationInspector?: ApplicationInspectorCapability;
  applicationPlanner?: ApplicationPlannerCapability;
  receiptReader?: ReceiptReaderCapability;
  statusReader?: StatusReaderCapability;
}

interface JobReaderCapability {
  read(
    input: ReadJobInput,
    context: ReadContext,
  ): Promise<SiteResult<ObservedJob>>;
}

interface ApplicationPlannerCapability {
  planStep(
    input: ApplicationStepInput,
    context: PlanningContext,
  ): Promise<SiteResult<ApplicationStepPlan>>;
}
```

The neutral SDK types describe observations and proposed actions. The gateway maps them into core types, where business invariants are checked. An extension cannot return a core entity and save it directly.

## Shared host services

The context includes a cancellation signal, deadline, invocation ID, task ownership, and only the services needed for that capability. Candidate information is limited to the allowed bindings for the operation. Discovery and job reading receive no applicant documents or submission tools.

- **Browser reading:** observe the assigned page, read declared DOM fields, inspect accessibility information, and follow observed navigation through shared commands. Site selectors can describe what to extract. Page reading, load checks, navigation ownership, and cancellation are implemented once.
- **HTTP reading:** request a declared read operation through the shared transport. The transport owns deadlines, response limits, credentials, pacing, redirects, and observed access failures. Private browser sessions are never silently replaced by an unauthenticated HTTP reader.
- **Model tasks:** invoke a declared prompt ID with validated bindings. This goes through the central prompt renderer and agent adapter. Extensions do not invoke a provider or compose prompts themselves.
- **Execution:** extensions return a typed plan containing observed targets, expected observation generation, allowed answer bindings, and required effects. The shared executor validates and executes that plan. It owns filling, upload, submission, and any API mutation.

Handlers cannot use raw `fetch`, browser-driver objects, filesystem APIs, subprocess APIs, or timers. Pure parsers may receive a bounded HTML or JSON value in RAM. A DOM extractor uses a defined read operation; the extension SDK does not expose unrestricted page JavaScript execution as a supposedly read-only capability.

Legacy CLI collection is an optional shared transport implementation. Its process management stays in an adapter and uses a fixed structured protocol. The extension does not supply arbitrary shell commands or own a background process.

## Normalized outcomes and completeness

Every result contains operation provenance: extension ID and version, capability, invocation ID, source URL, observation or request reference, and observation time. The host checks references against evidence created in this invocation or its valid retained context.

| Outcome | Meaning | Shared response |
| --- | --- | --- |
| `success` | Valid observed data for this operation | Normalize and pass to the owning use case |
| `pending` | Required content is still loading | Wait within the same deadline and task scope |
| `unsupported` | Operation, page, or required filter is unsupported | Consider the compatible generic capability |
| `layout_changed` | Recognized page no longer satisfies parsing expectations | Record a diagnostic; allow bounded read fallback |
| `blocked` | Login, verification, or observed access restriction | Preserve the shared blocker and recovery state |
| `not_found` | Explicit evidence that the exact resource is absent | Record observed absence with evidence |
| `failed` | Transport or execution failure | Classify for bounded recovery; preserve uncertainty |

Parsing zero cards is not proof of an empty search. Discovery distinguishes an observed complete page, confirmed exhaustion, partial coverage, and unknown coverage. An empty successful result or end-of-search claim requires evidence of that condition, such as an explicit API contract outcome or a recognized loaded empty-results state. Unknown markup produces `layout_changed` or `pending`, never a fabricated empty page.

The same distinction applies to job details. Missing description markup does not prove that a posting is closed. Unsupported filters are reported explicitly rather than silently omitted. Missing salary, language, or eligibility fields remain unknown facts for the shared matching rules.

Normalized job references include the observed URL, source, and optional external ID. External IDs are namespaced by provider and tenant where necessary. Alias proposals include their evidence. Changing extension versions does not change the provider identity or turn an existing application into a new one.

## Resolution and fallback

Resolve each capability against the current URL and observed page, including after navigation. A source's reader is not automatically the correct application handler.

1. Use an explicitly configured extension binding if it is compatible and matches the current scope.
2. Otherwise resolve matching enabled extensions using declared host and route specificity and, where needed, a bounded page recognition step.
3. If matching extensions remain ambiguous, return a configuration issue with the candidate matches. Registration order never breaks ties silently.
4. If no extension supports the operation, try the generic capability when it can operate in the same scope.

Use one selected handler for an operation. Record any fallback and its reason. Do not mix fields from unrelated page generations or merge competing parsers into a synthetic success.

Fallback is appropriate for an unsupported capability or a changed layout during reading. `pending` uses the same active load. `blocked` retains the same access barrier across transports. A timeout follows shared retry policy. These conditions must not start fresh requests through other transports to evade the existing task state.

After an external action, fallback first requires a fresh observation and an explicit checkpoint of what happened. Once submission may have occurred, no alternative handler can start another send. Receipt readers or the generic observer may assist reconciliation, but the shared application state determines whether execution can continue.

## Job board and ATS handoffs

A job found on one board may redirect to an employer site hosted by another provider. Discovery, job reading, form handling, and status reading can therefore use different extensions.

Preserve the candidate ID, canonical job ID, application ID, attempt ID, and current policy across the redirect. Resolve the destination capability from the observed destination, bind new page handles, and validate its requested effects. Keep separate source and application URLs in the record.

A board manifest does not need to enumerate every employer destination. The host validates an observed handoff against the application scope and resolves the destination's own transport and origin rules before continuing.

An applicant tracking system extension can support multiple employers using tenant-aware identity. Individual job-board extensions do not import that ATS extension or copy its form code; the shared host resolves it. Multiple aliases pointing to the same verified application target share duplicate protection.

## Submission and authority

An application plan can request filling, choosing an option, uploading an allowed document, navigating an observed step, or submitting. Every action references a fresh target or a declared typed API operation. The executor treats field autosave and upload as external transmission and validates them against current policy.

Before a potentially final action, the shared application use case reserves the attempt and daily budget. The executor checks the current policy revision, candidate, document hashes, browser identity, observation generation, and ownership token. An extension's label such as `read` or `safe` cannot downgrade the effect of a known action.

Receipt interpretation returns evidence rather than a command to mark the application submitted. The owning use case checks identity and outcome. Unknown receipts remain uncertain. Neither a broken extension, a version change, nor a switch to generic handling releases an unresolved submission hold.

## Checkpoints and versioning

The host returns validated continuation metadata for runtime persistence: extension and SDK versions, checkpoint version, search revision and fingerprint, cursor or URL, processed identities, and coverage state. The runtime stores it through its persistence port. Raw responses, full descriptions, rendered page text, model inputs containing that text, screenshots, session tokens, and Jev caches remain in RAM.

Process one bounded discovery batch at a time. Persist references and their checkpoint transactionally before advancing. After a crash, repeat reads as needed and deduplicate through stable identities. Extensions do not decide that all matching or application work has completed just because collection reached its last page.

Pin the extension version for a running operation. On upgrade, validate checkpoint compatibility. A compatible checkpoint can resume after fresh observation; an incompatible discovery checkpoint can restart with deduplication. Application attempts require reconciliation and cannot restart as new submissions. Transient tokens must be reacquired after restart.

## Centralized site prompts

All authored site instructions live under `packages/prompts/src/sites/<extension-id>`. The manifest references stable prompt IDs, and the central registry owns their versions, schemas, rendering, and evaluations. Reuse central fragments instead of copying base instructions into every site folder.

Most selectors, parsers, URL mappings, and API transformations should be deterministic code. Use a model only where interpretation is needed. Site prompts can explain form semantics; they cannot redefine candidate facts, eligibility policy, retry limits, or authority. Tool guidance and extension recovery messages sent to a model follow the same central catalog rule.

## Authoring and validation workflow

Provide a development command with an interface such as `pnpm site:create <site-id>` to generate a manifest, a minimal selected capability, fixtures, and contract tests. A companion `pnpm site:test <site-id>` runs manifest, boundary, parser, and shared contract checks. These commands are planned tooling, not currently available commands.

The normal authoring process is:

1. Declare supported hosts, capabilities, transports, filters, and configuration.
2. Implement pure parsers and identity rules against synthetic fixtures.
3. Connect capabilities to scoped SDK services, adding central prompt entries only if necessary.
4. Register the extension in the composition catalog.
5. Run the shared contract suite and controlled integration fixtures; expose supported and unsupported capabilities in the source UI.

Contract tests cover hostname boundaries, localized and tenant URLs, query and hash identity, missing capability handlers, ambiguous matching, delayed content, short valid descriptions, endless loading, explicit empty results, changed markup, pagination, unsupported filters, and stale observations.

Application tests also cover dynamic fields, document binding, board-to-ATS redirects, invalidated policy, cancellation, profile changes, and crashes immediately before or after a possible send. A failure in one site's invocation must not invalidate another task's context. CI uses synthetic applicants and forms and sends no real applications.

Static checks reject forbidden imports, private cross-site imports, direct model requests, raw transport access, and inline prompt instructions at defined boundaries. Use the contract suite for behavior; linting alone cannot establish correct completeness or submission evidence.

Fixtures are authored synthetic examples. Do not record live candidate pages, credentials, or raw production page caches into the repository. Integration observations and debug previews remain in RAM, with persistent diagnostics limited to structured metadata.

## Initial migration and completion criteria

Migrate the existing integrations as three implementations of the same SDK:

| Existing integration | New extension responsibility | Shared mechanism |
| --- | --- | --- |
| StepStone DOM reader | Result extraction, pagination interpretation and identity | Browser observation, readiness and task ownership |
| LinkedIn HTTP reader | Declared requests, card/detail parsing and identity | HTTP transport, access recovery, result validation |
| Himalayas API collector | Search mapping, filters, pagination and detail normalization | API transport, checkpoints and discovery workflow |

This migration describes code structure, not a guarantee that every remote endpoint is currently available. Each migrated extension must pass its new contract and controlled integration checks. Fix ambiguous empty-result and absence handling during the migration instead of preserving it as an extension-specific success rule.

The SDK is ready when a new fixture site can be added with its own folder, catalog entry, and optional central prompt entries while leaving core, workflow, scheduling, database schema, and shared browser recovery unchanged. Validate this with DOM, HTTP, and API fixtures plus a board-to-ATS application handoff before expanding the site catalog.
