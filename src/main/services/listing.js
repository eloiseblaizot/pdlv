import { fetchText } from '../net/download.js';

const decodeEntities = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');

/**
 * Lit une page d'index de fichiers (serveur ftp.paysdelavaliere.fr, gabarit « browse » de Caddy)
 * et renvoie les entrées : { name, url, isDir, size, modified }.
 */
export async function listDirectory(url) {
  const base = url.endsWith('/') ? url : `${url}/`;
  const html = await fetchText(base);
  const entries = [];
  for (const row of html.split(/<tr[\s>]/).slice(1)) {
    const href = row.match(/class="name"><a href="([^"]+)"/)?.[1];
    if (!href || href.startsWith('..')) continue;
    const isDir = href.endsWith('/');
    const name = decodeURIComponent(isDir ? href.slice(0, -1) : href);
    if (name.startsWith('.')) continue;
    const size = Number(row.match(/data-order="(-?\d+)"/)?.[1] ?? -1);
    const time = row.match(/<time datetime="([^"]+)"/)?.[1];
    // Format Go : "2026-08-30 20:11:41 +0000 UTC"
    const modified = time
      ? Date.parse(
          decodeEntities(time)
            .replace(' ', 'T')
            .replace(/ ([+-]\d{2})(\d{2}) UTC$/, '$1:$2'),
        )
      : null;
    entries.push({
      name,
      url: new URL(href, base).href,
      isDir,
      size: size >= 0 ? size : null,
      modified: Number.isNaN(modified) ? null : modified,
    });
  }
  return entries;
}
