export function ageLabel(at, now = Date.now()) {
  if (!at) return 'Henüz işlem bildirimi yok';
  const seconds = Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
  if (!Number.isFinite(seconds)) return 'Güncelleme zamanı bilinmiyor';
  return `Son bildirim: ${duration(seconds)} önce`;
}
export function elapsedLabel(at, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
  if (!Number.isFinite(seconds)) return 'Çalışıyor';
  return `${seconds < 60 ? seconds + ' saniyedir' : seconds < 3600 ? Math.floor(seconds / 60) + ' dakikadır' : Math.floor(seconds / 3600) + ' saattir'} çalışıyor`;
}
function duration(seconds) {
  return seconds < 60
    ? seconds + ' saniye'
    : seconds < 3600
      ? Math.floor(seconds / 60) + ' dakika'
      : Math.floor(seconds / 3600) + ' saat';
}
