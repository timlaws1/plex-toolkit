import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAddressLine, collectMultiline, sendMail } from '../src/mail/smtp.js';

test('From and To with line breaks are rejected before connecting', async () => {
  assert.doesNotThrow(() => assertAddressLine('a@example.com', 'From'));
  assert.doesNotThrow(() => assertAddressLine('Plex Toolkit <a@example.com>', 'From'));
  assert.throws(() => assertAddressLine('a@example.com\r\nRCPT TO:<b@evil.example>', 'To'), /line breaks/);
  assert.throws(() => assertAddressLine('a@example.com\nBcc: b@evil.example', 'To'), /line breaks/);
  assert.throws(() => assertAddressLine('a@example.com>\0', 'To'), /line breaks/);
  assert.throws(() => assertAddressLine('a@ex ample.com', 'To'), /not valid/);

  await assert.rejects(
    sendMail({
      host: '127.0.0.1',
      port: 1,
      from: 'a@example.com',
      to: 'b@example.com\r\nBcc: c@evil.example',
      subject: 's',
      text: 't',
    }),
    /line breaks/,
  );
});

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
