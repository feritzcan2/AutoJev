---
name: write-cover-letter
description: Write natural, factual cover letters for JobLoop applications and save a user-visible copy. Use when an application requires or the candidate requests a cover letter.
---
Adapted from MadsLorentzen/ai-job-search, `.claude/skills/job-application-assistant/03-writing-style.md` (MIT; see LICENSE). Source: https://github.com/MadsLorentzen/ai-job-search

Read the current candidate profile, CV, answers and target posting. Honor the candidate's language, declared language level, tone and document preferences. An explicit B1–B2 German writing preference calls for clear short sentences and familiar vocabulary, not native-level corporate prose. Do not change the CV unless authorized.

Write a short, conversational professional letter, generally 3–4 paragraphs and at most one page. Connect the candidate's real experience to the employer's tasks. Support the connection with one or two concrete examples from the candidate's records. Avoid repeating the whole CV. Use first person and active verbs. Avoid em dashes, generic praise and stock phrases such as “I am passionate about”, “leverage my skills”, “perfect fit” or “hit the ground running”. Do not force headings or a rigid template into every letter.

Reframe emphasis, never substance: academic work is not industry experience; adjacent skills are not direct expertise. The candidate should be able to explain every sentence in an interview without correcting it. Omit unsupported claims rather than adding a question or invented detail. Verify specific company claims from reliable sources before including them; omit unnecessary claims that cannot be verified. Never invent personal motivation.

Save the final text BEFORE using it in a form, even if the form only asks for pasted text. Use `documents/<company>-<job-id>/cover-letter-<language>-<timestamp>.md` inside the current candidate workspace. Save any generated PDF/DOCX alongside its source; inspect the generated document before use. Do not overwrite a previously submitted version. The desktop Files page automatically lists these files. Report the saved relative path through report_activity with jobId. File creation is not evidence of submission.

When submitting, use the exact saved version, and record the documents actually sent in record_submission. Continue within existing candidate authorization; creating a cover letter introduces no extra approval step. Do not add fit scoring, a personality interview or a mandatory second agent review.
