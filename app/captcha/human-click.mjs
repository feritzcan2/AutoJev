// @ts-check
import {setTimeout as delay} from 'node:timers/promises';

const between = (min, max) => min + Math.random() * (max - min);

// One verification checkbox click the way a person makes it: the pointer
// approaches from nearby along a slight curve, rests on the target (hover),
// then presses and releases. A provider may score an instant teleport-click
// as automated. The landing point stays within 2 px of the target centre, so
// the caller's hit-test of that point still applies. `check` aborts before the
// press when the task changed during the approach.
export async function humanClick(page, x, y, check = () => {}) {
  const angle = between(0, 2 * Math.PI),
    distance = between(80, 200),
    from = {
      x: Math.max(0, x + Math.cos(angle) * distance),
      y: Math.max(0, y + Math.sin(angle) * distance),
    },
    to = {x: x + between(-2, 2), y: y + between(-2, 2)},
    bend = between(-0.25, 0.25) * distance,
    control = {
      x: (from.x + to.x) / 2 - Math.sin(angle) * bend,
      y: (from.y + to.y) / 2 + Math.cos(angle) * bend,
    },
    steps = Math.round(between(14, 24));
  await page.mouse.move(from.x, from.y);
  for (let i = 1; i <= steps; i++) {
    // Ease in and out: slow start, faster middle, slow final approach.
    const t = i / steps,
      e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2,
      u = 1 - e;
    await page.mouse.move(
      u * u * from.x + 2 * u * e * control.x + e * e * to.x,
      u * u * from.y + 2 * u * e * control.y + e * e * to.y,
    );
    await delay(between(8, 22));
  }
  await delay(between(90, 240));
  check();
  await page.mouse.down();
  await delay(between(55, 140));
  await page.mouse.up();
}
