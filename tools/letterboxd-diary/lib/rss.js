/**
 * Diary entries from a Letterboxd member RSS feed. Only items with a watched
 * date are watches; lists and watchlist activity are ignored.
 * @param {string} xml
 */
export function parseDiaryRss(xml) {
  const text = String(xml || '');
  const entries = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRe.exec(text))) {
    const block = match[1];
    const watchedDate = decodeXml(firstTag(block, 'letterboxd:watchedDate'));
    if (!watchedDate) continue;
    const link = decodeXml(firstTag(block, 'link'));
    const guid = decodeXml(firstTag(block, 'guid')) || link;
    const title =
      decodeXml(firstTag(block, 'letterboxd:filmTitle')) ||
      splitTitle(decodeXml(firstTag(block, 'title'))).title;
    if (!title || !guid) continue;
    const year =
      numberOrNull(decodeXml(firstTag(block, 'letterboxd:filmYear'))) ??
      splitTitle(decodeXml(firstTag(block, 'title'))).year;
    const tmdbId = numberOrNull(decodeXml(firstTag(block, 'tmdb:movieId')));
    entries.push({
      guid,
      title,
      year,
      uri: link,
      watchedDate,
      guids: tmdbId ? [`tmdb://${tmdbId}`] : [],
    });
  }
  return entries;
}

export function diaryRssUrl(username) {
  const user = String(username || '')
    .trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/(www\.)?letterboxd\.com\//i, '')
    .replace(/\/.*$/, '');
  if (!user) throw new Error('Set a Letterboxd username in tool settings');
  if (!/^[a-zA-Z0-9_-]+$/.test(user)) throw new Error('Invalid Letterboxd username');
  return `https://letterboxd.com/${user}/rss/`;
}

function splitTitle(raw) {
  const cleaned = String(raw || '')
    .replace(/\s+-\s*[★½]+\s*$/, '')
    .trim();
  const match = cleaned.match(/^(.*?),\s*(\d{4})$/);
  if (match) return { title: match[1].trim(), year: Number(match[2]) };
  return { title: cleaned, year: null };
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
  if (value == null || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
