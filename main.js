const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path =require('path');
const fs = require('fs');
const PouchDB = require('pouchdb');
const crypto = require('crypto');
// Removed static fetch import to avoid potential resolution issues
const ffmpeg = require('fluent-ffmpeg'); // MINIMAL CHANGE A: Import fluent-ffmpeg

// MINIMAL CHANGE B (FIXED): Import ffmpeg-static, ffprobe-static, and configure paths
const ffmpegStatic = require('ffmpeg-static'); 
// 🔥 FIX: Explicitly import ffprobe-static
const ffprobeStatic = require('ffprobe-static'); 

ffmpeg.setFfmpegPath(ffmpegStatic); 
ffmpeg.setFfprobePath(ffprobeStatic.path); // <--- FIX 2: Resolves "Cannot find ffprobe"

// MINIMAL CHANGE C: Added new imports for streaming
const http = require('http'); 
const { parse } = require('url');

// --- Global Streaming Setup ---
const STREAMING_PORT = 8080; 
let currentlyStreamingPath = null;
let ffmpegProcess = null;

// --- PouchDB Setup ---

// PouchDB will store the database files in the Electron application's user data directory.
const db = new PouchDB('media_library_cache');
const CACHE_DOC_ID = 'user_library_data'; // Document ID for the library structure (shows/episodes)
const LIBRARY_PATHS_DOC_ID = 'library_root_paths'; // Document ID for the list of root paths
const METADATA_SETTINGS_DOC_ID = 'metadata_settings'; // NEW: Document ID for metadata configuration settings

console.log('[POUCHDB] Database initialized in:', app.getPath('userData'));

// --- Library Scanning Logic (Unchanged) ---

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
                            // --- START: Added tracking fields and ID
                            const fullPath = path.join(seasonPath, videoFile);
                            season.episodes.push({
                                id: crypto.randomUUID(), 
                                title: path.parse(videoFile).name,
                                fullPath: fullPath,
                                currentTime: 0, 
                                duration: 0,    
                                isWatched: false 
                            });
                            // --- END: Added tracking fields and ID
                        });
                    } else if (showItem.isFile() && isVideoFile(showItem.name)) {
                        // Video file directly under the show folder (assume Season 1)
                        const seasonIndex = 0;
                        let season = seasonMap.get(seasonIndex);
                        if (!season) {
                            season = { title: 'Season 1 (Root)', episodes: [] };
                            seasonMap.set(seasonIndex, season);
                        }
                        
                        // --- START: Added tracking fields and ID
                        const fullPath = seasonPath; // seasonPath is actually the file path here
                        season.episodes.push({
                            id: crypto.randomUUID(),
                            title: path.parse(showItem.name).name,
                            fullPath: fullPath,
                            currentTime: 0, 
                            duration: 0,    
                            isWatched: false 
                        });
                        // --- END: Added tracking fields and ID
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

// --- MINIMAL CHANGE D: FFmpeg Stream Server (MODIFIED AND FIXED FOR STABILITY) ---

function startStreamingServer() {
    // If a server is already running, skip starting another one
    if (this.server) {
        return;
    }
    
    // Create the HTTP server
    this.server = http.createServer((req, res) => {
        const { pathname } = parse(req.url, true);

        // Only handle requests to the /stream endpoint
        if (pathname === '/stream' && currentlyStreamingPath) {
            
            // Capture the path for use inside the ffprobe callback
            const filePath = currentlyStreamingPath;

            // --- START: MODIFIED SECTION (FIXED STREAMING CRASH) ---
            // Run ffprobe to get media metadata, including all audio streams
            ffmpeg.ffprobe(filePath, (err, metadata) => {
                if (err) {
                    console.error('[FFPROBE ERROR]: ' + err.message);
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('FFprobe Error: ' + err.message);
                    return;
                }

                console.log(`[FFMPEG] Starting stream for: ${filePath}`);
                
                // Set headers for video streaming
                res.writeHead(200, {
                    'Content-Type': 'video/mp4', // Use mp4 for wide Video.js compatibility
                    'Connection': 'keep-alive',
                });
                
                // Build the ffmpeg command
                const cmd = ffmpeg(filePath)
                    .format('mp4') // Set format first
                    .on('error', (err, stdout, stderr) => {
                        console.error('[FFMPEG ERROR]: ' + err.message);
                        if (!res.headersSent) {
                           res.writeHead(500, { 'Content-Type': 'text/plain' });
                           res.end('FFmpeg Error: ' + err.message);
                        } else {
                            res.end(); // If headers sent, just end the stream
                        }
                    });

                // --- BUILD CONSOLIDATED OUTPUT OPTIONS ARRAY (FIXED MAPPING/CRASH) ---
                const outputOptions = [
                    // Video Codec 
                    '-vcodec libx264',
                    // Video quality/speed settings
                    '-crf 28', 
                    '-preset veryfast',
                    // Optimization for streaming (fragmented MP4)
                    '-movflags frag_keyframe+empty_moov', 
                    
                    // --- VIDEO MAPPING ---
                    '-map 0:v:0', // Explicitly map the first video stream
                    
                    // --- AUDIO CODEC ---
                    '-acodec aac', // Apply AAC codec globally for all mapped audio streams
                ];
                
                // --- DYNAMIC AUDIO MAPPING & METADATA ---
                const audioStreams = metadata.streams.filter(s => s.codec_type === 'audio');
                
                if (audioStreams.length === 0) {
                    console.log('[FFMPEG] No audio streams found, streaming video only.');
                    outputOptions.push('-an'); // Disable audio entirely
                } else {
                    console.log(`[FFMPEG] Found ${audioStreams.length} audio streams. Mapping all...`);
                    
                    audioStreams.forEach((stream, idx) => {
                        // Map the Nth audio stream
                        outputOptions.push(`-map 0:a:${idx}`); 
                        
                        // Set the language metadata for the output audio stream
                        const lang = stream.tags?.language || 'und';
                        outputOptions.push(`-metadata:s:a:${idx} language=${lang}`);
                        console.log(`[FFMPEG] Mapping audio stream #${idx} (language: ${lang})`);
                    });
                }
                
                // --- APPLY ALL OPTIONS ---
                cmd.outputOptions(outputOptions);

                // Assign the command object to the global variable
                ffmpegProcess = cmd; 
                
                // Pipe the transcoded video directly to the HTTP response
                cmd.pipe(res, { end: true }); 
                
                // Add cleanup on client disconnect
                res.on('close', () => {
                    console.log('[SERVER] Client disconnected, killing FFmpeg.');
                    if (ffmpegProcess) {
                        ffmpegProcess.kill('SIGTERM'); // Use SIGTERM for graceful cleanup
                        ffmpegProcess = null;
                    }
                    currentlyStreamingPath = null; // Reset streaming path
                });
                
            });
            // --- END: MODIFIED SECTION ---
                
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found or Stream Path not set.');
        }
    }).listen(STREAMING_PORT, () => {
        console.log(`[SERVER] Streaming server listening on port ${STREAMING_PORT}`);
    });
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

    // 4. NEW: Fetch saved metadata settings (Unchanged)
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

    // 5. NEW: Save metadata settings (Unchanged)
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

    // 6. NEW: Fetch and cache Anilist metadata (Unchanged)
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

    // 7. NEW: Fetch library cache (Unchanged)
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

    // 8. UPDATED: Scan ALL libraries and cache the results (Unchanged)
    ipcMain.handle('scan-and-cache-library', async (event, rootPaths) => {
        try {
            if (!Array.isArray(rootPaths) || rootPaths.length === 0) {
                return { success: false, message: "No library paths provided for scanning." };
            }
            
            // START OF CHANGES TO PRESERVE METADATA AND TRACKING DATA
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
            // END OF CHANGES

            let allShows = [];
            
            // Scan each root path and aggregate the results
            for (const rootPath of rootPaths) {
                const showsFromPath = scanDirectory(rootPath);
                
                // START OF CHANGES TO PRESERVE METADATA AND TRACKING DATA
                const mergedShows = showsFromPath.map(newShow => {
                    const existingShow = existingShowsMap.get(newShow.title);
                    
                    if (existingShow) {
                        // 1. Copy over show-level metadata
                        if (existingShow.anilistMetadata) {
                            newShow.anilistMetadata = existingShow.anilistMetadata;
                        }
                        
                        // 2. Iterate through seasons/episodes to copy over tracking data
                        newShow.seasons.forEach((newSeason, sIndex) => {
                            const existingSeason = existingShow.seasons[sIndex];
                            if (existingSeason) {
                                newSeason.episodes.forEach(newEpisode => {
                                    // Find the existing episode by fullPath as a reliable key
                                    const existingEpisode = existingSeason.episodes.find(
                                        e => e.fullPath === newEpisode.fullPath
                                    );

                                    if (existingEpisode) {
                                        // Preserve tracking data: ID, progress, and watched status
                                        newEpisode.id = existingEpisode.id;
                                        newEpisode.currentTime = existingEpisode.currentTime || 0;
                                        newEpisode.duration = existingEpisode.duration || 0;
                                        newEpisode.isWatched = existingEpisode.isWatched || false;
                                    }
                                });
                            }
                        });
                    }
                    return newShow;
                });
                // END OF CHANGES
                
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

    // 9. NEW: Save Playback Progress (Renderer -> Main -> PouchDB) (Unchanged)
    ipcMain.handle('save-playback-progress', async (event, showId, episodeId, currentTime, duration, isFinished = false) => {
        try {
            let cacheDoc = await db.get(CACHE_DOC_ID);
            let shows = cacheDoc.shows || [];

            const show = shows.find(s => s.id === showId);

            if (show) {
                let episodeUpdated = false;
                // Iterate through seasons and episodes to find the one matching the episodeId
                for (const season of show.seasons) {
                    const episode = season.episodes.find(e => e.id === episodeId);
                    if (episode) {
                        episode.currentTime = currentTime;
                        // Only update duration if it's the first time or if a more accurate duration is received
                        if (duration > 0) episode.duration = duration;

                        // Mark as watched if the player sends the finished flag or if it's within the last 5 seconds
                        if (isFinished || (episode.duration > 0 && currentTime >= episode.duration - 5)) {
                            episode.isWatched = true;
                            episode.currentTime = episode.duration; // Ensure progress is 100%
                        } else if (currentTime > 60) {
                            // Mark as partially watched (explicitly false for 'isWatched' if partially seen)
                            episode.isWatched = false; 
                        } else {
                             // If less than 60 seconds watched, reset to unwatched state
                            episode.isWatched = false;
                        }

                        episodeUpdated = true;
                        break; 
                    }
                }

                if (episodeUpdated) {
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
    
    // MINIMAL CHANGE E: New IPC handler to start the FFmpeg process (SYNTAX ERROR FIXED)
    ipcMain.handle('start-ffmpeg-stream', async (event, fullPath) => {
        try {
            if (!fs.existsSync(fullPath)) {
                // 🔥 FIX 1: Corrected SyntaxError: missing ) after argument list
                throw new Error('Video file not found at path: ' + fullPath);
            }
            
            // --- 🔥 MODIFIED: Use SIGTERM instead of SIGKILL for graceful cleanup ---
            if (ffmpegProcess) {
                ffmpegProcess.kill('SIGTERM'); // Changed from SIGKILL to SIGTERM
                ffmpegProcess = null; // Clear the reference before starting a new one.
                console.log('[FFMPEG] Old process killed in IPC handler.');
            }
            // --- END FIX ---
            
            // Set the path globally for the HTTP server to pick up
            currentlyStreamingPath = fullPath;
            
            // Return the URL that the Video.js player should connect to
            const streamUrl = `http://localhost:${STREAMING_PORT}/stream`;
            return { success: true, url: streamUrl };
            
        } catch (error) {
            console.error('[FFMPEG] Failed to start stream:', error);
            // Re-throw the error with a check in case the kill was the issue
            if (error.message.includes('ffmpegProcess.kill')) {
                 return { success: false, message: 'Internal Stream Error: Check console for kill process failure.' };
            }
            return { success: false, message: error.message };
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

// MINIMAL CHANGE F: Start the server immediately when the app launches (Unchanged from original)
startStreamingServer();

// --- App Lifecycle (Modified to clean up FFmpeg) ---

app.on('ready', () => {
    registerIpcHandlers(); // Register handlers before window creation
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    // MINIMAL CHANGE G: Clean up FFmpeg process and server on quit (Unchanged from original)
    if (ffmpegProcess) {
        // Use .kill() on the fluent-ffmpeg command object
        ffmpegProcess.kill('SIGTERM'); 
        console.log('[FFMPEG] Process killed.');
    }
    if (this.server) {
        this.server.close(() => {
            console.log('[SERVER] Streaming server closed.');
        });
    }

    if (process.platform !== 'darwin') {
        app.quit();
    }
});