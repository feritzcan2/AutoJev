// @ts-check
const timestamp = (value) => (typeof value === 'number' ? value : Date.parse(value) || 0);

export function conversationQuestion(question, runs = []) {
  if (question.recordId || question.sourceUrl || question.browserContext?.sourceUrl) return false;
  if (typeof question.conversation === 'boolean') return question.conversation;
  const runId = question.runId ?? question.browserContext?.runId;
  return Boolean(runId && runs.some((run) => run.id === runId && run.kind === 'interview'));
}

// A recent-run window is not the beginning of work. Old unscoped messages must
// not become setup chat merely because the source runs that produced them aged out.
export function conversationMessages(snapshot, native = []) {
  const runs = snapshot.runs ?? [],
    questions = (snapshot.automation?.questions ?? []).filter((q) => conversationQuestion(q, runs));
  const answers = new Set(
    questions.filter((q) => q.answer != null).map((q) => q.text + '\nYanıt: ' + q.answer),
  );
  const saved = (snapshot.messages ?? []).filter((m) => {
    if (m.role === 'system') return false;
    if (typeof m.conversation === 'boolean') return m.conversation;
    if (m.recordId || m.sourceUrl) return false;
    if (m.runId) return runs.some((run) => run.id === m.runId && run.kind === 'interview');
    return (
      questions.some((q) => q.id === m.questionId) ||
      (m.role === 'user' &&
        (answers.has(m.text) ||
          runs.some((run) => run.kind === 'interview' && run.messageId === m.id)))
    );
  });
  // Native messages come from the verified setup transcript. A later saved reply
  // must not erase distinct commentary or earlier replies from that conversation.
  const requests = saved
    .filter((m) => m.role === 'user')
    .sort((a, b) => timestamp(a.at) - timestamp(b.at));
  const turn = (at) => requests.findLast((m) => timestamp(m.at) <= at)?.id ?? null;
  const live = native
    .filter(
      (m) =>
        m.role === 'agent' &&
        !saved.some(
          (s) =>
            s.role === 'assistant' &&
            s.text.trim() === m.text.trim() &&
            turn(timestamp(s.at)) === turn(timestamp(m.at)),
        ),
    )
    .map((m) => ({...m, id: 'native:' + m.id, role: 'assistant', live: true}));
  return [...saved, ...live].sort((a, b) => timestamp(a.at) - timestamp(b.at));
}
