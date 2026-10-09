// @ts-check
// Legacy workspace metadata is retained for history; a skip never validates a source.
export const automationTrialReady = (a) =>
  a.trial?.revision === a.revision && ['passed', 'skipped'].includes(a.trial?.status);
export const automationReady = (a) => a.reviewedRevision === a.revision;
export const sourceTrialReady = (a, url) => a.sourceState?.[url]?.trial?.status === 'passed';
