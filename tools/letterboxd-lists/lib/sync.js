import { matchFilm } from './library.js';

/**
 * Match list films against each selected library separately, because a Plex
 * collection belongs to one library section.
 * @param {Array<{ title: string, year: number|null, link: string }>} films
 * @param {Array<{ sectionId: string, index: any }>} sections
 */
export function matchList(films, sections) {
  const keysBySection = new Map(sections.map((s) => [s.sectionId, new Set()]));
  const missing = [];
  const ambiguous = [];
  let owned = 0;
  for (const film of films) {
    let found = false;
    let unclear = false;
    for (const { sectionId, index } of sections) {
      const match = matchFilm(index, film);
      if (match.status === 'matched') {
        found = true;
        for (const item of match.items) keysBySection.get(sectionId).add(String(item.ratingKey));
      } else if (match.status === 'ambiguous') {
        unclear = true;
      }
    }
    if (found) owned += 1;
    else if (unclear) ambiguous.push(film);
    else missing.push(film);
  }
  return { keysBySection, missing, ambiguous, owned };
}

/**
 * Items to add and remove so a collection mirrors the list. Only keys this
 * tool added earlier are ever removed, so films added by hand stay.
 * @param {{ matched: string[], managed: string[], current: string[] }} sets
 */
export function planCollection({ matched, managed, current }) {
  const matchedSet = new Set((matched || []).map(String));
  const currentSet = new Set((current || []).map(String));
  const managedList = [...new Set((managed || []).map(String))];
  const add = [...matchedSet].filter((key) => !currentSet.has(key));
  const remove = managedList.filter((key) => currentSet.has(key) && !matchedSet.has(key));
  const keep = managedList.filter((key) => currentSet.has(key) && matchedSet.has(key));
  return { add, remove, managed: [...new Set([...keep, ...add])] };
}

export function filmKey(film) {
  return film.link || `${String(film.title || '').toLowerCase()}|${film.year ?? ''}`;
}

export function missingSignature(missing) {
  return (missing || []).map(filmKey).sort().join('\n');
}
