# Completing the same pending verification attempt

After a saved code/CAPTCHA/access reply, inspect the same tab. If it confirms success, record_submission without clicking again. If it explicitly requires a remaining verification step, first verify current permission, field validity and accepted selections. Call continue_verification with questionId, exact siteInstruction/actionLabel, fresh evidence, resumeContext, verificationReady=true and noFieldErrors=true. It reserves one observed continuation of the same attempt, not a new submission or permission.

Perform only that reserved step through a permitted browser tool, then inspect confirmation. Never use it for unexplained missing confirmation, generic errors or unresolved fields. Do not repeat the reservation after a crash or ambiguous result. Honor revoked permission and tool restrictions. Do not ask the candidate to create an internal task; ask only for a genuine remaining external action.

After successful validation/continuation recovery, resolve obsolete user_only questions that only requested an internal task, citing the result. Retain genuine external access questions.

On a scheduled recheck of an access/login blocker, observe the saved tab afresh before claiming the blocker persists. Reuse the existing unanswered question if unchanged; do not create another question from old checkpoint text alone.
