import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';

export function chromeUserDataDirectory(){
 const home=homedir();
 return process.platform==='darwin'?path.join(home,'Library/Application Support/Google/Chrome')
  :process.platform==='win32'?path.join(process.env.LOCALAPPDATA||path.join(home,'AppData/Local'),'Google/Chrome/User Data')
  :path.join(process.env.XDG_CONFIG_HOME||path.join(home,'.config'),'google-chrome');
}
export async function listChromeProfiles(){
 const directory=chromeUserDataDirectory();
 let state;
 try{state=JSON.parse(await readFile(path.join(directory,'Local State'),'utf8'));}
 catch(error){if(error.code==='ENOENT')return [];throw Error('Chrome profilleri okunamadı.');}
 return Object.entries(state.profile?.info_cache??{})
  .filter(([directory,profile])=>/^[\w -]{1,100}$/.test(directory)&&typeof profile?.name==='string'&&profile.name.trim())
  .map(([directory,profile])=>({directory,name:profile.name.trim().slice(0,300)}))
  .sort((a,b)=>a.name.localeCompare(b.name,'tr'));
}
