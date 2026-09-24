import path from 'node:path';

export function absoluteItemPath(folderPath, relativePath) {
  return path.resolve(folderPath, ...String(relativePath).split('/'));
}

export function isBrowserPreviewable(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  return ext === '.mp4' || ext === '.m4v' || ext === '.webm';
}

export function contentTypeFor(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.mp4' || ext === '.m4v') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mkv') return 'video/x-matroska';
  return 'application/octet-stream';
}
