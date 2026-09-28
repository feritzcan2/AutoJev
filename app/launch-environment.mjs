import {homedir} from 'node:os';
import path from 'node:path';

// Finder supplies a minimal PATH. Keep inherited command precedence while
// making conventional user CLI and Homebrew installations discoverable by
// both readiness probes and the engine's provider processes.
export function launchEnvironment(env=process.env,platform=process.platform,home=env.HOME??homedir()){
 if(platform==='win32')return {...env};
 const inherited=env.PATH?env.PATH.split(':'):[];
 const additions=typeof home==='string'&&path.posix.isAbsolute(home)?[path.posix.join(home,'.local/bin'),path.posix.join(home,'.bun/bin')]:[];
 if(platform==='darwin')additions.push('/opt/homebrew/bin','/usr/local/bin');
 return {...env,PATH:[...inherited,...additions.filter(directory=>!inherited.includes(directory))].join(':')};
}
