import { inflateRawSync } from 'node:zlib';

/**
 * Read uncompressed text files from a ZIP buffer (stored or deflate).
 * @param {Buffer|Uint8Array} input
 * @returns {Map<string, string>}
 */
export function readZipTextFiles(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('That file is not a ZIP archive');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const files = new Map();

  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length) break;
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.slice(offset + 46, offset + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
    offset += 46 + nameLen + extraLen + commentLen;
    if (!name || name.endsWith('/')) continue;
    if (localOffset + 30 > buf.length) continue;
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = buf.slice(dataStart, dataStart + compSize);
    let raw;
    if (method === 0) raw = compressed;
    else if (method === 8) raw = inflateRawSync(compressed);
    else continue;
    files.set(name, raw.toString('utf8'));
  }

  if (files.size === 0) throw new Error('The ZIP archive has no readable files');
  return files;
}
