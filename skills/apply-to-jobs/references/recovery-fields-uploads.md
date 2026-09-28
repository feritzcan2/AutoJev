# Field entry and uploads

For BLOCKED, inspect returned targets and any overlay. Use an authorized exact clickTarget, reveal an offscreen control or take one screenshot when evidence is missing. Verify that the form actually opened; focus alone proves nothing. No overlay bypass, guessed targets or repeated uncertain click. Limit recovery to two distinct supported attempts against an unchanged blocker.

A known contact detail disappearing is an entry failure, not an unknown fact. Verify the actual editable field and required format. AX/DOM can redact a filled value: inspect a fresh screenshot before erasing/retrying it or asking for manual entry. If visually correct, continue. Try at most two distinct supported entry methods, checking values after each. Do not reload the draft or retry a submission.

For persistent entry failure that manual action can solve, ask with applicationBlocker.kind=access and recovery={kind:form_entry,attempts:[{method,result},{method,result}],visualCheck:{method:screenshot,result:empty or invalid,evidence},userActionReason}. Do not ask the candidate to supply already-known contact data again.

For the same file/field, uploads have at most two distinct supported attempts and 60 seconds total, including picker reopens/reselections and repeated confirmation screenshots. Inspect the existing filename and site acceptance first; reuse an accepted file. Read available tool troubleshooting, then preserve the draft and report a remaining technical failure. Ask for manual action only when it can fix the observed problem.
