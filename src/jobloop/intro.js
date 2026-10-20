// First launch only: the JobLoop tile appears, its paper trail draws the loop,
// the plane lands on the tip, the name and promise fade in, then everything
// lifts away and onboarding rises in underneath. About two seconds; any click
// or key skips it, and "reduce motion" turns it into a short fade.
import {BRAND} from './brand.js';

const SEEN = 'jobloop:intro-seen';
const TRAIL =
  'M214 762 C318 770 432 736 488 652 C540 574 506 474 424 478 C338 482 324 600 410 632 C496 664 566 604 600 548';

export function playIntro() {
  try {
    if (localStorage.getItem(SEEN)) return;
    localStorage.setItem(SEEN, String(Date.now()));
  } catch {
    return;
  }
  const quick = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const intro = document.createElement('div');
  intro.className = 'jl-intro' + (quick ? ' quick' : '');
  intro.setAttribute('role', 'presentation');
  intro.innerHTML = `
    <div class="jl-intro-stage">
      <svg class="jl-intro-mark" width="112" height="112" viewBox="64 64 896 896" aria-hidden="true">
        <rect x="64" y="64" width="896" height="896" rx="208" fill="#0E0F12" stroke="#FFFFFF" stroke-opacity="0.1" stroke-width="12"/>
        <g transform="translate(512 512) scale(0.92) translate(-512 -512)">
          <path class="jl-intro-trail" d="${TRAIL}" pathLength="100" fill="none" stroke="#F4F4EF" stroke-width="54" stroke-linecap="round" stroke-linejoin="round"/>
          <g class="jl-intro-plane">
            <path d="M826 232 L524 376 L646 438 Z" fill="#C6F432" stroke="#C6F432" stroke-width="26" stroke-linejoin="round"/>
            <path d="M826 232 L646 438 L694 558 Z" fill="#8DB10F" stroke="#8DB10F" stroke-width="26" stroke-linejoin="round"/>
          </g>
        </g>
      </svg>
      <div class="jl-intro-name">${BRAND}</div>
      <div class="jl-intro-line">Jobs that fit you, applied for you.</div>
    </div>`;
  document.body.append(intro);
  document.body.classList.add('jl-intro-on');
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    intro.classList.add('leaving');
    document.body.classList.add('jl-intro-reveal');
    document.body.classList.remove('jl-intro-on');
    setTimeout(
      () => {
        intro.remove();
        document.body.classList.remove('jl-intro-reveal');
      },
      quick ? 200 : 700,
    );
    removeEventListener('keydown', finish, true);
  };
  intro.addEventListener('pointerdown', finish);
  addEventListener('keydown', finish, true);
  setTimeout(finish, quick ? 500 : 2100);
}
