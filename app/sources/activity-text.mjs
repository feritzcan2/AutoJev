// @ts-check
// A scan's current step as one line ("Now: …"), for the Sources and
// Background work pages.
export function sourceActivityText(a, now = Date.now()) {
  if (!a?.step) return null;
  const until = a.waitUntil > now ? new Date(a.waitUntil).toLocaleTimeString('en-GB') : null;
  const what =
    a.step === 'page'
      ? `Reading a results page${a.search ? ` for “${a.search}”` : ''}`
      : a.step === 'listing'
        ? `Reading listing ${a.done + 1}/${a.total}${a.browser ? ' in the browser' : ''}` +
          (a.title ? `: ${a.title}${a.company ? ' @ ' + a.company : ''}` : '')
        : a.tool
          ? `Agent: ${a.label ?? a.tool.replace(/_/g, ' ')}${a.url ? ' · ' + a.url : ''}`
          : 'Agent: reviewing the ready batch';
  return (
    'Now: ' +
    what +
    (until ? ` · waiting for ${a.waitFor ?? 'the site’s pace'} until ${until}` : '')
  );
}
