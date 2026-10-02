const MAX_LIST_PAGES = 100;

/**
 * Only public list pages: https://letterboxd.com/{user}/list/{slug}/
 * @param {string} raw
 */
export function parseListUrl(raw) {
  const text = String(raw || '').trim();
  const match = text.match(
    /^https?:\/\/(?:www\.)?letterboxd\.com\/([a-z0-9_-]+)\/list\/([a-z0-9_-]+)\/?$/i,
  );
  if (!match) throw new Error(`Not a public Letterboxd list URL: ${text}`);
  const user = match[1].toLowerCase();
  const slug = match[2].toLowerCase();
  return { user, slug, url: `https://letterboxd.com/${user}/list/${slug}/` };
}

/**
 * List title and film posters from one page of a list.
 * @param {string} html
 */
export function parseListPage(html) {
  const text = String(html || '');
  const films = [];
  const seen = new Set();
  const tagRe = /<[a-z]+\b[^>]*\bdata-item-link="[^"]*"[^>]*>/gi;
  let match;
  while ((match = tagRe.exec(text))) {
    const tag = match[0];
    const linkPath = decodeHtml(attr(tag, 'data-item-link'));
    if (!/\/film\//.test(linkPath)) continue;
    const titleRaw = decodeHtml(
      attr(tag, 'data-item-full-display-name') || attr(tag, 'data-item-name'),
    );
    const { title, year } = splitTitleYear(titleRaw);
    if (!title) continue;
    const link = linkPath.startsWith('http')
      ? linkPath
      : `https://letterboxd.com${linkPath.startsWith('/') ? '' : '/'}${linkPath}`;
    if (seen.has(link)) continue;
    seen.add(link);
    films.push({ title, year, link });
  }
  return { title: listTitle(text), films };
}

export function nextListPage(html) {
  const match = String(html || '').match(/<a class="next" href="([^"]+)"/i);
  return match ? decodeHtml(match[1]) : null;
}

export function isCloudflareChallenge(html) {
  const head = String(html || '').slice(0, 2500);
  return /just a moment/i.test(head) || /cf-challenge/i.test(head);
}

/**
 * Every film on a list, following the next-page link.
 * @param {string} url normalized list URL from parseListUrl
 * @param {(url: string) => Promise<{ ok: boolean, status: number, text(): Promise<string> }>} fetchFn
 */
export async function loadList(url, fetchFn) {
  const { slug } = parseListUrl(url);
  const films = [];
  const seen = new Set();
  const visited = new Set();
  let title = '';
  let next = url;
  for (let page = 0; next && page < MAX_LIST_PAGES; page += 1) {
    const pageUrl = new URL(next, 'https://letterboxd.com').href;
    if (visited.has(pageUrl)) break;
    visited.add(pageUrl);
    const res = await fetchFn(pageUrl);
    const html = await res.text();
    assertListPage(res.status, html);
    const parsed = parseListPage(html);
    if (!title) title = parsed.title;
    const before = films.length;
    for (const film of parsed.films) {
      if (seen.has(film.link)) continue;
      seen.add(film.link);
      films.push(film);
    }
    if (films.length === before) break;
    next = nextListPage(html);
  }
  return { title: title || titleFromSlug(slug), films };
}

export function splitTitleYear(titleRaw) {
  const raw = String(titleRaw || '').trim();
  const match = raw.match(/^(.*?)\s*\((\d{4})\)\s*$/);
  if (match) return { title: match[1].trim(), year: Number(match[2]) };
  return { title: raw, year: null };
}

function assertListPage(status, html) {
  if (isCloudflareChallenge(html)) {
    throw new Error('Letterboxd blocked the request. Try again in a few minutes.');
  }
  if (status === 404) throw new Error('List not found. Check the URL and that the list is public.');
  if (status === 403) throw new Error('List is private or unavailable.');
  if (status && status >= 400) throw new Error(`Letterboxd list failed: HTTP ${status}`);
}

function listTitle(html) {
  const og = html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i);
  const raw = og ? og[1] : (html.match(/<h1\b[^>]*class="[^"]*title-1[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
  return decodeHtml(String(raw || '').replace(/<[^>]+>/g, ''))
    .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
    .trim();
}

function titleFromSlug(slug) {
  return slug
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
  return match ? match[1] : '';
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .trim();
}
