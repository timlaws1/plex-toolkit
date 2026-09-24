/**
 * Parse a Letterboxd activity or diary RSS feed.
 * Uses item fields and letterboxd:* tags. Does not fetch film pages.
 * @param {string} xml
 */
export function parseLetterboxdRss(xml) {
  const text = String(xml || '');
  const items = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRe.exec(text))) {
    const block = match[1];
    const titleRaw = decodeXml(firstTag(block, 'title'));
    const link = decodeXml(firstTag(block, 'link'));
    const guid = decodeXml(firstTag(block, 'guid')) || link;
    const filmTitle = decodeXml(firstTag(block, 'letterboxd:filmTitle'));
    const filmYear = numberOrNull(decodeXml(firstTag(block, 'letterboxd:filmYear')));
    const memberRating = numberOrNull(decodeXml(firstTag(block, 'letterboxd:memberRating')));
    const watchedDate = decodeXml(firstTag(block, 'letterboxd:watchedDate'));
    const parsed = filmTitle
      ? { title: filmTitle, year: filmYear }
      : splitActivityTitle(titleRaw);
    if (!parsed.title) continue;
    const filmLink = filmUriFrom(link, block);
    const kind = activityKind(titleRaw, memberRating, watchedDate);
    items.push({
      title: parsed.title,
      year: parsed.year,
      uri: filmLink,
      guid,
      kind,
      rating: memberRating ?? starsFromTitle(titleRaw),
      happenedOn: watchedDate || null,
    });
  }
  return items;
}

export function activityRssUrl(username, overrideUrl) {
  const custom = String(overrideUrl || '').trim();
  if (custom) {
    if (!/^https:\/\/letterboxd\.com\/.+/i.test(custom)) {
      throw new Error('Letterboxd RSS URL must be an https://letterboxd.com/ link');
    }
    return custom;
  }
  const user = String(username || '')
    .trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/(www\.)?letterboxd\.com\//i, '')
    .replace(/\/.*$/, '');
  if (!user) throw new Error('Set a Letterboxd username or RSS URL in tool settings');
  if (!/^[a-zA-Z0-9_-]+$/.test(user)) throw new Error('Invalid Letterboxd username');
  return `https://letterboxd.com/${user}/rss/`;
}

function activityKind(title, rating, watchedDate) {
  const text = title.toLowerCase();
  if (text.includes('watchlist')) return 'watchlist';
  if (text.includes('reviewed') || text.includes('review')) return 'review';
  if (text.includes('watched') || text.includes('logged') || watchedDate) return 'watched';
  if (text.includes('rated') || rating != null) return 'rating';
  return 'rss';
}

function filmUriFrom(link, block) {
  const candidates = [link, decodeXml(firstTag(block, 'description'))];
  for (const value of candidates) {
    const found = String(value).match(/https?:\/\/(?:www\.)?letterboxd\.com\/(?:[a-z0-9_-]+\/)?film\/[a-z0-9-]+\/?/i);
    if (found) return found[0];
    const boxd = String(value).match(/https?:\/\/boxd\.it\/[a-zA-Z0-9]+/);
    if (boxd) return boxd[0];
  }
  return '';
}

function splitActivityTitle(titleRaw) {
  let raw = String(titleRaw || '').trim();
  raw = raw.replace(/★+[½]?/g, '').trim();
  raw = raw.replace(/\s+-\s*$/, '').trim();
  const watched = raw.match(/\b(?:watched|logged|rated|reviewed|added)\s+(.+)$/i);
  if (watched) raw = watched[1];
  raw = raw.replace(/\s+to their watchlist$/i, '').trim();
  const yearMatch = raw.match(/^(.*?)(?:,|\()\s*(\d{4})\)?\s*$/);
  if (yearMatch) return { title: yearMatch[1].trim(), year: Number(yearMatch[2]) };
  return { title: raw, year: null };
}

function starsFromTitle(title) {
  const stars = title.match(/★+[½]?/);
  if (!stars) return null;
  const full = (stars[0].match(/★/g) || []).length;
  return stars[0].includes('½') ? full - 0.5 : full;
}

function firstTag(block, name) {
  const escaped = name.replace(':', '\\:');
  const re = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'i');
  const match = block.match(re);
  return match ? match[1].trim() : '';
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

function numberOrNull(value) {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
