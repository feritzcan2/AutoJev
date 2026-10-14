// @ts-check
import {usableFormFrame} from './frame-actions.mjs';
import {observedId} from './ids.mjs';
export async function captureEmbeddedForms(slot) {
  const previous = slot.embeddedFrames ?? new Map();
  slot.embeddedFrames = new Map();
  const frames = [];
  for (const frame of slot.page.frames().filter((f) => f !== slot.page.mainFrame())) {
    const rawUrl = frame.url();
    if (!(await usableFormFrame(frame, slot.page).catch(() => false))) continue;
    let element;
    try {
      element = await frame.frameElement();
      const url = rawUrl || (await element.evaluate((e) => e.src));
      const visible = await element.evaluate(
        (e) =>
          !e.hasAttribute('sandbox') &&
          !/captcha|challenge/i.test(e.title + ' ' + e.id) &&
          e.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}) &&
          e.getBoundingClientRect().width > 1 &&
          e.getBoundingClientRect().height > 1,
      );
      if (!visible) continue;
      const kind = await frame.evaluate(() => ({
        form: !!document.querySelector(
          'input:not([type="hidden"]):not([type="password"]),select,textarea,form',
        ),
        links: !!document.querySelector('a[href]'),
        password: !!document.querySelector('input[type="password"]'),
      }));
      if (kind.password || (!kind.form && !kind.links)) continue;
      const id =
        [...previous].find(
          ([, s]) => s.frame === frame && s.url === url && s.owner === slot.owner,
        )?.[0] ?? observedId('frame');
      slot.embeddedFrames.set(id, {frame, url, rawUrl, owner: slot.owner});
      frames.push({
        frameId: id,
        url,
        inPlace: true,
        hasForm: kind.form,
        // The fields of an embedded form have no ids in the parent page.
        nextAction:
          'To fill this form, browser_open its url in a new tab; it is the same form, not a second application.',
      });
    } catch {
    } finally {
      await element?.dispose().catch(() => {});
    }
  }
  return frames;
}
export async function embeddedFormTarget(slot, frameId, owner) {
  const saved = slot.embeddedFrames?.get(frameId);
  if (!saved || saved.owner !== owner)
    throw Error('A frameId from the current embeddedForms list is required.');
  await captureEmbeddedForms(slot);
  if (!slot.embeddedFrames.has(frameId))
    throw Error('The embedded form changed or is not accessible; it was not reopened.');
  return saved.url;
}
