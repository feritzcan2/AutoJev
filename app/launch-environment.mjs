import {homedir,userInfo} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';

const exec=promisify(execFile);
const pathMarker='\0JOBLOOP_SHELL_PATH=';

// Desktop launchers do not load terminal startup files. In particular, nvm
// usually adds its selected Node (and global CLIs) from an interactive rc file.
// Read only PATH, once at startup, so every child and readiness check agrees.
export async function resolveLaunchEnvironment(env=process.env,{platform=process.platform,home=env.HOME??homedir(),shell=env.SHELL,execImpl=exec}={}){
 const fallback=launchEnvironment(env,platform,home);
 if(platform==='win32')return fallback;
 if(!shell){try{shell=userInfo().shell;}catch{}}
 if(typeof shell!=='string'||!path.posix.isAbsolute(shell))return fallback;
 try{
  const {stdout}=await execImpl(shell,[platform==='darwin'?'-ilc':'-ic',`printf '\\0JOBLOOP_SHELL_PATH=%s\\0' "$PATH"`],{env,cwd:home,timeout:5000,killSignal:'SIGKILL',maxBuffer:1024*1024,encoding:'utf8'});
  const start=stdout.lastIndexOf(pathMarker),end=start<0?-1:stdout.indexOf('\0',start+pathMarker.length);
  if(end<0)return fallback;
  const directories=stdout.slice(start+pathMarker.length,end).split(':').filter(directory=>path.posix.isAbsolute(directory));
  if(!directories.length)return fallback;
  // Shell ordering also selects the matching Node interpreter for npm shims.
  return {...fallback,PATH:[...new Set([...directories,...fallback.PATH.split(':')])].join(':')};
 }catch{return fallback;}
}

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
