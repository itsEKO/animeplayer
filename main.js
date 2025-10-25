const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const PouchDB = require('pouchdb'); // ADDED: PouchDB
const crypto = require('crypto'); // Used for original random UUID fallback (now not strictly needed but kept)

// --- PouchDB Setup ---

// PouchDB will store the database files in the Electron application's user data directory.
const db = new PouchDB('media_library_cache');
const CACHE_DOC_ID = 'user_library_data'; // Single document ID for the library cache

console.log('[POUCHDB] Database initialized in:', app.getPath('userData'));

// The original Firebase auth/user ID logic is completely removed as PouchDB is local.
// However, the original structure used a user ID to namespace data (which isn't needed for local PouchDB).
// Since the frontend structure is independent of the DB, we can simplify and proceed.

// --- Library Scanning Logic (Unchanged) ---

// Defines the video file extensions to look for
const VIDEO_EXTENSIONS = ['.mkv', '.mp4', '.avi', '.webm', '.mov', '.flv'];

function isVideoFile(file) {
    const ext = path.extname(file).toLowerCase();
    return VIDEO_EXTENSIONS.includes(ext);
}

/**
 * Recursively scans a directory path to build the show > season > episode structure.
 * @param {string} rootPath - The path where the scanning starts (e.g., C:/Media/TV Shows)
 */
function scanDirectory(rootPath) {
    if (!fs.existsSync(rootPath)) {
        return { error: 'Path does not exist.' };
    }
    
    // Structure: { shows: [ { title: 'Show', rootPath: '/path/to/show', seasons: [ { title: 'Season 01', episodes: [...] } ] } ] }
    const library = { shows: [] };
    
    // Level 1: SHOWS
    const showDirectories = fs.readdirSync(rootPath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory());

    for (const showDir of showDirectories) {
        const showPath = path.join(rootPath, showDir.name);
        // Use a consistent ID generation for show identification
        const show = {
            id: showDir.name.toLowerCase().replace(/[^a-z0-9]/g, '-'), 
            title: showDir.name,
            rootPath: showPath,
            seasons: []
        };
        
        // Level 2: SEASONS
        const seasonDirectories = fs.readdirSync(showPath, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory());
            
        for (const seasonDir of seasonDirectories) {
            // Regex match for common season formats (e.g., "Season 01", "S1", "s01")
            if (!/season|s[0-9]{1,2}/i.test(seasonDir.name)) {
                continue; // Skip folders not named like seasons
            }

            const seasonPath = path.join(showPath, seasonDir.name);
            const season = {
                title: seasonDir.name,
                episodes: []
            };
            
            // Level 3: EPISODES
            const files = fs.readdirSync(seasonPath, { withFileTypes: true })
                .filter(dirent => dirent.isFile() && isVideoFile(dirent.name));
            
            for (const file of files) {
                const episode = {
                    title: file.name.replace(path.extname(file.name), ''), // Use filename as template title
                    fullPath: path.join(seasonPath, file.name)
                };
                season.episodes.push(episode);
            }
            
            if (season.episodes.length > 0) {
                show.seasons.push(season);
            }
        }
        
        if (show.seasons.length > 0) {
            library.shows.push(show);
        }
    }

    return library;
}

// --- Electron Setup ---

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
        },
    });

    win.loadFile('index.html');
    // win.webContents.openDevTools();

    // --- IPC Handlers ---

    // 0. Fetch initial library cache (Renderer -> Main -> PouchDB)
    ipcMain.handle('fetch-library-cache', async () => {
        try {
            // Get the document from PouchDB
            const doc = await db.get(CACHE_DOC_ID);

            console.log('[POUCHDB] Cache found.');
            return { shows: doc.shows, message: 'Cache loaded from PouchDB.' };
        } catch (error) {
            // PouchDB throws a 'missing' error if the document isn't found
            if (error.status === 404) {
                console.log('[POUCHDB] No cache found (404).');
                return { shows: [], message: 'No local PouchDB cache found.' };
            }
            console.error('[POUCHDB] Error fetching cache:', error);
            return { shows: [], message: `Error loading cache from PouchDB: ${error.message}` };
        }
    });
    
    // 1. Open Directory Dialog (Renderer -> Main) (Unchanged)
    ipcMain.handle('open-directory-dialog', async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog(win, {
            properties: ['openDirectory'],
        });
        return canceled ? null : filePaths[0];
    });

    // 2. Scan and Cache Library (Renderer -> Main -> PouchDB)
    ipcMain.handle('scan-and-cache-library', async (event, rootPath) => {
        if (!rootPath) {
            return { success: false, message: 'No path provided.' };
        }

        try {
            console.log(`Starting scan of: ${rootPath}`);
            const libraryData = scanDirectory(rootPath);

            if (libraryData.error) {
                return { success: false, message: libraryData.error };
            }

            // Create the new cache data object
            const newCacheData = {
                _id: CACHE_DOC_ID,
                lastScanned: Date.now(),
                rootPath: rootPath,
                shows: libraryData.shows
            };
            
            // Attempt to get the existing document to include its _rev (for update)
            try {
                const existingDoc = await db.get(CACHE_DOC_ID);
                newCacheData._rev = existingDoc._rev; // Add the revision for update/overwrite
            } catch (e) {
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

    // 3. Launch External Player (Renderer -> Main -> Shell) (Unchanged)
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

// --- App Lifecycle ---

app.whenReady().then(() => {
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