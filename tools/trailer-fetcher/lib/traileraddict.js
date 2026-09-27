const RSS_URL = 'https://traileraddict.com/rss';

const TRAILER_SUFFIX =
  /(?:\s*:\s*|\s+)(?:(?:Teaser|Final|Global)\s+)?Trailer(?:\s+\d+)?\s*$/i;

const VIDEO_MP4_RE =
  /https:\/\/video\.traileraddict\.com\/enc\/[^\s"'<>]+\.mp4/i;

/**
 * Strip TrailerAddict-style trailer suffixes from an RSS title.
 * @param {string} rawTitle
 * @returns {string}
 */
export function cleanFilmTitle(rawTitle) {
  let title = String(rawTitle || '').trim();
  while (TRAILER_SUFFIX.test(title)) {
    title = title.replace(TRAILER_SUFFIX, '').trim();
  }
  return title;
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function tagContent(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  return m ? decodeXmlEntities(m[1].trim()) : '';
}

/**
 * @param {string} xml
 * @returns {{ guid: string, title: string, link: string, pubDate: string }[]}
 */
export function parseRssItems(xml) {
  const items = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRe.exec(xml))) {
    const block = match[1];
    const guid = tagContent(block, 'guid') || tagContent(block, 'link');
    const title = tagContent(block, 'title');
    const link = tagContent(block, 'link');
    const pubDate = tagContent(block, 'pubDate');
    if (guid && title && link) {
      items.push({ guid, title, link, pubDate });
    }
  }
  return items;
}

/**
 * @param {(url: string, init?: RequestInit) => Promise<Response>} fetchFn
 */
export function createTrailerAddictClient({ fetchFn }) {
  return {
    async fetchFeed() {
      const res = await fetchFn(RSS_URL, {
        headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
      });
      if (!res.ok) {
        throw new Error(`TrailerAddict RSS failed: ${res.status}`);
      }
      const xml = await res.text();
      return parseRssItems(xml);
    },

    async fetchVideoUrl(pageUrl) {
      const res = await fetchFn(pageUrl, {
        headers: { Accept: 'text/html' },
      });
      if (!res.ok) {
        throw new Error(`TrailerAddict page failed: ${res.status}`);
      }
      const html = await res.text();
      const m = html.match(VIDEO_MP4_RE);
      return m ? m[0] : null;
    },
  };
}
