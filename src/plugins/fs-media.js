import fs from 'node:fs';
import path from 'node:path';

const VIDEO_EXT = new Set([
  '.mp4',
  '.m4v',
  '.mkv',
  '.avi',
  '.mov',
  '.webm',
  '.mpg',
  '.mpeg',
  '.ts',
  '.m2ts',
]);

/**
 * Recursively list video files under folderPath (caller must already guard roots).
 */
export function scanBucketFolder(folderPath) {
  const root = path.resolve(folderPath);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return [];
  }

  const results = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (!VIDEO_EXT.has(ext)) continue;
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      const relativePath = path.relative(root, full).split(path.sep).join('/');
      let durationMs = null;
      if (ext === '.mp4' || ext === '.m4v') {
        durationMs = readMp4DurationMsHost(full);
      }
      results.push({
        relativePath,
        filename: ent.name,
        sizeBytes: st.size,
        mtimeMs: Math.floor(st.mtimeMs),
        durationMs,
      });
    }
  }

  walk(root);
  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return results;
}

export function readMp4DurationMsHost(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    return findMvhdDuration(fd, 0, size, 0);
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function findMvhdDuration(fd, start, end, depth) {
  if (depth > 12 || start >= end) return null;
  let offset = start;
  const header = Buffer.alloc(8);

  while (offset + 8 <= end) {
    fs.readSync(fd, header, 0, 8, offset);
    let boxSize = header.readUInt32BE(0);
    const type = header.toString('ascii', 4, 8);
    let headerLen = 8;

    if (boxSize === 1) {
      if (offset + 16 > end) return null;
      const large = Buffer.alloc(8);
      fs.readSync(fd, large, 0, 8, offset + 8);
      boxSize = Number(large.readBigUInt64BE(0));
      headerLen = 16;
    } else if (boxSize === 0) {
      boxSize = end - offset;
    }

    if (boxSize < headerLen || offset + boxSize > end + 1) {
      return null;
    }

    const contentStart = offset + headerLen;
    const contentEnd = offset + boxSize;

    if (type === 'moov' || type === 'trak' || type === 'mdia') {
      const found = findMvhdDuration(fd, contentStart, contentEnd, depth + 1);
      if (found != null) return found;
    } else if (type === 'mvhd') {
      return parseMvhd(fd, contentStart, contentEnd - contentStart);
    }

    offset += boxSize;
  }
  return null;
}

function parseMvhd(fd, start, length) {
  if (length < 20) return null;
  const buf = Buffer.alloc(Math.min(length, 32));
  fs.readSync(fd, buf, 0, buf.length, start);
  const version = buf[0];
  let timescale;
  let duration;
  if (version === 0) {
    if (buf.length < 20) return null;
    timescale = buf.readUInt32BE(12);
    duration = buf.readUInt32BE(16);
  } else if (version === 1) {
    if (buf.length < 32) return null;
    timescale = buf.readUInt32BE(20);
    const high = buf.readUInt32BE(24);
    const low = buf.readUInt32BE(28);
    duration = high * 0x100000000 + low;
  } else {
    return null;
  }
  if (!timescale) return null;
  return Math.round((duration / timescale) * 1000);
}

export { VIDEO_EXT };
