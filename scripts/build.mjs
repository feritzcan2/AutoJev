import {build} from 'esbuild';
import {mkdir, copyFile} from 'node:fs/promises';
await mkdir('dist', {recursive:true});
await build({entryPoints:['src/renderer.js'], bundle:true, outfile:'dist/renderer.js', format:'esm', loader:{'.woff2':'file','.ttf':'file'}, assetNames:'assets/[name]-[hash]'});
await copyFile('src/index.html', 'dist/index.html');
