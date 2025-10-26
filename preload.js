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

    // IPC handler for starting FFmpeg streaming
    startFFmpegStream: (fullPath) => ipcRenderer.invoke('start-ffmpeg-stream', fullPath)
});