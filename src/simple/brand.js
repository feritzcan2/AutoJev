// JobLoop brand: one name and one mark for every surface of the simple view.
// The mark is a paper plane that has just flown a loop: it sends applications
// for you, on repeat. Volt plane and paper trail on an ink tile.
// Readability rule: Volt is never placed directly on a light ground, so the
// mark always sits on its ink tile.
export const BRAND = 'JobLoop';
export const VOLT = '#C6F432';
export const INK = '#0E0F12';
const TRAIL =
  'M214 762 C318 770 432 736 488 652 C540 574 506 474 424 478 C338 482 324 600 410 632 C496 664 566 604 600 548';
const WING = 'M826 232 L524 376 L646 438 Z';
const KEEL = 'M826 232 L646 438 L694 558 Z';
// Small sizes get a heavier trail and less padding so the loop stays legible.
export const markIcon = (size = 28, small = size <= 40) =>
  `<svg class="jl-mark" width="${size}" height="${size}" viewBox="64 64 896 896" aria-hidden="true">` +
  `<rect x="64" y="64" width="896" height="896" rx="208" fill="${INK}" stroke="#FFFFFF" stroke-opacity="0.1" stroke-width="12"/>` +
  `<g transform="translate(512 512) scale(${small ? 1.04 : 0.92}) translate(-512 -512)">` +
  `<path d="${TRAIL}" fill="none" stroke="#F4F4EF" stroke-width="${small ? 78 : 54}" stroke-linecap="round" stroke-linejoin="round"/>` +
  `<path d="${WING}" fill="${VOLT}" stroke="${VOLT}" stroke-width="26" stroke-linejoin="round"/>` +
  `<path d="${KEEL}" fill="#8DB10F" stroke="#8DB10F" stroke-width="26" stroke-linejoin="round"/>` +
  `</g></svg>`;
// Single-color mark for places that follow the text color (classic sidebar).
export const markInline = (size = 20) =>
  `<svg class="jl-mark" width="${size}" height="${size}" viewBox="190 200 680 600" aria-hidden="true">` +
  `<path d="${TRAIL}" fill="none" stroke="currentColor" stroke-width="54" stroke-linecap="round" stroke-linejoin="round"/>` +
  `<path d="${WING} ${KEEL}" fill="currentColor" stroke="currentColor" stroke-width="26" stroke-linejoin="round"/>` +
  `</svg>`;
