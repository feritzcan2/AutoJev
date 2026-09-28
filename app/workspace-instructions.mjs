import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

// Claude imports the shared source natively; never copy or fork its contents.
// Preserve any additional user-authored Claude instructions.
export async function writeWorkspaceInstructions(cwd,agents){
 await writeFile(path.join(cwd,'AGENTS.md'),agents);
 const target=path.join(cwd,'CLAUDE.md');
 let existing='';try{existing=await readFile(target,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
 if(!/^@(?:\.\/)?AGENTS\.md\s*$/m.test(existing))
  await writeFile(target,'@AGENTS.md\n\n'+existing,{mode:0o600});
}
export const STARTUP_INSTRUCTIONS='Session startup: follow current AGENTS.md task routing (Claude imports it through CLAUDE.md). Instruction revision 2026-09-28-uncertain-retry-v1: reuse rules already in context. If this revision is new, refresh only the skill for the assigned task. Read a recovery section only for an observed blocker, not merely because a checkpoint exists. Skill paths are explicit; do not search directories to discover them. Execute the assigned task below.';
