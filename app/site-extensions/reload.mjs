// @ts-check
// Development only: loads the site extensions again from disk, so an edited
// reader is used without restarting the app. Every module in this folder is
// imported fresh; modules outside it (site access, Jev, the store) keep their
// state. A module that fails to load leaves the current extensions in place.
import module from 'node:module';
import {SITE_EXTENSIONS} from './index.mjs';

const folder = new URL('./', import.meta.url).href,
  marker = /[?&]extensionReload=(\d+)/;
let version = 0,
  hooked = false;

// A module imported by a fresh copy is itself fresh when it lives in this folder.
function hook() {
  if (hooked) return;
  if (typeof module.registerHooks !== 'function')
    throw Error('Reloading site extensions needs Node 23.5 or later (the Electron app has it).');
  hooked = true;
  module.registerHooks({
    resolve(specifier, context, next) {
      const resolved = next(specifier, context),
        fresh = context.parentURL?.match(marker)?.[1];
      return fresh && resolved.url.startsWith(folder) && !resolved.url.includes('?')
        ? {...resolved, url: `${resolved.url}?extensionReload=${fresh}`}
        : resolved;
    },
  });
}

export async function reloadSiteExtensions() {
  hook();
  const next = version + 1,
    fresh = (await import(`./index.mjs?extensionReload=${next}`)).SITE_EXTENSIONS;
  version = next;
  SITE_EXTENSIONS.splice(0, SITE_EXTENSIONS.length, ...fresh);
  return {version, extensions: fresh.map((extension) => extension.id), at: Date.now()};
}
export const siteExtensionsVersion = () => version;
