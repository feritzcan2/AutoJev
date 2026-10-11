export function ageLabel(at, now = Date.now()) {
  if (!at) return 'No activity reported yet';
  const seconds = Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
  if (!Number.isFinite(seconds)) return 'Update time unknown';
  return `Last update: ${duration(seconds)} ago`;
}
export function elapsedLabel(at, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
  if (!Number.isFinite(seconds)) return 'Running';
  return `Running for ${duration(seconds)}`;
}
function duration(seconds) {
  return seconds < 60
    ? seconds + (seconds === 1 ? ' second' : ' seconds')
    : seconds < 3600
      ? Math.floor(seconds / 60) + (Math.floor(seconds / 60) === 1 ? ' minute' : ' minutes')
      : Math.floor(seconds / 3600) + (Math.floor(seconds / 3600) === 1 ? ' hour' : ' hours');
}
