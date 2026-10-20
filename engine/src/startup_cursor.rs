use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use termloop_terminal::{HEADLESS_CURSOR_POSITION_REPORT, TerminalService};

const QUERY: &[u8] = b"\x1b[6n";
const WAITING: u8 = 0;
const ANSWERED: u8 = 1;
const DONE: u8 = 2;

// Windows ConPTY inherits the cursor: conhost first asks the terminal where
// the cursor is and holds the agent's shell until it gets an answer. The
// renderer may not be attached yet, and a renderer replaying earlier output
// drops its replies, so the engine answers that first query itself and drops
// the renderer's late reply to the same query.
#[derive(Clone)]
pub struct StartupCursor(Arc<AtomicU8>);

impl StartupCursor {
    pub fn new() -> Self {
        Self(Arc::new(AtomicU8::new(if cfg!(windows) {
            WAITING
        } else {
            DONE
        })))
    }

    pub fn observer(&self) -> Observer {
        Observer {
            state: self.0.clone(),
            tail: Vec::with_capacity(QUERY.len()),
        }
    }

    /// True for a renderer reply to the query the engine already answered.
    pub fn is_duplicate_reply(&self, input: &[u8]) -> bool {
        is_cursor_position_report(input)
            && self
                .0
                .compare_exchange(ANSWERED, DONE, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
    }
}

pub struct Observer {
    state: Arc<AtomicU8>,
    tail: Vec<u8>,
}

impl Observer {
    pub fn output(&mut self, terminal: &TerminalService, id: &str, bytes: &[u8]) {
        for _ in 0..self.queries(bytes) {
            match self.state.load(Ordering::Acquire) {
                WAITING => {
                    // A failed write means the terminal is gone; its EOF follows.
                    let _ = terminal.input(id, HEADLESS_CURSOR_POSITION_REPORT);
                    self.state.store(ANSWERED, Ordering::Release);
                }
                // A later query belongs to the agent; the renderer answers it.
                _ => {
                    self.state.store(DONE, Ordering::Release);
                    return;
                }
            }
        }
    }

    pub fn gap(&mut self) {
        self.tail.clear();
    }

    fn queries(&mut self, bytes: &[u8]) -> usize {
        let mut found = 0;
        for byte in bytes {
            if self.tail.len() == QUERY.len() {
                self.tail.remove(0);
            }
            self.tail.push(*byte);
            if self.tail == QUERY {
                found += 1;
                self.tail.clear();
            }
        }
        found
    }
}

fn is_cursor_position_report(input: &[u8]) -> bool {
    let Some(body) = input
        .strip_prefix(b"\x1b[")
        .and_then(|rest| rest.strip_suffix(b"R"))
    else {
        return false;
    };
    let mut parts = body.split(|byte| *byte == b';');
    let number = |part: Option<&[u8]>| {
        part.is_some_and(|part| !part.is_empty() && part.iter().all(u8::is_ascii_digit))
    };
    number(parts.next()) && number(parts.next()) && parts.next().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cursor(state: u8) -> StartupCursor {
        StartupCursor(Arc::new(AtomicU8::new(state)))
    }

    #[test]
    fn queries_split_across_chunks_are_found_once() {
        let mut observer = cursor(WAITING).observer();
        assert_eq!(observer.queries(b"\x1b[?25l\x1b["), 0);
        assert_eq!(observer.queries(b"6nready\x1b[6n"), 2);
        assert_eq!(observer.queries(b"plain output"), 0);
        observer.queries(b"\x1b[6");
        observer.gap();
        assert_eq!(observer.queries(b"n"), 0);
    }

    #[test]
    fn only_the_reply_to_the_answered_startup_query_is_dropped() {
        let cursor = cursor(ANSWERED);
        assert!(!cursor.is_duplicate_reply(b"typed text"));
        assert!(!cursor.is_duplicate_reply(b"\x1b[1;1Rx"));
        assert!(cursor.is_duplicate_reply(b"\x1b[3;14R"));
        assert!(!cursor.is_duplicate_reply(b"\x1b[3;14R"));
        assert!(!self::cursor(WAITING).is_duplicate_reply(b"\x1b[1;1R"));
    }

    #[test]
    fn a_later_agent_query_is_left_to_the_renderer() {
        let cursor = cursor(ANSWERED);
        let mut observer = cursor.observer();
        observer.output(&TerminalService::default(), "none", b"\x1b[6n");
        assert!(!cursor.is_duplicate_reply(b"\x1b[1;1R"));
    }

    #[test]
    fn the_startup_query_is_answered_only_where_conpty_holds_the_shell() {
        let cursor = StartupCursor::new();
        assert_eq!(cursor.0.load(Ordering::Acquire) == WAITING, cfg!(windows));
    }
}
