// @ts-check
import {boundedText, webUrl} from '../templates/catalog.mjs';
import {
  normalizeSourceRecipe,
  recipeNeedsTerms,
  sameTerms,
  sourceRecipeOf,
  takesSearchTerms,
} from './recipe.mjs';
import {sourceCollector} from './collectors.mjs';
import {sourceTrialReady} from './trial.mjs';
import {siteExtensionKind} from '../site-extensions/index.mjs';

// The action permission is set only on the profile; every source follows it.
export function sourceMode(automation, url) {
  // An unregistered or disabled source cannot inherit workspace authority.
  // No URL means workspace context; record actions separately require a source.
  if (
    url &&
    (!automation.sources?.includes(url) || automation.sourceSettings?.[url]?.enabled === false)
  )
    return 'observe';
  return automation.mode ?? 'observe';
}
export const siteSourceTrialReady = (a, url) =>
  sourceTrialReady(a, url, {siteSearch: Boolean(siteExtensionKind(url, a.templateId)?.search)});
export const TERMS_REQUIRED =
  'Search terms required: the search address takes {query} and has no search terms. Add the workspace search terms on Sources, give this source its own terms, or ask the setup chat.';
export function automationSources(a) {
  return a.sources.map((url) => {
    const saved = a.sourceSettings?.[url] ?? {},
      state = a.sourceState?.[url] ?? {},
      recipe = sourceRecipeOf(a, url);
    return {
      ...saved,
      id: url,
      url,
      name: saved.name ?? new URL(url).hostname.replace(/^www\./, ''),
      query: saved.query ?? a.goal,
      enabled: saved.enabled !== false,
      intervalMinutes: saved.intervalMinutes ?? a.intervalMinutes,
      mode: sourceMode(a, url),
      // The recipe it scans with; sharedTerms marks the workspace's terms in it.
      ...(recipe ? {recipe} : {}),
      sharedTerms: takesSearchTerms(saved.recipe),
      ...state,
      trialReady: siteSourceTrialReady(a, url),
      // A trial still runs and learns the terms; a scan waits for them.
      termsRequired:
        recipeNeedsTerms(recipe) &&
        Boolean(sourceCollector(a, url) || siteSourceTrialReady(a, url)),
    };
  });
}
// Workspaces saved before the shared search terms: the terms list two or more
// keyword sources hold exactly becomes the workspace's and those sources drop
// their copy, so every source keeps searching the same. Runs once per workspace.
export function adoptSearchTerms(a) {
  if (a.searchTerms) return null;
  const own = (url) => {
    const {terms, ...recipe} = a.sourceSettings?.[url]?.recipe ?? {};
    return terms?.length && takesSearchTerms(recipe) ? {terms, recipe} : null;
  };
  const counts = new Map();
  for (const url of a.sources) {
    const key = JSON.stringify(own(url)?.terms ?? null);
    if (key !== 'null') counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const [best] = [...counts].sort((x, y) => y[1] - x[1]),
    searchTerms = best?.[1] >= 2 ? JSON.parse(best[0]) : [],
    sourceSettings = {...a.sourceSettings};
  for (const url of a.sources) {
    const source = own(url);
    if (sameTerms(source?.terms, searchTerms))
      sourceSettings[url] = {...sourceSettings[url], recipe: source.recipe};
  }
  return {...a, searchTerms, sourceSettings};
}
export function sourceInput(a, url, input) {
  url = webUrl(url);
  if (!a.sources.includes(url)) throw Error('The source does not belong to this workspace');
  // Older versions saved a per-source mode; the profile now decides alone.
  const {mode, ...saved} = a.sourceSettings?.[url] ?? {},
    result = {...saved};
  if (input.name !== undefined) result.name = boundedText(input.name, 'Source name', 120);
  if (input.query !== undefined) result.query = boundedText(input.query, 'Search scope', 2000);
  if (input.instructions !== undefined)
    result.instructions = boundedText(input.instructions, 'Working instructions', 6000, {
      empty: true,
    });
  if (input.skill !== undefined)
    result.skill = boundedText(input.skill, 'Source skill', 60000, {empty: true});
  if (input.recipe !== undefined) {
    const recipe = normalizeSourceRecipe(input.recipe);
    // The workspace's own terms keep the source on the shared list.
    if (
      recipe &&
      sameTerms(recipe.terms, a.searchTerms) &&
      takesSearchTerms({...recipe, terms: undefined})
    )
      delete recipe.terms;
    if (recipe) result.recipe = recipe;
    else delete result.recipe;
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw Error('Invalid source state');
    result.enabled = input.enabled;
  }
  if (input.intervalMinutes !== undefined) {
    if (
      !Number.isInteger(input.intervalMinutes) ||
      input.intervalMinutes < 1 ||
      input.intervalMinutes > 10080
    )
      throw Error('Scan interval: an integer from 1 to 10080 is required');
    result.intervalMinutes = input.intervalMinutes;
  }
  return result;
}
