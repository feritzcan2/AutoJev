// @ts-check
import {createHash} from 'node:crypto';
import {profileView} from '../templates/profile-sections.mjs';

// A short qualification profile replaces the full documents and saved facts in
// every Jev request (they were most of each request). It is written from those
// sources and used only while they are unchanged; otherwise Jev reads the full
// profile until an agent or the user writes it again. fields are the template's
// fields: the candidate profile fields count as sources too.
export const JEV_PROFILE_LIMIT = 3000;

export function jevProfileBasis(automation, documents, fields = []) {
  const candidate = profileView(automation, fields).candidate.map((f) => [f.id, f.value]);
  return createHash('sha256')
    .update(
      JSON.stringify([
        automation.facts ?? '',
        // Places of two retired sources, kept so saved profiles stay current.
        '',
        {},
        documents?.digest ?? null,
        // Appended only when present, so profiles without them keep their basis.
        ...(candidate.length ? [candidate] : []),
      ]),
    )
    .digest('hex');
}

/** @returns {'missing' | 'stale' | 'current'} */
export function jevProfileStatus(automation, documents, fields = []) {
  const saved = automation.jevProfile;
  if (!saved?.text) return 'missing';
  return saved.basis === jevProfileBasis(automation, documents, fields) ? 'current' : 'stale';
}

export function jevProfileView(automation, documents, fields = []) {
  const saved = automation.jevProfile;
  return {
    status: jevProfileStatus(automation, documents, fields),
    text: saved?.text ?? '',
    by: saved?.by ?? null,
    at: saved?.at ?? null,
  };
}

// The user's own text wins: an agent may replace it only after its sources changed.
export function saveJevProfile(db, id, text, by, documents, fields = []) {
  if (typeof text !== 'string') throw Error('The Jev profile must be text.');
  const value = text.trim(),
    a = db.get(id);
  if (value.length > JEV_PROFILE_LIMIT)
    throw Error(`The Jev profile must be at most ${JEV_PROFILE_LIMIT} characters.`);
  if (by === 'agent') {
    if (!value) throw Error('The Jev profile cannot be empty.');
    if (a.jevProfile?.by === 'user' && jevProfileStatus(a, documents, fields) === 'current')
      return {
        saved: false,
        reason: 'The profile edited by the user is current; it was not changed.',
      };
  }
  const {jevProfile, ...rest} = a;
  db.put(
    value
      ? {
          ...rest,
          jevProfile: {text: value, basis: jevProfileBasis(a, documents, fields), by, at: db.now()},
        }
      : rest,
  );
  return {saved: true};
}
