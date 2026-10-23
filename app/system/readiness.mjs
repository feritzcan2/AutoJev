import {access, stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {listChromeProfiles} from '../browser/chrome-profiles.mjs';
import {
  EXTENSION_INSTALL_STEPS,
  extensionInstalledInProfile,
  extensionMissingMessage,
  resolveChromeProfile,
} from '../jev/chrome.mjs';
import {WEB_STORE_URL} from '../jev/extension.mjs';
import {findChrome, findExecutable} from '../browser/chrome-installation.mjs';
import {launchEnvironment as readinessEnvironment} from '../agents/launch-environment.mjs';
import {missingAgentMessage} from '../agents/installation.mjs';
import {DECISION_MODES} from '../agents/settings.mjs';
export {findChrome, findExecutable} from '../browser/chrome-installation.mjs';
export {launchEnvironment as readinessEnvironment} from '../agents/launch-environment.mjs';
const exec = promisify(execFile);
const providers = {
  opencode: {
    label: 'OpenCode',
    args: ['auth', 'list'],
    login: 'opencode auth login',
    install: 'https://opencode.ai',
  },
  codex: {
    label: 'Codex',
    args: ['login', 'status'],
    login: 'codex login',
    install: 'https://github.com/openai/codex',
  },
  claude: {
    label: 'Claude Code',
    args: ['auth', 'status', '--json'],
    login: 'claude auth login',
    install: 'https://code.claude.com/docs/en/overview',
  },
};
// action: what the user can do to fix a check, a command to copy or a link to open.
const item = (id, label, state, detail, action) =>
  action && state !== 'ready' ? {id, label, state, detail, action} : {id, label, state, detail};
// Chrome ignores chrome: addresses passed on its command line, so the user
// pastes it; the folder is dragged from Finder or Explorer onto that page.
const extensionActions = (profile) => [
  ...(WEB_STORE_URL ? [{extension: 'store', profile, label: 'Add to Chrome'}] : []),
  {command: 'chrome://extensions', label: 'Copy the Chrome address'},
  {extension: 'folder', label: 'Show the extension folder'},
];
const signIn = (descriptor) => ({command: descriptor.login, label: 'Copy sign-in command'});

export async function inspectLogin(
  provider,
  executable,
  {execImpl = exec, env = process.env, platform = process.platform, home = homedir()} = {},
) {
  const descriptor = providers[provider];
  // Windows package-manager shims (.cmd) cannot run without a shell. Like the
  // engine, call them through PowerShell's call operator with the path as a
  // single-quoted literal; the status arguments are fixed words.
  let program = executable,
    args = descriptor.args,
    timeout = 5000;
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    const root = Object.entries(env).find(([key]) => key.toUpperCase() === 'SYSTEMROOT')?.[1];
    if (!root)
      return item(
        'login',
        'Agent session',
        'warning',
        `Sign in with ${descriptor.login} in a terminal. The session of this installation cannot be verified automatically.`,
        signIn(descriptor),
      );
    program = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    args = [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `& '${executable.replaceAll("'", "''")}' ${descriptor.args.join(' ')}; exit $LASTEXITCODE`,
    ];
    // PowerShell plus the shim's Node start can take longer than a native CLI.
    timeout = 15000;
  }
  let output, stdout;
  try {
    const result = await execImpl(program, args, {
      env,
      cwd: home,
      timeout,
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
        signIn(descriptor),
      );
    return item(
      'login',
      'Agent session',
      'warning',
      `The session check did not complete. Check your sign-in with ${descriptor.login} in a terminal.`,
      signIn(descriptor),
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
          signIn(descriptor),
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
        signIn(descriptor),
      );
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
        'AutoJob engine',
        usable ? 'ready' : 'error',
        usable
          ? 'The app engine is ready.'
          : 'The app engine was not found. Reinstall AutoJob; if you run from source, run the engine:build command.',
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
      {link: descriptor.install, label: 'Install ' + descriptor.label},
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
      {link: 'https://www.google.com/chrome/', label: 'Download Chrome'},
    ),
  );
  {
    let profiles = [],
      blocked = null;
    try {
      profiles = await (options.listChromeProfiles ?? listChromeProfiles)();
    } catch (error) {
      if (error.code === 'CHROME_DATA_BLOCKED') blocked = error.message;
    }
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
          : (blocked ??
              'Create a profile in Chrome or choose an existing profile in Agent settings.'),
      ),
    );
    let installed = false;
    try {
      installed = await (options.extensionInstalled ?? extensionInstalledInProfile)(
        await (options.resolveChromeProfile ?? resolveChromeProfile)(
          profile ? {directory: profile} : undefined,
        ),
      );
    } catch (error) {
      if (error.code === 'CHROME_DATA_BLOCKED') blocked = error.message;
    }
    checks.push(
      item(
        'chrome-extension',
        'AutoJob extension',
        installed ? 'ready' : 'error',
        installed
          ? 'The AutoJob extension is installed in the selected Chrome profile. While it is connected, Chrome shows an "AutoJob" bar at the top.'
          : (blocked ?? (options.extensionMissingMessage ?? extensionMissingMessage)()),
        blocked || installed ? undefined : extensionActions(profile),
      ),
    );
    if (!installed && !blocked) checks.at(-1).steps = EXTENSION_INSTALL_STEPS;
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
