// Motion kit for the simple view: Lottie animations, the Apply flight, rolling
// numbers and typed text. Every helper respects "reduce motion" and never
// blocks input; motion only explains where something went or what changed.
import lottie from './vendor/lottie_light.min.cjs';
import checkData from './lottie/check.json';
import scanData from './lottie/scan.json';

export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const clone = (data) => JSON.parse(JSON.stringify(data));
function mount(container, data, options = {}) {
  container.replaceChildren();
  const animation = lottie.loadAnimation({
    container,
    renderer: 'svg',
    loop: false,
    autoplay: false,
    animationData: clone(data),
    ...options,
  });
  return animation;
}

// A checkmark that pops in and draws itself. Returns the host element.
export function checkmark(size = 24, {play = true, label = ''} = {}) {
  const host = document.createElement('span');
  host.className = 'jl-lottie';
  host.style.width = host.style.height = size + 'px';
  if (label) {
    host.setAttribute('role', 'img');
    host.setAttribute('aria-label', label);
  } else host.setAttribute('aria-hidden', 'true');
  const animation = mount(host, checkData);
  host.play = () => (reduced() ? animation.goToAndStop(39, true) : animation.goToAndPlay(0, true));
  host.reset = () => animation.goToAndStop(0, true);
  if (play) requestAnimationFrame(() => host.play());
  return host;
}

// A page being read by a moving scan line, looping until stopped.
export function docScan(size = 64) {
  const host = document.createElement('span');
  host.className = 'jl-lottie';
  host.style.width = host.style.height = size + 'px';
  host.setAttribute('aria-hidden', 'true');
  const animation = mount(host, scanData, {loop: !reduced()});
  if (reduced()) animation.goToAndStop(74, true);
  else animation.play();
  host.stop = () => animation.stop();
  return host;
}

// ---- The Apply flight -----------------------------------------------------
// The icon's paper trail (its own coordinates), flown at 40% size from the button.
const LOOP = [
  [
    [214, 762],
    [318, 770],
    [432, 736],
    [488, 652],
  ],
  [
    [488, 652],
    [540, 574],
    [506, 474],
    [424, 478],
  ],
  [
    [424, 478],
    [338, 482],
    [324, 600],
    [410, 632],
  ],
  [
    [410, 632],
    [496, 664],
    [566, 604],
    [600, 548],
  ],
];
const PLANE =
  '<g transform="translate(22 22) rotate(46.5) scale(0.075) translate(-680 -400)"><path d="M826 232 L524 376 L646 438 Z" fill="#C6F432" stroke="#0E0F12" stroke-width="22" stroke-linejoin="round"/><path d="M826 232 L646 438 L694 558 Z" fill="#8DB10F" stroke="#0E0F12" stroke-width="22" stroke-linejoin="round"/></g>';
const NS = 'http://www.w3.org/2000/svg';
const round = (n) => Math.round(n * 10) / 10;

function flightPath(from, to) {
  const s = 0.4,
    map = ([x, y]) => [round(from.x + (x - 214) * s), round(from.y + (y - 762) * s)];
  const segments = LOOP.map((segment) => segment.map(map)),
    end = segments.at(-1)[3];
  // Leave the loop the way the icon's plane does (up and to the right), then
  // come in to the target from below.
  segments.push([end, [end[0] + 20, end[1] - 34], [to.x, to.y + 70], [to.x, to.y]]);
  return (
    `M ${segments[0][0].join(' ')} ` +
    segments.map(([, a, b, c]) => `C ${a.join(' ')}, ${b.join(' ')}, ${c.join(' ')}`).join(' ')
  );
}

// Keyframes for a continuous speed: slower climbing, faster falling, a gentle
// take-off and a soft landing, with no stop anywhere in between.
function speedFrames(path) {
  const holder = document.createElementNS(NS, 'svg'),
    probe = document.createElementNS(NS, 'path');
  holder.style.cssText = 'position:fixed;width:0;height:0;visibility:hidden';
  probe.setAttribute('d', path);
  holder.append(probe);
  document.body.append(holder);
  const length = probe.getTotalLength(),
    steps = 240,
    smooth = (x) => x * x * (3 - 2 * x),
    mid = probe.getPointAtLength(length * 0.3).y;
  const times = [0];
  for (let i = 1; i <= steps; i++) {
    const s = i / steps,
      y = probe.getPointAtLength(s * length).y;
    let v = Math.sqrt(Math.max(0.4, 1 + (0.55 * (y - mid)) / 100));
    if (s < 0.14) v *= 0.3 + 0.7 * smooth(s / 0.14);
    if (s > 0.84) v *= 1 - 0.72 * smooth((s - 0.84) / 0.16);
    times.push(times.at(-1) + 1 / steps / v);
  }
  holder.remove();
  const total = times.at(-1),
    frames = [];
  for (let k = 0; k <= 48; k++) {
    const t = (k / 48) * total;
    let i = times.findIndex((x) => x >= t);
    if (i <= 0) i = 1;
    const f = (t - times.at(i - 1)) / (times.at(i) - times.at(i - 1) || 1);
    frames.push({offset: k / 48, s: ((i - 1 + f) / steps) * 100});
  }
  return frames;
}

// Flies the plane from one element to another. Resolves when it lands.
export function flyPlane(fromElement, toElement, duration = 1400) {
  if (reduced() || !fromElement || !toElement) return Promise.resolve();
  const a = fromElement.getBoundingClientRect(),
    b = toElement.getBoundingClientRect();
  const from = {x: a.left + a.width / 2, y: a.top + a.height / 2},
    to = {x: b.left + b.width / 2, y: b.top + b.height / 2};
  const path = flightPath(from, to),
    frames = speedFrames(path);
  const layer = document.createElement('div');
  layer.className = 'jl-flight';
  const trail = document.createElementNS(NS, 'svg');
  trail.setAttribute('width', String(innerWidth));
  trail.setAttribute('height', String(innerHeight));
  const dashes = [
    [14, 0.1],
    [6, 0.22],
  ].map(([size, opacity]) => {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', path);
    p.setAttribute('pathLength', '100');
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-opacity', String(opacity));
    p.setAttribute('stroke-width', '3');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-dasharray', `${size} 200`);
    trail.append(p);
    return [p, size];
  });
  const plane = document.createElementNS(NS, 'svg');
  plane.setAttribute('viewBox', '0 0 44 44');
  plane.classList.add('jl-flight-plane');
  plane.innerHTML = PLANE;
  plane.style.offsetPath = `path('${path}')`;
  layer.append(trail, plane);
  document.body.append(layer);
  const timing = {duration, easing: 'linear', fill: 'forwards'};
  const flight = plane.animate(
    frames.map((f) => ({offset: f.offset, offsetDistance: f.s + '%'})),
    timing,
  );
  plane.animate(
    [
      {offset: 0, opacity: 0, transform: 'scale(0.7)'},
      {offset: 0.06, opacity: 1, transform: 'scale(1)'},
      {offset: 0.78, opacity: 1, transform: 'scale(1)'},
      {offset: 1, opacity: 0, transform: 'scale(0.55)'},
    ],
    {duration, easing: 'cubic-bezier(0.4,0,0.2,1)', fill: 'forwards'},
  );
  for (const [p, size] of dashes)
    p.animate(
      frames.map((f) => ({offset: f.offset, strokeDashoffset: String(size - f.s)})),
      timing,
    );
  trail.animate([{opacity: 1}, {opacity: 1, offset: 0.88}, {opacity: 0}], {
    duration,
    fill: 'forwards',
  });
  return flight.finished.then(() => layer.remove()).catch(() => layer.remove());
}

// ---- Rolling numbers ------------------------------------------------------
// Each digit rolls through a full turn before stopping, left digit first.
export function rollingNumber(value, {from = 0, animate = true} = {}) {
  const box = document.createElement('span');
  box.className = 'jl-odo';
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', String(value));
  const digits = String(value).split(''),
    start = String(from).padStart(digits.length, '0').slice(-digits.length);
  digits.forEach((digit, i) => {
    const column = document.createElement('span'),
      strip = document.createElement('span');
    column.className = 'jl-odo-col';
    column.setAttribute('aria-hidden', 'true');
    for (let n = 0; n < 20; n++)
      strip.append(Object.assign(document.createElement('span'), {textContent: String(n % 10)}));
    const target = 10 + Number(digit),
      begin = Number(start[i]);
    strip.style.transform = `translateY(-${animate && !reduced() ? begin : target}em)`;
    column.append(strip);
    box.append(column);
    if (animate && !reduced() && begin !== target)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          strip.style.transitionDelay = (digits.length - 1 - i) * 90 + 'ms';
          strip.style.transform = `translateY(-${target}em)`;
        }),
      );
  });
  return box;
}

// Types text into an element one character at a time, then calls done.
export function typewrite(element, text, {speed = 26, done} = {}) {
  if (reduced()) {
    element.textContent = text;
    done?.();
    return () => {};
  }
  let n = 0;
  element.textContent = '';
  element.classList.add('jl-typing');
  const timer = setInterval(() => {
    element.textContent = text.slice(0, ++n);
    if (n >= text.length) {
      clearInterval(timer);
      element.classList.remove('jl-typing');
      done?.();
    }
  }, speed);
  return () => clearInterval(timer);
}
