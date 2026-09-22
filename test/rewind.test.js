import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planRewind,
  planUndo,
  formatEpisodeCode,
  isShowAllowed,
} from '../../plex-toolkit-netflix-rewatch/rewind.js';

function ep(season, episode, watched, ratingKey) {
  return {
    ratingKey: String(ratingKey ?? `${season}-${episode}`),
    parentIndex: season,
    index: episode,
    viewCount: watched ? 1 : 0,
    title: `E${episode}`,
  };
}

test('planRewind matches Slow Horses style example', () => {
  const episodes = [
    ep(2, 1, true),
    ep(2, 2, true),
    ep(2, 3, true),
    ep(2, 4, true, 'pivot'),
    ep(2, 5, true),
    ep(2, 6, true),
    ep(2, 7, false),
  ];
  const { changes } = planRewind(episodes, { ratingKey: 'pivot', parentIndex: 2, index: 4 });
  assert.deepEqual(
    changes.map((c) => `${formatEpisodeCode(c.parentIndex, c.index)}:${c.from}->${c.to}`),
    ['S02E05:watched->unwatched', 'S02E06:watched->unwatched'],
  );
});

test('planRewind marks earlier unwatched episodes watched only when needed', () => {
  const episodes = [
    ep(1, 1, true),
    ep(1, 2, false),
    ep(1, 3, true, 'pivot'),
    ep(1, 4, true),
  ];
  const { changes } = planRewind(episodes, { ratingKey: 'pivot', parentIndex: 1, index: 3 });
  assert.deepEqual(
    changes.map((c) => `${c.ratingKey}:${c.to}`),
    ['1-2:watched', '1-4:unwatched'],
  );
});

test('planRewind excludes specials by default', () => {
  const episodes = [
    ep(0, 1, true, 'sp'),
    ep(1, 1, true, 'a'),
    ep(1, 2, true, 'pivot'),
    ep(1, 3, true, 'c'),
  ];
  const { changes, ordered } = planRewind(episodes, {
    ratingKey: 'pivot',
    parentIndex: 1,
    index: 2,
  });
  assert.equal(ordered.some((e) => e.parentIndex === 0), false);
  assert.deepEqual(
    changes.map((c) => c.ratingKey),
    ['c'],
  );
});

test('planUndo restores matching state and reports conflicts', () => {
  const original = [
    { ratingKey: '5', parentIndex: 2, index: 5, from: 'watched', to: 'unwatched' },
    { ratingKey: '6', parentIndex: 2, index: 6, from: 'watched', to: 'unwatched' },
  ];
  const current = new Map([
    ['5', false], // still as plugin left it
    ['6', true], // user re-watched
  ]);
  const plan = planUndo(original, current, { force: false });
  assert.equal(plan.apply.length, 1);
  assert.equal(plan.apply[0].ratingKey, '5');
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].ratingKey, '6');

  const forced = planUndo(original, current, { force: true });
  assert.equal(forced.apply.length, 2);
});

test('isShowAllowed respects include and exclude lists', () => {
  assert.equal(
    isShowAllowed('The Simpsons', { excludeShows: ['The Simpsons'], includeShows: [] }),
    false,
  );
  assert.equal(
    isShowAllowed('Slow Horses', {
      excludeShows: [],
      includeShows: ['Slow Horses'],
    }),
    true,
  );
  assert.equal(
    isShowAllowed('Other', { excludeShows: [], includeShows: ['Slow Horses'] }),
    false,
  );
});
