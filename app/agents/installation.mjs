// @ts-check
export function missingAgentMessage(provider) {
  const label =
    provider === 'opencode' ? 'OpenCode' : provider === 'codex' ? 'Codex CLI' : 'Claude Code';
  const login =
    provider === 'opencode'
      ? 'opencode auth login'
      : provider === 'codex'
        ? 'codex login'
        : 'claude auth login';
  return `AutoJob could not find the ${label} command. Check with ${provider} --version in a terminal. If the command works, quit AutoJob completely and open it from the same terminal. AutoJob does not include this tool; if it is not installed, install it separately and sign in with ${login}. Then continue the setup. Your saved information is kept.`;
}

export function engineErrorMessage(message) {
  const missing = /^agent CLI for (codex|claude|opencode) was not found on the launch PATH$/.exec(
    message,
  );
  return missing ? missingAgentMessage(missing[1]) : message;
}

// An engine error as an Error; a missing agent command carries code
// agent_missing, so the caller stops the workspace instead of failing each task.
export function engineError(message) {
  const text = engineErrorMessage(message);
  return Object.assign(Error(text), text === message ? {} : {code: 'agent_missing'});
}
