// @ts-check
import {randomUUID} from 'node:crypto';

// Reports source scans that end failed, blocked or timed out to Sentry so they
// can be triaged later. Only the site host, app status codes and scrubbed
// summaries leave the machine: no profile, CV, page content or full URLs.
export const SENTRY_DSN =
  'https://98689f2b21cbf36de286601b8d692d03@o4511248981164032.ingest.de.sentry.io/4512290640101456';

const REPORTED_STATUSES = new Set(['failed', 'blocked', 'timeout']);

const scanSource = (run) => run.sourceUrl ?? (run.sources?.length === 1 ? run.sources[0] : null);

/** A source scan (not record work) that just ended in a reported status. */
export function reportableScanFailure(run, previousStatus) {
  return Boolean(
    run &&
      ['run', 'trial'].includes(run.kind) &&
      scanSource(run) &&
      !run.recordId &&
      !run.recordOperation &&
      REPORTED_STATUSES.has(run.status) &&
      previousStatus !== run.status,
  );
}

const host = (value) => {
  try {
    return new URL(value).host;
  } catch {
    return 'unknown';
  }
};

export function scrubText(value, max = 400) {
  return String(value ?? '')
    .replace(/\bhttps?:\/\/([^/\s?#'")]+)[^\s'")]*/gi, '$1/…')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]')
    .replace(/\b[0-9A-F]{16,}\b/gi, '[id]')
    .replace(/\+?\d[\d\s/-]{6,}\d/g, '[number]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// The app's own error codes (site_wait, checkbox_not_ready, ...) group issues
// better than agent-written prose.
function failureCode(run) {
  if (run.toolFailure?.tool) return `tool:${run.toolFailure.tool}`;
  const text = `${run.stop?.evidence ?? ''} ${run.summary ?? ''}`;
  return text.match(/\b[a-z]+(?:_[a-z]+)+\b/)?.[0] ?? 'none';
}

export function scanFailureEvent(run, {release, environment}) {
  const site = host(scanSource(run)),
    stopKind = run.stop?.kind ?? 'none',
    code = failureCode(run),
    stats = run.scanStats ?? {};
  return {
    event_id: randomUUID().replaceAll('-', ''),
    timestamp: (run.finishedAt ?? Date.now()) / 1000,
    platform: 'node',
    level: run.status === 'failed' ? 'error' : 'warning',
    logger: 'jobloop.scan',
    release,
    environment,
    message: {formatted: `scan ${run.status} (${stopKind}) ${site}: ${code}`},
    fingerprint: ['jobloop-scan', site, run.status, stopKind, code],
    tags: {
      site,
      status: run.status,
      kind: run.kind,
      stop_kind: stopKind,
      code,
      collector: run.collector ?? run.scan?.collector ?? 'none',
      model: run.conversation?.settings?.model ?? 'unknown',
      provider: run.conversation?.provider ?? 'unknown',
      retry_exhausted: String(Boolean(run.stop?.retryExhausted)),
      recovered_after_crash: String(Boolean(run.recoveredAfterCrash)),
    },
    extra: {
      summary: scrubText(run.summary),
      stopEvidence: scrubText(run.stop?.evidence),
      toolFailure: run.toolFailure
        ? {
            tool: run.toolFailure.tool,
            message: scrubText(run.toolFailure.message),
            count: run.toolFailure.count,
          }
        : null,
      durationMs: run.finishedAt && run.startedAt ? run.finishedAt - run.startedAt : null,
      browserSteps: run.browserSteps ?? 0,
      pageProgress: run.pageProgress
        ? {currentPage: run.pageProgress.currentPage, totalPages: run.pageProgress.totalPages}
        : null,
      scanStats: Object.fromEntries(
        Object.entries(stats).filter(([, value]) => typeof value === 'number'),
      ),
      continuation: run.continuation?.reason ?? null,
    },
  };
}

function envelopeTarget(dsn) {
  const url = new URL(dsn);
  return {
    url: `${url.protocol}//${url.host}/api/${url.pathname.slice(1)}/envelope/`,
    key: url.username,
  };
}

/** Returns a reporter that sends each scan run at most once and never throws. */
export function createScanFailureReporter({
  dsn = SENTRY_DSN,
  release,
  environment,
  fetch = globalThis.fetch,
}) {
  const target = envelopeTarget(dsn),
    sent = new Set();
  return async (run) => {
    if (sent.has(run.id)) return;
    sent.add(run.id);
    const event = scanFailureEvent(run, {release, environment});
    const body = [
      JSON.stringify({event_id: event.event_id, sent_at: new Date().toISOString()}),
      JSON.stringify({type: 'event'}),
      JSON.stringify(event),
    ].join('\n');
    try {
      await fetch(target.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-sentry-envelope',
          'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${target.key}, sentry_client=jobloop/${release}`,
        },
        body,
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      // Reporting is best effort; a scan never fails because Sentry is unreachable.
    }
  };
}
