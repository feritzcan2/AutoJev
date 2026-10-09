import {isConversation} from '../../workspaces/conversation.mjs';
import {forgetScanPosition, forgetPlanPosition} from '../../sources/scan-work.mjs';
import {recipeValues, recipeReplay, replayMatches, recipeStatus} from '../../sources/recipe.mjs';
import {siteExtensionKind} from '../../site-extensions/index.mjs';
import {templateSourceSettings} from '../../templates/sources.mjs';
import {randomUUID} from 'node:crypto';
import {normalizeSourceUrls, webUrl} from '../../templates/catalog.mjs';
import {automationSources, sourceInput} from '../../sources/automation-sources.mjs';
import {sourceScanScope} from '../../sources/scan.mjs';
import {json, finishedSourceRun, runSource} from './rows.mjs';
// Only a different search method changes a recipe; notes, the pagination
// hint, the page cap and the login flag are advisory.
const recipeKey = (r) => (r ? JSON.stringify({entry: r.entry, terms: r.terms ?? null}) : null);

// AutomationStore methods: source list, per-source settings, waits and learned recipes.
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
          `SELECT json_object('id',id,'kind',json_extract(data,'$.kind'),'status',json_extract(data,'$.status'),'summary',json_extract(data,'$.summary'),'finishedAt',json_extract(data,'$.finishedAt'),'sourceUrl',json_extract(data,'$.sourceUrl'),'sources',json_extract(data,'$.sources')) AS data FROM automation_runs WHERE rowid IN (
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
        siteWait: this.sourceWait(id, source, a),
        pageProgress:
          active && !active.recordId
            ? (active.pageProgress ?? null)
            : (source.pageProgress ?? null),
        observedPage: active?.observedPage ?? source.observedPage ?? null,
        resultCount,
        extension: siteExtensionKind(source.url, a.templateId),
        scanning: Boolean(active),
        trialRunning: active?.kind === 'trial',
        scanIssue: active
          ? (Object.values(active.scanIssues ?? {}).sort((a, b) => b.at - a.at)[0] ?? null)
          : null,
        workerId: active?.workerId ?? null,
      };
    });
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
      throw Error('Kaldırılacak kaynağın çalışan görevini önce durdur.');
    return this.store.workspaces.tasks.atomic(() => {
      for (const task of this.store.workspaces.tasks.list(id, {states: ['pending', 'paused']}))
        if (removed.includes(task.sourceUrl))
          this.store.workspaces.tasks.finish(id, task.id, 'cancelled', 'Kaynak kaldırıldı');
      const keep = (values) =>
        Object.fromEntries(Object.entries(values ?? {}).filter(([url]) => urls.includes(url)));
      // A starting source added later (for example a country source proposed in
      // setup) keeps its template name, recipe and instructions.
      const defaults = new Map(
        (this.template(a.templateId).defaultSources ?? []).map((source) => [
          source.url,
          templateSourceSettings(source),
        ]),
      );
      const seeded = Object.fromEntries(
        added
          .filter((url) => !a.sourceSettings?.[url] && defaults.has(url))
          .map((url) => [url, defaults.get(url)]),
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
        if (JSON.stringify(proposed) === JSON.stringify(urls)) delete next.sourceDraft;
        else next.sourceDraft = {...a.sourceDraft, id: randomUUID(), sources: proposed};
      }
      return this.put(next);
    });
  },
  addSource(id, input) {
    const a = this.get(id),
      url = webUrl(input.url);
    if (a.sources.includes(url)) throw Error('Bu kaynak zaten kayıtlı');
    const settings = sourceInput({...a, sources: [...a.sources, url]}, url, input);
    return this.store.workspaces.tasks.atomic(() => {
      const next = this.saveSources(id, [...a.sources, url]);
      return this.put({...next, sourceSettings: {...next.sourceSettings, [url]: settings}});
    });
  },
  removeSource(id, url) {
    const a = this.get(id);
    if (!a.sources.includes(url)) throw Error('Kaynak bu çalışma alanına ait değil');
    return this.saveSources(
      id,
      a.sources.filter((source) => source !== url),
    );
  },
  resolveSourceDraft(id, draftId, accept) {
    const a = this.get(id);
    if (!a.sourceDraft || a.sourceDraft.id !== draftId)
      throw Error('Kaynak önerileri değişti. Güncel önerileri inceleyip tekrar dene.');
    if (accept) return this.saveSources(id, a.sourceDraft.sources, {acceptDraft: true});
    delete a.sourceDraft;
    return this.put(a);
  },
  saveSourcesInterval(id, intervalMinutes) {
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 10080)
      throw Error('Tarama aralığı: 1–10080 arasında tam sayı gerekli');
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
      throw Error('Önce bu kaynağın çalışan görevini durdur');
    const old = a.sourceSettings?.[url] ?? {};
    a.sourceSettings = {...a.sourceSettings, [url]: settings};
    const methodChanged =
      (old.instructions ?? '') !== (settings.instructions ?? '') ||
      (old.tool ?? '') !== (settings.tool ?? '') ||
      (old.skill ?? '') !== (settings.skill ?? '');
    if (old.query !== settings.query || old.mode !== settings.mode || methodChanged)
      this.clearApprovals(id);
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
            ? 'Kaynak yöntemi değişti. Yeniden denenecek.'
            : 'Arama kapsamı değişti. Yeni tam tarama bekleniyor.',
        }
      : (a.sourceState?.[url] ?? {});
    if (scopeChanged)
      for (const task of this.store.workspaces.tasks.list(id, {states: ['pending']}))
        if (task.sourceUrl === url)
          this.store.workspaces.tasks.finish(
            id,
            task.id,
            'cancelled',
            'Kaynak arama kapsamı değişti',
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
    if (!a.sources.includes(url)) throw Error('Kaynak bu çalışma alanına ait değil');
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
    const position =
      recipeKey(old) !== recipeKey(settings.recipe)
        ? this.forgetRecipePosition(id, a, url, old, state)
        : state;
    return this.put({
      ...a,
      sourceSettings: {...a.sourceSettings, [url]: settings},
      sourceState: {...a.sourceState, [url]: {...position, recipeState}},
    });
  },
  // A new search method restarts the results pages of the saved scan while
  // queued listings stay: they are the same opportunities whichever page listed
  // them. Addresses the old recipe produced are results pages, not listings.
  forgetRecipePosition(id, a, url, oldRecipe, state) {
    const replay = recipeReplay(oldRecipe, recipeValues(a, url)),
      oldResults = (candidate) => replayMatches(replay, candidate);
    const queue = this.store.workspaces.tasks;
    for (const task of queue.list(id, {states: ['pending']}))
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
    if (!a.sources.includes(url)) throw Error('Kaynak bu çalışma alanına ait değil');
    if (
      this.runs(id).some((r) => !isConversation(r) && r.status === 'running' && r.sourceUrl === url)
    )
      throw Error('Önce bu kaynağın çalışan görevini durdur');
    const state = a.sourceState?.[url] ?? {},
      recipe = a.sourceSettings?.[url]?.recipe;
    return this.put({
      ...a,
      sourceState: {
        ...a.sourceState,
        [url]: {
          ...state,
          trial: null,
          blocked: false,
          nextRunAt: this.now(),
          recipeState: recipe ? {...state.recipeState, status: 'candidate', failCount: 0} : null,
          lastResult: 'Kaynak yeniden öğrenilecek. Sıradaki tur deneme olacak.',
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
      recipe = a.sourceSettings?.[url]?.recipe ?? null,
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
