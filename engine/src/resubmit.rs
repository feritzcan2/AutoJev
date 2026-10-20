use std::time::{Duration, Instant};

const PRESSES: u8 = 3;
const SPACING: Duration = Duration::from_secs(3);

// A generated message can sit in the provider composer when its one Enter was
// lost: Windows ConPTY has no bracketed paste, so a provider may still be
// collecting the paste, and an unsettled screen or a missed hook leaves the
// delivery stalled. While the provider is idle an extra Enter only submits
// that composer and does nothing on an empty one. Press it a few times, then
// report the message as undelivered instead of waiting forever.
pub struct Resubmit { presses: u8, last: Instant, reported: bool }
#[derive(Debug, PartialEq, Eq)]
pub enum Step { Wait, Press, Report }
impl Resubmit {
    pub fn new(now: Instant) -> Self { Self{presses:0,last:now,reported:false} }
    pub fn step(&mut self, now: Instant, idle: bool) -> Step {
        if self.reported || now.duration_since(self.last) < SPACING { return Step::Wait; }
        if self.presses >= PRESSES { self.reported=true; return Step::Report; }
        if !idle { return Step::Wait; }
        self.presses+=1; self.last=now; Step::Press
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn presses_enter_only_while_idle_then_reports_once(){
        let start=Instant::now();let mut r=Resubmit::new(start);
        assert_eq!(r.step(start,true),Step::Wait,"the screen gets time to settle first");
        assert_eq!(r.step(start+SPACING,false),Step::Wait,"a busy or prompting provider is never pressed");
        let mut at=start+SPACING;
        for _ in 0..PRESSES {assert_eq!(r.step(at,true),Step::Press);assert_eq!(r.step(at,true),Step::Wait);at+=SPACING;}
        assert_eq!(r.step(at,true),Step::Report);
        assert_eq!(r.step(at+SPACING*10,true),Step::Wait);
    }
}
