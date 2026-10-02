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

const DISCOVER_HOSTS = new Set(['discover.provider.plex.tv', 'metadata.provider.plex.tv']);

function recordingFetch(calls) {
  return async (url) => {
    const parsed = new URL(String(url));
    calls.push(parsed);
    return jsonResponse({
      MediaContainer: {
        totalSize: 0,
        Metadata: [{ ratingKey: '1', type: 'movie', title: 'Stub' }],
      },
    });
  };
}

test('getDiscoverMetadata accepts rating keys and metadata paths only', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = recordingFetch(calls);
  try {
    const client = new PlexClient({ url: 'http://plex.local:32400', token: 'tok', clientId: 'cid' });
    await client.getDiscoverMetadata('5d776825880197001ec967c6');
    await client.getDiscoverMetadata(123);
    await client.getDiscoverMetadata('/library/metadata/123');
    assert.deepEqual(
      calls.map((u) => u.pathname),
      ['/library/metadata/5d776825880197001ec967c6', '/library/metadata/123', '/library/metadata/123'],
    );
    for (const u of calls) assert.ok(DISCOVER_HOSTS.has(u.host), u.host);

    const before = calls.length;
    for (const bad of [
      '//evil.example/library/metadata/1',
      'https://evil.example/library/metadata/1',
      '/\\evil.example',
      '/library/metadata/1?x=1',
      '/library/metadata/1#x',
      '/library/metadata/../../x',
      '../x',
      '',
    ]) {
      await assert.rejects(client.getDiscoverMetadata(bad), /rating key/, bad);
    }
    assert.equal(calls.length, before);
  } finally {
    globalThis.fetch = original;
  }
});

test('accountRequest refuses to send the token to a non-Discover host', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = recordingFetch(calls);
  try {
    const client = new PlexClient({ url: 'http://plex.local:32400', token: 'tok', clientId: 'cid' });
    await assert.rejects(
      client.accountRequest('GET', 'https://discover.provider.plex.tv', '//evil.example/x'),
      /Discover host/,
    );
    await assert.rejects(
      client.accountRequest('GET', 'https://discover.provider.plex.tv', 'http://discover.provider.plex.tv/x'),
      /Discover host/,
    );
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('dynamic Plex path segments are encoded and cannot change the host', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = recordingFetch(calls);
  try {
    const client = new PlexClient({ url: 'http://plex.local:32400', token: 'tok', clientId: 'cid' });
    await client.getLibraryItems('../../evil', {});
    await client.getShows('//evil.example');
    await client.getPlaylistItems('1/../../x');
    for (const u of calls) assert.equal(u.host, 'plex.local:32400');
    assert.equal(calls[0].pathname, '/library/sections/..%2F..%2Fevil/all');
    assert.equal(calls[1].pathname, '/library/sections/%2F%2Fevil.example/all');
    assert.equal(calls[2].pathname, '/playlists/1%2F..%2F..%2Fx/items');

    const before = calls.length;
    await assert.rejects(client.getMetadata('..'), /Invalid Plex id/);
    await assert.rejects(client.getMetadata(''), /Invalid Plex id/);
    await assert.rejects(client.request('GET', '//evil.example/x'), /leaves the server/);
    assert.equal(calls.length, before);
  } finally {
    globalThis.fetch = original;
  }
});
