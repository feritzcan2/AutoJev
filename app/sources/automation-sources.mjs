// @ts-check
import {boundedText, webUrl} from '../templates/catalog.mjs';
import {normalizeSourceRecipe} from './recipe.mjs';

const modes = ['observe', 'prepare', 'auto'];
export function sourceMode(automation, url) {
  // An unregistered or disabled source cannot inherit broader workspace authority.
  // No URL means workspace context; record actions separately require a source.
  if (
    url &&
    (!automation.sources?.includes(url) || automation.sourceSettings?.[url]?.enabled === false)
  )
    return 'observe';
  const requested = automation.sourceSettings?.[url]?.mode ?? automation.mode;
  return modes[Math.min(modes.indexOf(automation.mode), modes.indexOf(requested))] ?? 'observe';
}
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
    };
  });
}
export function sourceInput(a, url, input) {
  url = webUrl(url);
  if (!a.sources.includes(url)) throw Error('The source does not belong to this workspace');
  const saved = a.sourceSettings?.[url] ?? {},
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
  if (input.mode !== undefined) {
    if (!modes.includes(input.mode) || modes.indexOf(input.mode) > modes.indexOf(a.mode))
      throw Error('Source permissions cannot exceed the profile action permissions');
    result.mode = input.mode;
  }
  return result;
}
