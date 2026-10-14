import {CapsolverClient, CaptchaError} from './capsolver-client.mjs';

export class CaptchaSettings {
  constructor(db, {encrypt, decrypt, client = new CapsolverClient(), now = Date.now}) {
    Object.assign(this, {db, encrypt, decrypt, client, now});
    this.revision = 0;
    this.changes = new AbortController();
    this.lastCheck = null;
    db.exec(
      'CREATE TABLE IF NOT EXISTS captcha_settings(id INTEGER PRIMARY KEY CHECK(id=1),ciphertext TEXT NOT NULL,enabled INTEGER NOT NULL,daily_limit INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS captcha_usage(day TEXT PRIMARY KEY,requests INTEGER NOT NULL)',
    );
  }
  row() {
    return this.db.prepare('SELECT * FROM captcha_settings WHERE id=1').get();
  }
  day() {
    return new Date(this.now()).toISOString().slice(0, 10);
  }
  used() {
    return (
      this.db.prepare('SELECT requests FROM captcha_usage WHERE day=?').get(this.day())?.requests ??
      0
    );
  }
  config() {
    const row = this.row();
    if (!row) return {enabled: false, dailyLimit: 100};
    try {
      return {
        apiKey: this.decrypt(row.ciphertext),
        enabled: !!row.enabled,
        dailyLimit: row.daily_limit,
      };
    } catch {
      throw new CaptchaError(
        'CAPTCHA_KEY',
        'Could not unlock the CapSolver key. Unlock the system keychain or save the key again.',
      );
    }
  }
  status() {
    let config, error;
    try {
      config = this.config();
    } catch (e) {
      error = e.message;
    }
    return {
      configured: !!config?.apiKey,
      saved: !!this.row(),
      enabled: config?.enabled ?? false,
      dailyLimit: config?.dailyLimit ?? 100,
      usedToday: this.used(),
      day: this.day(),
      error,
      lastCheck: this.lastCheck,
    };
  }
  changed() {
    this.revision++;
    this.changes.abort();
    this.changes = new AbortController();
    this.lastCheck = null;
  }
  save(input) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((k) => !['apiKey', 'enabled', 'dailyLimit'].includes(k))
    )
      throw Error('Invalid CAPTCHA setting.');
    const previous = this.row(),
      enabled = input.enabled ?? !!previous?.enabled,
      dailyLimit = input.dailyLimit ?? previous?.daily_limit ?? 100;
    if (
      typeof enabled !== 'boolean' ||
      !Number.isSafeInteger(dailyLimit) ||
      dailyLimit < 1 ||
      dailyLimit > 10000
    )
      throw Error('The daily solve request limit must be between 1 and 10000.');
    if (input.apiKey !== undefined && typeof input.apiKey !== 'string')
      throw Error('Enter a valid CapSolver key.');
    const key = input.apiKey?.trim();
    let ciphertext = previous?.ciphertext;
    if (key) {
      if (key.length < 8 || key.length > 4096 || /\s/.test(key))
        throw Error('Enter a valid CapSolver key.');
      ciphertext = this.encrypt(key);
    }
    if (!ciphertext) throw Error('Enter the CapSolver API key.');
    this.db
      .prepare(
        'INSERT INTO captcha_settings VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext,enabled=excluded.enabled,daily_limit=excluded.daily_limit',
      )
      .run(ciphertext, Number(enabled), dailyLimit);
    this.changed();
    return this.status();
  }
  remove() {
    this.db.exec('DELETE FROM captcha_settings');
    this.changed();
    return this.status();
  }
  // Count before sending, including uncertain network outcomes. A restart must
  // not reset the user's spending bound; image rounds each consume one request.
  reserve() {
    const config = this.config();
    if (!config.enabled || !config.apiKey)
      throw new CaptchaError('CAPTCHA_DISABLED', 'Automatic CAPTCHA solving is off.');
    const result = this.db
      .prepare(
        'INSERT INTO captcha_usage(day,requests) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET requests=requests+1 WHERE requests<?',
      )
      .run(this.day(), config.dailyLimit);
    if (!result.changes)
      throw new CaptchaError('CAPTCHA_LIMIT', 'The daily CAPTCHA solve request limit was reached.');
    this.db
      .prepare('DELETE FROM captcha_usage WHERE day<?')
      .run(new Date(this.now() - 31 * 86400000).toISOString().slice(0, 10));
    return config.apiKey;
  }
  async testConnection() {
    if (this.checking) throw Error('The CapSolver connection is being checked.');
    this.checking = true;
    const revision = this.revision;
    try {
      const {apiKey} = this.config();
      if (!apiKey) throw Error('Save the CapSolver key first.');
      const balance = await this.client.balance(apiKey, this.changes.signal);
      const value = {
        ok: true,
        balance,
        checkedAt: this.now(),
        message: `Connection verified. Balance: $${balance.toFixed(2)}`,
      };
      if (revision === this.revision) this.lastCheck = value;
      return value;
    } catch (error) {
      const value = {
        ok: false,
        checkedAt: this.now(),
        message:
          revision === this.revision
            ? error.message
            : 'The setting changed; check the connection again.',
      };
      if (revision === this.revision) this.lastCheck = value;
      return value;
    } finally {
      this.checking = false;
    }
  }
}
