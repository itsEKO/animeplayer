const { contextBridge, ipcRenderer } = require('electron');

// Expose the necessary functions to the Renderer process
contextBridge.exposeInMainWorld('api', {
    // File/Directory Interaction
    openDirectoryDialog: () => ipcRenderer.invoke('open-directory-dialog'),
    launchExternal: (filePath) => ipcRenderer.invoke('launch-external', filePath),

    // Data Management
    fetchLibraryCache: () => ipcRenderer.invoke('fetch-library-cache'),
    scanAndCacheLibrary: (rootPath) => ipcRenderer.invoke('scan-and-cache-library', rootPath),
});

// Log to confirm preload script execution
console.log('[PRELOAD] IPC Bridge (window.api) exposed successfully.');
