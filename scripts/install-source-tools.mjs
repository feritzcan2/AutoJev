import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {sourceIntegrations} from '../app/source-integrations.mjs';
for(const source of sourceIntegrations){
 const cwd=path.resolve('vendor/ai-job-search/.agents/skills',source.id+'-search/cli');
 execFileSync(process.env.JOBLOOP_BUN||'bun',['install','--frozen-lockfile','--ignore-scripts'],{cwd,stdio:'inherit'});
}
