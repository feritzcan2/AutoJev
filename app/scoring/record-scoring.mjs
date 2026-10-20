// @ts-check
import {
  taskHasRecord,
  taskRecordIds,
  batchScoring,
  recordScoredInTask,
} from '../records/task-scope.mjs';
import {SCORING_VERSION} from './policy.mjs';
import {boundedText, webUrl} from '../templates/catalog.mjs';
import {assessmentEvidence} from '../records/evidence.mjs';
import {keepListingDescription} from '../records/description.mjs';
import {dryRunTask, saveDryScore} from './trial-scores.mjs';
import {normalizeCellToolArgs} from '../workspaces/table-tools.mjs';
import {parseHardRules, hardRuleEligibility} from '../../src/hard-rules.js';

const text = {type: 'string', minLength: 1, maxLength: 3000};
const notes = {type: 'array', maxItems: 10, items: text};
const optionalText = {...text, minLength: 0};
export const assessmentSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['score'],
  properties: {
    status: {type: 'string', enum: ['scored', 'unavailable']},
    score: {type: ['integer', 'null'], minimum: 0, maximum: 100},
    eligibility: {
      type: 'string',
      enum: ['verified', 'unverified', 'mismatch'],
      description:
        'Only without scoringPolicy.hardRules: mandatory conditions, independent of fit score. Omitted means unverified; missing information is not mismatch.',
    },
    eligibilityReason: optionalText,
    rules: {
      type: 'array',
      maxItems: 20,
      description:
        'Required when scoringPolicy.hardRules is listed: one answer per rule. pass = the record establishes it, fail = the record explicitly contradicts it, unknown = the record does not say. The app sets eligibility from these answers.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rule', 'result'],
        properties: {
          rule: {
            type: 'integer',
            minimum: 1,
            description: 'The rule number n from scoringPolicy.hardRules',
          },
          result: {type: 'string', enum: ['pass', 'fail', 'unknown']},
          evidence: {...optionalText, maxLength: 500},
        },
      },
    },
    summary: optionalText,
    evidenceUrl: optionalText,
    evidence: optionalText,
    strengths: notes,
    gaps: notes,
    uncertainties: notes,
    scorecard: {
      type: ['object', 'null'],
      properties: {},
      additionalProperties: true,
      description: 'Optional legacy breakdown. The submitted score is saved directly.',
    },
  },
};
export const resultScoreFields = {
  score: assessmentSchema.properties.score,
  scoreReason: optionalText,
  eligibility: assessmentSchema.properties.eligibility,
  eligibilityReason: optionalText,
  rules: assessmentSchema.properties.rules,
};
export const recordScoreTool = {
  name: 'record_automation_score',
  description:
    'Save the assigned record score: a 0–100 integer per current criteria.ranking; itemId defaults to the assigned record. Notes are optional; no quote or snapshot is needed. When scoringPolicy.hardRules is listed, answer every rule in rules (pass/fail/unknown) and the app sets eligibility; otherwise save eligibility and a short eligibilityReason; a condition the record never mentions stays unverified. Inaccessible record: status=unavailable, score=null. Keeps status, proposal and evidence. Finish the scoring task after saving.',
  inputSchema: {...assessmentSchema, properties: {itemId: text, ...assessmentSchema.properties}},
};

export function normalizeAssessment(input) {
  if (typeof input?.score !== 'string') return input;
  const score = input.score.trim();
  if (input.status === 'unavailable' && !score) return {...input, score: null};
  // Providers sometimes encode a JSON integer as text. Accept only the exact
  // integer representation; never parse units, percentages, fractions or prose.
  if (/^(?:0|[1-9]\d{0,2})$/.test(score) && Number(score) <= 100)
    return {...input, score: Number(score)};
  return input;
}
// Observations name their ids controlId/targetId/fieldId/uploadId while the
// browser tools take a single ref. A weaker or freshly compacted agent often
// copies the observation's key; accept exactly one such alias in place of ref.
const REF_ALIASES = ['controlId', 'targetId', 'fieldId', 'uploadId'];
const REF_TOOLS = new Set(['browser_interact', 'browser_upload_document', 'browser_target_press']);
function normalizeRefAlias(name, args) {
  if (!REF_TOOLS.has(name) || !args || typeof args !== 'object' || args.ref !== undefined)
    return args;
  const present = REF_ALIASES.filter((key) => typeof args[key] === 'string' && args[key]);
  if (present.length !== 1) return args;
  const {[present[0]]: ref, ...rest} = args;
  return {...rest, ref};
}
export function normalizeRecordToolArgs(name, args) {
  args = normalizeRefAlias(name, args);
  if (name === 'record_automation_results' && Array.isArray(args?.records))
    return {
      ...args,
      records: args.records.map((entry) =>
        normalizeRecordToolArgs('record_automation_result', entry),
      ),
    };
  args = normalizeCellToolArgs(name, args);
  if (name === 'record_automation_score') return normalizeAssessment(args);
  if (name === 'record_automation_result' && Object.hasOwn(args ?? {}, 'score'))
    return normalizeAssessment(args);
  if (name === 'record_automation_result' && args?.assessment)
    return {...args, assessment: normalizeAssessment(args.assessment)};
  return args;
}

// The source tool uses scalar fields; persisted records retain their existing
// assessment shape. Do not repair or extract scores from malformed JSON text.
export function recordResultInput(args) {
  if (!Object.keys(resultScoreFields).some((key) => Object.hasOwn(args, key))) return args;
  if (!Object.hasOwn(args, 'score'))
    throw Error(
      'arguments.score: Missing score; send a 0–100 integer or null when details are unavailable.',
    );
  if (args.assessment !== undefined)
    throw Error(
      'arguments.assessment: Use the top-level score fields together; do not combine them with assessment.',
    );
  const {score, scoreReason, eligibility, eligibilityReason, rules, ...input} = args;
  return {
    ...input,
    assessment: {
      score,
      ...(scoreReason !== undefined ? {summary: scoreReason} : {}),
      ...(eligibility !== undefined ? {eligibility} : {}),
      ...(eligibilityReason !== undefined ? {eligibilityReason} : {}),
      ...(rules !== undefined ? {rules} : {}),
    },
  };
}

export function recordAssessment(db, id, run, input, recordUrl) {
  input = normalizeAssessment(input);
  const a = db.get(id);
  if (run.revision !== a.revision)
    throw Error('The profile changed; score again with the current information');
  const score = input?.score,
    status = score === null ? 'unavailable' : 'scored';
  if (!input || (score !== null && (!Number.isInteger(score) || score < 0 || score > 100)))
    throw Error(
      'The score must be an integer from 0 to 100; use score=null if it cannot be assessed',
    );
  if (
    input.eligibility !== undefined &&
    !['verified', 'unverified', 'mismatch'].includes(input.eligibility)
  )
    throw Error('Invalid eligibility status');
  // With elimination rules the agent answers each rule and the app decides.
  const hardRules = parseHardRules(a.criteria.hard_rules),
    ruled = score !== null && hardRules.length ? hardRuleEligibility(hardRules, input.rules) : null;
  const eligibility =
      ruled?.eligibility ?? (score === null ? 'unverified' : (input.eligibility ?? 'unverified')),
    eligibilityReason =
      ruled?.eligibilityReason ??
      boundedText(input.eligibilityReason ?? '', 'Eligibility reason', 3000, {
        empty: true,
      });
  const fallback = recordUrl ?? run.sourceUrl;
  let evidenceUrl = fallback;
  if (input.evidenceUrl?.trim()) {
    try {
      evidenceUrl = webUrl(input.evidenceUrl);
    } catch {}
  }
  if (evidenceUrl) evidenceUrl = assessmentEvidence(db, id, run, evidenceUrl)?.url ?? evidenceUrl;
  const lists = Object.fromEntries(
    ['strengths', 'gaps', 'uncertainties'].map((key) => {
      const values = input[key] ?? [];
      if (!Array.isArray(values) || values.length > 10) throw Error('Invalid scoring notes');
      return [key, values.map((value) => boundedText(value, 'Puanlama notu', 3000))];
    }),
  );
  return {
    status,
    score,
    scoringVersion: SCORING_VERSION,
    eligibility,
    eligibilityReason,
    ...(ruled ? {ruleResults: ruled.ruleResults} : {}),
    summary: boundedText(input.summary ?? '', 'Score reason', 3000, {empty: true}),
    evidenceUrl: evidenceUrl ?? '',
    evidence: boundedText(input.evidence ?? '', 'Puanlama notu', 3000, {empty: true}),
    ...lists,
    rubric: a.criteria.ranking ?? '',
    revision: run.revision,
    runId: run.id,
    scoredAt: db.now(),
  };
}

export function assessmentCells(table, cells, assessment) {
  return {
    ...cells,
    ...(table.columns.some((c) => c.key === 'score' && c.type === 'number')
      ? {score: assessment.score === null ? '' : String(assessment.score)}
      : {}),
  };
}

export function saveRecordScore(db, id, runId, input) {
  const run = db.activeRun(id, runId);
  if (batchScoring(run) && !input.itemId)
    throw Error('In batch scoring, name the assigned record with itemId');
  // An ID outside the assignment (often a snapshotId) gets the IDs that still
  // need a score, so the agent can correct the call instead of repeating it.
  if (batchScoring(run) && !taskHasRecord(run, input.itemId)) {
    const open = taskRecordIds(run).filter((itemId) => {
      const item = db.store.workspaces.records.identities.resolve(id, itemId);
      return item && !recordScoredInTask(db, run, item);
    });
    throw Error(
      `itemId ${JSON.stringify(String(input.itemId).slice(0, 80))} is not an assigned record ID in this batch. Use an id from assignedRecords, not a snapshotId or URL. Assigned records not yet scored: ${open.join(', ') || 'none'}`,
    );
  }
  const item = db.result(id, input.itemId ?? run.recordId);
  if (run.recordOperation !== 'score' || !taskHasRecord(run, item.id))
    throw Error('A score can only be saved in the assigned scoring task');
  // A developer trial score may read a closed record; it never writes to it.
  if (
    item.trial ||
    !(dryRunTask(run) ? item.status !== 'executing' : ['found', 'prepared'].includes(item.status))
  )
    throw Error('This record cannot be scored');
  const assessment = recordAssessment(db, id, run, input, item.url);
  if (dryRunTask(run)) {
    saveDryScore(run.taskId, item.id, {assessment, runId: run.id, at: assessment.scoredAt});
    return {itemId: item.id, saved: true, score: assessment.score};
  }
  const cells = assessmentCells(db.get(id).table, item.cells, assessment),
    saved = db.putResult({...item, assessment, cells, updatedAt: assessment.scoredAt});
  keepListingDescription(db, id, run, saved.id, item.url);
  return saved;
}
