// @ts-check
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';

export const SENTRY_DSN =
  'https://98689f2b21cbf36de286601b8d692d03@o4511248981164032.ingest.de.sentry.io/4512290640101456';

/**
 * Returns a sender for Sentry envelope items ({type, payload, ...item header}).
 * Best effort: resolves to whether Sentry accepted the envelope and never throws.
 */
export function sentryTransport({dsn = SENTRY_DSN, release, fetch = globalThis.fetch}) {
  const url = new URL(dsn),
    target = `${url.protocol}//${url.host}/api/${url.pathname.slice(1)}/envelope/`;
  return async (items, header = {}) => {
    const body = [
      JSON.stringify({...header, sent_at: new Date().toISOString()}),
      ...items.flatMap(({type, payload, ...item}) => [
        JSON.stringify({type, ...item}),
        JSON.stringify(payload),
      ]),
    ].join('\n');
    try {
      const response = await fetch(target, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-sentry-envelope',
          'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${url.username}, sentry_client=jobloop/${release}`,
        },
        body,
        signal: AbortSignal.timeout(10000),
      });
      return Boolean(response?.ok);
    } catch {
      return false;
    }
  };
}

// The diagnostics preference and the anonymous install id, kept beside the data,
// outside the database and backups. Reports are on until the user turns them off.
export function diagnosticsSetting(file) {
  let state = {},
    writing = Promise.resolve();
  try {
    state = JSON.parse(readFileSync(file, 'utf8')) ?? {};
  } catch {}
  const save = (patch) => {
    state = {...state, ...patch};
    const text = JSON.stringify(state);
    writing = writing.catch(() => {}).then(() => writeFile(file, text));
    return writing;
  };
  const status = () => ({enabled: state.sendScanFailures !== false});
  return {
    enabled: () => status().enabled,
    status,
    async set(value) {
      await save({sendScanFailures: value === true});
      return status();
    },
    // A random id that only tells installs apart; nothing ties it to the user.
    async installId() {
      if (!state.installId) await save({installId: randomUUID()});
      return state.installId;
    },
    usageReportedAt: () => state.usageReportedAt ?? null,
    markUsageReported: (at) => save({usageReportedAt: at}),
  };
}
