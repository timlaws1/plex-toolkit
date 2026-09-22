import test from 'node:test';
import assert from 'node:assert/strict';
import { rankConnectionUris, ensureClientId } from '../src/plex/auth.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('rankConnectionUris prefers public non-relay over local/relay', () => {
  const uris = rankConnectionUris([
    { uri: 'http://192.168.1.5:32400', local: true, relay: false },
    { uri: 'https://relay.plex.example', local: false, relay: true },
    { uri: 'https://1-2-3.plex.direct:32400', local: false, relay: false },
    { address: '10.0.0.8', port: 32400, local: false, relay: false },
  ]);
  assert.ok(uris.length >= 3);
  assert.equal(uris[0], 'http://10.0.0.8:32400');
});

test('ensureClientId persists a stable id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-cid-'));
  const file = path.join(dir, 'client.id');
  const a = ensureClientId(file);
  const b = ensureClientId(file);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f-]{36}$/i);
  fs.rmSync(dir, { recursive: true, force: true });
});
