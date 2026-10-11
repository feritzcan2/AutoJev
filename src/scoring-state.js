// Shared by persistence and the UI; older scores need a fresh assessment.
export const SCORING_VERSION = 4;
export const eligibilityLabels = {
  verified: 'Required criteria met',
  unverified: 'Required criteria need verification',
  mismatch: 'A required criterion is not met',
};
export const assessmentEligibility = (assessment) =>
  assessment?.eligibility ?? assessment?.calculation?.eligibility ?? 'unverified';
export const oldScoringMethod = (assessment) =>
  (assessment?.scoringVersion ?? assessment?.calculation?.version ?? 0) < SCORING_VERSION;
export function automaticAssessmentError(assessment, revision) {
  if (!assessment) return null;
  if (oldScoringMethod(assessment) || assessment.revision !== revision)
    return 'Re-score with the current method and criteria before automatic actions';
  if (assessment.score === null) return 'The record must be scored before automatic actions';
  return assessmentEligibility(assessment) === 'verified'
    ? null
    : eligibilityLabels[assessmentEligibility(assessment)];
}
