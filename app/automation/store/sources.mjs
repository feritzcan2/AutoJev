// @ts-check
import {isConversation} from '../../workspaces/conversation.mjs';
import {
  forgetScanPosition,
  forgetPlanPosition,
  dropRecipeSearches,
  replayScanWork,
} from '../../sources/scan-work.mjs';
import {
  recipeValues,
  recipeReplay,
  replayMatches,
  recipeStatus,
  recipeNeedsTerms,
} from '../../sources/recipe.mjs';
import {siteExtensionKind, siteExtensionFor} from '../../site-extensions/index.mjs';
import {siteSearchRecipe} from '../../site-extensions/search.mjs';
import {templateSourceSettings, startingSource} from '../../templates/sources.mjs';
import {siteKey} from '../../browser/site-key.mjs';
import {siteDomainOf} from '../../browser/site-access.mjs';
import {randomUUID} from 'node:crypto';
import {normalizeSourceUrls, webUrl} from '../../templates/catalog.mjs';
import {automationSources, sourceInput} from '../../sources/automation-sources.mjs';
import {sourceScanScope} from '../../sources/scan.mjs';
import {
  sourceSearchChoice,
  sourceSearchOptions,
  sourceSearchRecipe,
} from '../../sources/source-search.mjs';
import {json, finishedSourceRun, runSource} from './rows.mjs';
import {sourceActivity} from '../../sources/source-activity.mjs';
import {siteTurn} from '../../sources/site-turns.mjs';
// Only a different search method changes a recipe; notes, the pagination
// hint, the page cap and the login flag are advisory.
const recipeKey = (r) => (r ? JSON.stringify({entry: r.entry, terms: r.terms ?? null}) : null);

// The search terms most sources of the workspace share, for a source added
// without its own: a {query} search then starts from the workspace's roles
// instead of waiting. Its trial or the setup chat can change them.
function sharedTerms(settings = {}) {
  const counts = new Map();
  for (const {recipe} of Object.values(settings))
    if (recipe?.terms?.length) {
      const key = JSON.stringify(recipe.terms);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  const [best] = [...counts].sort((x, y) => y[1] - x[1]);
  return best ? JSON.parse(best[0]) : null;
}

// AutomationStore methods: source list, per-source settings, waits and learned recipes.
// A site whose scans read its pages in the user's browser counts them under
// its browser budget (worker openInBrowser); other sites under their address.
const requestRate = (siteAccess, url) => {
  const extension = siteExtensionFor(url);
  if (!extension?.collector?.cardsInBrowser) return siteAccess.requestRate(url, extension?.pacing);
  const site = siteDomainOf(url);
  return siteAccess.requestRate('https://' + site, extension.pacing, site + ' browser');
};
export const sourceMethods = {
  schedulingSources(id, a = this.get(id)) {
    return automationSources(a).map((source) => ({
      ...source,
      siteWait: this.sourceWait(id, source, a),
    }));
  },
  sourceWait(id, source, a = this.get(id)) {
    const direct = this.siteAccess.status(source.url);
    const state = a.sourceState?.[source.url];
    if (!state?.siteBlocked && !state?.lastRunId) return direct;
    // A source can lead to another host (for example www -> de.linkedin.com).
    // Bind its observed wait to this source without blocking unrelated sources.
    const row = state.siteBlocked
      ? this.db
          .prepare(
            "SELECT json_extract(data,'$.siteWait.site') AS site FROM automation_runs WHERE automation_id=? AND json_extract(data,'$.sourceUrl')=? AND json_extract(data,'$.siteWait.site') IS NOT NULL ORDER BY rowid DESC LIMIT 1",
          )
          .get(id, source.url)
      : this.db
          .prepare(
            "SELECT json_extract(data,'$.siteWait.site') AS site FROM automation_runs WHERE id=? AND automation_id=? AND json_extract(data,'$.sourceUrl')=?",
          )
          .get(state.lastRunId, id, source.url);
    let observed = row?.site ? this.siteAccess.status('https://' + row.site) : null;
    if (!state.siteBlocked && !observed?.waiting) observed = null;
    return (
      [direct, observed]
        .filter(Boolean)
        .sort((a, b) => Number(b.exhausted) - Number(a.exhausted) || b.retryAt - a.retryAt)[0] ??
      null
    );
  },
  sources(id) {
    const a = this.get(id),
      runs = this.runs(id, {summary: true});
    const records = this.db
      .prepare(
        "SELECT json_extract(data,'$.url') AS url,json_extract(data,'$.sourceUrl') AS sourceUrl,json_extract(data,'$.trial') AS trial,json_extract(data,'$.runId') AS runId,json_extract(data,'$.discoveredRunId') AS discoveredRunId FROM workspace_records WHERE workspace_id=? AND json_extract(data,'$.mergedInto') IS NULL",
      )
      .all(id);
    // A new active run or unrelated record work must not hide the last source outcome.
    const lastRuns = new Map(
      this.db
        .prepare(
          `SELECT json_object('id',id,'kind',json_extract(data,'$.kind'),'status',json_extract(data,'$.status'),'summary',json_extract(data,'$.summary'),'finishedAt',json_extract(data,'$.finishedAt'),'scanStats',json_extract(data,'$.scanStats'),'sourceUrl',json_extract(data,'$.sourceUrl'),'sources',json_extract(data,'$.sources')) AS data FROM automation_runs WHERE rowid IN (
   SELECT max(rowid) FROM automation_runs WHERE automation_id=? AND ${finishedSourceRun} GROUP BY ${runSource}
  )`,
        )
        .all(id)
        .map(json)
        .map((run) => [
          run.sourceUrl ?? (run.sources?.length === 1 ? run.sources[0] : null),
          {
            id: run.id,
            kind: run.kind,
            status: run.status,
            summary: run.summary,
            finishedAt: run.finishedAt,
            scanStats: run.scanStats ?? null,
          },
        ]),
    );
    return automationSources(a).map((source) => {
      const last = runs.find(
        (r) =>
          !r.recordId &&
          !r.recordOperation &&
          ['run', 'trial'].includes(r.kind) &&
          (r.sourceUrl === source.url ||
            (!r.sourceUrl && r.sources?.length === 1 && r.sources[0] === source.url)),
      );
      const active = runs.find(
        (r) =>
          !r.recordId &&
          !r.recordOperation &&
          r.status === 'running' &&
          ['run', 'trial'].includes(r.kind) &&
          (r.sourceUrl === source.url || (r.sources?.length === 1 && r.sources[0] === source.url)),
      );
      const siteWait = this.sourceWait(id, source, a);
      const resultCount = records.filter(
        (r) =>
          !r.trial &&
          (r.sourceUrl
            ? r.sourceUrl === source.url
            : new URL(r.url).origin === new URL(source.url).origin &&
              a.sources.filter((url) => new URL(url).origin === new URL(source.url).origin)
                .length === 1),
      ).length;
      return {
        ...(last
          ? {
              lastRunAt: last.finishedAt,
              lastStatus: last.status,
              lastResult: last.summary,
              blocked: ['blocked', 'failed', 'timeout'].includes(last.status),
              lastFound: records.filter(
                (r) => !r.trial && (r.discoveredRunId ?? r.runId) === last.id,
              ).length,
            }
          : {}),
        ...source,
        lastRun: lastRuns.get(source.url) ?? null,
        siteWait,
        pageProgress:
          active && !active.recordId
            ? (active.pageProgress ?? null)
            : (source.pageProgress ?? null),
        observedPage: active?.observedPage ?? source.observedPage ?? null,
        requests: requestRate(this.siteAccess, source.url),
        resultCount,
        extension: siteExtensionKind(source.url, a.templateId),
        scanning: Boolean(active),
        activity: active ? sourceActivity(active.id) : null,
        // A due round that waits for another workspace's turn on this site.
        siteTurn:
          source.enabled &&
          a.status === 'enabled' &&
          !active &&
          // A shared site wait leaves the source blocked; its turn still shows.
          (!source.blocked || (siteWait && !siteWait.exhausted))
            ? source.batchId
              ? siteTurn(this, id, source.url, this.now(), {startedAt: source.roundStartedAt})
              : source.nextRunAt > this.now()
                ? null
                : siteTurn(this, id, source.url, this.now())
            : null,
        trialRunning: active?.kind === 'trial',
        scanIssue: active
          ? (Object.values(active.scanIssues ?? {}).sort((a, b) => b.at - a.at)[0] ?? null)
          : null,
        workerId: active?.workerId ?? null,
      };
    });
  },
  // The template's ready sources whose site is not in the workspace yet, for
  // one-click adding. Country copies of one board ("Indeed (Germany)", "Indeed
  // (France)") form one entry with a country choice. The workspace country
  // comes first, then the sources for every country or remote work, then the
  // others.
  sourceCatalog(id, a = this.get(id)) {
    const added = new Set(a.sources.map(siteKey)),
      country = String(a.criteria?.country ?? '').toUpperCase(),
      rank = (s) => (s.countries?.includes(country) ? 0 : !s.countries?.length || s.remote ? 1 : 2),
      groups = new Map();
    const sources = (this.template(a.templateId).defaultSources ?? [])
      .filter((s) => !added.has(siteKey(s.url)))
      .sort((x, y) => rank(x) - rank(y) || x.name.localeCompare(y.name, 'en'));
    for (const s of sources) {
      const [, base, label] = s.name.match(/^(.*?)\s*\(([^)]*)\)$/) ?? [, s.name, null],
        countries = s.countries ?? [];
      if (!groups.has(base))
        groups.set(base, {
          name: base,
          extension: siteExtensionKind(s.url, a.templateId)?.kind ?? null,
          choices: [],
        });
      const served = countries.join(', ');
      groups.get(base).choices.push({
        url: s.url,
        name: s.name,
        countries,
        ...(s.remote ? {remote: true} : {}),
        // Off in the template, for example an API that needs the user's own key.
        ...(s.enabled ? {} : {enabled: false}),
        label:
          label ??
          (s.remote ? (served ? served + ' or remote' : 'Remote only') : served || 'All countries'),
      });
    }
    return [...groups.values()];
  },
  // The agent names only the changes; every other saved or already suggested
  // source is kept, so a partial list never reads as removals.
  proposedSources(id, add = [], remove = []) {
    const a = this.get(id),
      base = a.sourceDraft?.sources ?? a.sources,
      dropped = normalizeSourceUrls(remove);
    const unknown = dropped.filter((url) => !base.includes(url));
    if (unknown.length)
      throw Error(
        'Not a saved or suggested source: ' +
          unknown.join(', ') +
          '. Current sources: ' +
          base.join(', '),
      );
    return normalizeSourceUrls([
      ...base.filter((url) => !dropped.includes(url)),
      ...normalizeSourceUrls(add),
    ]);
  },
  // A source's recipe, or the starting source's recipe it gets when added.
  sourceRecipeBase(a, url) {
    return (
      a.sourceSettings?.[url]?.recipe ??
      (a.sourceSettings?.[url]
        ? null
        : startingSource(this.template(a.templateId).defaultSources, url)?.recipe)
    );
  },
  // Search choices for the listed sources whose site extension knows the
  // results address, with the draft's choices applied.
  sourceSearchOptions(id, sources) {
    const a = this.get(id),
      draft = a.sourceDraft?.searches ?? {};
    return sources.flatMap((url) => {
      const search = siteExtensionKind(url, a.templateId)?.search;
      if (!search) return [];
      const recipe = this.sourceRecipeBase(a, url);
      return [
        {
          url,
          ...sourceSearchOptions(
            search,
            draft[url] ? sourceSearchRecipe(search, recipe, draft[url]) : recipe,
          ),
        },
      ];
    });
  },
  // The agent names only the sources whose search changes; earlier choices of
  // the draft stay while their source is in the list.
  proposedSourceSearches(id, sources, input = []) {
    const a = this.get(id),
      searches = Object.fromEntries(
        Object.entries(a.sourceDraft?.searches ?? {}).filter(([url]) => sources.includes(url)),
      );
    for (const {url: address, ...choice} of input) {
      const url = webUrl(address),
        search = siteExtensionKind(url, a.templateId)?.search;
      if (!sources.includes(url))
        throw Error(`Not a saved or suggested source: ${url}. Add it with addSources first.`);
      if (!search) throw Error(`${url} has no site extension search; its trial learns the search.`);
      searches[url] = sourceSearchChoice(search, this.sourceRecipeBase(a, url), choice);
    }
    return Object.keys(searches).length ? searches : null;
  },
  saveSources(id, sources, {acceptDraft = false} = {}) {
    const a = this.get(id),
      urls = normalizeSourceUrls(sources);
    const removed = a.sources.filter((url) => !urls.includes(url)),
      added = urls.filter((url) => !a.sources.includes(url));
    const usesRemoved = (work) =>
      work.sourceUrl
        ? removed.includes(work.sourceUrl)
        : (work.sources ?? a.sources).some((url) => removed.includes(url));
    if (
      this.runs(id).some(
        (run) => run.status === 'running' && !isConversation(run) && usesRemoved(run),
      ) ||
      this.store.workspaces.tasks
        .list(id, {states: ['running', 'reported']})
        .some((task) => task.operation !== 'interview' && usesRemoved(task))
    )
      throw Error('Stop the running task of the source you want to remove first.');
    return this.store.workspaces.tasks.atomic(() => {
      for (const task of this.store.workspaces.tasks.list(id, {states: ['pending', 'paused']}))
        if (removed.includes(task.sourceUrl))
          this.store.workspaces.tasks.finish(id, task.id, 'cancelled', 'Source removed');
      const keep = (values) =>
        Object.fromEntries(Object.entries(values ?? {}).filter(([url]) => urls.includes(url)));
      // A starting source added later (for example a country source proposed in
      // setup), or another address on its site, keeps its template name, recipe
      // and instructions.
      const defaults = this.template(a.templateId).defaultSources ?? [];
      const terms = sharedTerms(a.sourceSettings);
      const seeded = Object.fromEntries(
        added.flatMap((url) => {
          const source = !a.sourceSettings?.[url] && startingSource(defaults, url);
          if (!source) return [];
          const settings = templateSourceSettings(source);
          if (terms && recipeNeedsTerms(settings.recipe))
            settings.recipe = {...settings.recipe, terms};
          return [[url, settings]];
        }),
      );
      const next = {
        ...a,
        sources: urls,
        sourceSettings: {...keep(a.sourceSettings), ...seeded},
        sourceState: keep(a.sourceState),
        updatedAt: this.now(),
      };
      if (a.onceSources) next.onceSources = a.onceSources.filter((url) => urls.includes(url));
      if (a.status === 'enabled' && added.length) next.nextRunAt = this.now();
      if (acceptDraft) delete next.sourceDraft;
      else if (a.sourceDraft) {
        const proposed = [
          ...new Set([...a.sourceDraft.sources.filter((url) => !removed.includes(url)), ...added]),
        ];
        const searches = Object.entries(a.sourceDraft.searches ?? {}).filter(([url]) =>
          proposed.includes(url),
        );
        if (JSON.stringify(proposed) === JSON.stringify(urls) && !searches.length)
          delete next.sourceDraft;
        else
          next.sourceDraft = {
            ...a.sourceDraft,
            id: randomUUID(),
            sources: proposed,
            searches: searches.length ? Object.fromEntries(searches) : undefined,
          };
      }
      return this.put(next);
    });
  },
  addSource(id, input) {
    const a = this.get(id),
      url = webUrl(input.url);
    if (a.sources.includes(url)) throw Error('This source is already saved');
    // An address of a template starting source's site gets its recipe and
    // instructions when the add form leaves them empty.
    const starting = startingSource(this.template(a.templateId).defaultSources, url);
    if (starting) {
      input = {...input};
      if (!input.instructions?.trim()) delete input.instructions;
      if (!input.recipe) delete input.recipe;
    }
    const settings = sourceInput(
      {
        ...a,
        sources: [...a.sources, url],
        sourceSettings: starting ? {[url]: templateSourceSettings(starting)} : {},
      },
      url,
      input,
    );
    return this.store.workspaces.tasks.atomic(() => {
      const next = this.saveSources(id, [...a.sources, url]);
      return this.put({...next, sourceSettings: {...next.sourceSettings, [url]: settings}});
    });
  },
  removeSource(id, url) {
    const a = this.get(id);
    if (!a.sources.includes(url)) throw Error('The source does not belong to this workspace');
    return this.saveSources(
      id,
      a.sources.filter((source) => source !== url),
    );
  },
  resolveSourceDraft(id, draftId, accept) {
    const a = this.get(id);
    if (!a.sourceDraft || a.sourceDraft.id !== draftId)
      throw Error('The source suggestions changed. Review the current suggestions and try again.');
    if (accept)
      return this.store.workspaces.tasks.atomic(() => {
        let next = this.saveSources(id, a.sourceDraft.sources, {acceptDraft: true});
        for (const [url, choice] of Object.entries(a.sourceDraft.searches ?? {}))
          next = this.saveSource(id, url, {
            recipe: sourceSearchRecipe(
              siteExtensionKind(url, next.templateId).search,
              next.sourceSettings?.[url]?.recipe,
              choice,
            ),
          });
        return next;
      });
    delete a.sourceDraft;
    return this.put(a);
  },
  saveSourcesInterval(id, intervalMinutes) {
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 10080)
      throw Error('Scan interval: a whole number between 1 and 10080 is required');
    return this.store.workspaces.tasks.atomic(() => {
      const a = this.get(id);
      for (const url of a.sources) this.saveSource(id, url, {intervalMinutes});
      return this.sources(id);
    });
  },
  saveSource(id, url, input) {
    const a = this.get(id),
      settings = sourceInput(a, url, input);
    const intervalOnly = Object.keys(input).length === 1 && input.intervalMinutes !== undefined;
    if (
      !intervalOnly &&
      this.runs(id).some(
        (r) =>
          !isConversation(r) &&
          r.status === 'running' &&
          (r.sourceUrl === url || r.kind === 'interview' || !r.sourceUrl),
      )
    )
      throw Error('Stop this source’s running task first');
    const old = a.sourceSettings?.[url] ?? {};
    a.sourceSettings = {...a.sourceSettings, [url]: settings};
    const methodChanged =
      (old.instructions ?? '') !== (settings.instructions ?? '') ||
      (old.tool ?? '') !== (settings.tool ?? '') ||
      (old.skill ?? '') !== (settings.skill ?? '');
    if (old.query !== settings.query || methodChanged) this.clearApprovals(id);
    const scopeChanged =
      sourceScanScope({...a, sourceSettings: {...a.sourceSettings, [url]: old}}, url) !==
      sourceScanScope(a, url);
    const state = scopeChanged
      ? {
          trial: methodChanged ? null : (a.sourceState?.[url]?.trial ?? null),
          nextRunAt: this.now(),
          blocked: false,
          lastRunAt: null,
          lastStatus: null,
          lastFound: 0,
          lastResult: methodChanged
            ? 'The source method changed. It will be tried again.'
            : 'The search scope changed. Waiting for a new full scan.',
        }
      : (a.sourceState?.[url] ?? {});
    if (scopeChanged)
      for (const task of this.store.workspaces.tasks.list(id, {states: ['pending']}))
        if (task.sourceUrl === url)
          this.store.workspaces.tasks.finish(
            id,
            task.id,
            'cancelled',
            'Source search scope changed',
          );
    // An edited recipe is a new candidate; the next scan verifies it.
    // Only a different search method invalidates verification; notes, the
    // pagination hint and login flag are advisory.
    const recipeChanged = recipeKey(old.recipe) !== recipeKey(settings.recipe);
    const position =
      recipeChanged && !scopeChanged
        ? this.forgetRecipePosition(id, a, url, old.recipe, state)
        : state;
    a.sourceState = {
      ...a.sourceState,
      [url]: {
        ...position,
        ...(recipeChanged
          ? {
              recipeState: settings.recipe
                ? {status: 'candidate', successCount: 0, failCount: 0}
                : null,
            }
          : {}),
        ...(settings.intervalMinutes !== old.intervalMinutes && !state.blocked
          ? {
              nextRunAt: state.lastRunAt
                ? state.lastRunAt + (settings.intervalMinutes ?? a.intervalMinutes) * 60000
                : this.now(),
            }
          : {}),
      },
    };
    return this.put(a);
  },
  // Called from a running source task: the agent proposed a recipe and the app
  // already checked it. Never resets the trial or the scan scope.
  learnSourceRecipe(id, url, recipe, {runId, verified, listings = 0, pages = 0}) {
    const a = this.get(id);
    if (!a.sources.includes(url)) throw Error('The source does not belong to this workspace');
    const settings = sourceInput(a, url, {recipe});
    const previous = a.sourceState?.[url]?.recipeState ?? {};
    const recipeState =
      recipe.entry.kind === 'discovery'
        ? {
            status: 'discovery',
            successCount: 0,
            failCount: 0,
            learnedRunId: runId,
            learnedAt: this.now(),
          }
        : verified
          ? {
              status: 'verified',
              successCount: (previous.successCount ?? 0) + 1,
              failCount: 0,
              verifiedAt: this.now(),
              learnedRunId: runId,
              lastRunId: runId,
              lastFailure: null,
              evidence: {listings, pages},
            }
          : {status: 'candidate', successCount: 0, failCount: 0, learnedRunId: runId};
    const old = a.sourceSettings?.[url]?.recipe ?? null,
      state = a.sourceState?.[url] ?? {};
    const changed = recipeKey(old) !== recipeKey(settings.recipe);
    const position = changed ? this.forgetRecipePosition(id, a, url, old, state) : state;
    const saved = this.put({
      ...a,
      sourceSettings: {...a.sourceSettings, [url]: settings},
      sourceState: {...a.sourceState, [url]: {...position, recipeState}},
    });
    // The running scan continues with the new recipe's searches; the search the
    // agent is on stays until it completes it.
    const run = changed ? this.runs(id).find((r) => r.id === runId) : null;
    if (run?.status === 'running' && run.sourceUrl === url && run.scan?.work && !run.collector) {
      const oldReplay = recipeReplay(old, recipeValues(a, url)),
        kept = dropRecipeSearches(
          run.scan,
          (candidate) => replayMatches(oldReplay, candidate),
          run.scan.work.activeSearchId,
        );
      const scan = replayScanWork(
        kept,
        recipeReplay(settings.recipe, recipeValues(a, url))?.searches,
      );
      if (scan !== run.scan) this.persistScan(id, {...run, scan});
    }
    return saved;
  },
  // A new search method restarts the results pages of the saved scan while
  // queued listings stay: they are the same opportunities whichever page listed
  // them. Addresses the old recipe produced are results pages, not listings.
  forgetRecipePosition(id, a, url, oldRecipe, state) {
    const replay = recipeReplay(oldRecipe, recipeValues(a, url)),
      oldResults = (candidate) => replayMatches(replay, candidate);
    const queue = this.store.workspaces.tasks;
    for (const task of queue.list(id, {states: ['pending', 'paused', 'blocked']}))
      if (task.sourceUrl === url && (task.scan || task.scanPlan))
        queue.put({
          ...task,
          ...(task.scan ? {scan: forgetScanPosition({scan: task.scan}, oldResults).scan} : {}),
          ...(task.scanPlan ? {scanPlan: forgetPlanPosition(task.scanPlan)} : {}),
        });
    return forgetScanPosition(state, oldResults);
  },
  // Forget that the source was ever checked so its next turn is a trial with
  // the trial agent. The saved recipe stays as a candidate for comparison.
  relearnSource(id, url) {
    const a = this.get(id);
    if (!a.sources.includes(url)) throw Error('The source does not belong to this workspace');
    if (
      this.runs(id).some((r) => !isConversation(r) && r.status === 'running' && r.sourceUrl === url)
    )
      throw Error('Stop this source’s running task first');
    const state = a.sourceState?.[url] ?? {},
      recipe = a.sourceSettings?.[url]?.recipe;
    return this.put({
      ...a,
      sourceState: {
        ...a.sourceState,
        [url]: {
          ...state,
          trial: {status: 'requested', at: this.now()},
          blocked: false,
          nextRunAt: this.now(),
          recipeState: recipe ? {...state.recipeState, status: 'candidate', failCount: 0} : null,
          lastResult: 'The source will be learned again. The next round will be a trial.',
        },
      },
    });
  },
  // Start the next scan of this source from its first results page. Recorded
  // and rejected listings stay known, so they are not read again.
  forgetSourceScan(id, url) {
    const a = this.get(id),
      state = a.sourceState?.[url] ?? {};
    return this.put({
      ...a,
      sourceState: {
        ...a.sourceState,
        [url]: {
          ...state,
          scan: null,
          pageProgress: null,
          observedPage: null,
          ...(state.scanState ? {scanState: {...state.scanState, active: null}} : {}),
        },
      },
    });
  },
  sourceRecipe(id, url) {
    const a = this.get(id),
      saved = a.sourceSettings?.[url]?.recipe ?? null,
      search =
        saved?.entry?.kind === 'url_template' ? siteExtensionKind(url, a.templateId)?.search : null,
      // The site extension owns the sort, pagination and ordering of its results
      // address, also for a recipe saved before the extension changed them.
      recipe = search ? siteSearchRecipe(search, saved).recipe : saved,
      state = a.sourceState?.[url]?.recipeState ?? null;
    return {
      recipe,
      state,
      status: recipeStatus(recipe, state),
      replay:
        recipeStatus(recipe, state) === 'stale' ? null : recipeReplay(recipe, recipeValues(a, url)),
    };
  },
};
