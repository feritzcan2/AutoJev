// Inspect the rendered terminal screen: interactive prompts are often redrawn
// in place and can be split across PTY output events.
import {providerLimit, providerLimitAttention} from '../app/agents/provider-limit.mjs';
export function terminalAttention(screen, state, provider = 'claude') {
  const limit = providerLimit(screen, provider);
  if (limit) return providerLimitAttention(limit);
  const text = String(screen ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const trust =
    /(?:quick safety check|do you trust (?:the files in )?this (?:folder|workspace|project))/i.test(
      text,
    ) &&
    /(?:yes,? i trust this folder|trust this (?:folder|workspace|project))/i.test(text) &&
    /(?:enter to confirm|press enter|esc to cancel)/i.test(text);
  if (trust)
    return {
      kind: 'trust',
      title: 'Waiting for workspace trust approval',
      detail:
        'Claude Code is asking for permission to access the folder. Check the path in the terminal and make your choice there.',
    };
  const permission =
    /(?:do you want to (?:allow|proceed|approve)|allow .{1,120}\?|permission (?:required|requested)|needs (?:your )?permission)/i.test(
      text,
    ) &&
    /\b(?:yes|allow|approve)\b/i.test(text) &&
    /\b(?:no|deny|cancel)\b/i.test(text) &&
    /(?:enter to confirm|press enter|esc to cancel)/i.test(text);
  if (permission)
    return {
      kind: 'permission',
      title: 'Agent is waiting for approval of an action',
      detail: 'Review the requested action in the terminal and decide.',
    };
  if (state === 'AwaitingInput')
    return {
      kind: 'input',
      title: 'Agent is waiting for input or approval',
      detail: 'Review the request in the terminal and answer it to continue.',
    };
  return null;
}

// Keys that move Claude's folder trust menu to "Yes, I trust this folder" and confirm it.
// The default option differs between Claude versions, so it is read from the screen.
export function trustKeys(screen) {
  const options = String(screen ?? '')
      .split('\n')
      .filter((line) => /^\s*[❯›>]?\s*(?:\d+\.\s*)?(?:yes,? i trust|no,? exit)/i.test(line)),
    yes = options.findIndex((line) => /yes,? i trust this folder/i.test(line)),
    cursor = options.findIndex((line) => /^\s*[❯›>]/.test(line));
  if (options.length !== 2 || yes < 0 || cursor < 0) return null;
  return [...Array(Math.abs(yes - cursor)).fill(yes > cursor ? '\x1b[B' : '\x1b[A'), '\r'];
}
