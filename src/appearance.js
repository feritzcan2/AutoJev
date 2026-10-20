// Visual preferences: theme (system, light, dark), text size and reduced motion.
// Stored per computer in localStorage and applied as the app starts.
const KEY = 'jobloop.appearance.v1',
  DEFAULTS = {theme: 'system', size: 'default', motion: 'system'},
  ZOOM = {small: 0.92, default: 1, large: 1.1};

export function loadAppearance() {
  try {
    return {...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}')};
  } catch {
    return {...DEFAULTS};
  }
}

export function applyAppearance(api, value = loadAppearance()) {
  const root = document.documentElement;
  root.style.zoom = String(ZOOM[value.size] ?? 1);
  root.toggleAttribute('data-reduce-motion', value.motion === 'reduce');
  // The main process switches Chromium's colour scheme, so every prefers-color-scheme rule follows.
  api.setTheme?.(value.theme).catch(() => {});
}

export function appearancePanel(api, container) {
  container.innerHTML = `<form class="appearance-form">
<fieldset><legend>Theme</legend><div class="appearance-choices">
<label><input type="radio" name="theme" value="system"><span>Match system</span></label>
<label><input type="radio" name="theme" value="light"><span>Light</span></label>
<label><input type="radio" name="theme" value="dark"><span>Dark</span></label></div></fieldset>
<fieldset><legend>Text size</legend><div class="appearance-choices">
<label><input type="radio" name="size" value="small"><span>Small</span></label>
<label><input type="radio" name="size" value="default"><span>Default</span></label>
<label><input type="radio" name="size" value="large"><span>Large</span></label></div></fieldset>
<label class="appearance-toggle"><input type="checkbox" name="motion"><span>Reduce motion<small>Turns off animations and transitions.</small></span></label>
</form>`;
  const form = container.querySelector('form'),
    value = loadAppearance();
  form.elements.theme.value = value.theme;
  form.elements.size.value = value.size;
  form.elements.motion.checked = value.motion === 'reduce';
  form.onchange = () => {
    const next = {
      theme: form.elements.theme.value,
      size: form.elements.size.value,
      motion: form.elements.motion.checked ? 'reduce' : 'system',
    };
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {}
    applyAppearance(api, next);
  };
}
