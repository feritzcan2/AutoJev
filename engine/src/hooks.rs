use serde_json::{Value,json};
use termloop_agent_runtime::hook_forwarder::HookProtocol;
pub struct Protocol;
impl HookProtocol for Protocol{
 fn encode(&self,id:&str,token:&str,observation:Value)->Result<Value,Box<dyn std::error::Error>>{Ok(json!({"id":id,"token":token,"observation":observation}))}
 fn accept(&self,id:&str,response:Value)->Result<(),Box<dyn std::error::Error>>{if response["id"]==id&&response["accepted"]==true{Ok(())}else{Err("hook rejected".into())}}
}
pub fn input(v:&Value)->termloop_agents::ProviderHookObservationInput{
 let string=|key:&str|v[key].as_str().map(str::to_owned);
 termloop_agents::ProviderHookObservationInput{event_name:string("eventName").unwrap_or_default(),notification_type:string("notificationType"),native_session_id:string("nativeSessionId"),provider_model_id:string("providerModelId"),permission_mode:string("permissionMode"),reasoning_level:string("effortLevel"),transcript_path:string("transcriptPath"),prompt_id:string("promptId"),plan:None}
}
