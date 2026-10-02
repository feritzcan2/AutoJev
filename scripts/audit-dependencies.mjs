import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 // Windows package-manager shims require cmd.exe. Both arguments are constants.
 execFileSync(process.platform==='win32'?'pnpm.cmd':'pnpm',['audit','--prod'],{cwd:root,stdio:'inherit',shell:process.platform==='win32',timeout:120000});
}
