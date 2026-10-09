// @ts-check
import {createHash} from 'node:crypto';

// A short qualification profile replaces the full documents and saved facts in
// every Jev request (they were most of each request). It is written from those
// sources and used only while they are unchanged; otherwise Jev reads the full
// profile until an agent or the user writes it again.
export const JEV_PROFILE_LIMIT = 3000;

export function jevProfileBasis(automation, documents) {
  const profile = automation.referenceData?.profile ?? {};
  return createHash('sha256')
    .update(
      JSON.stringify([
        automation.facts ?? '',
        profile.facts ?? '',
        profile.learnedFacts ?? {},
        documents?.digest ?? null,
      ]),
    )
    .digest('hex');
}

/** @returns {'missing' | 'stale' | 'current'} */
export function jevProfileStatus(automation, documents) {
  const saved = automation.jevProfile;
  if (!saved?.text) return 'missing';
  return saved.basis === jevProfileBasis(automation, documents) ? 'current' : 'stale';
}

export function jevProfileView(automation, documents) {
  const saved = automation.jevProfile;
  return {
    status: jevProfileStatus(automation, documents),
    text: saved?.text ?? '',
    by: saved?.by ?? null,
    at: saved?.at ?? null,
  };
}

// The user's own text wins: an agent may replace it only after its sources changed.
export function saveJevProfile(db, id, text, by, documents) {
  if (typeof text !== 'string') throw Error('Jev profili metin olmalı.');
  const value = text.trim(),
    a = db.get(id);
  if (value.length > JEV_PROFILE_LIMIT)
    throw Error(`Jev profili en fazla ${JEV_PROFILE_LIMIT} karakter olmalı.`);
  if (by === 'agent') {
    if (!value) throw Error('Jev profili boş olamaz.');
    if (a.jevProfile?.by === 'user' && jevProfileStatus(a, documents) === 'current')
      return {saved: false, reason: 'Kullanıcının düzenlediği profil güncel; değiştirilmedi.'};
  }
  const {jevProfile, ...rest} = a;
  db.put(
    value
      ? {...rest, jevProfile: {text: value, basis: jevProfileBasis(a, documents), by, at: db.now()}}
      : rest,
  );
  return {saved: true};
}
