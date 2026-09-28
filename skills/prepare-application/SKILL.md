---
name: prepare-application
description: Inspect an assigned JobLoop application form and prepare its documents and answer drafts when the task kind is preparation. Stop at the saved application package.
---

# Prepare an application

Use the single `get_task_context` result for the task, candidate facts, CV, saved replies, `documentRoot`, previous package and current revision. `applicationAuthorization.mode=prepare` permits preparing this job regardless of research/source/score settings, but never sending. Profile auto-submission does not widen this task.

## Inspect the actual form

Use `resume_application(jobId)` in Jev; other backends resume the saved tab or open the exact listing. Verify company, role and account. Inspect accessible form steps including fields below the fold. Record observed document requirements, required/optional/unknown, accepted formats, language, limits and questions with the site's evidence. An advertisement alone is not complete form inspection. Preserve the tab with `save_application_checkpoint`.

Advance ordinary form steps only with known facts and existing consent. Keep documents local by default. Uploading or saving candidate data to the employer requires existing permission for that transmission; a local preparation request alone does not grant it. If later requirements are inaccessible, record coverage=partial and the exact stopping point. Never click final Submit, use submitting status, or send just to discover validation errors.

## Prepare and save

Reuse the candidate CV. Preserve the unchanged-CV preference; create a separate tailored version only when the candidate permits it. Read `../write-cover-letter/SKILL.md` when a letter is needed. Write employer-facing content in the requested language, using verified facts. Certificates/diplomas must come from existing documents. Do not manufacture them.

Save artifacts under `documentRoot/documents/<job-id>/` with distinct versioned filenames. Create this directory if needed. This absolute shared candidate directory also applies to additional workers. Return paths relative to `documentRoot` in `save_preparation`. Keep an editable source alongside a requested PDF/DOCX and inspect rendered output before marking it ready. For pasted text use an answer requirement; honor character limits. Required files must match the actual requested format and size; supply acceptedExtensions such as [".pdf", ".docx"] when observed.

Use stable requirement IDs across refreshes. Keep `userEdited` answers and documents exactly as saved, including when requirements are re-inspected. Never overwrite any submitted or edited file. If a changed requirement makes an edit unsuitable, preserve it and record the specific gap.

Call `save_preparation` with the current revision, profileKey=job.preparation.currentProfileKey, and full requirements list after inspection and after material progress. Reuse each returned revision. Complete useful documents/answers before asking about missing facts. For an observed required unknown, read `../apply-to-jobs/references/questions.md`, save progress, then use `ask_candidate`; it ends the task atomically. Preserve existing unanswered questions. For login or browser failures use only the matching recovery reference linked from apply-to-jobs.

Set ready only after complete form inspection and all required items are ready. Otherwise save partial with an honest coverage note and missing requirements. Missing required facts that the candidate can answer use waiting and `ask_candidate`. Report done for a saved ready/partial package with `report_campaign_work`. Prepared package completion is independent of form completion. Leave submission to the user's separate Başvur action.
