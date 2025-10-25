const { contextBridge, ipcRenderer } = require('electron');

// Expose the necessary functions to the Renderer process
contextBridge.exposeInMainWorld('api', {
    // File/Directory Interaction
    openDirectoryDialog: () => ipcRenderer.invoke('open-directory-dialog'),
    launchExternal: (filePath) => ipcRenderer.invoke('launch-external', filePath),

    // Data Management
    fetchLibraryCache: () => ipcRenderer.invoke('fetch-library-cache'),
    // scanAndCacheLibrary expects an array of paths
    scanAndCacheLibrary: (rootPaths) => ipcRenderer.invoke('scan-and-cache-library', rootPaths),
    
    // Library Path Management
    fetchLibraryPaths: () => ipcRenderer.invoke('fetch-library-paths'),
    saveLibraryPaths: (paths) => ipcRenderer.invoke('save-library-paths', paths),

    // NEW: Metadata Settings Management
    fetchMetadataSettings: () => ipcRenderer.invoke('fetch-metadata-settings'),
    saveMetadataSettings: (settings) => ipcRenderer.invoke('save-metadata-settings', settings),
    
    // NEW: Anilist Metadata Fetching (Asynchronous background task)
    fetchAndCacheAnilistMetadata: (showTitle) => ipcRenderer.invoke('fetch-and-cache-anilist-metadata', showTitle),
});

// Log to confirm preload script execution
console.log('[PRELOAD] IPC Bridge (window.api) exposed successfully.');
