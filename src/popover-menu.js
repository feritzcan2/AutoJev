// Place an open popover menu under its trigger, or above it when the viewport is short.
export const positionMenu = (panel, toggle) => {
  const trigger = toggle.getBoundingClientRect(),
    width = panel.offsetWidth,
    height = panel.offsetHeight;
  panel.style.left = Math.max(8, Math.min(trigger.right - width, innerWidth - width - 8)) + 'px';
  panel.style.top =
    (trigger.bottom + height + 8 <= innerHeight
      ? trigger.bottom + 4
      : Math.max(8, trigger.top - height - 4)) + 'px';
};
