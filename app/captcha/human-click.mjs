// @ts-check
import {setTimeout as delay} from 'node:timers/promises';

const between = (min, max) => min + Math.random() * (max - min);

// The last pointer position this helper left on each page, so a second click
// starts where the pointer actually rests instead of appearing somewhere new.
const pointers = new WeakMap();

// One verification checkbox click the way a person makes it: a short pause to
// notice the checkbox, then the pointer travels along a slight curve with a
// little hand tremor, speeding up and slowing down (longer moves take longer),
// sometimes overshoots a few pixels and corrects, rests on the target (hover),
// then presses and releases. Mouse events carry whole pixels, as a real mouse
// does. A provider may score an instant or perfectly smooth path as automated.
// The landing point stays within 4 px of the target centre, so the caller's
// hit-test of that point still applies. `check` aborts before the press when
// the task changed meanwhile.
export async function humanClick(page, x, y, check = () => {}) {
  let at = null;
  const move = async (px, py) => {
    const next = {x: Math.max(0, Math.round(px)), y: Math.max(0, Math.round(py))};
    // A real mouse sends no event when the pointer stays on the same pixel.
    if (at && at.x === next.x && at.y === next.y) return;
    at = next;
    await page.mouse.move(next.x, next.y);
  };
  let from = pointers.get(page);
  if (!from || Math.hypot(from.x - x, from.y - y) < 40) {
    const angle = between(0, 2 * Math.PI),
      distance = between(120, 320);
    from = {x: x + Math.cos(angle) * distance, y: y + Math.sin(angle) * distance};
  }
  await delay(between(250, 700));
  check();
  await move(from.x, from.y);
  const to = {x: x + between(-2, 2), y: y + between(-2, 2)},
    distance = Math.hypot(to.x - from.x, to.y - from.y),
    ux = (to.x - from.x) / distance,
    uy = (to.y - from.y) / distance,
    // Most longer reaches end a few pixels past the target, then come back.
    overshoot = distance > 80 && Math.random() < 0.6 ? between(3, 8) : 0,
    aim = {x: to.x + ux * overshoot, y: to.y + uy * overshoot},
    bend = between(-0.2, 0.2) * distance,
    control = {x: (from.x + aim.x) / 2 - uy * bend, y: (from.y + aim.y) / 2 + ux * bend},
    // Fitts's law for a ~24 px target, with person-to-person variation.
    duration = (120 + 110 * Math.log2(distance / 24 + 1)) * between(0.85, 1.25),
    steps = Math.max(8, Math.round(duration / 16));
  for (let i = 1; i <= steps; i++) {
    // Minimum-jerk profile: slow start, fast middle, slow final approach.
    const t = i / steps,
      e = t * t * t * (10 - 15 * t + 6 * t * t),
      u = 1 - e,
      tremor = i < steps ? between(-0.8, 0.8) * (1 - t) : 0;
    await move(
      u * u * from.x + 2 * u * e * control.x + e * e * aim.x - uy * tremor,
      u * u * from.y + 2 * u * e * control.y + e * e * aim.y + ux * tremor,
    );
    await delay(between(10, 22));
  }
  if (overshoot) {
    await delay(between(40, 110));
    const back = Math.round(between(2, 4));
    for (let i = 1; i <= back; i++) {
      const t = i / back;
      await move(aim.x + (to.x - aim.x) * t, aim.y + (to.y - aim.y) * t);
      await delay(between(14, 30));
    }
  }
  // The hand is not perfectly still while hovering.
  await delay(between(60, 160));
  if (Math.random() < 0.5) {
    await move(to.x + between(-1, 1), to.y + between(-1, 1));
    await delay(between(40, 120));
  }
  check();
  await page.mouse.down();
  await delay(between(55, 140));
  await page.mouse.up();
  pointers.set(page, at);
}
