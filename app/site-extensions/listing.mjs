// @ts-check
// The listing an extension read itself: title, the listing's own description
// and named facts (company, location, pay...). Which facts exist is the
// extension's business; the core only renders them. The page carries
// `listing`, so Jev knows the text holds no site chrome to filter out.
const entity = (cp) => (cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '');
export const decode = (text) =>
  text
    .replace(/&#(\d+);/g, (_, d) => entity(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => entity(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
// Listing HTML as plain text: paragraphs on their own lines, list items as "• ".
export const htmlText = (html) =>
  decode(
    html
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|li|ul|ol|div|h\d)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
// One line of listing HTML (a title, a company, a card teaser) as plain text.
export const inlineText = (html) => htmlText(html).replace(/\s+/g, ' ').trim();
const line = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const fact = (value) =>
  Array.isArray(value)
    ? value.map(fact).filter(Boolean).join(', ')
    : value && typeof value === 'object'
      ? JSON.stringify(value)
      : line(value);

/**
 * @param {{url: string, title?: string, description?: string | null,
 *   fields?: Record<string, unknown>, notes?: string[], browser?: string}} listing
 */
export function listingPage({url, title, description, fields = {}, notes = [], browser}) {
  const facts = Object.fromEntries(
    Object.entries(fields)
      .map(([key, value]) => [key, fact(value)])
      .filter(([, value]) => value),
  );
  const body = String(description ?? '').trim();
  const text = [
    line(title),
    ...Object.entries(facts).map(([key, value]) => `${key}: ${value}`),
    ...notes.map(line).filter(Boolean),
    '',
    body,
  ]
    .join('\n')
    .trim();
  return {
    browser: browser ?? 'Site extension',
    url,
    title: line(title),
    text,
    links: [],
    pagination: [],
    status: 'ready',
    reading: {
      scope: 'site_reader',
      truncated: false,
      readiness: {loading: false, reason: null},
      unreadFrames: 0,
    },
    // Without its own description the text is not a complete listing; Jev
    // then treats it like any other page.
    ...(body ? {listing: {fields: facts}} : {}),
  };
}

// The card of a listingPage: its title, fields and notes without the
// description, for a confident exclusion before the full text is read.
export const listingCard = (page) =>
  page.listing ? page.text.split('\n\n')[0].slice(0, 2000) : null;
