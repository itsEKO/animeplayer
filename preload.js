const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process (index.html)
// to communicate with the main process (main.js) via IPC
contextBridge.exposeInMainWorld('api', {
  // Opens a directory selection dialog and returns the selected path
  openDirectoryDialog: () => ipcRenderer.invoke('open-directory-dialog'),

  // Fetches the list of saved library root paths from PouchDB
  fetchLibraryPaths: () => ipcRenderer.invoke('fetch-library-paths'),

  // Saves the list of library root paths to PouchDB
  saveLibraryPaths: (paths) => ipcRenderer.invoke('save-library-paths', paths),

  // Fetches metadata settings (e.g., Anilist enabled status and API key) from PouchDB
  fetchMetadataSettings: () => ipcRenderer.invoke('fetch-metadata-settings'),

  // Saves metadata settings to PouchDB
  saveMetadataSettings: (settings) => ipcRenderer.invoke('save-metadata-settings', settings),

  // Fetches and caches Anilist metadata for a given show title
  fetchAndCacheAnilistMetadata: (showTitle) => ipcRenderer.invoke('fetch-and-cache-anilist-metadata', showTitle),

  // Scans library paths and caches the show structure in PouchDB
  scanAndCacheLibrary: (rootPaths) => ipcRenderer.invoke('scan-and-cache-library', rootPaths),

  // Launches an external media player with the given file path
  launchExternal: (filePath) => ipcRenderer.invoke('launch-external', filePath),

  // Fetches the cached library data from PouchDB
  fetchLibraryCache: () => ipcRenderer.invoke('fetch-library-cache')
});