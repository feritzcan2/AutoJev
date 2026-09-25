use serde_json::{Value,json};
use std::path::Path;
use termloop_agents::CodexThreadHistoryInspection;

fn inspect(id:&str,cwd:&str,directory:&Path,native:&str)->Result<CodexThreadHistoryInspection,String>{
 let (sender,_receiver)=std::sync::mpsc::channel();
 let runtime=termloop_agent_runtime::start_codex_runtime(id,1,cwd,false,None,directory,None,None,sender).map_err(|e|e.to_string())?;
 let result=runtime.inspect_thread_history(native);
 runtime.reap().map_err(|e|e.to_string())?;
 result.map_err(|e|format!("History inspection failed: {e:?}"))
}
pub fn repair(v:&Value)->Result<Value,String>{
 let id=super::field(v,"sessionId")?;let cwd=super::field(v,"cwd")?;let directory=Path::new(super::field(v,"runtimeDirectory")?);let native=super::field(v,"resumeId")?;
 let CodexThreadHistoryInspection::Damaged{codex_home,rollout_path}=inspect(id,cwd,directory,native)? else{return Ok(json!({"repaired":false}));};
 let rollout=rollout_path.ok_or("History locator unavailable; no files changed")?;
 // The probe runtime is reaped before the atomic, backed-up repair. Only the
 // exact known duplicate-settings-ordinal pattern is accepted by TermLoop.
 let repair=termloop_agents::repair_codex_thread_history(&codex_home,&rollout,native).map_err(|e|format!("History repair refused: {e:?}"))?;
 if !matches!(inspect(id,cwd,directory,native)?,CodexThreadHistoryInspection::Healthy){return Err("History repair verification failed; writer not started".into());}
 Ok(json!({"repaired":true,"records":repair.repaired_records,"boundaries":repair.duplicate_boundaries,"backupPath":repair.backup_path}))
}
