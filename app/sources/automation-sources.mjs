// @ts-check
import {boundedText, webUrl} from '../templates/catalog.mjs';
import {normalizeSourceRecipe, recipeNeedsTerms} from './recipe.mjs';
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
export function automationSources(a) {
  return a.sources.map((url) => {
    const saved = a.sourceSettings?.[url] ?? {},
      state = a.sourceState?.[url] ?? {};
    return {
      ...saved,
      id: url,
      url,
      name: saved.name ?? new URL(url).hostname.replace(/^www\./, ''),
      query: saved.query ?? a.goal,
      enabled: saved.enabled !== false,
      intervalMinutes: saved.intervalMinutes ?? a.intervalMinutes,
      mode: sourceMode(a, url),
      ...state,
      trialReady: siteSourceTrialReady(a, url),
    };
  });
}
// Workspaces saved with the short-lived workspace search terms (schema 43):
// every source that searched with that list keeps it as its own terms, so
// each source searches as before and manages its terms itself.
export function ownSearchTerms(a) {
  if (!('searchTerms' in a) && !a.sourceDraft?.searchTerms) return null;
  const {searchTerms, ...next} = a;
  next.sourceSettings = {...a.sourceSettings};
  for (const url of a.sources) {
    const recipe = a.sourceSettings?.[url]?.recipe,
      [path, query = ''] = recipe?.entry.template?.split(/\?(.*)/s) ?? [];
    if (
      searchTerms?.length &&
      recipeNeedsTerms(recipe) &&
      !path.includes('{query}') &&
      query.includes('{query}')
    )
      next.sourceSettings[url] = {
        ...next.sourceSettings[url],
        recipe: {...recipe, terms: [...searchTerms]},
      };
  }
  if (next.sourceDraft?.searchTerms) {
    const {searchTerms: dropped, ...draft} = next.sourceDraft;
    next.sourceDraft = draft;
  }
  return next;
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
