import test from 'node:test';
import assert from 'node:assert/strict';
import { PlexClient } from '../src/plex/client.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('searchDiscover uses Discover /library/search SearchResults', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    calls.push(href);
    const parsed = new URL(href);
    if (
      parsed.hostname === 'discover.provider.plex.tv' &&
      parsed.pathname === '/library/search'
    ) {
      assert.equal(parsed.searchParams.get('query'), 'Inception 2010');
      assert.equal(parsed.searchParams.get('searchProviders'), 'discover');
      assert.equal(parsed.searchParams.get('searchTypes'), 'movies,tv');
      return jsonResponse({
        MediaContainer: {
          SearchResults: [
            {
              id: 'external',
              SearchResult: [
                {
                  Metadata: {
                    ratingKey: '5d77685333f255001e852e11',
                    type: 'movie',
                    title: 'Inception',
                    year: 2010,
                    guid: 'plex://movie/5d77685333f255001e852e11',
                  },
                  score: 0.93,
                },
                {
                  Metadata: {
                    ratingKey: 'show-1',
                    type: 'show',
                    title: 'The Cruise',
                    year: 2021,
                  },
                },
              ],
            },
          ],
        },
      });
    }
    return jsonResponse(
      { Error: { error: 'Not Found', message: 'Not Found', statusCode: 404 } },
      404,
    );
  };

  try {
    const client = new PlexClient({
      url: 'http://plex.local:32400',
      token: 'tok',
      clientId: 'cid',
    });
    const results = await client.searchDiscover('Inception 2010', { limit: 10 });
    assert.equal(results.length, 2);
    assert.equal(results[0].title, 'Inception');
    assert.equal(results[0].ratingKey, '5d77685333f255001e852e11');
    assert.equal(results[0].guid, 'plex://movie/5d77685333f255001e852e11');
    assert.equal(results[1].type, 'show');
    assert.equal(
      calls.some((href) => href.includes('/hubs/search')),
      false,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('searchDiscover returns no matches without throwing when Discover is empty', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/library/search') {
      return jsonResponse({
        MediaContainer: { SearchResults: [{ id: 'external', SearchResult: [] }] },
      });
    }
    return jsonResponse(
      { Error: { error: 'Not Found', message: 'Not Found', statusCode: 404 } },
      404,
    );
  };

  try {
    const client = new PlexClient({
      url: 'http://plex.local:32400',
      token: 'tok',
      clientId: 'cid',
    });
    const results = await client.searchDiscover('Missing Title', { limit: 5 });
    assert.deepEqual(results, []);
  } finally {
    globalThis.fetch = original;
  }
});

test('searchDiscover falls back to server hub search when Discover fails', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/library/search') {
      return jsonResponse(
        { Error: { error: 'Not Found', message: 'Not Found', statusCode: 404 } },
        404,
      );
    }
    if (parsed.pathname === '/hubs/search') {
      return jsonResponse({
        MediaContainer: {
          Hub: [
            {
              Metadata: [
                {
                  ratingKey: '99',
                  type: 'movie',
                  title: 'Local Only',
                  year: 1999,
                },
              ],
            },
          ],
        },
      });
    }
    return jsonResponse({ Error: { message: 'nope' } }, 500);
  };

  try {
    const client = new PlexClient({
      url: 'http://plex.local:32400',
      token: 'tok',
      clientId: 'cid',
    });
    const results = await client.searchDiscover('Local Only');
    assert.equal(results.length, 1);
    assert.equal(results[0].ratingKey, '99');
  } finally {
    globalThis.fetch = original;
  }
});
