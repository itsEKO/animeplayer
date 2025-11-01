const { contextBridge, ipcRenderer } = require('electron');

// Expose a safe API to the renderer process
contextBridge.exposeInMainWorld('api', {
    // IPC handler for opening the directory dialog
    openDirectoryDialog: () => ipcRenderer.invoke('open-directory-dialog'),

    // IPC handler for fetching library paths
    fetchLibraryPaths: () => ipcRenderer.invoke('fetch-library-paths'),

    // IPC handler for saving library paths
    saveLibraryPaths: (paths) => ipcRenderer.invoke('save-library-paths', paths),

    // IPC handler for fetching metadata settings
    fetchMetadataSettings: () => ipcRenderer.invoke('fetch-metadata-settings'),

    // IPC handler for saving metadata settings
    saveMetadataSettings: (settings) => ipcRenderer.invoke('save-metadata-settings', settings),

    // IPC handler for fetching and caching Anilist metadata
    fetchAndCacheAnilistMetadata: (showTitle) => ipcRenderer.invoke('fetch-and-cache-anilist-metadata', showTitle),

    // IPC handler for fetching the library cache
    fetchLibraryCache: () => ipcRenderer.invoke('fetch-library-cache'),

    // IPC handler for scanning and caching the library
    scanAndCacheLibrary: (rootPaths) => ipcRenderer.invoke('scan-and-cache-library', rootPaths),

    // IPC handler for saving playback progress
    savePlaybackProgress: (showId, episodeId, currentTime, duration, isFinished) =>
        ipcRenderer.invoke('save-playback-progress', showId, episodeId, currentTime, duration, isFinished),

    // IPC handler for starting video playback (direct or transcoded)
    startVideoPlayback: (fullPath, options) => ipcRenderer.invoke('start-video-playback', fullPath, options),

    // IPC handler for starting FFmpeg streaming (legacy compatibility)
    startFFmpegStream: (fullPath, options) => ipcRenderer.invoke('start-ffmpeg-stream', fullPath, options),

    // IPC handler for getting media metadata (audio/subtitle tracks)
    getMediaMetadata: (filePath) => ipcRenderer.invoke('get-media-metadata', filePath),

    // Helper function to switch audio track
    switchAudioTrack: async (trackIndex) => {
        try {
            const response = await fetch(`http://localhost:8080/switch-audio?track=${trackIndex}`);
            return await response.json();
        } catch (error) {
            return { success: false, message: error.message };
        }
    }
});