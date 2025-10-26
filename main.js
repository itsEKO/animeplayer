const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const PouchDB = require('pouchdb');
const crypto = require('crypto');
// Removed static fetch import to avoid potential resolution issues

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
    
    try {
        const items = fs.readdirSync(rootPath, { withFileTypes: true });

        items.forEach(item => {
            const itemPath = path.join(rootPath, item.name);
            
            if (item.isDirectory()) {
                // Treat each top-level directory as a 'Show'
                const show = {
                    id: crypto.randomUUID(), // Unique ID for the show
                    title: item.name,
                    rootPath: itemPath, // Path to the show directory
                    seasons: [],
                };

                const showItems = fs.readdirSync(itemPath, { withFileTypes: true });
                const seasonMap = new Map();

                showItems.forEach(showItem => {
                    const seasonPath = path.join(itemPath, showItem.name);

                    if (showItem.isDirectory() && showItem.name.toLowerCase().includes('season')) {
                        // Directory is explicitly named 'Season X'
                        const seasonTitle = showItem.name;
                        const seasonIndex = parseInt(showItem.name.match(/\d+/)?.[0] || '1', 10) - 1; // Extract season number

                        let season = seasonMap.get(seasonIndex);
                        if (!season) {
                            season = { title: seasonTitle, episodes: [] };
                            seasonMap.set(seasonIndex, season);
                        }
                        
                        // Scan for videos inside the season directory
                        const videoFiles = fs.readdirSync(seasonPath).filter(isVideoFile);
                        
                        videoFiles.forEach(videoFile => {
                            season.episodes.push({
                                title: path.parse(videoFile).name,
                                fullPath: path.join(seasonPath, videoFile)
                            });
                        });
                    } else if (showItem.isFile() && isVideoFile(showItem.name)) {
                        // Video file directly under the show folder (assume Season 1)
                        const seasonIndex = 0;
                        let season = seasonMap.get(seasonIndex);
                        if (!season) {
                            season = { title: 'Season 1 (Root)', episodes: [] };
                            seasonMap.set(seasonIndex, season);
                        }
                        
                        season.episodes.push({
                            title: path.parse(showItem.name).name,
                            fullPath: seasonPath // seasonPath is actually the file path here
                        });
                    }
                });

                // Convert map to array and sort by index
                show.seasons = Array.from(seasonMap.entries())
                    .sort(([indexA], [indexB]) => indexA - indexB)
                    .map(([, season]) => {
                        // Sort episodes by filename (useful for correct episode order)
                        season.episodes.sort((a, b) => a.fullPath.localeCompare(b.fullPath));
                        return season;
                    });
                
                // Only add show if it has seasons/episodes
                if (show.seasons.length > 0) {
                    shows.push(show);
                }

            }
        });
    } catch (error) {
        console.error(`Error scanning path ${rootPath}:`, error);
    }

    return shows;
}

// --- IPC HANDLERS ---

function registerIpcHandlers() {
    
    // 1. Directory Dialog (Unchanged)
    ipcMain.handle('open-directory-dialog', async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
            properties: ['openDirectory']
        });

        if (canceled || filePaths.length === 0) {
            return null;
        }

        return filePaths[0];
    });
    
    // 2. Fetch saved library root paths (Unchanged)
    ipcMain.handle('fetch-library-paths', async () => {
        try {
            const doc = await db.get(LIBRARY_PATHS_DOC_ID);
            // paths: Array<string>
            return { success: true, paths: doc.paths || [] }; 
        } catch (error) {
            if (error.status === 404) {
                // If document is not found, return an empty array and success
                return { success: true, paths: [] };
            }
            console.error('[POUCHDB] Fetch Library Paths Error:', error);
            return { success: false, message: error.message };
        }
    });

    // 3. Save library root paths (Unchanged)
    ipcMain.handle('save-library-paths', async (event, paths) => {
        try {
            let doc = { _id: LIBRARY_PATHS_DOC_ID, paths: paths };

            try {
                // Attempt to get the existing document to grab the revision
                const existingDoc = await db.get(LIBRARY_PATHS_DOC_ID);
                doc._rev = existingDoc._rev;
            } catch (error) {
                // If it doesn't exist (404), _rev remains undefined, and put will create it
            }

            // Save/update the document
            await db.put(doc);
            return { success: true };
        } catch (error) {
            console.error('[POUCHDB] Save Library Paths Error:', error);
            return { success: false, message: error.message };
        }
    });

    // 4. NEW: Fetch saved metadata settings
    ipcMain.handle('fetch-metadata-settings', async () => {
        try {
            const doc = await db.get(METADATA_SETTINGS_DOC_ID);
            // Default structure: { providers: { anilist: { enabled: false } } }
            return { 
                success: true, 
                settings: doc.settings || { 
                    providers: { 
                        anilist: { enabled: false } 
                    } 
                } 
            }; 
        } catch (error) {
            if (error.status === 404) {
                // Default settings if document is not found
                return { success: true, settings: { providers: { anilist: { enabled: false } } } };
            }
            console.error('[POUCHDB] Fetch Metadata Settings Error:', error);
            return { success: false, message: error.message };
        }
    });

    // 5. NEW: Save metadata settings
    ipcMain.handle('save-metadata-settings', async (event, settings) => {
        try {
            let doc = { _id: METADATA_SETTINGS_DOC_ID, settings: settings };

            try {
                const existingDoc = await db.get(METADATA_SETTINGS_DOC_ID);
                doc._rev = existingDoc._rev;
            } catch (error) {
                // Ignore 404
            }

            await db.put(doc);
            return { success: true };
        } catch (error) {
            console.error('[POUCHDB] Save Metadata Settings Error:', error);
            return { success: false, message: error.message };
        }
    });

    // 6. NEW: Fetch and cache Anilist metadata
    ipcMain.handle('fetch-and-cache-anilist-metadata', async (event, showTitle) => {
        console.log(`[METADATA] Fetching Anilist metadata for: ${showTitle}`);
        
        try {
            // Dynamically require node-fetch with error handling
            let fetch;
            try {
                fetch = require('node-fetch');
            } catch (importError) {
                console.error('[METADATA] Failed to load node-fetch:', importError);
                return { success: false, message: `Failed to load node-fetch: ${importError.message}` };
            }
            
            // AniList GraphQL API endpoint
            const ANILIST_API_URL = 'https://graphql.anilist.co';
            
            // GraphQL query to search for anime by title
            const query = `
                query ($search: String) {
                    Media(search: $search, type: ANIME) {
                        id
                        description
                        coverImage { large }
                        genres
                    }
                }
            `;
            
            // Variables for the GraphQL query
            const variables = { search: showTitle };
            
            // Make the API request
            const response = await fetch(ANILIST_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                body: JSON.stringify({ query, variables })
            });
            
            const data = await response.json();
            
            if (data.errors) {
                console.error('[METADATA] AniList API error:', data.errors);
                return { success: false, message: `AniList API error: ${data.errors[0].message}` };
            }
            
            const media = data.data.Media;
            if (!media) {
                console.error('[METADATA] No media found for:', showTitle);
                return { success: false, message: `No media found for ${showTitle}` };
            }
            
            // Extract metadata
            const metadata = {
                anilistId: media.id,
                description: media.description || 'No description available.',
                coverImage: media.coverImage?.large || 'placeholder_url',
                genres: media.genres || []
            };
            
            // Update PouchDB cache with metadata
            try {
                let cacheDoc = await db.get(CACHE_DOC_ID);
                let shows = cacheDoc.shows || [];
                
                // Find the show by title and update its metadata
                const showIndex = shows.findIndex(show => show.title === showTitle);
                if (showIndex !== -1) {
                    shows[showIndex].anilistMetadata = metadata;
                    cacheDoc.shows = shows;
                    await db.put(cacheDoc);
                    console.log(`[METADATA] Successfully cached Anilist metadata for ${showTitle}`);
                } else {
                    console.error(`[METADATA] Show ${showTitle} not found in cache`);
                    return { success: false, message: `Show ${showTitle} not found in cache` };
                }
                
                return { success: true, metadata };
            } catch (error) {
                console.error('[POUCHDB] Error updating cache with metadata:', error);
                return { success: false, message: `PouchDB error: ${error.message}` };
            }
            
        } catch (error) {
            console.error('[METADATA] Error fetching Anilist metadata:', error);
            return { success: false, message: `Failed to fetch metadata: ${error.message}` };
        }
    });

    // 7. NEW: Fetch library cache
    ipcMain.handle('fetch-library-cache', async () => {
        try {
            const doc = await db.get(CACHE_DOC_ID);
            return { success: true, shows: doc.shows || [], message: 'Cache retrieved successfully.' };
        } catch (error) {
            if (error.status === 404) {
                // If cache doesn't exist, return empty shows array
                return { success: true, shows: [], message: 'No cache found.' };
            }
            console.error('[POUCHDB] Fetch Library Cache Error:', error);
            return { success: false, message: error.message };
        }
    });

    // 8. UPDATED: Scan ALL libraries and cache the results
    ipcMain.handle('scan-and-cache-library', async (event, rootPaths) => {
        try {
            if (!Array.isArray(rootPaths) || rootPaths.length === 0) {
                return { success: false, message: "No library paths provided for scanning." };
            }
            
            // START OF MINIMAL CHANGE TO PRESERVE METADATA
            let existingShowsMap = new Map();
            try {
                const existingCacheDoc = await db.get(CACHE_DOC_ID);
                // Create a map from existing shows, using 'title' as the key for fast lookup
                if (existingCacheDoc.shows) {
                    existingCacheDoc.shows.forEach(show => {
                        existingShowsMap.set(show.title, show);
                    });
                }
            } catch (error) {
                // Ignore 404. Map remains empty if no cache exists.
            }
            // END OF MINIMAL CHANGE

            let allShows = [];
            
            // Scan each root path and aggregate the results
            for (const rootPath of rootPaths) {
                const showsFromPath = scanDirectory(rootPath);
                
                // START OF MINIMAL CHANGE TO PRESERVE METADATA
                const mergedShows = showsFromPath.map(newShow => {
                    const existingShow = existingShowsMap.get(newShow.title);
                    
                    // If a cached version exists and has metadata, copy it over to the newly scanned show.
                    if (existingShow && existingShow.anilistMetadata) {
                        newShow.anilistMetadata = existingShow.anilistMetadata;
                    }
                    return newShow;
                });
                // END OF MINIMAL CHANGE
                
                allShows.push(...mergedShows);
            }
            
            const libraryData = {
                shows: allShows,
                timestamp: new Date().toISOString()
            };

            // Prepare the document for saving the library structure
            let newCacheData = { _id: CACHE_DOC_ID, ...libraryData };

            try {
                // Attempt to get the existing document to grab the revision
                const existingDoc = await db.get(CACHE_DOC_ID);
                newCacheData._rev = existingDoc._rev;
            } catch (error) {
                // If it doesn't exist (404), _rev remains undefined, and put will create it
            }

            // Save/update the document in PouchDB
            await db.put(newCacheData);
            
            console.log(`[POUCHDB] Scan complete. ${libraryData.shows.length} shows found and cached locally.`);
            
            // Return the data
            return { success: true, shows: libraryData.shows }; 
        } catch (error) {
            console.error('[POUCHDB] Library Scanning/Caching Error:', error);
            return { success: false, message: `PouchDB error: ${error.message}` };
        }
    });

    // 9. Launch External Player (Renderer -> Main -> Shell) (Unchanged)
    ipcMain.handle('launch-external', async (event, filePath) => {
        try {
            const result = await shell.openPath(filePath);
            if (result.startsWith('A path could not be opened')) {
                return { success: false, error: result };
            }
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });
}

// --- Window Creation ---

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

// --- App Lifecycle ---

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