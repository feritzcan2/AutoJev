// @ts-check
import {normalizeSourceRecipe} from '../sources/recipe.mjs';

// countries (ISO 3166 alpha-2) marks a source that serves only those
// countries; it joins a workspace when setup adds it. Untagged sources serve
// every country and join every new workspace.
export const TEMPLATE_SOURCE_LIMIT = 100;
export const globalTemplateSource = (source) => !source.countries?.length;
export function templateSourceSettings({url: _url, countries: _countries, ...settings}) {
  return settings;
}
export function normalizeTemplateSources(input = []) {
  if (!Array.isArray(input) || input.length > TEMPLATE_SOURCE_LIMIT)
    throw Error(`Template en fazla ${TEMPLATE_SOURCE_LIMIT} başlangıç kaynağı içerebilir`);
  const seen = new Set();
  return input.map((source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source))
      throw Error('Geçersiz kaynak tanımı');
    let url;
    try {
      url = new URL(source.url);
    } catch {
      throw Error('Geçersiz template kaynak adresi');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw Error('Template kaynağı kullanıcı bilgisi içermeyen HTTP(S) adresi olmalı');
    url.hash = '';
    const address = url.href;
    if (seen.has(address)) throw Error('Template kaynak adresleri benzersiz olmalı');
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
      throw Error('Geçersiz template kaynak açıklaması');
    if (
      !Number.isInteger(intervalMinutes) ||
      intervalMinutes < 1 ||
      intervalMinutes > 10080 ||
      typeof enabled !== 'boolean'
    )
      throw Error('Geçersiz template kaynak zamanlaması');
    const instructions = source.instructions ?? '';
    if (typeof instructions !== 'string' || instructions.length > 6000)
      throw Error('Kaynak talimatı en fazla 6000 karakter olmalı');
    if (
      source.skill !== undefined &&
      (typeof source.skill !== 'string' || source.skill.length > 60000)
    )
      throw Error('Kaynak skilli en fazla 60000 karakter olmalı');
    const recipe = normalizeSourceRecipe(source.recipe);
    const countries = source.countries ?? [];
    if (
      !Array.isArray(countries) ||
      countries.length > 60 ||
      countries.some((c) => typeof c !== 'string' || !/^[A-Z]{2}$/.test(c))
    )
      throw Error('Kaynak ülkeleri ISO iki harfli kodlar olmalı');
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
