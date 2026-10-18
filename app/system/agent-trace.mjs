// @ts-check
// Development only: what each agent session was given and what it did — the
// instruction files, start and follow-up messages, every tool call with its
// arguments, full output and duration, and every Jev question with its answer.
// An automation session is one run (its session id is the run id). Kept in RAM
// per workspace and bounded; a restart clears it and nothing reaches the disk.
// Credential tools keep only their name, and secret-named fields are masked.
const RUNS_PER_WORKSPACE = 40,
  EVENTS_PER_RUN = 3000,
  TEXT_LIMIT = 200000,
  CHARS_PER_WORKSPACE = 40_000_000;
const SECRET = /(?:credential|password|passwd|secret|token|otp|api.?key|verification.?code)/i;

const clip = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
  return text.length > TEXT_LIMIT
    ? {text: text.slice(0, TEXT_LIMIT), characters: text.length, truncated: true}
    : {text, characters: text.length, truncated: false};
};
// Masks secret-named fields at any depth; the shape stays readable.
const masked = (value, depth = 0) => {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => masked(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, SECRET.test(k) ? '[masked]' : masked(v, depth + 1)]),
  );
};
// A tool result as the agent got it: text parts as text, binary parts as a note.
const output = (result) =>
  (result?.content ?? [])
    .map((part) =>
      part.type === 'text'
        ? part.text
        : `[${part.type}${part.mimeType ? ' ' + part.mimeType : ''}]`,
    )
    .join('\n');
const pretty = (text) => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};

export class AgentTrace {
  constructor({now = Date.now, changed = (_workspaceId) => {}} = {}) {
    this.now = now;
    this.changed = changed;
    /** @type {Map<string, Map<string, any>>} */
    this.workspaces = new Map();
  }
  #run(workspaceId, runId, workerId = 'main') {
    let runs = this.workspaces.get(workspaceId);
    if (!runs) this.workspaces.set(workspaceId, (runs = new Map()));
    let run = runs.get(runId);
    if (!run) {
      run = {
        runId,
        workerId,
        startedAt: this.now(),
        lastAt: this.now(),
        seq: 0,
        chars: 0,
        dropped: 0,
        counts: {prompt: 0, tool: 0, jev: 0, error: 0},
        events: [],
      };
      runs.set(runId, run);
      while (runs.size > RUNS_PER_WORKSPACE) runs.delete(runs.keys().next().value);
    }
    return run;
  }
  #push(workspaceId, runId, workerId, event) {
    if (!workspaceId || !runId) return;
    const run = this.#run(workspaceId, runId, workerId),
      chars = JSON.stringify(event).length;
    run.events.push({seq: ++run.seq, at: this.now(), ...event});
    run.chars += chars;
    run.lastAt = this.now();
    run.counts[event.type]++;
    if (event.error) run.counts.error++;
    while (run.events.length > EVENTS_PER_RUN) {
      run.chars -= JSON.stringify(run.events.shift()).length;
      run.dropped++;
    }
    // The oldest runs of the workspace go first once its budget is spent.
    const runs = this.workspaces.get(workspaceId);
    let total = [...runs.values()].reduce((sum, r) => sum + r.chars, 0);
    for (const [key, old] of runs) {
      if (total <= CHARS_PER_WORKSPACE || old === run) break;
      total -= old.chars;
      runs.delete(key);
    }
    this.changed(workspaceId);
  }

  // An InstructionLog event of a session: instruction files, the start
  // message, the provider instructions or a follow-up message.
  session({workspaceId, workerId = 'main', sessionId, kind, title, status, parts = [], provider}) {
    if (!parts.length && !['launch', 'message'].includes(kind)) return;
    this.#push(workspaceId, sessionId, workerId, {
      type: 'prompt',
      kind,
      title,
      status,
      ...(provider ? {provider} : {}),
      parts: parts.map((part) => ({
        key: part.key,
        title: part.title,
        source: part.source,
        ...clip(part.text ?? ''),
      })),
    });
  }

  // One MCP exchange: the tool list once per session, every call with its
  // arguments and the full output the agent received.
  tool({workspaceId, sessionId, workerId}, {name, args, result, ms, kind}) {
    if (kind === 'tool_catalog') {
      this.#push(workspaceId, sessionId, workerId, {
        type: 'prompt',
        kind: 'tools',
        title: `Tool list (${result?.tools?.length ?? 0} tools)`,
        parts: (result?.tools ?? []).map((t) => ({
          key: 'tool:' + t.name,
          title: t.name,
          source: 'tool',
          ...clip({description: t.description, inputSchema: t.inputSchema}),
        })),
      });
      return;
    }
    const secret = SECRET.test(name ?? '');
    this.#push(workspaceId, sessionId, workerId, {
      type: 'tool',
      name,
      ms: ms ?? null,
      error: Boolean(result?.isError),
      args: secret ? {text: '[not kept for a credential tool]'} : clip(masked(args ?? {})),
      output: secret ? {text: '[not kept for a credential tool]'} : clip(pretty(output(result))),
    });
  }

  // One Jev request: the state and questions it was given and its answers.
  jev(workspaceId, runId, {state, questions, answers, usage, error, ms, workerId}) {
    this.#push(workspaceId, runId, workerId, {
      type: 'jev',
      ms: ms ?? null,
      error: error ?? null,
      usage: usage ?? null,
      questions: Object.keys(questions ?? {}),
      state: clip(masked(state)),
      instructions: clip(questions),
      answers: clip(answers ?? null),
    });
  }

  runs(workspaceId) {
    return [...(this.workspaces.get(workspaceId)?.values() ?? [])]
      .map(({events, ...run}) => ({...run, events: events.length}))
      .sort((a, b) => b.lastAt - a.lastAt);
  }
  events(workspaceId, runId) {
    const run = this.workspaces.get(workspaceId)?.get(runId);
    if (!run) return null;
    const {events, ...summary} = run;
    return {...summary, events};
  }
  forget(workspaceId) {
    this.workspaces.delete(workspaceId);
  }
}
