// @ts-check
import {siteDomainOf} from '../browser/site-access.mjs';

// Workspaces that scan the same site take turns: a site limits requests per
// address, not per workspace, so two scans at once only slow each other and
// risk a block. A workspace starts a new scan round on a site only when no
// other enabled workspace has a round open there, and only 30 minutes after
// the last other workspace's round on that site ended. Rounds already under
// way are never interrupted.
export const SITE_TURN_GAP_MS = 30 * 60000;

// Open rounds go in the order they started; the workspace id breaks a tie
// (rounds opened before turns existed have no start time).
const before = (x, y) =>
  (x.startedAt ?? 0) - (y.startedAt ?? 0) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/**
 * The other workspace this source waits for, or null when it may go on.
 * {workspace, site, scanning: true} while that workspace's round is open;
 * {workspace, site, until} during the gap after it ended. A source whose own
 * round is open (`open`, with its round start) waits for an open round that
 * started before it, and for the gap after a round that ended while it waited.
 */
export function siteTurn(store, id, url, now, open = null) {
  const site = siteDomainOf(url);
  let gap = null;
  for (const other of store.list()) {
    if (other.id === id) continue;
    for (const sourceUrl of other.sources ?? []) {
      if (siteDomainOf(sourceUrl) !== site) continue;
      const state = other.sourceState?.[sourceUrl] ?? {};
      if (
        state.batchId &&
        other.status === 'enabled' &&
        other.sourceSettings?.[sourceUrl]?.enabled !== false &&
        (!open ||
          before({id: other.id, startedAt: state.roundStartedAt}, {id, startedAt: open.startedAt}) <
            0)
      )
        return {
          workspaceId: other.id,
          workspace: other.title ?? 'another workspace',
          site,
          scanning: true,
        };
      // An open round counts only the gaps of rounds that ended after it began.
      if (open && !((state.roundEndedAt ?? 0) > (open.startedAt ?? 0))) continue;
      const until = (state.roundEndedAt ?? 0) + SITE_TURN_GAP_MS;
      if (until > now && until > (gap?.until ?? 0))
        gap = {workspaceId: other.id, workspace: other.title ?? 'another workspace', site, until};
    }
  }
  return gap;
}
