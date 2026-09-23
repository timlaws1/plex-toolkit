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
export function letterboxdUsername(username) {
  const user = String(username || '')
    .trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/(www\.)?letterboxd\.com\//i, '')
    .replace(/\/.*$/, '');
  if (!user) throw new Error('Letterboxd username is required');
  if (!/^[a-zA-Z0-9_-]+$/.test(user)) {
    throw new Error('Invalid Letterboxd username');
  }
  return user;
}

export function watchlistRssUrl(username) {
  return `https://letterboxd.com/${letterboxdUsername(username)}/watchlist/rss/`;
}

export function watchlistPageUrl(username) {
  return `https://letterboxd.com/${letterboxdUsername(username)}/watchlist/`;
}

/**
 * Film posters on the public watchlist page.
 * @param {string} html
 */
export function parseWatchlistHtml(html) {
  const text = String(html || '');
  const items = [];
  const tagRe = /<div\b[^>]*data-component-class="LazyPoster"[^>]*>/gi;
  let match;
  while ((match = tagRe.exec(text))) {
    const tag = match[0];
    const titleRaw = decodeXml(
      attr(tag, 'data-item-full-display-name') || attr(tag, 'data-item-name') || '',
    );
    const linkPath = decodeXml(attr(tag, 'data-item-link') || '');
    const { title, year } = splitTitleYear(titleRaw);
    if (!title) continue;
    const link = linkPath.startsWith('http')
      ? linkPath
      : `https://letterboxd.com${linkPath.startsWith('/') ? '' : '/'}${linkPath}`;
    items.push({ title, year, link, guid: link, titleRaw });
  }
  return items;
}

/** Relative or absolute href of the Older/next control, or null. */
export function nextWatchlistPage(html) {
  const match = String(html || '').match(/<a class="next" href="([^"]+)"/i);
  return match ? decodeXml(match[1]) : null;
}

export function isCloudflareChallenge(html) {
  const head = String(html || '').slice(0, 2500);
  return /just a moment/i.test(head) || /cf-challenge/i.test(head);
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
  return match ? match[1] : '';
}
