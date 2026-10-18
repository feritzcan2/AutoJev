// @ts-check
// Every execute task applies the record in one pass; there is no saved draft
// or approval step. Short numbered steps: the agents reading this are not experts.
export const directRecordInstructions =
  "The user asked to apply to this record now. Steps: 1. Open the listing and reach the real application form. When the page hands the application over to another site (a link or note saying it continues on the employer's or another website), open that link and continue there: a status such as Applied that a listing site shows after this click-through only records the redirect, not a submitted application. If the page says the listing is no longer available (removed, expired, not found, no longer accepting applications), read it once more; if it still says so, call record_automation_outcome with status=closed and that exact sentence as evidence, then finish completed. If it says the user already applied to this listing, do not apply again: call record_automation_outcome with status=applied and that exact sentence as evidence, then finish completed. 2. Call browser_jev_inspect_form and list every required field and upload. 3. Answer each field from the saved profile, documents and earlierAnswers; map a saved answer to the form option with the same meaning, and use what the profile directly implies (someone who already lives in the city of the job needs no relocation; a full-time role means the standard full-time week, for example 40 hours; how you heard about the job is the site of the listing URL; whether the user worked at a company follows from the employment history in the CV). Never invent a fact. Do not ask permission for any step of this application: the request to apply already approves it. If the site asks you to register or create a candidate profile before applying, fill that form from the saved profile, accept its terms and continue without asking. Only a password the user never saved or a code sent to the user (email, SMS) needs the user: keep the tab and finish blocked naming that step. 4. Only if a required fact is still missing, ask ONE ask_workspace_question with this recordId that contains one typed field per missing fact, then finish blocked; the answer resumes this application. 5. Fill the form, upload the documents from the workspace documents folder, tick consents the saved application policy allows. 6. Call reserve_automation_action, then click the final submit button once. 7. Read the fresh page and call record_automation_outcome: completed when the site that received the form confirms, otherwise uncertain. Never click submit twice; an unclear result is uncertain, not a retry. record_automation_result is optional notes, not a requirement.";

export const recordOperationDefaults = {
  score: {
    label: 'Score',
    runningLabel: 'Scoring',
    instructions:
      'Assess only the assigned record. Read its full live detail (keep any retained form intact), the saved criteria.ranking, facts and documents, and follow scoringPolicy.instructions. Save an integer score 0–100 with record_automation_score; eligibility and reasons are optional extras. If the detail cannot be read, save status=unavailable with score=null and the observed reason. Do not change proposals, fill forms, upload or submit. Finish after saving.',
    successCriteria:
      'A score from this run is saved with record_automation_score; inaccessible details are recorded as unavailable without a fabricated score.',
  },
  prepare: {
    label: 'Prepare action',
    runningLabel: 'Preparing',
    instructions:
      'Inspect the assigned record and the actual destination form. Prepare the complete intended action using saved criteria and verified personal facts. Include the destination, all answers, document paths and any commitments in the proposal. Ask missing facts with ask_workspace_question and this recordId. Save the proposal with record_automation_result. Do not submit, send, book or create an external commitment.',
  },
  execute: {
    label: 'Run',
    runningLabel: 'Running',
    instructions: directRecordInstructions,
  },
  verify: {
    label: 'Verify outcome',
    runningLabel: 'Verifying',
    instructions:
      'Inspect only whether the assigned record’s earlier action succeeded. Use its retained page, confirmation or history. Never resubmit, reserve another action or change the proposal. Call record_automation_outcome with current evidence. If the portal explicitly identifies this exact action as a draft, not submitted, or rejected before submission, report not_submitted with the current snapshot and record identity; a status description is optional. Inspect the site’s history/status if necessary without discarding the retained form. An unfinished form, missing attachment, or absent success message alone is not proof. If inconclusive retain uncertain and explain what is missing. After not_submitted finish completed; the application separately resumes an unchanged authorized execution or requests review. Never execute in this verification task.',
  },
};

export const UNSTATED_CHECK = 'Do not apply until checked',
  UNSTATED_MET = 'Treat as met';
// Every workspace scores its records. The setup agent writes the rubric for the
// workspace's own goal; templates do not define scoring criteria themselves.
export const scoringFields = [
  {
    id: 'ranking',
    label: 'Scoring criteria',
    question:
      'Which criteria should records be scored by, 0–100? The setup agent suggests them; free text.',
    required: false,
    type: 'text',
  },
  {
    id: 'score_threshold',
    label: 'Minimum score for automatic action',
    question: 'Lowest score for automatic action, 1–100 (default 60)',
    required: false,
    type: 'number',
  },
  {
    id: 'unstated_conditions',
    label: 'When a listing does not mention a required condition',
    question:
      'Treat it as met, or do not apply automatically until it is checked (default). An explicit restriction always excludes the listing.',
    required: false,
    type: 'choice',
    options: [UNSTATED_CHECK, UNSTATED_MET],
  },
  {
    id: 'save_score_threshold',
    label: 'Minimum score to save',
    question:
      'New results below this score are not saved. 0–100; leave empty to keep results regardless of score.',
    required: false,
    type: 'number',
  },
];
export const withScoringFields = (fields) => [
  ...fields,
  ...scoringFields.filter((field) => !fields.some((f) => f.id === field.id)),
];

export function normalizeRecordOperations(input, driver) {
  if (driver.id !== 'browser') return {};
  if (input != null && input !== false && (typeof input !== 'object' || Array.isArray(input)))
    throw Error('Invalid record operations');
  const result = {};
  for (const key of Object.keys(input || {}))
    if (!Object.hasOwn(recordOperationDefaults, key)) throw Error('Unknown record operation');
  for (const [kind, defaults] of Object.entries(recordOperationDefaults)) {
    // Templates may switch off outgoing operations, never scoring.
    if (kind !== 'score' && (input === false || input?.[kind] === false)) {
      result[kind] = false;
      continue;
    }
    const saved = {...defaults, ...(input?.[kind] || {})};
    for (const key of ['label', 'runningLabel', 'instructions'])
      if (
        typeof saved[key] !== 'string' ||
        !saved[key].trim() ||
        saved[key].length > (key === 'instructions' ? 6000 : 100)
      )
        throw Error('Invalid record operation ' + key);
    const successCriteria =
      saved.successCriteria ??
      'Save fresh observed confirmation of the intended outcome. A click or lack of an error is not confirmation.';
    if (
      typeof successCriteria !== 'string' ||
      !successCriteria.trim() ||
      successCriteria.length > 2000
    )
      throw Error('Invalid operation success criteria');
    result[kind] = {
      kind,
      id: 'record-' + kind,
      label: saved.label,
      runningLabel: saved.runningLabel,
      instructions: saved.instructions,
      successCriteria,
      scope: 'record',
      effect: kind === 'execute' ? 'write' : kind === 'prepare' ? 'prepare' : 'read',
      capability:
        kind === 'execute'
          ? 'browser.act'
          : kind === 'prepare'
            ? 'browser.prepare'
            : kind === 'score'
              ? 'browser.evaluate'
              : 'browser.observe',
      after: [],
    };
  }
  return result;
}
