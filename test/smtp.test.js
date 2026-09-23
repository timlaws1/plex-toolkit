import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMultiline } from '../src/mail/smtp.js';

function readerFrom(lines) {
  const queue = [...lines];
  return {
    next() {
      if (!queue.length) return Promise.reject(new Error('no more lines'));
      return Promise.resolve(queue.shift());
    },
  };
}

test('collectMultiline accepts multiline 220 greeting', async () => {
  const text = await collectMultiline(
    readerFrom([
      '220-We do not authorize the use of this system to transport unsolicited,',
      '220-email, and any such emails will be reported to the relevant authorities.',
      '220 mail.example.com ESMTP ready',
    ]),
    220,
  );
  assert.match(text, /We do not authorize/);
  assert.match(text, /ESMTP ready/);
});

test('collectMultiline rejects wrong reply code mid-stream', async () => {
  await assert.rejects(
    () =>
      collectMultiline(
        readerFrom([
          '220-hello',
          '421 shutting down',
        ]),
        220,
      ),
    /SMTP unexpected response: 421/,
  );
});
