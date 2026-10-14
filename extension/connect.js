// Opened by the AutoJev app with the relay address; the service worker
// connects and closes this tab once the app accepts.
const relayUrl = new URLSearchParams(location.search).get('relay');
const show = (id, text) => {
  for (const element of document.querySelectorAll('p')) element.hidden = element.id !== id;
  if (text) document.getElementById(id).textContent = text;
};
const closeLater = () =>
  setTimeout(
    () => chrome.tabs.getCurrent((tab) => tab && chrome.tabs.remove(tab.id).catch(() => {})),
    20000,
  );
chrome.runtime.sendMessage({type: 'connect', relayUrl}, (response) => {
  if (chrome.runtime.lastError || !response?.ok) {
    show(
      'error',
      'Could not connect to AutoJev. Make sure the app is open and press Reconnect. ' +
        (response?.error ?? chrome.runtime.lastError?.message ?? ''),
    );
    closeLater();
    return;
  }
  show('done');
  closeLater();
});
