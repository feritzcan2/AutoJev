import {recordUrlKey} from './record-identity.mjs';
// Comparison removes tracking parameters and a trailing slash while keeping
// entity query parameters and SPA routes significant.
export function canonicalJobUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 3000)
    throw Error('Geçersiz ilan bağlantısı');
  const key = recordUrlKey(raw.trim());
  if (!key) throw Error('Geçersiz ilan bağlantısı');
  return key;
}

// Form destinations need an observed relationship. A route suffix alone does
// not establish that two pages belong to the same record.
export function listingIdentity(raw) {
  let url;
  try {
    url = new URL(canonicalJobUrl(raw));
  } catch {
    return null;
  }
  const base = url.href;
  return {namespace: 'url', id: base, key: 'url:' + base};
}

export const jobUrlKey = (url) => listingIdentity(url)?.key ?? 'url:' + canonicalJobUrl(url);
export const jobIdentities = (job) => [
  ...new Set([job.url, job.proof?.url].map((url) => listingIdentity(url)?.key).filter(Boolean)),
];
export function conflictingIdentities(a, b) {
  const split = (key) => [key.slice(0, key.lastIndexOf(':')), key.slice(key.lastIndexOf(':') + 1)];
  const left = (a.listingKeys ?? jobIdentities(a)).filter((k) => !k.startsWith('url:')).map(split),
    right = (b.listingKeys ?? jobIdentities(b)).filter((k) => !k.startsWith('url:')).map(split);
  return (
    left.some(([namespace, id]) =>
      right.some(([other, value]) => namespace === other && id !== value),
    ) &&
    !left.some(([namespace, id]) =>
      right.some(([other, value]) => namespace === other && id === value),
    )
  );
}
