import {execFileSync} from 'node:child_process';
import {appendFile,readFile} from 'node:fs/promises';
const env=process.env,tag=env.JOBLOOP_RELEASE_TAG,repository=env.GITHUB_REPOSITORY;
if(!/^v\d+\.\d+\.\d+$/.test(tag??''))throw Error('Use a stable vMAJOR.MINOR.PATCH tag');
if(!/^[\w.-]+\/[\w.-]+$/.test(repository??''))throw Error('GITHUB_REPOSITORY is required');
const git=args=>execFileSync('git',args,{encoding:'utf8'}).trim();
const sha=git(['rev-parse','HEAD']);
if(env.JOBLOOP_CANDIDATE_SHA&&sha!==env.JOBLOOP_CANDIDATE_SHA)throw Error('Checked out commit differs from the verified candidate');
if(env.GITHUB_EVENT_NAME==='push'&&env.GITHUB_SHA!==sha)throw Error('Tag event does not match checkout');
git(['fetch','--no-tags','origin',`+refs/tags/${tag}:refs/tags/${tag}`,'+refs/heads/main:refs/remotes/origin/main']);
if(git(['rev-parse',`${tag}^{commit}`])!==sha)throw Error('Release tag moved to another commit');
git(['merge-base','--is-ancestor',sha,'refs/remotes/origin/main']);
const manifest=JSON.parse(await readFile('package.json','utf8'));
if(tag!==`v${manifest.version}`)throw Error('Release version and tag differ');
async function api(route){const response=await fetch(`https://api.github.com/repos/${repository}/${route}`,{headers:{Authorization:`Bearer ${env.GH_TOKEN||env.GITHUB_TOKEN}`,'X-GitHub-Api-Version':'2022-11-28',Accept:'application/vnd.github+json'}});if(!response.ok)throw Error(`GitHub API failed: ${response.status}`);return response.json();}
const runs=await api(`actions/workflows/ci.yml/runs?head_sha=${sha}&status=success&per_page=50`);
const required=['preflight','verify (macos)','verify (linux)','verify (windows)'];
let verified;
for(const run of runs.workflow_runs.filter(run=>['push','workflow_dispatch'].includes(run.event)&&run.head_sha===sha)){
 const {jobs}=await api(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
 if(required.every(name=>jobs.some(job=>job.name===name&&job.conclusion==='success'))){verified=run;break;}
}
if(!verified)throw Error(`No complete successful native CI run exists for exact candidate ${sha}`);
console.log(`Verified ${sha} with ${verified.html_url}`);
if(env.GITHUB_OUTPUT)await appendFile(env.GITHUB_OUTPUT,`sha=${sha}\nci-run-id=${verified.id}\n`);
