/**
 * Streaming services people can tell us they subscribe to.
 * `match` is tested against TMDb provider names, which vary by region and over time.
 */
export const STREAMING_SERVICES = [
  { id: 'netflix', label: 'Netflix', match: /^netflix/i },
  { id: 'prime', label: 'Amazon Prime Video', match: /amazon prime video|^prime video/i },
  { id: 'disney', label: 'Disney+', match: /^disney/i },
  { id: 'apple', label: 'Apple TV+', match: /^apple tv(\+| plus)?$/i },
  { id: 'now', label: 'NOW', match: /^now( tv)?( cinema)?$/i },
  { id: 'sky', label: 'Sky Go', match: /^sky( go| store)?$/i },
  { id: 'paramount', label: 'Paramount+', match: /^paramount/i },
  { id: 'iplayer', label: 'BBC iPlayer', match: /iplayer/i },
  { id: 'itvx', label: 'ITVX', match: /^itvx/i },
  { id: 'channel4', label: 'Channel 4', match: /^channel 4|^all 4/i },
  { id: 'my5', label: 'My5', match: /^my5|^channel 5/i },
  { id: 'mubi', label: 'MUBI', match: /^mubi/i },
  { id: 'britbox', label: 'BritBox', match: /^britbox/i },
  { id: 'bfi', label: 'BFI Player', match: /^bfi/i },
  { id: 'lionsgate', label: 'Lionsgate+', match: /^lionsgate/i },
  { id: 'shudder', label: 'Shudder', match: /^shudder/i },
  { id: 'curzon', label: 'Curzon Home Cinema', match: /^curzon/i },
];

/**
 * Provider names (from TMDb) that belong to one of the selected services, labelled for display.
 * @param {string[]} providerNames
 * @param {string[]} selectedIds
 * @returns {string[]}
 */
export function matchSelectedServices(providerNames, selectedIds) {
  const selected = new Set((selectedIds || []).map(String));
  const out = [];
  for (const service of STREAMING_SERVICES) {
    if (!selected.has(service.id)) continue;
    if ((providerNames || []).some((name) => service.match.test(String(name)))) {
      out.push(service.label);
    }
  }
  return out;
}
