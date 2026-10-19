// @ts-check
// A cover letter as an A4 PDF, rendered by Chromium in a hidden window of the
// app itself; no PDF library and no network. Electron is loaded on first use so
// node tests can inject their own renderer.
const escape = (text) =>
  text.replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);

export function coverLetterHtml(text) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => `<p>${escape(p.trim()).replace(/\n/g, '<br>')}</p>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@page{size:A4;margin:25mm 22mm}
body{margin:0;font:11pt/1.5 "Helvetica Neue",Helvetica,Arial,sans-serif;color:#111}
p{margin:0 0 1em}
</style></head><body>${paragraphs}</body></html>`;
}

export async function renderCoverLetterPdf(text) {
  const {BrowserWindow} = await import('electron');
  const window = new BrowserWindow({
    show: false,
    webPreferences: {javascript: false, sandbox: true, offscreen: true},
  });
  try {
    await window.loadURL(
      'data:text/html;charset=utf-8,' + encodeURIComponent(coverLetterHtml(text)),
    );
    return await window.webContents.printToPDF({pageSize: 'A4', preferCSSPageSize: true});
  } finally {
    window.destroy();
  }
}
