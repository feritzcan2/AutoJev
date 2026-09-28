use std::sync::mpsc::{self, Receiver};
use std::time::Duration;
use termloop_agents::AgentState;
use termloop_terminal::TerminalService;

pub fn submit_key(provider: &str, state: AgentState) -> Option<&'static [u8]> {
    match (provider, state) {
        ("codex", AgentState::Working) => Some(b"\t"),
        ("claude", AgentState::Working)
        | ("codex" | "claude", AgentState::Idle | AgentState::Interrupted) => Some(b"\r"),
        _ => None,
    }
}

pub struct Delivery { ready: Receiver<Result<(), String>>, sequence: u64 }
impl Delivery {
    pub fn begin(terminal: &TerminalService, id: &str) -> Result<Self, String> {
        let sequence=terminal.user_input_activity(id,1).map_err(|e|e.to_string())?.sequence;
        // Trailing space closes slash completion so Codex Tab means queue.
        let submission=termloop_launch::generated_submission(&super::TEMPLATE,"/compact ").map_err(|e|e.to_string())?;
        let write=terminal.input_atomic_receipted_if_protocol_settled(id,1,submission.paste_input()).map_err(|e|e.to_string())?;
        let (send,ready)=mpsc::channel();
        std::thread::spawn(move||{
            let result=write.wait(Duration::from_secs(2)).map_err(|e|format!("Compact paste: {e:?}"))
                .and_then(|receipt|receipt.output_before_write.wait_for_composer_render_settlement(Duration::from_millis(160),Duration::from_secs(10))
                    .map(|_|()).map_err(|e|format!("Compact composer: {e:?}")));
            let _=send.send(result);
        });
        Ok(Self{ready,sequence})
    }
    pub fn poll(&self, terminal: &TerminalService, id: &str, provider: &str, state: Option<AgentState>) -> Option<Result<(), String>> {
        match self.ready.try_recv(){
            Err(mpsc::TryRecvError::Empty)=>return None,
            Err(_)=>return Some(Err("Compact writer closed".into())),
            Ok(Err(error))=>return Some(Err(error)),
            Ok(Ok(()))=>{},
        }
        Some((||{
            let activity=terminal.user_input_activity(id,1).map_err(|e|e.to_string())?;
            if activity.sequence!=self.sequence{return Err("Terminal input changed; compact was not submitted".into());}
            let key=state.and_then(|state|submit_key(provider,state)).ok_or("Provider cannot accept compact now")?;
            terminal.input_atomic_receipted_if_protocol_settled(id,1,key).map_err(|e|e.to_string())?
                .wait(Duration::from_secs(2)).map_err(|e|format!("Compact submit: {e:?}"))?;
            Ok(())
        })())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn queues_native_commands_while_working_and_submits_at_idle(){
        assert_eq!(submit_key("codex",AgentState::Working),Some(b"\t".as_slice()));
        assert_eq!(submit_key("claude",AgentState::Working),Some(b"\r".as_slice()));
        for provider in ["codex","claude"]{
            assert_eq!(submit_key(provider,AgentState::Idle),Some(b"\r".as_slice()));
            for state in [AgentState::Compacting,AgentState::AwaitingInput,AgentState::Unknown,AgentState::Exited,AgentState::Failed]{assert_eq!(submit_key(provider,state),None);}
        }
    }
}
