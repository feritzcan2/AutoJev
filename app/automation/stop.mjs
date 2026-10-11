// @ts-check
import {boundedText} from '../templates/catalog.mjs';

// A partial scan is unfinished work, not a request for human intervention. The
// agent only names an access barrier or a missing user fact; loading failures
// are verified by the app itself and become a technical stop with a retry.
export function sourceStop(run, input) {
  if (
    run.kind !== 'run' ||
    !run.sourceUrl ||
    run.recordId ||
    !['failed', 'blocked'].includes(input.status)
  )
    return null;
  const stop = input.stop,
    verified = Object.values(run.scanIssues ?? {}).filter((issue) => issue.verified);
  if (stop && ['access', 'user_input'].includes(stop.kind))
    return {
      kind: stop.kind,
      evidence: boundedText(stop.evidence, 'Evidence of the actual blocker', 2000),
    };
  if (stop && stop.kind !== 'technical')
    throw Error(
      'Stopping a source requires stop.kind access or user_input. Incomplete coverage is not a blocker; process the remaining pages and details in the same task.',
    );
  if (!verified.length)
    throw Error(
      'No verified loading failure. Report stop.kind=access for an access barrier or stop.kind=user_input for missing user information; otherwise continue the remaining work.',
    );
  const remaining = (run.scan?.pendingUrls ?? []).filter(
    (url) => !verified.some((issue) => issue.global || issue.url === url),
  );
  if (remaining.length)
    throw Error(
      `The issue does not stop the whole source. First process the ${remaining.length} reachable pending address(es): ${remaining.slice(0, 3).join(', ')}.`,
    );
  return {
    kind: 'technical',
    evidence: boundedText(
      stop?.evidence ?? verified[0].evidence,
      'Evidence of the actual blocker',
      2000,
    ),
    issueIds: verified.map((issue) => issue.id),
  };
}
