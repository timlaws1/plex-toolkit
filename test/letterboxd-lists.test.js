import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateManifest } from '../src/plugins/manifest.js';
import { buildIndex } from '../tools/letterboxd-lists/lib/library.js';
import { loadList, nextListPage, parseListPage, parseListUrl } from '../tools/letterboxd-lists/lib/letterboxd.js';
import { buildMissingEmail } from '../tools/letterboxd-lists/lib/mail.js';
import { matchList, planCollection } from '../tools/letterboxd-lists/lib/sync.js';
import { _internal } from '../tools/letterboxd-lists/plugin.js';

function poster(link, name) {
  return `<div class="react-component" data-component-class="LazyPoster" data-item-link="${link}" data-item-full-display-name="${name}"></div>`;
}

const PAGE_ONE = `<html><head><meta property="og:title" content="&#8206;Sci-Fi &amp; More" /></head><body>
${poster('/film/inception/', 'Inception (2010)')}
${poster('/film/arrival-2016/', 'Arrival (2016)')}
<a class="next" href="/dave/list/sci-fi/page/2/">Next</a></body></html>`;
const PAGE_TWO = `<html><body>${poster('/film/heat/', 'Heat (1995)')}${poster('/film/inception/', 'Inception (2010)')}</body></html>`;

function response(body, status = 200) {
  return { ok: status < 400, status, text: async () => body };
}

test('lists manifest is valid', () => {
  const raw = JSON.parse(fs.readFileSync(new URL('../tools/letterboxd-lists/plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateManifest(raw).errors, []);
});

test('parseListUrl accepts only public list pages', () => {
  assert.deepEqual(parseListUrl('https://www.letterboxd.com/Dave/list/Sci-Fi'), {
    user: 'dave',
    slug: 'sci-fi',
    url: 'https://letterboxd.com/dave/list/sci-fi/',
  });
  for (const bad of [
    'https://letterboxd.com/dave/watchlist/',
    'https://letterboxd.com/dave/list/sci-fi/page/2/',
    'https://example.com/dave/list/sci-fi/',
    'letterboxd.com/dave/list/sci-fi/',
  ]) {
    assert.throws(() => parseListUrl(bad), /Not a public Letterboxd list URL/);
  }
});

test('parseListPage reads the title, posters, and next page', () => {
  const page = parseListPage(PAGE_ONE);
  assert.equal(page.title, 'Sci-Fi & More');
  assert.deepEqual(page.films, [
    { title: 'Inception', year: 2010, link: 'https://letterboxd.com/film/inception/' },
    { title: 'Arrival', year: 2016, link: 'https://letterboxd.com/film/arrival-2016/' },
  ]);
  assert.equal(nextListPage(PAGE_ONE), '/dave/list/sci-fi/page/2/');
  assert.equal(nextListPage(PAGE_TWO), null);
});

test('loadList follows pages and dedupes films', async () => {
  const fetched = [];
  const list = await loadList('https://letterboxd.com/dave/list/sci-fi/', async (url) => {
    fetched.push(url);
    return response(url.endsWith('/page/2/') ? PAGE_TWO : PAGE_ONE);
  });
  assert.deepEqual(fetched, [
    'https://letterboxd.com/dave/list/sci-fi/',
    'https://letterboxd.com/dave/list/sci-fi/page/2/',
  ]);
  assert.equal(list.title, 'Sci-Fi & More');
  assert.deepEqual(list.films.map((f) => f.title), ['Inception', 'Arrival', 'Heat']);

  await assert.rejects(
    loadList('https://letterboxd.com/dave/list/gone/', async () => response('', 404)),
    /List not found/,
  );
});

test('planCollection only removes keys the tool added', () => {
  const plan = planCollection({
    matched: ['1', '2', '5'],
    managed: ['1', '3', '4'],
    current: ['1', '3', '4', '9'],
  });
  assert.deepEqual(plan.add, ['2', '5']);
  assert.deepEqual(plan.remove, ['3', '4']);
  assert.deepEqual(plan.managed, ['1', '2', '5']);
});

test('matchList matches per library and separates missing from ambiguous', () => {
  const sections = [
    { sectionId: '1', index: buildIndex([{ ratingKey: '10', title: 'Inception', year: 2010 }]) },
    {
      sectionId: '2',
      index: buildIndex([
        { ratingKey: '20', title: 'Inception', year: 2010 },
        { ratingKey: '21', title: 'Solaris', year: 2002, guids: ['tmdb://1'] },
        { ratingKey: '22', title: 'Solaris', year: 2002, guids: ['tmdb://2'] },
      ]),
    },
  ];
  const result = matchList(
    [
      { title: 'Inception', year: 2010, link: 'a' },
      { title: 'Solaris', year: 2002, link: 'b' },
      { title: 'Heat', year: 1995, link: 'c' },
    ],
    sections,
  );
  assert.equal(result.owned, 1);
  assert.deepEqual([...result.keysBySection.get('1')], ['10']);
  assert.deepEqual([...result.keysBySection.get('2')], ['20']);
  assert.deepEqual(result.ambiguous.map((f) => f.title), ['Solaris']);
  assert.deepEqual(result.missing.map((f) => f.title), ['Heat']);
});

test('buildMissingEmail lists missing films per list', () => {
  const mail = buildMissingEmail([
    {
      title: 'Sci-Fi',
      url: 'https://letterboxd.com/dave/list/sci-fi/',
      owned: 1,
      total: 2,
      missing: [{ title: 'Arrival', year: 2016, link: 'https://letterboxd.com/film/arrival-2016/' }],
    },
  ]);
  assert.equal(mail.subject, 'Letterboxd list update: Sci-Fi');
  assert.match(mail.text, /- Arrival \(2016\) https:\/\/letterboxd\.com\/film\/arrival-2016\//);
  assert.match(mail.html, /<a href="https:\/\/letterboxd\.com\/film\/arrival-2016\/">Arrival \(2016\)<\/a>/);
});

test('syncAll builds a collection, keeps hand-added films, and emails only on change', async () => {
  let pageOne = PAGE_ONE;
  let pageTwo = PAGE_TWO;
  const library = [
    { ratingKey: '10', title: 'Inception', year: 2010 },
    { ratingKey: '11', title: 'Heat', year: 1995 },
    { ratingKey: '12', title: 'Hand Picked', year: 2000 },
  ];
  const collections = new Map();
  const mails = [];
  const storage = new Map();
  const ctx = {
    settings: {
      get: () => ({
        lists: ['https://letterboxd.com/dave/list/sci-fi/'],
        libraries: ['1'],
        emailMissing: true,
      }),
    },
    storage: {
      get: (key) => (storage.has(key) ? structuredClone(storage.get(key)) : null),
      set: (key, value) => storage.set(key, structuredClone(value)),
    },
    log: { info() {}, warn() {}, error() {} },
    fetch: async (url) => response(url.endsWith('/page/2/') ? pageTwo : pageOne),
    mail: { isConfigured: () => true, send: async (msg) => mails.push(msg) },
    plex: {
      getLibraries: async () => [{ id: '1', type: 'movie', title: 'Films' }],
      getLibraryItems: async (id, { start }) => ({ items: start ? [] : library, total: library.length }),
      listCollections: async () => [...collections.entries()].map(([ratingKey, c]) => ({ ratingKey, title: c.title })),
      async createCollection({ title, ratingKeys }) {
        collections.set('c1', { title, items: new Set(ratingKeys) });
        return { ratingKey: 'c1', title };
      },
      getCollectionItems: async (key) => [...collections.get(key).items].map((ratingKey) => ({ ratingKey })),
      addCollectionItems: async (key, keys) => keys.forEach((k) => collections.get(key).items.add(k)),
      removeCollectionItem: async (key, ratingKey) => collections.get(key).items.delete(ratingKey),
    },
  };

  const first = await _internal.syncAll(ctx);
  assert.equal(first, 'Synced 1 of 1 list');
  assert.equal(collections.get('c1').title, 'Sci-Fi & More');
  assert.deepEqual([...collections.get('c1').items].sort(), ['10', '11']);
  assert.equal(mails.length, 1);
  const state = ctx.storage.get('lists')['https://letterboxd.com/dave/list/sci-fi/'];
  assert.equal(state.owned, 2);
  assert.deepEqual(state.missing.map((f) => f.title), ['Arrival']);

  collections.get('c1').items.add('12');
  pageOne = PAGE_ONE.replace(poster('/film/inception/', 'Inception (2010)'), '');
  pageTwo = PAGE_TWO.replace(poster('/film/inception/', 'Inception (2010)'), '');
  await _internal.syncAll(ctx);
  assert.deepEqual([...collections.get('c1').items].sort(), ['11', '12']);
  assert.equal(mails.length, 1);
});
