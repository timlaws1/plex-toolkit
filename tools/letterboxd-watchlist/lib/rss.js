/**
 * Parse Letterboxd watchlist RSS XML into { title, year, link, guid } items.
 * Titles typically look like "Film Name (2020)".
 */
export function parseWatchlistRss(xml) {
  const text = String(xml || '');
  const items = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRe.exec(text))) {
    const block = match[1];
    const titleRaw = decodeXml(firstTag(block, 'title') || '');
    const link = decodeXml(firstTag(block, 'link') || '');
    const guid = decodeXml(firstTag(block, 'guid') || link);
    const { title, year } = splitTitleYear(titleRaw);
    if (!title) continue;
    items.push({ title, year, link, guid, titleRaw });
  }
  return items;
}

function firstTag(block, name) {
  const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i');
  const m = block.match(re);
  return m ? m[1].trim() : '';
}

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();
}

/**
 * @param {string} titleRaw
 * @returns {{ title: string, year: number|null }}
 */
export function splitTitleYear(titleRaw) {
  const raw = String(titleRaw || '').trim();
  const m = raw.match(/^(.*?)\s*\((\d{4})\)\s*$/);
  if (m) {
    return { title: m[1].trim(), year: Number(m[2]) };
  }
  return { title: raw, year: null };
}

/**
 * @param {string} username
 */
export function watchlistRssUrl(username) {
  const user = String(username || '')
    .trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/(www\.)?letterboxd\.com\//i, '')
    .replace(/\/.*$/, '');
  if (!user) throw new Error('Letterboxd username is required');
  if (!/^[a-zA-Z0-9_-]+$/.test(user)) {
    throw new Error('Invalid Letterboxd username');
  }
  return `https://letterboxd.com/${user}/watchlist/rss/`;
}
