# Explicit field validation after a send

Only fresh field-level errors that explicitly prevented submission in the same open form justify record_validation_failure. Supply exact labels/messages, evidence, submissionPrevented=true and resumeContext. Follow its result to correct known values or ask all remaining questions together. This can recover a legacy uncertain record; generic errors, timeouts, CAPTCHA, an unchanged form or missing confirmation cannot. After correction inspect the changed fields and follow the normal authorized path. Recovery itself is not permission to submit.
