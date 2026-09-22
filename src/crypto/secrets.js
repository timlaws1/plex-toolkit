import crypto from 'node:crypto';
import fs from 'node:fs';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

export function ensureSecretKey(secretKeyPath, envKey) {
  if (envKey && /^[0-9a-fA-F]{64}$/.test(envKey)) {
    return Buffer.from(envKey, 'hex');
  }
  if (fs.existsSync(secretKeyPath)) {
    const raw = fs.readFileSync(secretKeyPath, 'utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      return Buffer.from(raw, 'hex');
    }
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(pathDir(secretKeyPath), { recursive: true });
  fs.writeFileSync(secretKeyPath, key.toString('hex'), { mode: 0o600 });
  return key;
}

function pathDir(filePath) {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return idx >= 0 ? filePath.slice(0, idx) : '.';
}

export function createSecrets(key) {
  return {
    encrypt(plaintext) {
      if (plaintext == null || plaintext === '') return null;
      const iv = crypto.randomBytes(IV_LEN);
      const cipher = crypto.createCipheriv(ALGO, key, iv);
      const enc = Buffer.concat([
        cipher.update(String(plaintext), 'utf8'),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([iv, tag, enc]).toString('base64');
    },
    decrypt(ciphertext) {
      if (!ciphertext) return null;
      const buf = Buffer.from(ciphertext, 'base64');
      const iv = buf.subarray(0, IV_LEN);
      const tag = buf.subarray(IV_LEN, IV_LEN + 16);
      const data = buf.subarray(IV_LEN + 16);
      const decipher = crypto.createDecipheriv(ALGO, key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString(
        'utf8',
      );
    },
    hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
      const hash = crypto
        .scryptSync(password, salt, 64)
        .toString('hex');
      return `${salt}:${hash}`;
    },
    verifyPassword(password, stored) {
      if (!stored || !stored.includes(':')) return false;
      const [salt, hash] = stored.split(':');
      const check = crypto.scryptSync(password, salt, 64).toString('hex');
      try {
        return crypto.timingSafeEqual(
          Buffer.from(hash, 'hex'),
          Buffer.from(check, 'hex'),
        );
      } catch {
        return false;
      }
    },
    randomToken(bytes = 32) {
      return crypto.randomBytes(bytes).toString('hex');
    },
  };
}

export function maskToken(token) {
  if (!token) return '';
  if (token.length <= 8) return '••••••••';
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}
