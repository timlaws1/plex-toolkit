export const CERTIFICATES = ['U', 'PG', '12', '15', '18'];

const RANK = new Map([
  ['U', 0],
  ['PG', 1],
  ['12', 2],
  ['12A', 2],
  ['15', 3],
  ['18', 4],
  ['R18', 5],
]);

// Plex agents often report US ratings; map conservatively so a cap is never exceeded.
const US_TO_BBFC = new Map([
  ['G', 'U'],
  ['PG', 'PG'],
  ['PG-13', '12'],
  ['R', '18'],
  ['NC-17', '18'],
]);

/**
 * Normalise a Plex contentRating or TMDb certification to a BBFC certificate.
 * @returns {string|null}
 */
export function toBbfc(value) {
  let raw = String(value || '').trim().toUpperCase();
  if (!raw) return null;
  const prefixed = raw.match(/^([A-Z]{2})\/(.+)$/);
  let country = null;
  if (prefixed) {
    country = prefixed[1];
    raw = prefixed[2].trim();
  }
  if (country && country !== 'GB' && country !== 'UK' && country !== 'US') return null;
  if (country !== 'US' && RANK.has(raw)) return raw === '12A' ? '12' : raw;
  if (US_TO_BBFC.has(raw)) return US_TO_BBFC.get(raw);
  return null;
}

/**
 * @param {string|null} cap one of CERTIFICATES; '18' or empty means no cap
 */
export function normaliseCap(cap) {
  const value = String(cap || '').trim().toUpperCase();
  if (!CERTIFICATES.includes(value) || value === '18') return null;
  return value;
}

export function withinCap(certificate, cap) {
  const limit = normaliseCap(cap);
  if (!limit) return true;
  const cert = toBbfc(certificate);
  if (!cert) return false;
  return RANK.get(cert) <= RANK.get(limit);
}
