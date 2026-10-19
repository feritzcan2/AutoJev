// @ts-check
import {resolveCloudflareCheckbox} from './cloudflare-checkbox.mjs';

// A visible Cloudflare checkbox gets its one native click; every other
// verification is reported to the agent and handed to the user.
export async function resolveBrowserCaptcha(browser, id, result, owner, options) {
  const part = result.content?.find((p) => p.type === 'text');
  let value;
  try {
    value = JSON.parse(part.text);
  } catch {
    return result;
  }
  if (value.status === 'verification_pending' && value.captcha?.kind === 'cloudflare_checkbox')
    return resolveCloudflareCheckbox(browser, id, result, owner, options);
  return result;
}
