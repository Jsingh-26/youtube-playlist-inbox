/**
 * Pure logic with no Apps Script calls, so it runs (and is tested) in Node too.
 * In Apps Script every file shares one global scope, so Code.js calls these directly.
 */

/** Script Properties allow 9 KB per value; stay safely under it. */
const CHUNK_SIZE = 8000;

/** Titles YouTube returns for videos that can no longer be added to a playlist. */
const UNAVAILABLE_TITLES = ['Private video', 'Deleted video'];

/**
 * Returns the playlist ID from a playlist URL, a watch URL with &list=, or a bare ID.
 * Returns null when nothing usable is found.
 */
function extractPlaylistId(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  const match = text.match(/[?&]list=([A-Za-z0-9_-]+)/);
  if (match) return match[1];
  if (/^[A-Za-z0-9_-]{10,}$/.test(text)) return text;
  return null;
}

/** IDs in `currentIds` that are not in `seenIds`, in playlist order, without duplicates. */
function findNewVideoIds(currentIds, seenIds) {
  const seen = new Set(seenIds);
  const result = [];
  for (const id of currentIds) {
    if (id && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

/**
 * Videos to add on this run. With no reliable history (a playlist with no seen list,
 * or the first run after migrating from 1.0, which only ever saw the first 50 items),
 * every video counts as already seen: older videos must not flood the inbox.
 */
function videosToAdd(currentIds, seenIds, needsBaseline) {
  if (needsBaseline || !seenIds) return [];
  return findNewVideoIds(currentIds, seenIds);
}

/**
 * The seen list to store after a run: every video currently in the source playlist,
 * except the ones still waiting to be added (so the next run picks them up).
 * Videos that left the source playlist drop out, which keeps storage bounded by
 * the size of the playlists being tracked instead of growing forever.
 */
function nextSeenIds(currentIds, deferredIds) {
  const deferred = new Set(deferredIds);
  return Array.from(new Set(currentIds.filter(id => id && !deferred.has(id))));
}

/** True for a video YouTube will refuse to add (private or deleted). */
function isUnavailable(video) {
  return !video || !video.videoId || UNAVAILABLE_TITLES.includes(video.title);
}

/** True when an error from the YouTube service means the daily quota is used up. */
function isQuotaError(error) {
  const message = String((error && error.message) || error || '');
  return /quota/i.test(message);
}

/** Splits a string into pieces no longer than `size`. An empty string gives no pieces. */
function splitIntoChunks(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

/**
 * Converts the storage format of the first version (one SEEN_VIDEOS map of
 * videoId -> { title, sourcePlaylistId, ... }) into { playlistId: [videoId, ...] }.
 */
function migrateLegacySeen(legacyMap) {
  const byPlaylist = {};
  Object.keys(legacyMap || {}).forEach(videoId => {
    const playlistId = legacyMap[videoId] && legacyMap[videoId].sourcePlaylistId;
    if (!playlistId) return;
    (byPlaylist[playlistId] = byPlaylist[playlistId] || []).push(videoId);
  });
  return byPlaylist;
}

/** True when an ISO timestamp falls inside [startIso, endIso]. */
function isInWindow(timestamp, startIso, endIso) {
  const t = Date.parse(timestamp);
  return !Number.isNaN(t) && t >= Date.parse(startIso) && t <= Date.parse(endIso);
}

/** The `count` videos most recently added to a playlist (by the time they were added). */
function pickRecent(videos, count) {
  return videos
    .filter(v => !isUnavailable(v))
    .slice()
    .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))
    .slice(0, count);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CHUNK_SIZE,
    extractPlaylistId,
    findNewVideoIds,
    videosToAdd,
    nextSeenIds,
    isUnavailable,
    isQuotaError,
    splitIntoChunks,
    migrateLegacySeen,
    isInWindow,
    pickRecent
  };
}
