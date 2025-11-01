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
        const { pathname, query } = parse(req.url, true);

        // Handle subtitle extraction endpoint
        if (pathname === '/subtitle' && currentlyStreamingPath) {
            const subtitleIndex = parseInt(query.track) || 0;
            
            if (!currentlyStreamingPath) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('No media file loaded');
                return;
            }

            console.log(`[SUBTITLE] Extracting subtitle track ${subtitleIndex} from: ${currentlyStreamingPath}`);
            
            // First, get metadata to find the correct stream index
            ffmpeg.ffprobe(currentlyStreamingPath, (err, metadata) => {
                if (err) {
                    console.error('[SUBTITLE] Error getting metadata for subtitle extraction:', err.message);
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Error reading media metadata: ' + err.message);
                    return;
                }

                const subtitleStreams = metadata.streams.filter(s => s.codec_type === 'subtitle');
                
                if (subtitleIndex >= subtitleStreams.length) {
                    console.error(`[SUBTITLE] Subtitle track ${subtitleIndex} not found. Available: ${subtitleStreams.length}`);
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end(`Subtitle track ${subtitleIndex} not found`);
                    return;
                }

                const actualStreamIndex = subtitleStreams[subtitleIndex].index;
                console.log(`[SUBTITLE] Using actual stream index ${actualStreamIndex} for subtitle track ${subtitleIndex}`);
                
                // Set headers for WebVTT
                res.writeHead(200, {
                    'Content-Type': 'text/vtt',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET',
                    'Access-Control-Allow-Headers': 'Content-Type'
                });

                // Extract subtitle using ffmpeg with correct stream index
                const subtitleCommand = ffmpeg(currentlyStreamingPath)
                    .outputOptions([
                        `-map 0:${actualStreamIndex}`,  // Use actual stream index, not subtitle array index
                        '-c:s webvtt',
                        '-f webvtt'
                    ])
                    .on('error', (err) => {
                        console.error(`[SUBTITLE] Error extracting subtitle ${subtitleIndex}:`, err.message);
                        if (!res.headersSent) {
                            res.writeHead(500, { 'Content-Type': 'text/plain' });
                            res.end(`Error extracting subtitle: ${err.message}`);
                        } else {
                            res.end();
                        }
                    })
                    .on('start', (cmdLine) => {
                        console.log(`[SUBTITLE] Started extraction: ${cmdLine}`);
                    });

                // Stream subtitle to response
                subtitleCommand.pipe(res, { end: true });
            });
            return;
        }

        // Handle audio track switch endpoint
        if (pathname === '/switch-audio' && currentlyStreamingPath) {
            const audioTrackIndex = parseInt(query.track) || 0;
            
            console.log(`[AUDIO] Switching to audio track ${audioTrackIndex}`);
            
            // Store the selected audio track globally (don't kill process here)
            global.selectedAudioTrack = audioTrackIndex;
            
            res.writeHead(200, { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({ success: true, message: `Audio track ${audioTrackIndex} selected` }));
            return;
        }

        // Handle direct file serving endpoint (only for browser-compatible formats)
        if (pathname === '/video' && currentlyStreamingPath) {
            const filePath = currentlyStreamingPath;
            const ext = path.extname(filePath).toLowerCase();
            
            // Only serve MP4 and WebM files directly, force MKV to use transcoding
            if (ext === '.mkv' || ext === '.avi' || ext === '.mov' || ext === '.flv') {
                console.log(`[DIRECT] Redirecting ${ext} to transcoding - not browser compatible`);
                res.writeHead(302, { 'Location': '/test-stream' });
                res.end();
                return;
            }
            
            console.log(`[DIRECT] Serving compatible video file: ${filePath}`);
            
            // Check if file exists
            if (!fs.existsSync(filePath)) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Video file not found');
                return;
            }

            // Get file stats for range requests (seeking support)
            const stat = fs.statSync(filePath);
            const fileSize = stat.size;
            const range = req.headers.range;

            // Handle range requests for seeking
            if (range) {
                const parts = range.replace(/bytes=/, "").split("-");
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                const chunksize = (end - start) + 1;
                
                console.log(`[DIRECT] Range request: ${start}-${end}/${fileSize}`);
                
                const file = fs.createReadStream(filePath, { start, end });
                
                const contentType = ext === '.mp4' ? 'video/mp4' : 'video/webm';
                
                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': chunksize,
                    'Content-Type': contentType,
                });
                
                file.pipe(res);
            } else {
                // Full file request
                console.log(`[DIRECT] Full file request: ${fileSize} bytes`);
                
                const contentType = ext === '.mp4' ? 'video/mp4' : 'video/webm';
                
                res.writeHead(200, {
                    'Content-Length': fileSize,
                    'Content-Type': contentType,
                    'Accept-Ranges': 'bytes',
                });
                
                fs.createReadStream(filePath).pipe(res);
            }
            return;
        }

        // Handle MKV transcoding stream (converts MKV to MP4 for browsers)
        if (pathname === '/test-stream' && currentlyStreamingPath) {
            const filePath = currentlyStreamingPath;
            
            console.log(`[MKV-TRANSCODE] Starting MKV to MP4 conversion: ${filePath}`);
            
            // Get metadata first to handle audio tracks properly
            ffmpeg.ffprobe(filePath, (err, metadata) => {
                if (err) {
                    console.error('[MKV-TRANSCODE] Probe error:', err.message);
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Error reading MKV file: ' + err.message);
                    return;
                }

                const audioStreams = metadata.streams.filter(s => s.codec_type === 'audio');
                const videoStreams = metadata.streams.filter(s => s.codec_type === 'video');
                const selectedAudioTrack = global.selectedAudioTrack || 0;
                
                console.log(`[MKV-TRANSCODE] Found ${videoStreams.length} video streams, ${audioStreams.length} audio streams`);
                
                if (videoStreams.length === 0) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('No video stream found in MKV file');
                    return;
                }
                
                const duration = metadata.format.duration;
                console.log(`[MKV-TRANSCODE] Video duration: ${duration}s`);
                
                const headers = {
                    'Content-Type': 'video/mp4',
                    'Connection': 'keep-alive',
                    'Accept-Ranges': 'bytes',
                    'Cache-Control': 'no-cache'
                };
                
                // Add duration header if available
                if (duration && !isNaN(duration)) {
                    headers['X-Duration'] = duration.toString();
                    headers['X-Content-Duration'] = duration.toString();
                }
                
                res.writeHead(200, headers);
                
                const cmd = ffmpeg(filePath)
                    .videoCodec('libx264')
                    .audioCodec('aac')
                    .format('mp4')
                    .outputOptions([
                        '-map 0:v:0',  // Map first video stream
                        '-preset ultrafast',
                        '-crf 23',
                        '-pix_fmt yuv420p',
                        '-movflags frag_keyframe+empty_moov+faststart+dash',
                        '-avoid_negative_ts make_zero',
                        '-fflags +genpts',
                        '-copyts',
                        '-start_at_zero',
                        '-vsync cfr'  // Constant frame rate for better timeline support
                    ])
                    .on('start', (cmdLine) => {
                        console.log('[MKV-TRANSCODE] FFmpeg command:', cmdLine);
                    })
                    .on('progress', (progress) => {
                        if (progress.frames) {
                            console.log(`[MKV-TRANSCODE] Progress: ${progress.frames} frames processed`);
                        }
                    })
                    .on('error', (err, stdout, stderr) => {
                        console.error('[MKV-TRANSCODE ERROR]:', err.message);
                        console.error('[MKV-TRANSCODE STDERR]:', stderr);
                        if (!res.headersSent) {
                            res.writeHead(500, { 'Content-Type': 'text/plain' });
                            res.end('Transcoding error: ' + err.message);
                        } else {
                            res.end();
                        }
                    });
                
                // Add audio track mapping
                if (audioStreams.length > 0 && selectedAudioTrack < audioStreams.length) {
                    cmd.outputOptions(`-map 0:a:${selectedAudioTrack}`);
                    const lang = audioStreams[selectedAudioTrack].tags?.language || 'und';
                    console.log(`[MKV-TRANSCODE] Using audio track ${selectedAudioTrack} (${lang})`);
                } else if (audioStreams.length > 0) {
                    cmd.outputOptions('-map 0:a:0'); // Default to first audio track
                    console.log('[MKV-TRANSCODE] Using default first audio track');
                } else {
                    cmd.outputOptions('-an'); // No audio
                    console.log('[MKV-TRANSCODE] No audio streams found');
                }
                
                cmd.pipe(res, { end: true });
                ffmpegProcess = cmd;
                
                res.on('close', () => {
                    console.log('[MKV-TRANSCODE] Client disconnected, stopping transcoding');
                    if (ffmpegProcess) {
                        ffmpegProcess.kill('SIGTERM');
                        ffmpegProcess = null;
                    }
                });
            });
            return;
        }

        // Handle transcoded stream endpoint (when direct playback isn't compatible)
        if (pathname === '/stream' && currentlyStreamingPath) {
            const filePath = currentlyStreamingPath;
            const range = req.headers.range;
            
            console.log(`[TRANSCODE] Starting transcoding for: ${filePath}`);
            
            // Run ffprobe to get media metadata
            ffmpeg.ffprobe(filePath, (err, metadata) => {
                if (err) {
                    console.error('[FFPROBE ERROR]: ' + err.message);
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('FFprobe Error: ' + err.message);
                    return;
                }
                
                const audioStreams = metadata.streams.filter(s => s.codec_type === 'audio');
                const selectedAudioTrack = global.selectedAudioTrack || 0;
                const duration = metadata.format.duration;
                
                // Handle range/seeking requests
                let seekTime = 0;
                if (range) {
                    // Parse range header to determine seek time (approximate)
                    const rangeMatch = range.match(/bytes=(\d+)-/);
                    if (rangeMatch && duration) {
                        const byteStart = parseInt(rangeMatch[1]);
                        const fileSize = metadata.format.size || (duration * 1000000); // Estimate
                        seekTime = (byteStart / fileSize) * duration;
                        console.log(`[TRANSCODE] Seeking to approximately ${seekTime}s based on byte range`);
                    }
                }
                
                // Set headers for transcoded streaming
                if (range) {
                    res.writeHead(206, {
                        'Content-Type': 'video/mp4',
                        'Accept-Ranges': 'bytes',
                        'Connection': 'keep-alive',
                    });
                } else {
                    res.writeHead(200, {
                        'Content-Type': 'video/mp4',
                        'Accept-Ranges': 'bytes',
                        'Connection': 'keep-alive',
                    });
                }
                
                // Verify we have a video stream to transcode
                if (videoStreams.length === 0) {
                    console.error('[TRANSCODE] No video streams found in file!');
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('No video stream found in file');
                    return;
                }

                // Build optimized transcoding command
                const cmd = ffmpeg(filePath)
                    .on('error', (err, stdout, stderr) => {
                        console.error('[TRANSCODE ERROR]: ' + err.message);
                        console.error('[TRANSCODE STDERR]:', stderr);
                        if (!res.headersSent) {
                           res.writeHead(500, { 'Content-Type': 'text/plain' });
                           res.end('Transcode Error: ' + err.message);
                        } else {
                            res.end();
                        }
                    })
                    .on('start', (cmdLine) => {
                        console.log('[TRANSCODE] FFmpeg command:', cmdLine);
                    })
                    .on('progress', (progress) => {
                        if (progress.frames) {
                            console.log(`[TRANSCODE] Progress: ${progress.frames} frames, ${progress.currentFps} fps`);
                        }
                    });

                // Log video stream info for debugging
                const videoStreams = metadata.streams.filter(s => s.codec_type === 'video');
                console.log(`[TRANSCODE] Video streams found: ${videoStreams.length}`);
                if (videoStreams.length > 0) {
                    const videoStream = videoStreams[0];
                    console.log(`[TRANSCODE] Video codec: ${videoStream.codec_name}, Resolution: ${videoStream.width}x${videoStream.height}`);
                }

                const outputOptions = [
                    // Video encoding options
                    '-c:v libx264',           // Video codec
                    '-preset ultrafast',      // Fastest encoding for real-time
                    '-crf 23',               // Quality setting
                    '-pix_fmt yuv420p',      // Pixel format for web compatibility
                    '-profile:v baseline',    // H.264 baseline profile for compatibility
                    '-level 3.0',            // H.264 level
                    '-maxrate 5M',           // Max bitrate
                    '-bufsize 10M',          // Buffer size
                    '-movflags frag_keyframe+empty_moov+faststart+default_base_moof',
                    '-avoid_negative_ts make_zero',
                    '-fflags +genpts',       // Generate presentation timestamps
                    '-f mp4',
                    '-map 0:v:0'             // Map first video stream
                ];
                
                // Add seeking if requested
                if (seekTime > 0) {
                    cmd.seekInput(seekTime);
                }
                
                // Map selected audio track
                if (audioStreams.length > 0 && selectedAudioTrack < audioStreams.length) {
                    outputOptions.push(`-map 0:a:${selectedAudioTrack}`);
                    outputOptions.push('-acodec aac');
                    outputOptions.push('-b:a 128k');
                    const lang = audioStreams[selectedAudioTrack].tags?.language || 'und';
                    console.log(`[TRANSCODE] Using audio track ${selectedAudioTrack} (${lang})`);
                } else {
                    outputOptions.push('-an'); // No audio
                }
                
                cmd.outputOptions(outputOptions);
                
                ffmpegProcess = cmd;
                cmd.pipe(res, { end: true });
                
                res.on('close', () => {
                    console.log('[TRANSCODE] Client disconnected, killing FFmpeg.');
                    if (ffmpegProcess) {
                        ffmpegProcess.kill('SIGTERM');
                        ffmpegProcess = null;
                    }
                });
            });
            return;
        }
        
        // 404 for unknown paths
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
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
    
    // NEW: IPC handler to get media metadata (audio/subtitle tracks)
    ipcMain.handle('get-media-metadata', async (event, filePath) => {
        try {
            if (!fs.existsSync(filePath)) {
                throw new Error('Video file not found at path: ' + filePath);
            }

            return new Promise((resolve, reject) => {
                ffmpeg.ffprobe(filePath, (err, metadata) => {
                    if (err) {
                        console.error('[FFPROBE] Error getting metadata:', err);
                        reject(new Error('Failed to read media metadata: ' + err.message));
                        return;
                    }

                    try {
                        const audioTracks = metadata.streams
                            .filter(stream => stream.codec_type === 'audio')
                            .map((stream, index) => ({
                                index: index,
                                streamIndex: stream.index,
                                language: stream.tags?.language || 'und',
                                title: stream.tags?.title || `Audio Track ${index + 1}`,
                                codec: stream.codec_name,
                                channels: stream.channels,
                                sampleRate: stream.sample_rate
                            }));

                        const subtitleTracks = metadata.streams
                            .filter(stream => stream.codec_type === 'subtitle')
                            .map((stream, index) => ({
                                index: index,
                                streamIndex: stream.index,
                                language: stream.tags?.language || 'und',
                                title: stream.tags?.title || `Subtitle Track ${index + 1}`,
                                codec: stream.codec_name,
                                forced: stream.disposition?.forced === 1,
                                default: stream.disposition?.default === 1
                            }));

                        console.log(`[METADATA] Found ${audioTracks.length} audio tracks and ${subtitleTracks.length} subtitle tracks`);
                        
                        resolve({
                            success: true,
                            audioTracks: audioTracks,
                            subtitleTracks: subtitleTracks,
                            duration: metadata.format.duration
                        });
                    } catch (parseError) {
                        console.error('[METADATA] Error parsing metadata:', parseError);
                        reject(new Error('Failed to parse media metadata: ' + parseError.message));
                    }
                });
            });
        } catch (error) {
            console.error('[METADATA] Error:', error);
            return { success: false, message: error.message };
        }
    });

    // ENHANCED: Video serving handler with direct file access and transcoding fallback
    ipcMain.handle('start-video-playback', async (event, fullPath, options = {}) => {
        try {
            if (!fs.existsSync(fullPath)) {
                throw new Error('Video file not found at path: ' + fullPath);
            }
            
            // Kill existing process
            if (ffmpegProcess) {
                ffmpegProcess.kill('SIGTERM');
                ffmpegProcess = null;
                console.log('[VIDEO] Old process killed in IPC handler.');
            }
            
            // Set the path and options globally for the HTTP server
            currentlyStreamingPath = fullPath;
            global.streamingOptions = options;
            global.selectedAudioTrack = options.audioTrack || 0;
            
            // Check if file is directly playable by browsers (only MP4 and WebM work reliably)
            const ext = path.extname(fullPath).toLowerCase();
            const directPlayableFormats = ['.mp4', '.webm'];
            const needsTranscodingFormats = ['.mkv', '.avi', '.mov', '.flv'];
            
            let videoUrl;
            let needsTranscoding = false;
            
            if (directPlayableFormats.includes(ext)) {
                // Direct serving for browser-compatible formats
                videoUrl = `http://localhost:${STREAMING_PORT}/video`;
                console.log(`[VIDEO] Direct playback for ${ext} file`);
            } else {
                // Use simple transcoding for MKV and other formats that browsers can't play directly
                videoUrl = `http://localhost:${STREAMING_PORT}/test-stream`;
                needsTranscoding = true;
                console.log(`[VIDEO] Simple transcoding for ${ext} file`);
            }
            
            return { 
                success: true, 
                url: videoUrl,
                needsTranscoding: needsTranscoding,
                format: ext 
            };
            
        } catch (error) {
            console.error('[VIDEO] Failed to start playback:', error);
            return { success: false, message: error.message };
        }
    });

    // Legacy handler for compatibility
    ipcMain.handle('start-ffmpeg-stream', async (event, fullPath, options = {}) => {
        // Just call the new handler directly
        const result = await new Promise((resolve) => {
            resolve(ipcMain.emit('start-video-playback', event, fullPath, options));
        });
        
        // For compatibility, just return the URL in old format
        try {
            currentlyStreamingPath = fullPath;
            global.selectedAudioTrack = options.audioTrack || 0;
            const videoUrl = `http://localhost:${STREAMING_PORT}/video`;
            return { success: true, url: videoUrl };
        } catch (error) {
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