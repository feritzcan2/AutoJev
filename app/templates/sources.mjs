// @ts-check
import {normalizeSourceRecipe} from '../sources/recipe.mjs';
import {siteKey} from '../browser/site-key.mjs';

// countries (ISO 3166 alpha-2) marks a source that serves only those
// countries; it joins a workspace when setup adds it. Untagged sources serve
// every country and join every new workspace.
export const TEMPLATE_SOURCE_LIMIT = 100;
export const globalTemplateSource = (source) => !source.countries?.length;
export function templateSourceSettings({url: _url, countries: _countries, ...settings}) {
  return settings;
}
// The starting source a workspace address belongs to: the same address, or
// else the same site (host without www), so any LinkedIn or StepStone address
// gets that board's ready recipe and instructions.
export function startingSource(sources = [], url) {
  return sources.find((s) => s.url === url) ?? sources.find((s) => siteKey(s.url) === siteKey(url));
}
export function normalizeTemplateSources(input = []) {
  if (!Array.isArray(input) || input.length > TEMPLATE_SOURCE_LIMIT)
    throw Error(`A template can hold at most ${TEMPLATE_SOURCE_LIMIT} starting sources`);
  const seen = new Set();
  return input.map((source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source))
      throw Error('Invalid source definition');
    let url;
    try {
      url = new URL(source.url);
    } catch {
      throw Error('Invalid template source address');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw Error('A template source must be an HTTP(S) address without user credentials');
    url.hash = '';
    const address = url.href;
    if (seen.has(address)) throw Error('Template source addresses must be unique');
    seen.add(address);
    const name = source.name ?? url.hostname,
      query = source.query ?? '',
      intervalMinutes = source.intervalMinutes ?? 30,
      enabled = source.enabled ?? true;
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      name.length > 120 ||
      typeof query !== 'string' ||
      query.length > 6000
    )
      throw Error('Invalid template source description');
    if (
      !Number.isInteger(intervalMinutes) ||
      intervalMinutes < 1 ||
      intervalMinutes > 10080 ||
      typeof enabled !== 'boolean'
    )
      throw Error('Invalid template source schedule');
    const instructions = source.instructions ?? '';
    if (typeof instructions !== 'string' || instructions.length > 6000)
      throw Error('Source instructions must be at most 6000 characters');
    if (
      source.skill !== undefined &&
      (typeof source.skill !== 'string' || source.skill.length > 60000)
    )
      throw Error('A source skill must be at most 60000 characters');
    const recipe = normalizeSourceRecipe(source.recipe);
    const countries = source.countries ?? [];
    if (
      !Array.isArray(countries) ||
      countries.length > 60 ||
      countries.some((c) => typeof c !== 'string' || !/^[A-Z]{2}$/.test(c))
    )
      throw Error('Source countries must be two-letter ISO codes');
    return {
      url: address,
      name: name.trim(),
      query,
      intervalMinutes,
      enabled,
      ...(countries.length ? {countries: [...new Set(countries)]} : {}),
      ...(instructions ? {instructions: instructions.trim()} : {}),
      ...(source.skill !== undefined ? {skill: source.skill} : {}),
      ...(recipe ? {recipe} : {}),
    };
  });
}
