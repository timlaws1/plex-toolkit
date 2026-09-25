import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/db/index.js';
import { createSecrets } from '../src/crypto/secrets.js';
import {
  loadMailSettings,
  mailConfigured,
  migrateLegacyMail,
  saveMailSettings,
} from '../src/mail/settings.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-mail-'));
  const db = openDatabase(path.join(dir, 't.sqlite'));
  const secrets = createSecrets(crypto.randomBytes(32));
  return { db, secrets, dir };
}

test('mail settings keep the password when saved blank', () => {
  const { db, secrets, dir } = setup();
  saveMailSettings(db, secrets, { host: 'smtp.example.com', port: '587', user: 'me', pass: 'secret', from: 'a@b.c', to: 'd@e.f' });
  assert.equal(loadMailSettings(db, secrets).pass, 'secret');
  saveMailSettings(db, secrets, { host: 'smtp.example.com', port: '465', user: 'me', pass: '', from: 'a@b.c', to: 'd@e.f' });
  const mail = loadMailSettings(db, secrets);
  assert.equal(mail.pass, 'secret');
  assert.equal(mail.secure, true);
  assert.equal(mailConfigured(mail), true);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('legacy Plex Notifier SMTP settings are copied once', () => {
  const { db, secrets, dir } = setup();
  db.prepare(
    `INSERT INTO plugins (id, name, version, source_type) VALUES ('plex-notifier', 'Plex Notifier', '1.3.3', 'bundled')`,
  ).run();
  const insert = db.prepare('INSERT INTO plugin_settings (plugin_id, key, value) VALUES (?, ?, ?)');
  insert.run('plex-notifier', 'smtpHost', JSON.stringify('mail.old'));
  insert.run('plex-notifier', 'smtpPort', JSON.stringify(2525));
  insert.run('plex-notifier', 'smtpPassword', JSON.stringify(secrets.encrypt('hunter2')));
  insert.run('plex-notifier', 'smtpFrom', JSON.stringify('from@old'));
  insert.run('plex-notifier', 'smtpTo', JSON.stringify('to@old'));

  assert.equal(migrateLegacyMail(db, secrets), true);
  const mail = loadMailSettings(db, secrets);
  assert.equal(mail.host, 'mail.old');
  assert.equal(mail.port, 2525);
  assert.equal(mail.pass, 'hunter2');
  assert.equal(mail.to, 'to@old');
  assert.equal(migrateLegacyMail(db, secrets), false);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
