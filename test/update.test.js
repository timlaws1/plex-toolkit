import test from 'node:test';
import assert from 'node:assert/strict';
import {
  revisionsDiffer,
  shortRevision,
  splitImageRef,
} from '../src/update/version.js';
import { replacementSpec } from '../src/update/docker.js';
import { refreshUpdateStatus } from '../src/update/status.js';

test('revisionsDiffer ignores missing and dev revisions', () => {
  assert.equal(revisionsDiffer(null, 'abc'), false);
  assert.equal(revisionsDiffer('dev', 'abc'), false);
  assert.equal(revisionsDiffer('abc', 'abc'), false);
  assert.equal(revisionsDiffer('aaa', 'bbb'), true);
  assert.equal(shortRevision('abcdefghijk'), 'abcdefg');
});

test('splitImageRef keeps registry and tag', () => {
  assert.deepEqual(splitImageRef('ghcr.io/timlaws1/plex-toolkit:latest'), {
    fromImage: 'ghcr.io/timlaws1/plex-toolkit',
    tag: 'latest',
  });
  assert.equal(splitImageRef('sha256:abcd').tag, 'latest');
});

test('replacementSpec drops the container-id hostname and live IP', () => {
  const spec = replacementSpec(
    {
      Id: 'abc123def456',
      Config: {
        Hostname: 'abc123def456',
        Image: 'app:latest',
        Env: ['A=1'],
        Labels: { app: 'plex-toolkit' },
      },
      HostConfig: {
        Binds: ['./data:/data'],
        PortBindings: { '8787/tcp': [{ HostPort: '8787' }] },
      },
      NetworkSettings: {
        Networks: { bridge: { Aliases: ['plex-toolkit'], IPAddress: '1.2.3.4' } },
      },
    },
    'ghcr.io/timlaws1/plex-toolkit:latest',
  );

  assert.equal(spec.Hostname, undefined);
  assert.equal(spec.Image, 'ghcr.io/timlaws1/plex-toolkit:latest');
  assert.deepEqual(spec.Labels, { app: 'plex-toolkit' });
  assert.deepEqual(spec.NetworkingConfig.EndpointsConfig.bridge, {
    Aliases: ['plex-toolkit'],
  });
});

test('refreshUpdateStatus marks a newer GitHub commit', async () => {
  const previous = process.env.APP_REVISION;
  process.env.APP_REVISION = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  try {
  const status = await refreshUpdateStatus(
    async () => ({
      ok: true,
      async json() {
        return {
          sha: 'ffffffffffffffffffffffffffffffffffffffff',
          commit: {
            message: 'Ship updater\n\nbody',
            committer: { date: '2026-09-23T12:00:00Z' },
          },
        };
      },
    }),
    { force: true },
  );

  assert.equal(status.updateAvailable, true);
  assert.equal(status.latestShort, 'fffffff');
  assert.equal(status.latestMessage, 'Ship updater');
  assert.match(status.latestDate, /23 Sept? 2026/);
  } finally {
    if (previous === undefined) delete process.env.APP_REVISION;
    else process.env.APP_REVISION = previous;
  }
});
