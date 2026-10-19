// @ts-check
// What a site extension knows about the site's results address: the template
// its searches use, the order that template gives and the filters the address
// accepts. Data only: recipes are built from it, nothing here reads a page or
// judges a listing. Also bundled into the renderer; keep it free of app imports.
//
// search: {template, ordering?, pagination?, filters, notes?, removes?}
// removes: address parameters a saved template drops, such as a sort the site
// no longer uses, so the site's default applies.
// filter: {param, label, values?} — values maps a parameter value to its
// label; without values the filter takes free text.
// Placeholders must survive the form encoding of URLSearchParams.
const restore = (encoded) => encoded.replace(/%7B([a-z_][a-z0-9_]*)%7D/gi, '{$1}');
const split = (template) => {
  const [base, query = ''] = String(template ?? '').split(/\?(.*)/s);
  return {base, params: new URLSearchParams(query)};
};

// The values a results template carries for the site's filters, by parameter.
export function searchFilterValues(search, template) {
  const {params} = split(template);
  return Object.fromEntries(
    search.filters
      .map((filter) => [filter.param, params.get(filter.param)])
      .filter(([, value]) => value !== null),
  );
}

// The template with these filter values; an empty value removes the filter.
export function withSearchFilters(template, values) {
  const {base, params} = split(template);
  for (const [param, value] of Object.entries(values))
    if (value) params.set(param, value);
    else params.delete(param);
  const query = restore(params.toString());
  return query ? `${base}?${query}` : base;
}

// "label: value" lines for the filters a template carries, for the source screen.
export const searchFilterLabels = (search, template) =>
  Object.entries(searchFilterValues(search, template)).map(([param, value]) => {
    const filter = search.filters.find((f) => f.param === param);
    return `${filter.label}: ${filter.values?.[value] ?? value}`;
  });

// An agent's url_template recipe for a site whose results address the
// extension knows. The extension owns the site structure: its fixed address
// parameters (the sort) and the ones it removes, the pagination and the ordering. The agent keeps its
// choices: the path, the search placeholders, the terms and the filter values.
// Returns the recipe to save and the fields that changed.
export function siteSearchRecipe(search, recipe) {
  const placeholder = /\{[a-z_][a-z0-9_]*\}/i,
    fixed = [...split(search.template).params].filter(
      ([param, value]) =>
        !placeholder.test(value) && !search.filters.some((filter) => filter.param === param),
    ),
    {base, params} = split(recipe.entry.template),
    removed = (search.removes ?? []).filter((param) => params.has(param)),
    keepsFixed = !removed.length && fixed.every(([param, value]) => params.get(param) === value);
  for (const [param, value] of fixed) params.set(param, value);
  for (const param of removed) params.delete(param);
  const query = restore(params.toString()),
    template = keepsFixed ? recipe.entry.template : query ? `${base}?${query}` : base,
    next = {
      ...recipe,
      entry: {...recipe.entry, template},
      pagination: search.pagination ?? recipe.pagination,
    };
  if (search.ordering) next.ordering = search.ordering;
  else delete next.ordering;
  const changed = [
    ...(keepsFixed ? [] : ['template']),
    ...(next.pagination !== recipe.pagination ? ['pagination'] : []),
    ...(next.ordering !== recipe.ordering ? ['ordering'] : []),
  ];
  return {recipe: next, changed};
}
