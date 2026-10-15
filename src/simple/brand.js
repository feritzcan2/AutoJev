// JobLoop brand: one name and one mark for every surface of the simple view.
export const BRAND = 'JobLoop';
const svg = (size, ring, dot, ground) =>
  `<svg class="jl-mark" width="${size}" height="${size}" viewBox="64 64 896 896" aria-hidden="true">` +
  (ground ? `<rect x="64" y="64" width="896" height="896" rx="208" fill="${ground}"/>` : '') +
  `<path d="M743.8 418.3 A250 250 0 1 1 564 267.5" fill="none" stroke="${ring}" stroke-width="100" stroke-linecap="round"/>` +
  `<circle cx="672.7" cy="320.5" r="62" fill="${dot}"/></svg>`;
// App icon: paper ring on ink with the agent dot that keeps the loop going.
export const markIcon = (size = 28) => svg(size, '#F5F4EF', '#8B98FF', '#15171C');
// The bare mark follows the text color.
export const markInline = (size = 20) => svg(size, 'currentColor', 'var(--jl-accent)', null);
