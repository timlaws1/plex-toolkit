import { Impit } from 'impit';

let client;

/**
 * Fetch with a browser TLS fingerprint. Letterboxd's public pages
 * reject the default Node client.
 */
export function browserFetch(url, init) {
  if (!client) {
    client = new Impit({ browser: 'firefox' });
  }
  return client.fetch(url, init);
}
