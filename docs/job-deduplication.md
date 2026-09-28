# Vacancy identity and duplicate records

JobLoop owns vacancy identity. Agents pass observed URLs; URL adapters extract
platform IDs for LinkedIn, StepStone, Personio, Greenhouse, Lever, Ashby, JOIN,
SmartRecruiters, Indeed and N26. Employer-scoped platforms include the employer
in the key. Unsupported URLs use the existing conservative URL normalization;
unknown query parameters are retained because they can identify a vacancy.

## Discovery and application

- `check_jobs({jobs:[{url}, ...]})` checks up to 50 result URLs before detail
  retrieval. It is read-only and returns compact receipts and `needsResearch`.
- `add_job` checks the identity again under a SQLite writer lock, then either
  creates a record or remembers the alternate URL on the existing vacancy.
- `link_job_url({jobId,url,evidence})` records an observed Apply-link relationship
  to a supported employer/ATS vacancy. Similar titles are not evidence of that
  relationship. Generic login, search and success pages cannot supply identities.
- Application checkpoints and Jev observations automatically bind supported
  vacancy URLs. The `working`, `prepared` and `submitting` transitions recheck
  shared identity and ownership. Jev also rechecks the actual URL immediately
  before a final submission click. Native browser workflows must save their
  current checkpoint/link before requesting `submitting`.
- Company/title/location matching produces a possible-duplicate application
  guard, not a database uniqueness constraint. Different IDs within the same
  platform/employer namespace can remain distinct despite identical metadata.

## Persistence and history

`job_keys` enforces uniqueness on `(candidate_id,key)`. `job_urls` remembers all
observed aliases and their evidence. `job_members` links original job IDs to a
canonical job and indexes company/title candidates for secondary checks.

Startup removes the old metadata uniqueness constraint and indexes stored listing
and submission-proof URLs. The migration is transactional and repeatable. It
preserves all original job JSON, IDs, questions, proofs, documents and events.
Reindexing on startup also picks up newly supported routes and older imports.

Canonical selection prefers completed submissions, then uncertain/in-progress
work, open listings and skipped records. All original records remain addressable.
UI lists and counters show each vacancy once; **Bağlı kayıtlar** exposes linked
records and their proof/checkpoints. `list_applications(jobId)` includes related
application history and questions. Uncertain linked records remain independently
eligible for verification; deduplication never converts them to a successful send.

Both `submitted` and `already_submitted` appear under **Gönderildi** in the UI
and count toward the same application target. The stored status and proof keep
the origin of the confirmation. Saved filters for `already_submitted` migrate
to the combined submitted filter.

Worker reservations and submission budgets use canonical identity. Discovering
a shared identity during two existing tasks does not erase either task: the
duplicate task can report completion, and new submissions remain guarded.

## Validation and rollout

Run `node --test tests/job-registry.test.mjs`, `npm test`, `npm run check`,
`npm run build`, and `node scripts/smoke-job-duplicates.mjs`.

Before updating a real workspace, make a consistent SQLite backup (including WAL
contents through the backup API). Validate migration on a copy. Restart JobLoop
through its normal quit path so ongoing sends recover as uncertain. Avoid running
an older build against a migrated database: it does not understand canonical
membership. To roll back, stop JobLoop and restore the complete backup with the
matching application version; retain newer history before any restoration.

Unsupported platforms still get exact normalized-URL matching. Cross-platform
identity requires a recognized observed destination or saved submission-proof URL;
metadata-only similarities are intentionally not merged automatically.
