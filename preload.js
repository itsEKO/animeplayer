const { contextBridge, ipcRenderer } = require('electron');

// Expose the necessary functions to the Renderer process
contextBridge.exposeInMainWorld('api', {
    // File/Directory Interaction
    openDirectoryDialog: () => ipcRenderer.invoke('open-directory-dialog'),
    launchExternal: (filePath) => ipcRenderer.invoke('launch-external', filePath),

    // Data Management
    fetchLibraryCache: () => ipcRenderer.invoke('fetch-library-cache'),
    // scanAndCacheLibrary now expects an array of paths
    scanAndCacheLibrary: (rootPaths) => ipcRenderer.invoke('scan-and-cache-library', rootPaths),
    
    // NEW: Library Path Management
    fetchLibraryPaths: () => ipcRenderer.invoke('fetch-library-paths'),
    saveLibraryPaths: (paths) => ipcRenderer.invoke('save-library-paths', paths),
});

// Log to confirm preload script execution
console.log('[PRELOAD] IPC Bridge (window.api) exposed successfully.');
