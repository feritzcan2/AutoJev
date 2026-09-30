// Skipping is an explicit user decision, not evidence of source access.
export const automationTrialReady=a=>a.trial?.revision===a.revision&&['passed','skipped'].includes(a.trial?.status);
