// @ts-check
// A site extension knows a site's results address but not every value the
// site writes its own way: a location may become an ID (geoId=…), a path part
// (/in-berlin) or a region code. When the extension reports a value it cannot
// write (SearchValueError), the scan does not retry it as a page failure. The
// source goes to a trial round: the agent enters the value in the site's own
// search field, reads how the results address carries it, and saves a recipe
// learned for that value (recipe.learnedFor). A changed value is learned again.
import {searchLearning} from './recipe.mjs';

export {searchLearning};

export const searchLearningSummary = ({field, value}) =>
  `The site extension cannot write the ${field} "${value}" into this site's search address. The next round learns how the site writes it in the browser, then the scan starts again.`;

// The collector reported the value: the source learns it in its next round,
// and this run ends without a technical retry. suggestions are address values
// the site's own lookup gave for it ({param, value}, best first); the trial
// tries them before the site's search field.
export function requestSearchLearning(db, runId, {field, value, message}, suggestions = []) {
  const run = db.run(runId),
    a = db.get(run.automationId),
    state = a.sourceState?.[run.sourceUrl] ?? {},
    learning = {
      field,
      value,
      message: String(message ?? '').slice(0, 1000),
      ...(suggestions.length ? {suggestions: suggestions.slice(0, 3)} : {}),
      runId,
      at: db.now(),
    };
  db.put({
    ...a,
    sourceState: {...a.sourceState, [run.sourceUrl]: {...state, searchLearning: learning}},
  });
  db.putRun({...run, searchLearning: learning, collectorError: null});
  return {
    status: 'search_learning',
    field,
    value,
    next: `${searchLearningSummary(learning)} End the turn now without calling any tool. Do not ask the user and do not report this run as failed or blocked.`,
  };
}

export function clearSearchLearning(db, id, url) {
  const a = db.get(id),
    state = a.sourceState?.[url];
  if (!state?.searchLearning) return;
  const {searchLearning: _, ...rest} = state;
  db.put({...a, sourceState: {...a.sourceState, [url]: rest}});
}

// What the trial agent reads in assignedSource.
export function searchLearningContext(learning) {
  const {field, value, learnedValue, suggestions = []} = learning;
  const listed = suggestions.map((s) => `${s.param}=${s.value}`).join(', ');
  return {
    field,
    value,
    ...(learnedValue !== undefined ? {learnedValue} : {}),
    ...(suggestions.length ? {suggestions} : {}),
    guidance:
      (learnedValue !== undefined
        ? `The saved recipe was learned for the ${field} "${learnedValue}"; it is now "${value}". `
        : `The site extension cannot write the ${field} "${value}" into this site's search address. `) +
      (suggestions.length
        ? `The site's own lookup suggests these address values for "${value}", best match first: ${listed}. Try the first one: save the recipe with save_source_recipe as url_template from siteSearch.template (when present), with that parameter in place of {${field}} and the search terms kept. The app checks that the results follow the ${field}. If the check refuses it, try the next one. Only when none passes, learn it in the browser as follows. `
        : '') +
      `This trial learns how the site writes it. Do not start with recipeReplay. Open the site's search page with browser_open, enter "${value}" in the site's own ${field} field, choose the suggestion that names it and run the search. Compare the results address with the one before: the parameter or path part the site added is how it writes the ${field}. Save the recipe with save_source_recipe as url_template from siteSearch.template (when present), with that parameter in place of {${field}} and the search terms kept. The app checks that the results follow the ${field}. If the site has no such field, or the address does not change when you choose it, report the trial blocked with what you observed.`,
  };
}

const folded = (text) =>
  String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

// Whether listing cards name the value ("Netherlands" in "Amsterdam, North
// Holland, Netherlands"); a value with parts ("Berlin, Germany") matches any
// part. null when the cards carry no location to compare.
export function cardsShowLocation(value, jobs) {
  const parts = folded(value)
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length >= 2),
    located = jobs.map((job) => folded(job.location)).filter(Boolean);
  if (!parts.length || !located.length) return null;
  return located.some((location) => parts.some((part) => location.includes(part)));
}

// The first page with the learned value against the same search without it.
// The cards may name places in the site's language, so a page whose cards do
// not name the value still passes when its results differ from the search
// without it. readWithout is null when there is no such search to compare.
export async function learnedLocationApplied(value, jobs, readWithout) {
  if (cardsShowLocation(value, jobs) !== false) return {ok: true};
  if (!readWithout) return {ok: true};
  const without = new Set((await readWithout()).map((job) => job.url)),
    shared = jobs.filter((job) => without.has(job.url)).length;
  if (jobs.length && shared / jobs.length < 0.8) return {ok: true};
  const shown = [...new Set(jobs.map((job) => job.location).filter(Boolean))].slice(0, 4);
  return {
    ok: false,
    reason: `the results do not follow the location "${value}": they match the search without it and show other locations (${shown.join('; ')})`,
  };
}
