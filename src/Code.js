const CONFIG = {
  destinationPlaylistTitle: 'Playlist Inbox',
  destinationPlaylistDescription: 'Auto-collected from selected YouTube playlists',
  destinationPlaylistPrivacy: 'private',
  checkIntervalHours: 1,
  // Adding one video costs 50 of the 10,000 daily YouTube API units.
  // Cap each run so a big batch can't use up the whole day's quota at once.
  maxInsertsPerRun: 50,
  // Safety limit for very long playlists (50 videos per page).
  maxVideosPerPlaylist: 5000,
  recentVideosShown: 3
};

const PROP = {
  playlists: 'PLAYLIST_IDS',
  destination: 'DEST_PLAYLIST_ID',
  lastRun: 'LAST_RUN',
  seenChunks: 'SEEN_CHUNKS',
  seenChunkPrefix: 'SEEN_',
  legacySeen: 'SEEN_VIDEOS'
};

// ---------- Web app ----------

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index').setTitle('YouTube Inbox');
}

/** Called from the web UI: each tracked playlist with its title and latest videos. */
function getPlaylistsWithVideos() {
  return getSourcePlaylists_().map(p => {
    try {
      const info = YouTube.Playlists.list('snippet', { id: p.id });
      const title = (info.items && info.items[0] && info.items[0].snippet.title) || p.id;
      const videos = pickRecent(getPlaylistVideos_(p.id), CONFIG.recentVideosShown);
      return { id: p.id, title, videos };
    } catch (e) {
      return { id: p.id, title: p.id, videos: [] };
    }
  });
}

/** Called from the web UI. Existing videos are marked seen so only new uploads come through. */
function addPlaylist(url) {
  const id = extractPlaylistId(url);
  if (!id) return { error: 'Could not find a playlist ID in that URL.' };

  return withLock_(() => {
    const list = getSourcePlaylists_();
    if (list.some(p => p.id === id)) return { error: 'This playlist is already being tracked.' };

    let videos;
    try {
      videos = getPlaylistVideos_(id);
    } catch (e) {
      return { error: 'Could not read that playlist. Is it public or unlisted?' };
    }

    const seen = loadSeen_();
    seen[id] = nextSeenIds(videos.map(v => v.videoId), []);
    saveSeen_(seen);

    list.push({ id, addedAt: new Date().toISOString() });
    saveSourcePlaylists_(list);
    return { success: true, id };
  });
}

/** Called from the web UI. */
function removePlaylist(id) {
  return withLock_(() => {
    saveSourcePlaylists_(getSourcePlaylists_().filter(p => p.id !== id));
    const seen = loadSeen_();
    delete seen[id];
    saveSeen_(seen);
    return { success: true };
  });
}

// ---------- Setup and sync ----------

/** Run once from the editor: creates the inbox playlist and the hourly trigger. */
function setup() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(PROP.destination, getOrCreateDestinationPlaylist_());
  createTrigger_();
  Logger.log('Setup complete. Deploy as a web app and open it to add playlists.');
}

/**
 * Run from the editor to start fresh: everything currently in the followed playlists
 * is marked as seen, so only videos added from now on reach the inbox.
 */
function markAllSeen() {
  withLock_(() => {
    const seen = {};
    getSourcePlaylists_().forEach(({ id }) => {
      seen[id] = nextSeenIds(getPlaylistVideos_(id).map(v => v.videoId), []);
    });
    saveSeen_(seen);
    const total = Object.keys(seen).reduce((n, id) => n + seen[id].length, 0);
    Logger.log(`Marked ${total} video(s) in ${Object.keys(seen).length} playlist(s) as seen.`);
  });
}

/** Runs every hour: copies new videos from each tracked playlist into the inbox. */
function syncPlaylists() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    Logger.log('Another sync is still running; skipping this one.');
    return;
  }
  try {
    const props = PropertiesService.getScriptProperties();
    let destPlaylistId = props.getProperty(PROP.destination);
    if (!destPlaylistId) {
      destPlaylistId = getOrCreateDestinationPlaylist_();
      props.setProperty(PROP.destination, destPlaylistId);
    }

    // 1.0 stored no SEEN_CHUNKS; its history only covers the first 50 items of each playlist.
    const migrating = !props.getProperty(PROP.seenChunks);
    const seen = loadSeen_();
    let insertsLeft = CONFIG.maxInsertsPerRun;
    let quotaHit = false;
    let totalAdded = 0;

    getSourcePlaylists_().forEach(({ id: sourceId }) => {
      let videos;
      try {
        videos = getPlaylistVideos_(sourceId);
      } catch (e) {
        Logger.log(`Could not read playlist ${sourceId}: ${e.message}`);
        // Keep its seen list, except a 1.0 list: drop it so the next run takes a fresh baseline.
        if (migrating) delete seen[sourceId];
        return;
      }

      const available = videos.filter(v => !isUnavailable(v));
      const newIds = videosToAdd(available.map(v => v.videoId), seen[sourceId], migrating);
      const deferred = [];

      newIds.forEach(videoId => {
        if (quotaHit || insertsLeft <= 0) {
          deferred.push(videoId);
          return;
        }
        try {
          YouTube.PlaylistItems.insert(
            { snippet: { playlistId: destPlaylistId, resourceId: { kind: 'youtube#video', videoId } } },
            'snippet'
          );
          insertsLeft--;
          totalAdded++;
          Utilities.sleep(300);
        } catch (e) {
          if (isQuotaError(e)) {
            quotaHit = true;
            deferred.push(videoId);
          } else {
            // e.g. the video was made private between listing and inserting: skip it for good
            Logger.log(`Skipped ${videoId}: ${e.message}`);
          }
        }
      });

      seen[sourceId] = nextSeenIds(videos.map(v => v.videoId), deferred);
    });

    saveSeen_(seen);
    props.setProperty(PROP.lastRun, new Date().toISOString());
    Logger.log(`Sync complete. Added ${totalAdded} video(s).${quotaHit ? ' Daily quota reached; the rest will follow.' : ''}`);
  } finally {
    lock.releaseLock();
  }
}

// ---------- Storage ----------

function getSourcePlaylists_() {
  const raw = PropertiesService.getScriptProperties().getProperty(PROP.playlists);
  return raw ? JSON.parse(raw) : [];
}

function saveSourcePlaylists_(list) {
  PropertiesService.getScriptProperties().setProperty(PROP.playlists, JSON.stringify(list));
}

/**
 * Seen videos are stored as { playlistId: [videoId, ...] }, split across as many
 * properties as needed (each value is capped at 9 KB). The first version kept one
 * map with titles in a single property, which stopped working after ~60–80 videos;
 * it is migrated here on first read.
 */
function loadSeen_() {
  const props = PropertiesService.getScriptProperties();
  const count = Number(props.getProperty(PROP.seenChunks) || 0);
  if (count > 0) {
    let json = '';
    for (let i = 0; i < count; i++) json += props.getProperty(PROP.seenChunkPrefix + i) || '';
    return JSON.parse(json);
  }
  const legacy = props.getProperty(PROP.legacySeen);
  return legacy ? migrateLegacySeen(JSON.parse(legacy)) : {};
}

function saveSeen_(seen) {
  const props = PropertiesService.getScriptProperties();
  const oldCount = Number(props.getProperty(PROP.seenChunks) || 0);
  const chunks = splitIntoChunks(JSON.stringify(seen), CHUNK_SIZE);

  const values = { [PROP.seenChunks]: String(chunks.length) };
  chunks.forEach((chunk, i) => { values[PROP.seenChunkPrefix + i] = chunk; });
  props.setProperties(values);

  for (let i = chunks.length; i < oldCount; i++) props.deleteProperty(PROP.seenChunkPrefix + i);
  props.deleteProperty(PROP.legacySeen);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ---------- YouTube ----------

function createTrigger_() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'syncPlaylists') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncPlaylists').timeBased().everyHours(CONFIG.checkIntervalHours).create();
}

function getOrCreateDestinationPlaylist_() {
  const existingId = findPlaylistByTitle_(CONFIG.destinationPlaylistTitle);
  if (existingId) return existingId;
  const response = YouTube.Playlists.insert(
    {
      snippet: { title: CONFIG.destinationPlaylistTitle, description: CONFIG.destinationPlaylistDescription },
      status: { privacyStatus: CONFIG.destinationPlaylistPrivacy }
    },
    'snippet,status'
  );
  return response.id;
}

function findPlaylistByTitle_(title) {
  let pageToken = null;
  do {
    const response = YouTube.Playlists.list('snippet', { mine: true, maxResults: 50, pageToken });
    for (const item of response.items || []) {
      if (item.snippet && item.snippet.title === title) return item.id;
    }
    pageToken = response.nextPageToken;
  } while (pageToken);
  return null;
}

/**
 * Reads the WHOLE playlist. The first version read only the first 50 items, so on
 * playlists that add new videos at the end, anything past position 50 was never seen.
 * Each page costs 1 quota unit.
 */
function getPlaylistVideos_(playlistId) {
  const videos = [];
  let pageToken = null;
  do {
    const response = YouTube.PlaylistItems.list('snippet', { playlistId, maxResults: 50, pageToken });
    (response.items || []).forEach(item => {
      const snippet = item.snippet || {};
      videos.push({
        videoId: snippet.resourceId && snippet.resourceId.videoId,
        title: snippet.title || '',
        publishedAt: snippet.publishedAt || ''
      });
    });
    pageToken = response.nextPageToken;
  } while (pageToken && videos.length < CONFIG.maxVideosPerPlaylist);
  return videos;
}
