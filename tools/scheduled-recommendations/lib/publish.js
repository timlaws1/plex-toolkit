import { MANAGED_SUMMARY } from './engine.js';

export async function publishPicks(plex, schedule, picks, ownedKeys, onDestination) {
  const output = schedule.output_type;
  const libraryPicks = picks.filter((pick) => pick.inLibrary && pick.plexRatingKey);
  const streamingCount = picks.length - libraryPicks.length;
  if (!libraryPicks.length) {
    return {
      destinationId: schedule.plex_destination_id,
      added: 0,
      plexCount: 0,
      streamingCount,
      warning: 'No Plex library matches to publish',
    };
  }

  if (output === 'playlist') {
    const destinationId = await syncPlaylist(plex, schedule, libraryPicks, ownedKeys, onDestination);
    return { destinationId, added: libraryPicks.length, plexCount: libraryPicks.length, streamingCount };
  }

  const destinationId = await syncCollection(plex, schedule, libraryPicks, ownedKeys, onDestination);
  return { destinationId, added: libraryPicks.length, plexCount: libraryPicks.length, streamingCount };
}

export async function removePublishedItem(plex, schedule, item) {
  if (!item?.plex_rating_key) return;
  if (schedule.output_type === 'collection' && schedule.plex_destination_id) {
    await plex.removeCollectionItem(schedule.plex_destination_id, item.plex_rating_key);
    return;
  }
  if (schedule.output_type === 'playlist' && schedule.plex_destination_id) {
    const current = await plex.getPlaylistItems(schedule.plex_destination_id);
    const match = current.find((row) => row.ratingKey === item.plex_rating_key && row.playlistItemID);
    if (match) await plex.removePlaylistItem(schedule.plex_destination_id, match.playlistItemID);
  }
}

async function syncCollection(plex, schedule, picks, ownedKeys, onDestination) {
  const desired = picks.map((pick) => String(pick.plexRatingKey));
  let destinationId = schedule.plex_destination_id;
  if (!destinationId) {
    if (!schedule.plex_section_id) throw new Error('Choose a Plex movie library for this collection');
    const created = await plex.createCollection({
      sectionId: schedule.plex_section_id,
      title: schedule.name,
      ratingKeys: [desired[0]],
    });
    destinationId = created.ratingKey;
    onDestination?.(destinationId);
    await plex.addCollectionItems(destinationId, desired.slice(1));
  } else {
    const current = await plex.getCollectionItems(destinationId);
    const present = new Set(current.map((item) => item.ratingKey));
    const owned = new Set(ownedKeys.map(String));
    for (const key of owned) {
      if (!desired.includes(key) && present.has(key)) {
        await plex.removeCollectionItem(destinationId, key);
      }
    }
    const missing = desired.filter((key) => !present.has(key));
    if (missing.length) await plex.addCollectionItems(destinationId, missing);
  }
  await plex.setItemSummary(destinationId, MANAGED_SUMMARY);
  return destinationId;
}

async function syncPlaylist(plex, schedule, picks, ownedKeys, onDestination) {
  const desired = picks.map((pick) => String(pick.plexRatingKey));
  let destinationId = schedule.plex_destination_id;
  if (!destinationId) {
    const created = await plex.createPlaylist({ title: schedule.name, ratingKeys: desired });
    destinationId = created.ratingKey;
    onDestination?.(destinationId);
  } else {
    const current = await plex.getPlaylistItems(destinationId);
    const owned = new Set(ownedKeys.map(String));
    for (const item of current) {
      if (owned.has(item.ratingKey) && item.playlistItemID) {
        await plex.removePlaylistItem(destinationId, item.playlistItemID);
      }
    }
    await plex.addPlaylistItems(destinationId, desired);
  }
  await plex.setItemSummary(destinationId, MANAGED_SUMMARY);
  return destinationId;
}
