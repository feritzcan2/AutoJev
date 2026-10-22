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
    ...(base.entry.variants ? {setups: base.entry.variants} : {}),
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
  const choice = {
    ...(input.terms ? {terms: input.terms} : {}),
    filters: filterChoices(search, input.filters),
    ...(input.setups ? {setups: input.setups.map((setup) => setupChoice(search, setup))} : {}),
  };
  sourceSearchRecipe(search, recipe, choice);
  return choice;
}

// A further search setup beside the main address: the same terms in another
// place and with its own filter values (remote anywhere in a country beside
// hybrid in one city). Filters it leaves out keep the main search's values.
const setupChoice = (search, {label, location = '', filters}) => ({
  label,
  ...(location ? {location} : {}),
  filters: filterChoices(search, filters),
});

function filterChoices(search, input = []) {
  return input.map(({param, value = ''}) => {
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
}

const filterValues = (filters) => Object.fromEntries(filters.map((f) => [f.param, f.value]));

// A choice without setups keeps the recipe's setups; an empty list removes them.
export function sourceSearchRecipe(
  search,
  recipe,
  {terms = undefined, filters, setups = undefined},
) {
  const base = baseRecipe(search, recipe),
    template = withSearchFilters(base.entry.template, filterValues(filters)),
    variants = setups
      ? setups.map(({label, location, filters: own}) => {
          if (location && !template.includes('{location}'))
            throw Error(
              `Setup ${label}: this search address has no {location}; leave out the setup's location`,
            );
          return {
            label,
            template: withSearchFilters(
              location ? template.replaceAll('{location}', encodeURIComponent(location)) : template,
              filterValues(own),
            ),
          };
        })
      : base.entry.variants,
    entry = {kind: base.entry.kind, template, ...(variants?.length ? {variants} : {})},
    next = siteSearchRecipe(search, {...base, entry, ...(terms ? {terms} : {})}).recipe;
  // Each setup follows the same site structure as the main address.
  if (next.entry.variants)
    next.entry.variants = next.entry.variants.map((variant) => ({
      ...variant,
      template: siteSearchRecipe(search, {...next, entry: variant}).recipe.entry.template,
    }));
  return normalizeSourceRecipe(next);
}
