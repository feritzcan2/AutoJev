// @ts-check
// Retained for importing and exporting historical template metadata.
const outcome = (id, label) => ({id, label});
export const defaultMailContract = {
  instructions:
    'Read messages related to this workspace and its saved records from the last 90 days. Match by record title, source, URLs, identifiers and observed action evidence. Include pending unmatched messages for reconsideration. Do not treat unrelated recommendations as confirmations.',
  outcomes: [
    outcome('confirmation', 'Confirmation'),
    outcome('reply', 'Reply'),
    outcome('update', 'Update'),
    outcome('rejection', 'Rejection'),
  ],
};
export function normalizeMailContract(input = defaultMailContract) {
  if (
    !input ||
    typeof input !== 'object' ||
    !Array.isArray(input.outcomes) ||
    !input.outcomes.length ||
    input.outcomes.length > 20
  )
    throw Error('Invalid mail outcomes');
  if (
    typeof input.instructions !== 'string' ||
    !input.instructions.trim() ||
    input.instructions.length > 6000
  )
    throw Error('Invalid mail instructions');
  const ids = new Set(['unmatched', 'ignored', 'constructor', 'prototype', '__proto__']);
  const outcomes = input.outcomes.map((value) => {
    const {id, label} = value ?? {};
    if (
      typeof id !== 'string' ||
      !/^[a-z][a-z0-9_-]{0,59}$/.test(id) ||
      ids.has(id) ||
      typeof label !== 'string' ||
      !label.trim() ||
      label.length > 100
    )
      throw Error('Invalid mail outcome');
    ids.add(id);
    return {id, label: label.trim()};
  });
  return {instructions: input.instructions.trim(), outcomes};
}
