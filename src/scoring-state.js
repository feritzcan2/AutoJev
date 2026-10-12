// Shared by persistence and the UI. Only an older scoring method needs a fresh
// assessment; profile revisions never invalidate a saved score.
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
export function automaticAssessmentError(assessment, threshold = null) {
  if (!assessment) return null;
  if (oldScoringMethod(assessment))
    return 'Re-score with the current method before automatic actions';
  if (assessment.score === null) return 'The record must be scored before automatic actions';
  if (threshold !== null && assessment.score < threshold)
    return 'The score is below the minimum score for automatic applying';
  return assessmentEligibility(assessment) === 'verified'
    ? null
    : eligibilityLabels[assessmentEligibility(assessment)];
}
