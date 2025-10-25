const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const PouchDB = require('pouchdb');
const crypto = require('crypto');
const fetch = require('node-fetch').default;

// --- PouchDB Setup ---
const db = new PouchDB('media_library_cache');
const CACHE_DOC_ID = 'user_library_data';
const LIBRARY_PATHS_DOC_ID = 'library_root_paths';
const METADATA_SETTINGS_DOC_ID = 'metadata_settings';

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
                const show = {
                    id: crypto.randomUUID(),
                    title: item.name,
                    rootPath: itemPath,
                    seasons: [],
                };

                const showItems = fs.readdirSync(itemPath, { withFileTypes: true });
                const seasonMap = new Map();

                showItems.forEach(showItem => {
                    const seasonPath = path.join(itemPath, showItem.name);

                    if (showItem.isDirectory() && showItem.name.toLowerCase().includes('season')) {
                        const seasonTitle = showItem.name;
                        const seasonIndex = parseInt(showItem.name.match(/\d+/)?.[0] || '1', 10) - 1;

                        let season = seasonMap.get(seasonIndex);
                        if (!season) {
                            season = { title: seasonTitle, episodes: [] };
                            seasonMap.set(seasonIndex, season);
                        }
                        
                        const videoFiles = fs.readdirSync(seasonPath).filter(isVideoFile);
                        
                        videoFiles.forEach(videoFile => {
                            season.episodes.push({
                                title: path.parse(videoFile).name,
                                fullPath: path.join(seasonPath, videoFile)
                            });
                        });
                    } else if (showItem.isFile() && isVideoFile(showItem.name)) {
                        const seasonIndex = 0;
                        let season = seasonMap.get(seasonIndex);
                        if (!season) {
                            season = { title: 'Season 1 (Root)', episodes: [] };
                            seasonMap.set(seasonIndex, season);
                        }
                        
                        season.episodes.push({
                            title: path.parse(showItem.name).name,
                            fullPath: seasonPath
                        });
                    }
                });

                show.seasons = Array.from(seasonMap.entries())
                    .sort(([indexA], [indexB]) => indexA - indexB)
                    .map(([, season]) => {
                        season.episodes.sort((a, b) => a.fullPath.localeCompare(b.fullPath));
                        return season;
                    });
                
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

// --- UPDATED: Path Validation Function ---
/**
 * Validates a file path to ensure it’s a valid Windows path and doesn’t contain invalid characters.
 * @param {string} filePath - The path to validate.
 * @returns {boolean} True if valid, false otherwise.
 */
function isValidWindowsPath(filePath) {
    // Check for non-string, empty, or undefined/null paths
    if (!filePath || typeof filePath !== 'string' || filePath.trim() === '') {
        console.warn(`[VALIDATION] Invalid path: ${filePath} (non-string, empty, or undefined)`);
        return false;
    }

    // Normalize path first to handle escaped backslashes (e.g., 'G:\\Anime' -> 'G:\Anime')
    let normalizedPath;
    try {
        normalizedPath = path.normalize(filePath.trim());
    } catch (error) {
        console.warn(`[VALIDATION] Path normalization error for ${filePath}: ${error.message}`);
        return false;
    }

    // Check for invalid Windows characters, excluding valid backslashes and colons in drive letters
    const invalidChars = /[<>|"*?\x00-\x1F]/; // Removed : from invalid chars to allow drive letters (e.g., G:)
    const pathWithoutDrive = normalizedPath.replace(/^[A-Z]:/, ''); // Strip drive letter (e.g., G: -> '')
    if (invalidChars.test(pathWithoutDrive)) {
        const invalidMatches = pathWithoutDrive.match(invalidChars);
        console.warn(`[VALIDATION] Invalid characters in path ${normalizedPath}: ${invalidMatches.join(', ')}`);
        return false;
    }

    // Check for reserved Windows names (e.g., CON, PRN, AUX)
    const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
    const baseName = path.basename(normalizedPath).split('.')[0];
    if (reservedNames.test(baseName)) {
        console.warn(`[VALIDATION] Reserved name in path: ${normalizedPath}`);
        return false;
    }

    // Verify path exists and is a directory
    try {
        const exists = fs.existsSync(normalizedPath);
        if (!exists) {
            console.warn(`[VALIDATION] Path does not exist: ${normalizedPath}`);
            return false;
        }
        const stats = fs.statSync(normalizedPath);
        if (!stats.isDirectory()) {
            console.warn(`[VALIDATION] Path is not a directory: ${normalizedPath}`);
            return false;
        }
        console.log(`[VALIDATION] Path validated successfully: ${normalizedPath}`);
        return true;
    } catch (error) {
        console.warn(`[VALIDATION] Path validation error for ${normalizedPath}: ${error.message}`);
        return false;
    }
}

// --- IPC HANDLERS ---
function registerIpcHandlers() {
    
    // 1. Fetch library cache
    ipcMain.handle('fetch-library-cache', async () => {
        try {
            const doc = await db.get(CACHE_DOC_ID);
            return { success: true, shows: doc.shows || [], message: 'Library cache loaded.' };
        } catch (error) {
            if (error.status === 404) {
                return { success: true, shows: [], message: 'No library cache found.' };
            }
            console.error('[POUCHDB] Fetch Library Cache Error:', error);
            return { success: false, message: error.message };
        }
    });

    // 2. Directory Dialog
    ipcMain.handle('open-directory-dialog', async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
            properties: ['openDirectory']
        });

        if (canceled || filePaths.length === 0) {
            return null;
        }

        return filePaths[0];
    });
    
    // 3. Fetch saved library root paths
    ipcMain.handle('fetch-library-paths', async () => {
        try {
            const doc = await db.get(LIBRARY_PATHS_DOC_ID);
            return { success: true, paths: doc.paths || [] }; 
        } catch (error) {
            if (error.status === 404) {
                return { success: true, paths: [] };
            }
            console.error('[POUCHDB] Fetch Library Paths Error:', error);
            return { success: false, message: error.message };
        }
    });

    // 4. Save library root paths (UPDATED with detailed logging)
    ipcMain.handle('save-library-paths', async (event, paths) => {
        try {
            // Ensure paths is an array
            if (!Array.isArray(paths)) {
                console.error('[POUCHDB] Invalid paths input: not an array', paths);
                return { success: false, message: 'Invalid input: paths must be an array' };
            }

            // Validate all paths
            console.log('[POUCHDB] Validating paths:', paths);
            const validPaths = paths.filter(path => isValidWindowsPath(path));
            if (validPaths.length !== paths.length) {
                const invalidPaths = paths.filter(path => !isValidWindowsPath(path));
                console.warn('[POUCHDB] Invalid paths detected:', invalidPaths);
                return { success: false, message: `Invalid paths detected: ${invalidPaths.join(', ')}` };
            }

            let doc = { _id: LIBRARY_PATHS_DOC_ID, paths: validPaths };

            try {
                const existingDoc = await db.get(LIBRARY_PATHS_DOC_ID);
                doc._rev = existingDoc._rev;
            } catch (error) {
                if (error.status !== 404) {
                    console.error('[POUCHDB] Error fetching existing paths document:', error);
                    return { success: false, message: `Failed to fetch existing paths: ${error.message}` };
                }
            }

            // Attempt to save the document
            await db.put(doc);
            console.log('[POUCHDB] Library paths saved successfully:', validPaths);
            return { success: true };
        } catch (error) {
            console.error('[POUCHDB] Save Library Paths Error:', error);
            // Handle potential database corruption
            if (error.message.includes('MANIFEST') || error.message.includes('IO error')) {
                console.warn('[POUCHDB] Possible database corruption detected. Consider resetting the database.');
                return { success: false, message: `IO error: Possible database corruption. Try resetting the database: ${error.message}` };
            }
            return { success: false, message: `IO error: ${error.message}` };
        }
    });

    // 5. Fetch saved metadata settings
    ipcMain.handle('fetch-metadata-settings', async () => {
        try {
            const doc = await db.get(METADATA_SETTINGS_DOC_ID);
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
                return { success: true, settings: { providers: { anilist: { enabled: false } } } };
            }
            console.error('[POUCHDB] Fetch Metadata Settings Error:', error);
            return { success: false, message: error.message };
        }
    });

    // 6. Save metadata settings
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

    // 7. Anilist Metadata Fetching and Caching
    ipcMain.handle('fetch-and-cache-anilist-metadata', async (event, showTitle) => {
        console.log(`[METADATA] Fetching Anilist metadata for: ${showTitle}`);
        try {
            const query = `
                query ($search: String) {
                    Media(search: $search, type: ANIME) {
                        id
                        title { romaji english }
                        description
                        coverImage { large }
                        genres
                    }
                }
            `;
            const variables = { search: showTitle };
            const response = await fetch('https://graphql.anilist.co', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                body: JSON.stringify({ query, variables })
            });
            const result = await response.json();
            if (result.errors) {
                console.error('[METADATA] Anilist API errors:', result.errors);
                return { success: false, message: `Anilist API error: ${result.errors[0].message}` };
            }
            const media = result.data.Media;
            if (!media) {
                console.warn(`[METADATA] No matching media found for: ${showTitle}`);
                return { success: false, message: `No matching media found for ${showTitle}` };
            }
            const metadata = {
                anilistId: media.id,
                title: media.title.english || media.title.romaji || showTitle,
                description: media.description || 'No description available.',
                coverImage: media.coverImage?.large || 'placeholder_url',
                genres: media.genres || []
            };
            let libraryData;
            try {
                libraryData = await db.get(CACHE_DOC_ID);
            } catch (error) {
                if (error.status !== 404) {
                    console.error('[POUCHDB] Error fetching library cache:', error);
                    return { success: false, message: `Failed to access cache: ${error.message}` };
                }
                libraryData = { _id: CACHE_DOC_ID, shows: [], timestamp: new Date().toISOString() };
            }
            const showIndex = libraryData.shows.findIndex(show => show.title.toLowerCase() === showTitle.toLowerCase());
            if (showIndex !== -1) {
                libraryData.shows[showIndex] = {
                    ...libraryData.shows[showIndex],
                    metadata: { anilist: metadata }
                };
                try {
                    await db.put(libraryData);
                    console.log(`[METADATA] Successfully cached Anilist metadata for ${showTitle}`);
                    return { success: true, metadata };
                } catch (error) {
                    console.error('[POUCHDB] Error saving updated cache:', error);
                    return { success: false, message: `Failed to save metadata: ${error.message}` };
                }
            } else {
                console.warn(`[METADATA] Show ${showTitle} not found in cache`);
                return { success: false, message: `Show ${showTitle} not found in cache` };
            }
        } catch (error) {
            console.error('[METADATA] Fetch error:', error);
            return { success: false, message: `Failed to fetch metadata: ${error.message}` };
        }
    });

    // 8. Scan ALL libraries and cache the results
    ipcMain.handle('scan-and-cache-library', async (event, rootPaths) => {
        try {
            if (!Array.isArray(rootPaths) || rootPaths.length === 0) {
                return { success: false, message: "No library paths provided for scanning." };
            }
            
            let allShows = [];
            
            // Scan each root path and aggregate the results
            for (const rootPath of rootPaths) {
                const showsFromPath = scanDirectory(rootPath);
                allShows.push(...showsFromPath);
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

    // 9. Launch External Player
    ipcMain.handle('launch-external', async (event, filePath) => {
        try {
            const result = await shell.openPath(filePath);
            if (result.startsWith('A path could not be opened')) {
                return { success: false, error: result };
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
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
    registerIpcHandlers();
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