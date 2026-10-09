// @ts-check
// Kept free of Node imports: the renderer bundle reaches it through templates.
export const siteKey = (url) => new URL(url).hostname.toLowerCase().replace(/^www\./, '');
