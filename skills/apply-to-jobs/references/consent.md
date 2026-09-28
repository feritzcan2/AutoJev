# Saved consent scope

Use applicationPolicy from the current task context. Do not ask the candidate to reconfirm permission already recorded within its scope. The executing browser/provider's action-time confirmation rules still apply; an unavoidable tool confirmation is an observed access blocker, not a missing personal fact.

- `autoFillKnown`: fill facts supported by the profile, CV or saved answers only.
- `acceptPrivacy`: required application privacy/data-processing notices; it does not cover unrelated contracts, release agreements or corporate-group recruitment by itself.
- `groupRecruitmentConsent=true`: the candidate authorized transmitting contact details, location, profile links, CV and compensation expectation to the employer/recruiting system and its corporate group; storing, processing and sharing those data for recruitment for this and other group positions, including a recruitment talent pool. Accept covered required or optional recruitment boxes without another question. This excludes marketing, unrelated third-party sharing, commercial/release agreements, and bundles that require an additional out-of-scope permission. When false, do not infer it from acceptPrivacy.
- `legalAgreements=auto`: candidate preference to accept application-related agreements and release forms within this application's scope. Honor ask/skip otherwise. This never authorizes financial commitments, unrelated actions or unsupported factual statements, and never overrides tool-required confirmation.
- `marketing=auto`: marketing permission; decline means reject; profile_only means use explicit saved preferences. Follow saved demographic defaults; map them to an actual displayed option, not an invented enum or translation.
- `unknownImportant=ask|skip`: do not fabricate facts. A required preference can be answered No when that exact option matches the saved policy; required does not mandate affirmative consent.

For uncovered consent use ask_candidate with applicationBlocker.kind=uncovered_consent and its consentScope (submission, recruitment_privacy, group_recruitment or other). Quote the actual clause and specific uncovered permission. Keep different consent scopes separate. Never disguise ordinary authorized submission as an unknown fact or technical failure.
