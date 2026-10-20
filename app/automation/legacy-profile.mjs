// @ts-check
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {workspaceDirectory} from '../workspaces/paths.mjs';
import {profilePlan, profileChanged} from './profile-updates.mjs';

// Workspaces imported from the former job application app kept the old
// candidate profile in referenceData, templates retire replaced fields, and
// older conversations stored source suggestions inside profile drafts. The
// store converts each workspace once on startup without losing a fact:
// - the old profile facts and saved answers become a workspace document, so
//   agents keep reading them while the profile fields stay as the user wrote them;
// - the old CV becomes a user document;
// - the text of a retired field joins the instructions (or the document when
//   the instructions have no room left);
// - a removed setting is dropped.
export const EARLIER_PROFILE_DOCUMENT = 'documents/earlier-profile.md';
const INSTRUCTIONS_LIMIT = 12000;

// Elimination rules decide what an unmentioned condition means.
const DROPPED_CRITERIA = ['unstated_conditions'];
const text = (value) => (typeof value === 'string' ? value.trim() : '');
const retired = (template) => Object.entries(template?.retiredFields ?? {});
const oldKeys = (template) => [...retired(template).map(([key]) => key), ...DROPPED_CRITERIA];

export function needsLegacyConversion(a, template) {
  const drafts = [a.planDraft?.plan, a.profileUpdate?.plan].filter(Boolean);
  return (
    a.referenceData !== undefined ||
    drafts.some((plan) => Object.hasOwn(plan, 'sources')) ||
    [a, ...drafts].some((plan) =>
      oldKeys(template).some((key) => Object.hasOwn(plan.criteria ?? {}, key)),
    )
  );
}

// Moves retired criteria into the instructions; returns the text that did not fit.
function retireFields(plan, template) {
  if (!plan.criteria) return [];
  const criteria = {...plan.criteria},
    moved = [];
  for (const [key, label] of retired(template)) {
    const value = text(criteria[key]);
    delete criteria[key];
    if (value) moved.push(`${label} (moved from a replaced field): ${value}`);
  }
  for (const key of DROPPED_CRITERIA) delete criteria[key];
  const instructions = [text(plan.instructions), ...moved].filter(Boolean).join('\n\n');
  if (instructions.length <= INSTRUCTIONS_LIMIT) {
    Object.assign(plan, {criteria, ...(moved.length ? {instructions} : {})});
    return [];
  }
  plan.criteria = criteria;
  return moved;
}

// Older conversations stored source suggestions inside the profile draft.
function splitPlanDraft(a) {
  const next = {...a};
  for (const key of ['planDraft', 'profileUpdate']) {
    const draft = a[key];
    if (!draft?.plan || !Object.hasOwn(draft.plan, 'sources')) continue;
    const {sources} = draft.plan,
      plan = profilePlan(draft.plan);
    if (
      !next.sourceDraft &&
      draft.baseRevision === a.revision &&
      JSON.stringify(sources) !== JSON.stringify(a.sources)
    )
      next.sourceDraft = {
        id: `${key}:${draft.runId ?? draft.savedAt}:${draft.updatedAt ?? draft.savedAt}`,
        sources,
        runId: draft.runId,
        updatedAt: draft.updatedAt ?? draft.savedAt,
      };
    if (key === 'profileUpdate' || profileChanged(plan, {...a, ...a.profileUpdate?.plan}))
      next[key] = {...draft, plan};
    else delete next[key];
  }
  return next;
}

function earlierProfileText(profile, leftovers) {
  const answers = Object.entries(profile.learnedFacts ?? {})
    .map(([key, fact]) => [key, text(fact?.value)])
    .filter(([, value]) => value)
    .map(([key, value]) => `- ${key}: ${value}`);
  const parts = [
    text(profile.facts),
    ...(answers.length ? ['## Saved answers\n' + answers.join('\n')] : []),
    ...leftovers,
  ].filter(Boolean);
  return parts.length
    ? '# Earlier profile\n\nImported from the former job application app. Where the current profile differs, the current profile is right.\n\n' +
        parts.join('\n\n') +
        '\n'
    : '';
}

// store: the AutomationStore. Returns true when the workspace changed.
export function convertLegacyProfile(store, id) {
  let a = store.get(id);
  let template = null;
  try {
    template = store.template(a.templateId);
  } catch {
    // A missing template retires no fields; the rest still converts.
  }
  if (!needsLegacyConversion(a, template)) return false;
  a = splitPlanDraft(a);
  const leftovers = retireFields(a, template);
  for (const key of ['planDraft', 'profileUpdate'])
    if (a[key]?.plan) {
      const plan = {...a[key].plan};
      retireFields(plan, template);
      a[key] = {...a[key], plan};
    }
  const profile = a.referenceData?.profile ?? {},
    root = workspaceDirectory(store.store.directory, store.store.workspaces.get(id)),
    registered = new Set(store.userDocuments(id)),
    add = (relative, message) => {
      if (!registered.has(relative)) store.message(id, 'system', message, {document: relative});
    };
  const earlier = earlierProfileText(profile, leftovers);
  if (earlier) {
    const file = path.join(root, EARLIER_PROFILE_DOCUMENT);
    if (!existsSync(file)) {
      mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
      writeFileSync(file, earlier, {mode: 0o600});
    }
    add(
      EARLIER_PROFILE_DOCUMENT,
      `The earlier profile was moved to the document ${EARLIER_PROFILE_DOCUMENT}. Use it only within this automation.`,
    );
  }
  // A CV outside the workspace folder was never readable; it is dropped.
  if (typeof profile.cvPath === 'string') {
    const file = path.resolve(root, profile.cvPath),
      relative = path.relative(root, file).split(path.sep).join('/');
    if (!relative.startsWith('..') && !path.isAbsolute(relative) && existsSync(file))
      add(
        relative,
        `The CV of the earlier profile is now the document ${relative}. Use it only within this automation.`,
      );
  }
  delete a.referenceData;
  store.put(a);
  return true;
}
