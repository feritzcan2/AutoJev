// @ts-check
// API credentials a site extension needs, entered by the user under
// Configuration → Site accounts. An extension declares
// `credentials: {label, help, signupUrl, fields: [{key, label}]}`; the values
// are stored encrypted with the system keychain and handed to the extension's
// reads, never to an agent, a page or a log.
import {SITE_EXTENSIONS} from '../site-extensions/index.mjs';

const VALUE = /^[\x21-\x7e]{4,4096}$/;
const declared = (site) => SITE_EXTENSIONS.find((e) => e.id === site && e.credentials) ?? null;

export class SiteCredentials {
  constructor(db, {encrypt, decrypt}) {
    this.db = db;
    this.encrypt = encrypt;
    this.decrypt = decrypt;
    db.exec(
      'CREATE TABLE IF NOT EXISTS site_credentials(site TEXT PRIMARY KEY,ciphertext TEXT NOT NULL)',
    );
  }
  row(site) {
    return this.db.prepare('SELECT ciphertext FROM site_credentials WHERE site=?').get(site);
  }
  // The saved values of a site, or null when none are saved. A key the
  // keychain cannot unlock is an error, not a missing key.
  values(site) {
    const row = this.row(site);
    if (!row) return null;
    try {
      return JSON.parse(this.decrypt(row.ciphertext));
    } catch {
      throw Error(
        `Could not unlock the ${declared(site)?.credentials.label ?? site} credentials. Unlock the system keychain or save them again.`,
      );
    }
  }
  status() {
    return SITE_EXTENSIONS.filter((e) => e.credentials).map((e) => {
      let error = null,
        values = null;
      try {
        values = this.values(e.id);
      } catch (err) {
        error = err.message;
      }
      const {label, help, signupUrl, fields} = e.credentials;
      return {
        site: e.id,
        label,
        help,
        signupUrl,
        fields: fields.map(({key, label}) => ({key, label})),
        saved: Boolean(this.row(e.id)),
        configured: Boolean(values && fields.every((f) => values[f.key])),
        error,
      };
    });
  }
  save(site, input) {
    const extension = declared(site);
    if (!extension) throw Error('This site has no account settings.');
    const {fields, label} = extension.credentials;
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((k) => !fields.some((f) => f.key === k))
    )
      throw Error(`Invalid ${label} credentials.`);
    let previous = null;
    try {
      previous = this.values(site);
    } catch {}
    const values = {};
    for (const field of fields) {
      const value = typeof input[field.key] === 'string' ? input[field.key].trim() : '';
      if (value && !VALUE.test(value)) throw Error(`Enter a valid ${field.label}.`);
      values[field.key] = value || previous?.[field.key] || '';
      if (!values[field.key]) throw Error(`Enter the ${field.label}.`);
    }
    this.db
      .prepare(
        'INSERT INTO site_credentials VALUES(?,?) ON CONFLICT(site) DO UPDATE SET ciphertext=excluded.ciphertext',
      )
      .run(site, this.encrypt(JSON.stringify(values)));
    return this.status();
  }
  remove(site) {
    this.db.prepare('DELETE FROM site_credentials WHERE site=?').run(site);
    return this.status();
  }
}

let current = null;
export const useSiteCredentials = (store) => {
  current = store;
};
// The values a collector read passes to its extension, or null.
export const siteCredentialValues = (site) => current?.values(site) ?? null;
