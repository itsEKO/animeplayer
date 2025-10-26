const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const PouchDB = require('pouchdb');
const crypto = require('crypto');
// Removed static fetch import to avoid potential resolution issues
// MINIMAL CHANGE: Added placeholder import for FFmpeg library
const ffmpeg = require('fluent-ffmpeg'); 

// --- PouchDB Setup ---

// PouchDB will store the database files in the Electron application's user data directory.
const db = new PouchDB('media_library_cache');
const CACHE_DOC_ID = 'user_library_data'; // Document ID for the library structure (shows/episodes)
const LIBRARY_PATHS_DOC_ID = 'library_root_paths'; // Document ID for the list of root paths
const METADATA_SETTINGS_DOC_ID = 'metadata_settings'; // NEW: Document ID for metadata configuration settings

console.log('[POUCHDB] Database initialized in:', app.getPath('userData'));

// --- Library Scanning Logic ---

const VIDEO_EXTENSIONS = ['.mkv', '.mp4', '.avi', '.webm', '.mov', '.flv'];

function isVideoFile(file) {
    const ext = path.extname(file).toLowerCase();
    return VIDEO_EXTENSIONS.includes(ext);
}

/**
 * Recursively scans a directory path to build the show > season > episode structure.
 * @param {string} rootPath - The path to scan.
 * @returns {Array<object>} An array of show objects.
 */
function scanDirectory(rootPath) {
    const shows = [];
    const files = fs.readdirSync(rootPath, { withFileTypes: true });

    for (const file of files) {
        const fullPath = path.join(rootPath, file.name);

        if (file.isDirectory()) {
            // Assume top-level directory is a SHOW (e.g., 'Attack on Titan')
            const showTitle = file.name;
            const showId = crypto.createHash('sha256').update(showTitle).digest('hex');
            const show = {
                id: showId,
                title: showTitle,
                rootPath: fullPath,
                seasons: []
            };

            const showFiles = fs.readdirSync(fullPath, { withFileTypes: true });

            let seasonIndex = 0; // Tracks the sequential season number found
            for (const showFile of showFiles) {
                const seasonPath = path.join(fullPath, showFile.name);

                // Look for 'Season XX' or treat the directory as a simple season container
                if (showFile.isDirectory()) {
                    const seasonName = showFile.name;
                    const episodes = [];

                    const episodeFiles = fs.readdirSync(seasonPath, { withFileTypes: true });
                    
                    for (const episodeFile of episodeFiles) {
                        if (episodeFile.isFile() && isVideoFile(episodeFile.name)) {
                            episodes.push({
                                id: crypto.createHash('sha256').update(episodeFile.name).digest('hex'),
                                title: path.parse(episodeFile.name).name, // Name without extension
                                fullPath: path.normalize(path.join(seasonPath, episodeFile.name)),
                                currentTime: 0, // Playback tracking
                                duration: 0, // Playback tracking
                                isWatched: false // Playback tracking
                            });
                        }
                    }

                    if (episodes.length > 0) {
                        episodes.sort((a, b) => a.title.localeCompare(b.title)); // Sort episodes alphabetically/numerically
                        
                        show.seasons.push({
                            title: seasonName,
                            episodes: episodes
                        });
                        seasonIndex++;
                    }
                }
            }
            
            // If no clear season subfolders were found, check the root show folder for episodes directly
            if (show.seasons.length === 0) {
                const directEpisodes = [];
                const directFiles = fs.readdirSync(fullPath, { withFileTypes: true });
                
                for (const directFile of directFiles) {
                    if (directFile.isFile() && isVideoFile(directFile.name)) {
                        directEpisodes.push({
                            id: crypto.createHash('sha256').update(directFile.name).digest('hex'),
                            title: path.parse(directFile.name).name,
                            fullPath: path.normalize(path.join(fullPath, directFile.name)),
                            currentTime: 0,
                            duration: 0,
                            isWatched: false
                        });
                    }
                }
                
                if (directEpisodes.length > 0) {
                    directEpisodes.sort((a, b) => a.title.localeCompare(b.title));
                    show.seasons.push({
                        title: 'Season 1', // Default season title
                        episodes: directEpisodes
                    });
                }
            }


            if (show.seasons.length > 0) {
                 // Sort seasons by title (e.g., "Season 1", "Season 2")
                show.seasons.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }));
                shows.push(show);
            }
        }
    }

    return shows;
}


// --- POUCHDB HELPER FUNCTIONS ---

/**
 * Fetches an existing PouchDB document or returns a default empty document.
 * @param {string} docId - The ID of the document to fetch.
 * @param {object} defaultDoc - The default object to return if the document is not found.
 * @returns {object} The fetched or default document object.
 */
async function getOrCreateDoc(docId, defaultDoc) {
    try {
        const doc = await db.get(docId);
        return doc;
    } catch (err) {
        if (err.status === 404) {
            return { _id: docId, ...defaultDoc };
        }
        throw err;
    }
}

// --- IPC HANDLERS ---

function registerIpcHandlers() {
    
    // 1. Directory Dialog
    ipcMain.handle('open-directory-dialog', async (event) => {
        const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
            properties: ['openDirectory']
        });

        if (canceled) {
            return null;
        } else {
            return filePaths;
        }
    });

    // 2. Fetch saved library root paths
    ipcMain.handle('fetch-library-paths', async () => {
        try {
            const doc = await getOrCreateDoc(LIBRARY_PATHS_DOC_ID, { paths: [] });
            return { success: true, paths: doc.paths };
        } catch (error) {
            console.error('[POUCHDB] Error fetching library paths:', error);
            return { success: false, message: error.message };
        }
    });

    // 3. Save library root paths
    ipcMain.handle('save-library-paths', async (event, paths) => {
        try {
            const doc = await getOrCreateDoc(LIBRARY_PATHS_DOC_ID, { paths: [] });
            doc.paths = paths;
            await db.put(doc);
            return { success: true };
        } catch (error) {
            console.error('[POUCHDB] Error saving library paths:', error);
            return { success: false, message: error.message };
        }
    });
    
    // 4. NEW: Fetch saved metadata settings
    ipcMain.handle('fetch-metadata-settings', async () => {
        const defaultSettings = { 
            providers: { anilist: { enabled: false, apiKey: '' } } 
        };
        try {
            const doc = await getOrCreateDoc(METADATA_SETTINGS_DOC_ID, { settings: defaultSettings });
            // Merge defaults in case new settings have been added since the last save
            const mergedSettings = {
                ...defaultSettings,
                ...doc.settings,
                providers: {
                    ...defaultSettings.providers,
                    ...doc.settings.providers
                }
            };
            return { success: true, settings: mergedSettings };
        } catch (error) {
            console.error('[POUCHDB] Error fetching metadata settings:', error);
            return { success: false, message: error.message };
        }
    });

    // 5. NEW: Save metadata settings
    ipcMain.handle('save-metadata-settings', async (event, settings) => {
        try {
            const doc = await getOrCreateDoc(METADATA_SETTINGS_DOC_ID, { settings: {} });
            doc.settings = settings;
            await db.put(doc);
            return { success: true };
        } catch (error) {
            console.error('[POUCHDB] Error saving metadata settings:', error);
            return { success: false, message: error.message };
        }
    });
    
    // 6. NEW: Fetch and cache Anilist metadata
    ipcMain.handle('fetch-and-cache-anilist-metadata', async (event, showTitle) => {
        // This is a minimal implementation. A full version would involve:
        // 1. Calling the Anilist GraphQL API (e.g., using node-fetch).
        // 2. Parsing the response for key data (description, cover image, etc.).
        // 3. Finding the corresponding show in the local cache document.
        // 4. Updating that show's anilistMetadata property in PouchDB.

        // Placeholder logic:
        try {
             // 1. Get the current library cache
            const cacheDoc = await getOrCreateDoc(CACHE_DOC_ID, { shows: [] });
            
            // 2. Find the show to update
            const showToUpdate = cacheDoc.shows.find(s => s.title === showTitle);

            if (showToUpdate) {
                // FAKE API CALL DELAY
                await new Promise(resolve => setTimeout(resolve, 500)); 

                // Inject placeholder data
                showToUpdate.anilistMetadata = {
                    fetched: new Date().toISOString(),
                    description: `This is placeholder metadata for ${showTitle}. The real data would come from the Anilist API.`,
                    coverImage: 'https://via.placeholder.com/300x450.png?text=Cover+Image' // Fake cover URL
                };

                // 3. Save the updated cache document
                await db.put(cacheDoc);

                return { success: true, message: `Successfully faked metadata update for ${showTitle}` };
            } else {
                 return { success: false, message: `Show ${showTitle} not found in current library cache.` };
            }

        } catch (error) {
             console.error('[ANILIST] Error during fake metadata fetch:', error);
             return { success: false, message: `Fake metadata fetch failed: ${error.message}` };
        }
    });


    // 7. NEW: Fetch library cache
    ipcMain.handle('fetch-library-cache', async () => {
        try {
            const doc = await getOrCreateDoc(CACHE_DOC_ID, { shows: [] });
            return { success: true, shows: doc.shows, message: 'Local cache loaded.' };
        } catch (error) {
            console.error('[POUCHDB] Error fetching library cache:', error);
            return { success: false, shows: [], message: error.message };
        }
    });

    // 8. UPDATED: Scan ALL libraries and cache the results
    ipcMain.handle('scan-and-cache-library', async (event, rootPaths) => {
        let allShows = [];
        try {
            // Get the current cache to preserve playback progress and metadata
            const cacheDoc = await getOrCreateDoc(CACHE_DOC_ID, { shows: [] });
            const existingShows = cacheDoc.shows;

            for (const rootPath of rootPaths) {
                if (fs.existsSync(rootPath)) {
                    allShows = allShows.concat(scanDirectory(rootPath));
                }
            }
            
            // Merge existing progress/metadata into the new scan results
            const mergedShows = allShows.map(newShow => {
                const existing = existingShows.find(e => e.id === newShow.id);
                if (existing) {
                    // Deep merge episodes to preserve currentTime and isWatched
                    newShow.seasons = newShow.seasons.map(newSeason => {
                        const existingSeason = existing.seasons.find(eS => eS.title === newSeason.title);
                        if (existingSeason) {
                            newSeason.episodes = newSeason.episodes.map(newEpisode => {
                                const existingEpisode = existingSeason.episodes.find(eE => eE.id === newEpisode.id);
                                if (existingEpisode) {
                                    return {
                                        ...newEpisode,
                                        currentTime: existingEpisode.currentTime || 0,
                                        duration: existingEpisode.duration || 0,
                                        isWatched: existingEpisode.isWatched || false
                                    };
                                }
                                return newEpisode;
                            });
                        }
                        return newSeason;
                    });
                    
                    // Preserve metadata from the existing show
                    newShow.anilistMetadata = existing.anilistMetadata || null;
                }
                return newShow;
            });


            // Update cache document and save
            cacheDoc.shows = mergedShows;
            await db.put(cacheDoc);

            return { success: true, shows: mergedShows };

        } catch (error) {
            console.error('[SCAN] Error during library scan or cache update:', error);
            return { success: false, message: `Scan failed: ${error.message}` };
        }
    });
    
    // 9. NEW: Save Playback Progress (Renderer -> Main -> PouchDB)
    ipcMain.handle('save-playback-progress', async (event, showId, episodeId, currentTime, duration, isFinished) => {
        try {
            const cacheDoc = await getOrCreateDoc(CACHE_DOC_ID, { shows: [] });
            
            const show = cacheDoc.shows.find(s => s.id === showId);
            
            if (show) {
                let episodeFound = false;
                
                // Deep search for the episode
                for (const season of show.seasons) {
                    const episode = season.episodes.find(e => e.id === episodeId);
                    if (episode) {
                        // Update progress data
                        episode.currentTime = currentTime;
                        episode.duration = duration;
                        
                        // Mark as watched if finished (or 95% of the way through)
                        if (isFinished || (duration > 0 && currentTime >= duration * 0.95)) {
                            episode.isWatched = true;
                        } else if (currentTime > 60) {
                            // If user is >60 seconds in, it's considered started/in-progress
                            episode.isWatched = false; 
                        } else {
                            // Less than 60 seconds is essentially unwatched
                            episode.isWatched = false;
                        }

                        episodeFound = true;
                        break;
                    }
                }
                
                if (episodeFound) {
                    // Save the updated cache document
                    await db.put(cacheDoc);
                    return { success: true };
                } else {
                    return { success: false, message: `Episode with ID ${episodeId} not found.` };
                }
            } else {
                return { success: false, message: `Show with ID ${showId} not found.` };
            }
        } catch (error) {
            console.error('[POUCHDB] Error saving playback progress:', error);
            return { success: false, message: `PouchDB error: ${error.message}` };
        }
    });
}

// --- Window Creation (Unchanged) ---

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        frame: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    win.loadFile('index.html');
    // win.webContents.openDevTools(); // Uncomment for debugging
}

// --- App Lifecycle (Unchanged) ---

app.whenReady().then(() => {
    registerIpcHandlers(); // Register handlers before window creation
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});