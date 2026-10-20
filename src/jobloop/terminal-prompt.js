// Reads an interactive choice prompt (folder trust, tool approval) from the
// rendered terminal screen so the app can show it as its own card and answer
// it with keystrokes, instead of showing the user a terminal.
const FOOTER = /(?:enter to (?:confirm|select)|esc to (?:cancel|exit)|press enter)/i;
const MARKER = /^[❯›>▶➜]\s*/u;
const BOX = /[│┃║╭╮╰╯─━═┌┐└┘├┤┬┴┼]/gu;

const clean = (line) => line.replace(BOX, ' ').replace(/\s+/g, ' ').trim();
const optionLabel = (line) =>
  clean(line)
    .replace(MARKER, '')
    .replace(/^\d+[.)]\s*/, '')
    .trim();

// Returns {question, options: [{label, selected}], selected} or null.
export function readChoicePrompt(screen) {
  const lines = String(screen ?? '').split('\n');
  let footer = -1;
  for (let i = lines.length - 1; i >= 0; i--)
    if (FOOTER.test(lines[i])) {
      footer = i;
      break;
    }
  // Without a key hint, the menu must sit at the bottom and ask a question.
  const hinted = footer >= 0;
  if (!hinted) {
    footer = lines.length;
    while (footer > 0 && !clean(lines[footer - 1])) footer--;
  }
  let marker = -1;
  for (let i = footer - 1; i >= 0 && footer - i <= 14; i--)
    if (MARKER.test(clean(lines[i]))) {
      marker = i;
      break;
    }
  if (marker < 0) return null;
  // The options are the unbroken run of short lines around the selected one.
  const isOption = (i) => {
    const text = clean(lines[i] ?? '');
    return text && !FOOTER.test(text) && text.length <= 120;
  };
  let first = marker,
    last = marker;
  while (
    first > 0 &&
    isOption(first - 1) &&
    /^(?:[❯›>▶➜]\s*)?\d+[.)]/u.test(clean(lines[first - 1]))
  )
    first--;
  // Unnumbered menus: take neighbours only when the selected line is unnumbered too.
  if (first === marker && !/^\d+[.)]/.test(clean(lines[marker]).replace(MARKER, '')))
    while (first > 0 && isOption(first - 1) && marker - first < 5) first--;
  while (last < footer - 1 && isOption(last + 1)) last++;
  const options = [];
  for (let i = first; i <= last; i++)
    options.push({label: optionLabel(lines[i]), selected: i === marker});
  if (options.length < 2) return null;
  // The question is the paragraph just above the options; the one before it
  // usually names the action (a command, a file) and is kept as context.
  const paragraphs = [[]];
  for (let i = first - 1; i >= 0 && paragraphs.length <= 2; i--) {
    const text = clean(lines[i]);
    if (!text) {
      if (paragraphs[0].length) paragraphs.unshift([]);
      continue;
    }
    if (paragraphs[0].length < 6) paragraphs[0].unshift(text);
  }
  const filled = paragraphs.filter((p) => p.length).map((p) => p.join(' '));
  if (!hinted && !/\?$/.test(filled.at(-1) ?? '')) return null;
  return {
    question: filled.at(-1) ?? '',
    context: filled.length > 1 ? filled.at(-2) : '',
    options,
    selected: options.findIndex((o) => o.selected),
  };
}

// Keystrokes that move the highlight from the current option to the chosen one and confirm.
export function choiceKeys(prompt, index) {
  const steps = index - prompt.selected;
  return (steps > 0 ? '\x1b[B'.repeat(steps) : '\x1b[A'.repeat(-steps)) + '\r';
}
