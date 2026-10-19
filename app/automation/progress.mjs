// @ts-check
import {sourceTrialReady} from '../sources/trial.mjs';
import {providerLimitAttention} from '../agents/provider-limit.mjs';
import {isConversation, conversationWaiting} from '../workspaces/conversation.mjs';
const action = (id, label) => ({id, label});
const failures = new Set(['failed', 'blocked', 'timeout']);
export const runKindLabel = (kind) =>
  ({
    'record-score': 'Scoring listing',
    'record-prepare': 'Preparing action',
    'record-execute': 'Executing action',
    'record-verify': 'Verifying result',
    'record-cover-letter': 'Writing cover letter',
    'record-contacts': 'LinkedIn contacts',
    interview: 'Setup conversation',
    trial: 'Trial',
    run: 'Source scan',
  })[kind] ?? 'Run';
// Task operations are queue identifiers; people see what the worker is doing, not the id.
export const runOperationLabel = (operation, kind) =>
  ({
    'record-score': 'Scoring listing',
    'record-prepare': 'Preparing action',
    'record-execute': 'Executing action',
    'record-verify': 'Verifying result',
    'record-cover-letter': 'Writing cover letter',
    'record-contacts': 'LinkedIn contacts',
    interview: 'Setup conversation',
    trial: 'Trial scan',
    run: 'Source scan',
    scan: 'Source scan',
    detail: 'Reading listing details',
    inspect: 'Reading listing details',
    verify: 'Verifying result',
  })[operation] ?? runKindLabel(kind);

// One presentation of the durable run outcome and the next allowed step.
// A saved result and a provider process that is still closing are separate states.
export function automationProgress(snapshot, {dirty = false} = {}) {
  const {automation: a, runs = [], missing = [], messages = []} = snapshot;
  const activeRuns = (snapshot.activeRuns ?? (snapshot.activeRun ? [snapshot.activeRun] : [])).map(
    (run) => runs.find((r) => r.id === run.id) ?? run,
  );
  const current =
    activeRuns.find((run) => run.status === 'running' && !isConversation(run)) ??
    activeRuns.find((run) => run.status === 'running') ??
    activeRuns[0] ??
    null;
  const enabledSources = (a.sources ?? []).filter(
    (url) => a.sourceSettings?.[url]?.enabled !== false,
  );
  const latest = runs[0],
    reviewed = a.reviewedRevision === a.revision,
    passed = enabledSources.length > 0 && enabledSources.every((url) => sourceTrialReady(a, url));
  const relevant = latest?.revision === a.revision ? latest : null;
  const reply = [...messages].reverse().find((m) => m.role === 'assistant');
  // A workspace nobody has written to yet is a blank page, not a list of missing fields.
  const fresh =
    !current && !runs.length && !messages.some((m) => m.role === 'user') && !a.goal && !reviewed;
  const result = {
    stage: 0,
    tone: 'neutral',
    title: 'Describe what you want to do',
    label: 'Setup',
    detail: 'The agent will ask questions to prepare your criteria and sources.',
    next: 'Write your first message on the Setup agent page; the agent asks the rest.',
    primary: action('message', 'Message the agent'),
    secondary: [],
    running: Boolean(current),
    finishedRun: !current && latest?.finishedAt ? latest : null,
    reply,
    reviewed,
    passed,
    fresh,
  };
  const set = (value) => Object.assign(result, value);
  if (current && isConversation(current)) {
    const waiting = conversationWaiting(current);
    set({
      stage: reviewed ? 2 : 0,
      tone: waiting ? 'neutral' : 'active',
      label: waiting ? 'Waiting for message' : 'Running',
      title: waiting ? 'Conversation open' : 'Agent is preparing a reply',
      detail: waiting
        ? 'You can send your next message in the same conversation.'
        : 'The agent is reviewing your message. Sources continue their own tasks.',
      next: 'The session stays open until you close the conversation.',
      running: !waiting,
      primary: waiting ? action('message', 'Write a message') : null,
      secondary: [],
    });
    if (current.usageLimit) {
      const limit = providerLimitAttention(current.usageLimit);
      set({
        tone: 'waiting',
        label: 'Usage limit',
        title: limit.title,
        detail: limit.detail,
        primary: action('terminal', 'Go to terminal'),
      });
    }
  } else if (current) {
    const closing = current.status !== 'running',
      waiting = current.state === 'AwaitingInput';
    set({
      stage: current.kind === 'interview' ? 0 : 2,
      tone: waiting ? 'waiting' : 'active',
      label: closing ? 'Result saved' : waiting ? 'Sign-in / approval needed' : 'Running',
      title: closing
        ? 'Session closing…'
        : waiting
          ? 'Check the terminal to continue'
          : {
              interview: 'Agent is preparing the setup',
              trial: 'Trial running',
              run: 'Scanning sources',
            }[current.kind],
      detail: closing
        ? current.summary
        : current.kind === 'trial'
          ? 'Checking that this source can be read. A trial submits nothing.'
          : current.kind === 'interview'
            ? 'Reviewing the template and saved information; preparing setup questions, profile and sources.'
            : a.goal,
      next: closing
        ? 'The next step opens when the session closes.'
        : waiting
          ? 'Answer the provider’s sign-in or tool permission request in the live terminal below.'
          : 'When this round ends you will see the result and the next step here.',
      primary: waiting ? action('terminal', 'Go to terminal') : null,
      secondary: closing ? [] : [action('stop', 'Stop')],
    });
    if (!closing && current.usageLimit) {
      const limit = providerLimitAttention(current.usageLimit);
      set({
        tone: 'waiting',
        label: 'Usage limit',
        title: limit.title,
        detail: limit.detail,
        next: 'The task and saved progress are kept.',
        primary: action('terminal', 'Go to terminal'),
      });
    }
  } else if (dirty) {
    set({
      title: 'Profile changes not saved',
      label: 'Save needed',
      detail: 'Tracking settings update once the new information is saved.',
      next: 'Review and save the workspace profile.',
      primary: action('profile', 'Open profile'),
    });
  } else if ((a.questions ?? []).some((q) => q.answer == null)) {
    set({
      tone: 'waiting',
      title: 'Answer the questions',
      label: 'Waiting for answer',
      detail: 'The agent needs the information in the form to continue.',
      next: 'After you submit the form, the agent continues automatically with your saved answers.',
      primary: action('questions', 'Fill in the form'),
    });
  } else if (a.status === 'complete') {
    set({
      stage: 3,
      tone: 'success',
      title: 'Tracking complete',
      label: 'Complete',
      detail: latest?.summary ?? 'The workspace reached its end condition.',
      next: 'You can review the saved results.',
      primary: action('results', 'View results'),
    });
  } else if (
    relevant &&
    failures.has(relevant.status) &&
    (a.status !== 'enabled' ||
      relevant.kind === 'interview' ||
      (!relevant.sourceUrl && relevant.kind !== 'trial'))
  ) {
    const trial = relevant.kind === 'trial',
      setup = relevant.kind === 'interview';
    set({
      stage: setup ? 0 : 2,
      tone: 'waiting',
      title: trial
        ? 'Trial could not complete'
        : setup
          ? 'Setup conversation could not complete'
          : 'Run could not complete',
      label: relevant.status === 'timeout' ? 'Timed out' : 'Action needed',
      detail: relevant.summary,
      next: trial
        ? 'Check the blocked source on the Sources page and run it again.'
        : setup
          ? 'You can continue setup with the saved information and answers.'
          : 'Check the results; you can run again once the blocker is resolved.',
      primary: setup
        ? action('setup', 'Continue setup')
        : trial
          ? action('sources', 'View sources')
          : action('run', 'Run again'),
      secondary: setup
        ? []
        : [action('browser', 'Open browser'), action('message', 'Fix with agent')],
    });
    if (
      !setup &&
      a.status === 'paused' &&
      reviewed &&
      relevant.sourceUrl &&
      !relevant.recordId &&
      (snapshot.sources ?? []).some((s) => s.enabled && !s.blocked)
    )
      set({
        title: 'Tracking of other sources is off',
        next: 'When you turn on regular tracking, unblocked sources run at their own intervals. Manage the blocked source separately on the Sources page.',
        primary: action('enable', 'Resume regular tracking'),
        secondary: [action('sources', 'View sources'), action('message', 'Fix with agent')],
      });
  } else if (fresh) {
    // keep the blank-page invitation
  } else if (!reviewed) {
    if (missing.length)
      set({
        title: latest?.kind === 'interview' ? 'Setup needs your answer' : 'Let’s finish setup',
        label: 'Waiting for information',
        detail: reply?.text ?? result.detail,
        next: 'Missing information: ' + missing.join(', '),
        primary: action('message', 'Write a reply'),
      });
    else
      set({
        title: 'Setup draft ready',
        label: 'Review needed',
        detail:
          latest?.kind === 'interview'
            ? latest.summary
            : 'The agent prepared the criteria and sources.',
        next: 'Review and save the profile and action permission. Each source gets an automatic trial in its first round.',
        primary: action('profile', 'Review and save profile'),
      });
  } else if (a.sources?.length === 0) {
    set({
      title: 'Add a source',
      label: 'Waiting for a source',
      detail: 'Profile saved. Tracking needs a source.',
      next: 'Add an address on the Sources screen or review the agent’s suggestions.',
      primary: action('sources', 'Open sources'),
      secondary: [],
    });
  } else if (a.status === 'enabled') {
    set({
      stage: 2,
      tone: 'success',
      title: 'Regular tracking on',
      label: latest?.status === 'completed' ? 'Last round complete' : 'Waiting for the next check',
      detail:
        latest?.kind === 'run'
          ? latest.summary
          : 'Sources will be checked at the intervals you set.',
      next: `Sources are checked at their own scan intervals. Next check: ${a.nextRunAt ? new Date(a.nextRunAt).toLocaleString('en-GB') : 'queued'}. The app must stay open.`,
      primary: action('results', 'View results'),
      secondary: [action('stop', 'Pause tracking')],
    });
    const sources = snapshot.sources ?? [],
      blocked = sources.filter((s) => s.enabled && s.blocked);
    if (sources.length)
      set({
        next: `Sources run at their own scan intervals. Next check: ${a.nextRunAt ? new Date(a.nextRunAt).toLocaleString('en-GB') : 'no check scheduled'}. The app must stay open.`,
      });
    if (blocked.length)
      set({
        tone: 'waiting',
        label: `${blocked.length} ${blocked.length === 1 ? 'source' : 'sources'} blocked`,
        title:
          blocked.length === sources.filter((s) => s.enabled).length
            ? 'Sources need attention'
            : 'Other sources are still tracked',
        detail: blocked.map((s) => `${s.name}: ${s.lastResult ?? 'Access blocked'}`).join('\n'),
        next: 'Blocked sources are not retried automatically. You can run each one separately from the Sources page.',
      });
  } else {
    const ran = relevant?.kind === 'run',
      paused = a.status === 'paused';
    set({
      stage: 2,
      tone: ran || paused ? 'neutral' : 'success',
      title: paused ? 'Tracking paused' : ran ? 'This round is complete' : 'Setup complete',
      label: paused ? 'Paused' : ran ? 'Round finished' : 'Ready to run',
      detail: relevant?.summary ?? 'Your criteria and sources are saved.',
      next: `Regular tracking is off. Each source’s first round is a trial and submits nothing. Run once, or turn on regular tracking at each source’s own scan interval.`,
      primary: action('enable', paused ? 'Resume regular tracking' : 'Start regular tracking'),
      secondary: [action('run', 'Run once'), action('results', 'View results')],
    });
  }
  result.steps = [
    {label: 'Setup', state: reviewed ? 'done' : result.stage === 0 ? 'current' : 'pending'},
    {
      label: 'Tracking',
      state: a.status === 'complete' ? 'done' : result.stage >= 2 ? 'current' : 'pending',
    },
  ];
  return result;
}
