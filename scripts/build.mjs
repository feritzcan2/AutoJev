import {build} from 'esbuild';
import {mkdir, copyFile, readFile, writeFile} from 'node:fs/promises';
await mkdir('dist', {recursive:true});
const loader={'.woff2':'file','.ttf':'file'}, assetNames='assets/[name]-[hash]';
await build({entryPoints:['src/renderer.js'], bundle:true, outfile:'dist/renderer.js', format:'esm', loader, assetNames});
await copyFile('src/index.html', 'dist/index.html');

// Mobile build: the same renderer, with the Electron preload bridge replaced by HTTP calls to the desktop app.
// The method → IPC channel map is read from preload.cjs so every desktop feature reaches the phone automatically.
const preload=await readFile('app/preload.cjs','utf8'), invoke={}, events={};
const custom=new Set(['importSetupCv']); // arguments are transformed in preload; the mobile bridge overrides these
for(const [,name,grouped,single,channel,rest] of preload.matchAll(/(\w+):(?:\(([^)]*)\)|(\w+))=>ipcRenderer\.invoke\('([^']+)'((?:,[^)]*)?)\)/g)){
  const params=(grouped??single??'').replace(/\s/g,''), args=rest.replace(/^,/,'').replace(/\s/g,'');
  if(params!==args&&!custom.has(name))throw Error(`preload.cjs: ${name} does not pass its arguments straight to '${channel}'; add a mobile override in src/mobile/web-api.js`);
  invoke[name]=channel;
}
for(const [,name,channel] of preload.matchAll(/(\w+):callback=>subscribe\('([^']+)',callback\)/g))events[name]=channel;
if(Object.keys(invoke).length<20||!events.onChange)throw Error('preload.cjs bridge could not be parsed');
const bridge={name:'jobloop-bridge',setup(b){
  b.onResolve({filter:/^jobloop:bridge$/},()=>({path:'bridge',namespace:'jobloop'}));
  b.onLoad({filter:/.*/,namespace:'jobloop'},()=>({contents:`export const invoke=${JSON.stringify(invoke)};export const events=${JSON.stringify(events)};`,loader:'js'}));
}};
await build({entryPoints:['src/mobile.js'], bundle:true, outfile:'dist/mobile.js', format:'esm', loader, assetNames, plugins:[bridge]});
const html=(await readFile('src/index.html','utf8'))
  .replace("connect-src 'none'","connect-src 'self'")
  .replace('<meta name="viewport" content="width=device-width, initial-scale=1">','<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#1e2325"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="JobLoop"><link rel="manifest" href="manifest.webmanifest" crossorigin="use-credentials"><link rel="apple-touch-icon" href="icon-180.png">')
  .replace('href="renderer.css"','href="mobile.css"').replace('src="renderer.js"','src="mobile.js"');
if(!html.includes('mobile.js')||!html.includes("connect-src 'self'")||!html.includes('manifest.webmanifest'))throw Error('mobile.html could not be generated from index.html');
await writeFile('dist/mobile.html', html);
for(const size of [180,192,512])await copyFile(`src/mobile/icon-${size}.png`, `dist/icon-${size}.png`);
