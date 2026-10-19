// @ts-check
import {normalizeSourceRecipe} from './recipe.mjs';
import {
  searchFilterValues,
  siteSearchRecipe,
  withSearchFilters,
} from '../site-extensions/search.mjs';

// The setup agent picks a source's search terms and the extension filters that
// have fixed values; the extension keeps the address, sort and pagination. The
// result is a candidate recipe the source's next scan verifies.
const baseRecipe = (search, recipe) =>
  recipe?.entry.kind === 'url_template'
    ? recipe
    : {entry: {kind: 'url_template', template: search.template}, pagination: 'auto'};
const choiceFilters = (search) => search.filters.filter((filter) => filter.values);

// What the agent can choose for a source and what its recipe uses now.
export function sourceSearchOptions(search, recipe) {
  const base = baseRecipe(search, recipe),
    current = searchFilterValues(search, base.entry.template);
  return {
    ...(search.notes ? {notes: search.notes} : {}),
    ...(base.terms ? {terms: base.terms} : {}),
    filters: choiceFilters(search).map(({param, label, values}) => ({
      param,
      label,
      values,
      ...(current[param] ? {current: current[param]} : {}),
    })),
  };
}

// Validates a choice and returns it with a summary for the Sources screen.
export function sourceSearchChoice(search, recipe, input) {
  const filters = (input.filters ?? []).map(({param, value = ''}) => {
    const filter = choiceFilters(search).find((f) => f.param === param);
    if (!filter)
      throw Error(
        `${param} is not a choosable filter of this site. Filters: ${
          choiceFilters(search)
            .map((f) => f.param)
            .join(', ') || 'none'
        }`,
      );
    if (value && !Object.hasOwn(filter.values, value))
      throw Error(
        `${filter.label} (${param}) accepts ${Object.keys(filter.values).join(', ')}, or "" to remove it`,
      );
    return {param, value, label: `${filter.label}: ${value ? filter.values[value] : 'any'}`};
  });
  const choice = {...(input.terms ? {terms: input.terms} : {}), filters};
  sourceSearchRecipe(search, recipe, choice);
  return choice;
}

// Empty terms drop the source's own terms, so it searches with the workspace's.
export function sourceSearchRecipe(search, recipe, {terms = undefined, filters}) {
  const {terms: own, ...base} = baseRecipe(search, recipe),
    template = withSearchFilters(
      base.entry.template,
      Object.fromEntries(filters.map((f) => [f.param, f.value])),
    ),
    kept = terms ?? own;
  return normalizeSourceRecipe(
    siteSearchRecipe(search, {
      ...base,
      entry: {...base.entry, template},
      ...(kept?.length ? {terms: kept} : {}),
    }).recipe,
  );
}
