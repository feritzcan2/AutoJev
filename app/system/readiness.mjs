import {access, stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createConnection} from 'node:net';
import {listChromeProfiles} from '../browser/chrome-profiles.mjs';
import {existingChromeEndpoint} from '../jev/chrome.mjs';
import {findChrome, findExecutable} from '../browser/chrome-installation.mjs';
import {launchEnvironment as readinessEnvironment} from '../agents/launch-environment.mjs';
import {missingAgentMessage} from '../agents/installation.mjs';
import {DECISION_MODES} from '../agents/settings.mjs';
export {findChrome, findExecutable} from '../browser/chrome-installation.mjs';
export {launchEnvironment as readinessEnvironment} from '../agents/launch-environment.mjs';
const exec = promisify(execFile);
const providers = {
  opencode: {label: 'OpenCode', args: ['auth', 'list'], login: 'opencode auth login'},
  codex: {label: 'Codex', args: ['login', 'status'], login: 'codex login'},
  claude: {label: 'Claude Code', args: ['auth', 'status', '--json'], login: 'claude auth login'},
};
const item = (id, label, state, detail) => ({id, label, state, detail});

export async function inspectLogin(
  provider,
  executable,
  {execImpl = exec, env = process.env, platform = process.platform, home = homedir()} = {},
) {
  const descriptor = providers[provider];
  // Windows package-manager shims need a shell; readiness never evaluates shell
  // code. Native CLI installs are checked, shim users get an explicit manual step.
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(executable))
    return item(
      'login',
      'Agent session',
      'warning',
      `Sign in with ${descriptor.login} in a terminal. The session of this installation cannot be verified automatically.`,
    );
  let output, stdout;
  try {
    const result = await execImpl(executable, descriptor.args, {
      env,
      cwd: home,
      timeout: 5000,
      maxBuffer: 32768,
      windowsHide: true,
    });
    stdout = result.stdout;
    output = result.stdout + '\n' + result.stderr;
  } catch (error) {
    // Never forward provider output: status commands can include identity or keys.
    if (error.code === 1)
      return item(
        'login',
        'Agent session',
        'error',
        `Could not verify the session. Sign in with ${descriptor.login} in a terminal and check again.`,
      );
    return item(
      'login',
      'Agent session',
      'warning',
      `The session check did not complete. Check your sign-in with ${descriptor.login} in a terminal.`,
    );
  }
  let authenticated = false;
  if (provider === 'claude') {
    try {
      const status = JSON.parse(stdout.trim());
      if (status.loggedIn === false)
        return item(
          'login',
          'Agent session',
          'error',
          `Sign in with ${descriptor.login} in a terminal and check again.`,
        );
      authenticated = status.loggedIn === true;
    } catch {}
  } else if (provider === 'opencode')
    authenticated = /\b[1-9]\d* credentials?\b/i.test(
      output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''),
    );
  else authenticated = /\blogged in\b/i.test(output) && !/\bnot logged in\b/i.test(output);
  return authenticated
    ? item(
        'login',
        'Agent session',
        'ready',
        'CLI session credentials found. Service access is verified when a task starts.',
      )
    : item(
        'login',
        'Agent session',
        'warning',
        `Could not verify the session status. Check with ${descriptor.login} in a terminal.`,
      );
}
export async function chromePortAvailable(endpoint) {
  const url = new URL(endpoint);
  if (
    url.protocol !== 'ws:' ||
    url.hostname !== '127.0.0.1' ||
    !/^\/devtools\/browser\/[\w-]+$/.test(url.pathname)
  )
    return false;
  return new Promise((resolve) => {
    const socket = createConnection({host: '127.0.0.1', port: Number(url.port)});
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}
export async function collectReadiness(input = {}, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw Error('Invalid setup choice.');
  const provider = input.provider ?? 'codex';
  if (!Object.hasOwn(providers, provider)) throw Error('Invalid setup choice.');
  const decisions = input.decisions ?? 'agent';
  if (!DECISION_MODES.includes(decisions)) throw Error('Invalid setup choice.');
  const profile = input.chromeProfile?.directory;
  if (profile !== undefined && (typeof profile !== 'string' || !/^[\w -]{1,100}$/.test(profile)))
    throw Error('Invalid Chrome profile.');
  const platform = options.platform ?? process.platform,
    home = options.home ?? homedir(),
    env = readinessEnvironment(options.env ?? process.env, platform, home);
  const deps = {env, platform, home},
    checks = [],
    descriptor = providers[provider];
  if (options.enginePath) {
    let usable = false;
    try {
      await access(options.enginePath, platform === 'win32' ? constants.F_OK : constants.X_OK);
      usable = (await stat(options.enginePath)).isFile();
    } catch {}
    checks.push(
      item(
        'engine',
        'JobLoop engine',
        usable ? 'ready' : 'error',
        usable
          ? 'The app engine is ready.'
          : 'The app engine was not found. Reinstall JobLoop; if you run from source, run the engine:build command.',
      ),
    );
  }
  const executable = await (options.findExecutable ?? findExecutable)(provider, deps);
  checks.push(
    item(
      'agent',
      descriptor.label,
      executable ? 'ready' : 'error',
      executable ? 'Agent command found.' : missingAgentMessage(provider),
    ),
  );
  if (executable)
    checks.push(await (options.inspectLogin ?? inspectLogin)(provider, executable, deps));
  const chrome = await (options.findChrome ?? findChrome)(deps);
  checks.push(
    item(
      'chrome',
      'Google Chrome',
      chrome ? 'ready' : 'error',
      chrome ? 'Chrome installation found.' : 'Install Google Chrome and open it at least once.',
    ),
  );
  {
    let profiles = [];
    try {
      profiles = await (options.listChromeProfiles ?? listChromeProfiles)();
    } catch {}
    const hasProfile = profile
      ? profiles.some((p) => p.directory === profile)
      : profiles.length > 0;
    checks.push(
      item(
        'chrome-profile',
        'Chrome profile',
        hasProfile ? 'ready' : 'error',
        hasProfile
          ? 'Existing Chrome profile found.'
          : 'Create a profile in Chrome or choose an existing profile in Agent settings.',
      ),
    );
    let listening = false;
    try {
      listening = await (options.chromePortAvailable ?? chromePortAvailable)(
        await (options.existingChromeEndpoint ?? existingChromeEndpoint)(),
      );
    } catch {}
    checks.push(
      item(
        'chrome-debug',
        'Chrome connection',
        listening ? 'ready' : 'error',
        listening
          ? 'Local debugging connection is open. Allow Chrome’s connection request when the agent starts.'
          : 'Turn on remote debugging in Chrome at chrome://inspect/#remote-debugging. Allow the connection request when the agent starts.',
      ),
    );
    let jev;
    if (decisions === 'jev')
      try {
        jev = await options.jevStatus?.();
      } catch {}
    checks.push(
      decisions === 'agent'
        ? item(
            'jev',
            'Listing decisions',
            'ready',
            'The agent makes the listing decisions; no TypeSafe key is needed.',
          )
        : item(
            'jev',
            'Jev key',
            jev?.configured ? 'ready' : 'error',
            jev?.configured
              ? 'Jev key configured. You can test the connection under Configuration → Jev.'
              : (jev?.error ??
                  'Save the TypeSafe API key under Configuration → Jev, or let the agent make the listing decisions in Agent settings.'),
          ),
    );
  }
  return {
    ready: checks.every((check) => check.state !== 'error'),
    checkedAt: Date.now(),
    provider,
    checks,
  };
}
