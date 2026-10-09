// The short qualification profile Jev compares every listing with. The user
// sees what Jev reads and can correct it; an edit they save is kept.
const states = {
  missing:
    'Henüz yok. Bir sonraki taramada agent belgelerinden ve bilgilerinden yazar; o zamana kadar Jev tam profili okur.',
  stale:
    'Belgelerin veya bilgilerin değişti. Bir sonraki taramada agent yeniden yazar; o zamana kadar Jev tam profili okur.',
};

export function renderJevProfile(box, view, save) {
  if (!box.firstChild) {
    const label = document.createElement('label'),
      text = document.createElement('textarea'),
      state = document.createElement('small'),
      button = document.createElement('button');
    label.textContent = 'Jev için kısa profil';
    text.maxLength = 3000;
    text.rows = 8;
    text.placeholder =
      'Diller ve seviyeleri, deneyim, alan, eğitim, çalışma izni, çalışabileceğin yerler.';
    button.type = 'button';
    button.textContent = 'Kısa profili kaydet';
    label.append(text);
    box.append(label, state, button);
    text.addEventListener('input', () => {
      button.disabled = text.value.trim() === box.dataset.saved;
    });
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await save(text.value);
      } catch (error) {
        state.textContent = error.message;
        button.disabled = false;
      }
    });
  }
  const [label, state, button] = box.children,
    text = label.querySelector('textarea'),
    editing = text.value.trim() !== (box.dataset.saved ?? '');
  box.dataset.saved = view?.text ?? '';
  if (!editing) text.value = box.dataset.saved;
  button.disabled = text.value.trim() === box.dataset.saved;
  const at = view?.at ? new Date(view.at).toLocaleString('tr-TR') : '';
  state.textContent =
    states[view?.status] ??
    `Jev her ilanı CV’n yerine bununla karşılaştırır. ${view?.by === 'user' ? 'Sen düzenledin' : 'Agent yazdı'}${at ? ' · ' + at : ''}. Yanlış veya eksik bir bilgi varsa düzeltip kaydet; boş kaydedersen Jev tam profili okur.`;
}
