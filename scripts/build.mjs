import {build} from 'esbuild';
import {mkdir, copyFile, rm} from 'node:fs/promises';
import {buildSourceTools} from './build-source-tools.mjs';
await rm('dist', {recursive:true,force:true});
await mkdir('dist', {recursive:true});
const loader={'.woff2':'file','.ttf':'file'}, assetNames='assets/[name]-[hash]';
await build({entryPoints:['src/renderer.js'], bundle:true, outfile:'dist/renderer.js', format:'esm', loader, assetNames});
await copyFile('src/index.html', 'dist/index.html');
await buildSourceTools();
