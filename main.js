const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto'); // ADDED: For guaranteed random UUID fallback
const { initializeApp } = require('firebase/app'); 
const { getAuth, signInWithCustomToken, signInAnonymously } = require('firebase/auth');
const { getFirestore, doc, setDoc, getDoc } = require('firebase/firestore'); // ADDED: getDoc for loading cache

// --- Global Variables (MUST be set by the canvas environment) ---

const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-media-app-id';

// Provide a structural fallback config to avoid 'projectId not provided' error 
const defaultFirebaseConfig = {
    apiKey: "DUMMY_API_KEY",
    authDomain: "DUMMY_AUTH_DOMAIN",
    projectId: "DUMMY-PROJECT-ID",
    storageBucket: "DUMMY_STORAGE_BUCKET",
    messagingSenderId: "DUMMY_SENDER_ID",
    appId: "DUMMY_APP_ID"
};

let firebaseConfig;
try {
    firebaseConfig = (typeof __firebase_config !== 'undefined' && __firebase_config)
        ? JSON.parse(__firebase_config)
        : defaultFirebaseConfig;
} catch (e) {
    console.error("Error parsing __firebase_config (malformed JSON), using default structure.", e);
    firebaseConfig = defaultFirebaseConfig;
}

const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;
// ----------------------------------------------------------------

let db;
let auth;
let userId;

// Promise logic to track when Firebase authentication has completed its initial check
let authPromiseResolve;
const authReadyPromise = new Promise(resolve => {
    authPromiseResolve = resolve;
});

function initializeFirebase() {
    try {
        console.log('Firebase Config used in Main Process:', firebaseConfig);

        const firebaseApp = initializeApp(firebaseConfig);
        db = getFirestore(firebaseApp);
        auth = getAuth(firebaseApp);
        
        // Initial Authentication
        auth.onAuthStateChanged(async (user) => {
            if (user) {
                // SUCCESS PATH
                userId = user.uid;
                console.log('Firebase initialized. User ID:', userId);
            } else {
                try {
                    // ATTEMPT SIGN-IN
                    if (initialAuthToken) {
                        const userCredential = await signInWithCustomToken(auth, initialAuthToken);
                        userId = userCredential.user.uid;
                    } else {
                        const anonUser = await signInAnonymously(auth);
                        userId = anonUser.user.uid;
                    }
                } catch (error) {
                    // FAILURE PATH (Expected with dummy config)
                    console.error('Firebase Auth Error (Expected with dummy config):', error.message);
                }
            }
            
            // GUARANTEE USER ID: If all auth attempts failed, assign a random UUID
            if (!userId) {
                userId = crypto.randomUUID();
                console.warn('Authentication failed; using randomly generated User ID:', userId);
            }
            
            authPromiseResolve(true); // Signal completion
        });

    } catch (error) {
        console.error('Failed to initialize Firebase in main process:', error);
        
        // GUARANTEE USER ID on init failure too
        if (!userId) {
            userId = crypto.randomUUID();
        }
        authPromiseResolve(false); // Signal completion with failure
    }
}

// --- Library Scanning Logic ---

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

    // 0. Fetch initial library cache (Renderer -> Main -> Firestore)
    ipcMain.handle('fetch-library-cache', async () => {
        await authReadyPromise; // Wait for the ID to be guaranteed
        
        if (!db || !userId) {
            return { shows: [], message: 'Database/Auth not available.' };
        }
        
        // NEW CHECK: Skip fetching if in dummy mode
        if (firebaseConfig.projectId === defaultFirebaseConfig.projectId) {
            console.warn('[DUMMY MODE]: Skipping Firestore read to avoid permission errors.');
            return { shows: [], message: 'Dummy mode: No cache loaded.' };
        }

        try {
            const docRef = doc(db, 'artifacts', appId, 'users', userId, 'library_data', 'library_cache');
            const docSnap = await getDoc(docRef);

            if (docSnap.exists()) {
                console.log('Cache found.');
                return { shows: docSnap.data().shows, message: 'Cache loaded.' };
            } else {
                return { shows: [], message: 'No cache found.' };
            }
        } catch (error) {
            console.error('Error fetching cache:', error);
            return { shows: [], message: `Error loading cache: ${error.message}` };
        }
    });
    
    // 1. Open Directory Dialog (Renderer -> Main)
    ipcMain.handle('open-directory-dialog', async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog(win, {
            properties: ['openDirectory'],
        });
        return canceled ? null : filePaths[0];
    });

    // 2. Scan and Cache Library (Renderer -> Main -> Firestore)
    ipcMain.handle('scan-and-cache-library', async (event, rootPath) => {
        // Wait for the ID to be guaranteed before checking it
        await authReadyPromise; 
        
        if (!userId) {
            return { success: false, message: 'Authentication is not ready or failed.' };
        }
        if (!rootPath) {
            return { success: false, message: 'No path provided.' };
        }

        try {
            console.log(`Starting scan of: ${rootPath}`);
            const libraryData = scanDirectory(rootPath);

            if (libraryData.error) {
                return { success: false, message: libraryData.error };
            }

            const cacheData = {
                lastScanned: Date.now(),
                rootPath: rootPath,
                shows: libraryData.shows
            };
            
            // CHECK ADDED: Only attempt to save to Firestore if NOT using the dummy configuration
            if (firebaseConfig.projectId !== defaultFirebaseConfig.projectId) {
                // Mandatory Firestore Security Rules path: /artifacts/{appId}/users/{userId}/library_data/library_cache
                const docRef = doc(db, 'artifacts', appId, 'users', userId, 'library_data', 'library_cache');
                await setDoc(docRef, cacheData);
                console.log(`Scan complete. ${libraryData.shows.length} shows cached and saved to Firestore.`);
            } else {
                console.warn(`[DUMMY MODE]: Skipping Firestore write to avoid permission errors. Shows available locally.`);
            }

            console.log(`Scan complete. ${libraryData.shows.length} shows found.`);
            // Return the data regardless of whether it was saved to the cloud
            return { success: true, shows: libraryData.shows }; 
        } catch (error) {
            console.error('Library Scanning/Caching Error:', error);
            return { success: false, message: `Database error (check connectivity/config): ${error.message}` };
        }
    });

    // 3. Launch External Player (Renderer -> Main -> Shell)
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
    initializeFirebase();
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
