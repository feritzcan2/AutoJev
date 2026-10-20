export function scanReportPanel(api, root, {notice = () => {}} = {}) {
  root.innerHTML = `<label class="background-option"><span><b>Send failed scan reports</b></span><input class="switch" type="checkbox" data-scan-reports aria-label="Send failed scan reports"></label>`;
  const toggle = root.querySelector('[data-scan-reports]');
  const render = (state) => {
    toggle.checked = state.enabled;
    toggle.disabled = false;
  };
  toggle.onchange = async () => {
    toggle.disabled = true;
    try {
      render(await api.setScanReports(toggle.checked));
    } catch (error) {
      notice(error.message);
      load();
    }
  };
  function load() {
    api.scanReportsStatus().then(render, (error) => notice(error.message));
  }
  return {load};
}
