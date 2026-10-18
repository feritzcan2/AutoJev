// @ts-check
// Development trial scores: a score task queued with request.dryRun runs the
// ordinary scoring agent, but its validated assessments are kept here instead
// of on the record, so a developer can compare repeated scores of one listing.
// RAM only; a restart clears them.
const TASKS = 200;
/** @type {Map<string, Map<string, {assessment: any, runId: string, at: number}>>} */
const scores = new Map();

export const dryRunTask = (task) => task?.request?.dryRun === true;
export function saveDryScore(taskId, itemId, entry) {
  let task = scores.get(taskId);
  if (!task) {
    scores.set(taskId, (task = new Map()));
    while (scores.size > TASKS) scores.delete(scores.keys().next().value);
  }
  task.set(itemId, entry);
}
export const dryScore = (taskId, itemId) => scores.get(taskId)?.get(itemId) ?? null;
// Every trial score of one record, newest first.
export const dryScores = (itemId) =>
  [...scores.entries()]
    .flatMap(([taskId, task]) => (task.has(itemId) ? [{taskId, ...task.get(itemId)}] : []))
    .sort((a, b) => b.at - a.at);
