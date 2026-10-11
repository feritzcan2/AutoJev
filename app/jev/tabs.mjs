// @ts-check
import {mkdir, readFile, writeFile, rename} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const TARGET_ID = /^[A-Fa-f0-9]{32}$/;

// Saved and checkpoint targets worth asking the extension about. Never
// discover a tab by URL.
export function restoredTargets(saved, checkpoints) {
  const ids = new Set([
    ...(saved?.targets ?? []),
    ...checkpoints.filter((c) => c?.browser === 'Jev Chrome').map((c) => c.tabId),
  ]);
  return [...ids].filter((id) => TARGET_ID.test(id));
}

// Candidate-owned metadata only: never discover a draft by matching its URL.
export class JevTabs {
  constructor(directory, profile) {
    this.file = path.join(directory, `tabs-${encodeURIComponent(profile)}.json`);
    this.profile = profile;
    this.writes = Promise.resolve();
  }
  async read() {
    let saved;
    try {
      saved = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw Error('Jev sekme kaydı okunamadı; mevcut formlar korunuyor.');
    }
    // Records of the former remote-debugging connection name no extension tab.
    if (saved?.version === 1) return null;
    if (
      saved?.version !== 2 ||
      saved.profile !== this.profile ||
      typeof saved.instanceId !== 'string' ||
      !Array.isArray(saved.targets) ||
      !saved.targets.every((id) => TARGET_ID.test(id)) ||
      !saved.tabIds ||
      typeof saved.tabIds !== 'object' ||
      !Object.values(saved.tabIds).every((id) => Number.isInteger(id))
    )
      throw Error('Jev sekme kaydı geçersiz; mevcut formlar korunuyor.');
    return saved;
  }
  save(instanceId, targets, tabIds, metadata = {}) {
    const data = JSON.stringify({
      version: 2,
      profile: this.profile,
      instanceId,
      targets: [...new Set(targets)],
      tabIds,
      ...metadata,
    });
    const write = async () => {
      await mkdir(path.dirname(this.file), {recursive: true, mode: 0o700});
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, data, {mode: 0o600});
      await rename(temporary, this.file);
    };
    this.writes = this.writes.catch(() => {}).then(write);
    return this.writes;
  }
}
