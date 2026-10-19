// @ts-check
import {boundedText, webUrl} from '../templates/catalog.mjs';
import {normalizeSourceRecipe, recipeNeedsTerms} from './recipe.mjs';
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
  'Search terms required: the search address takes {query} and the recipe has no search terms. Add them on the source’s recipe or ask the setup chat.';
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
      // A trial still runs and learns the terms; a scan waits for them.
      termsRequired:
        recipeNeedsTerms(saved.recipe) &&
        Boolean(sourceCollector(a, url) || siteSourceTrialReady(a, url)),
    };
  });
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
