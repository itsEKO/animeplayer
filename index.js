// --- APP STATE AND INITIALIZATION ---
let appState = {
  shows: [],
  selectedShowId: null,
  selectedSeasonIndex: 0,
  libraryPaths: [],
  metadataSettings: {
      providers: {
          anilist: { enabled: false, apiKey: '' }
      }
  },
  currentPlaying: {
      showId: null,
      episodeId: null,
      fullPath: null
  }
};

let playerInstance = null;

const elements = {
  sidebar: document.getElementById('sidebar'),
  detailView: document.getElementById('detail-view'),
  mainContent: document.getElementById('main-content'),
  scanButton: document.getElementById('scan-button'),
  statusContainer: document.getElementById('status-container'),
  initialMessage: document.getElementById('initial-state-message'),
  showListTitle: document.getElementById('show-list-title'),
  settingsButton: document.getElementById('settings-button'),
  playerView: document.getElementById('player-view'),
  videoPlayer: document.getElementById('otaku-video-player'),
  closePlayerButton: document.getElementById('close-player-button'),
  settingsModal: document.getElementById('settings-modal'),
  closeSettingsButton: document.getElementById('close-settings-button'),
  libraryPathsContainer: document.getElementById('library-paths-container'),
  addLibraryButton: document.getElementById('add-library-button'),
  initialScanInstruction: document.getElementById('initial-scan-instruction'),
  anilistToggle: document.getElementById('anilist-toggle'),
  anilistApiKeySection: document.getElementById('anilist-api-key-section'),
  anilistApiKeyInput: document.getElementById('anilist-api-key'),
  anilistApiSettingsBtn: document.getElementById('anilist-api-settings-btn')
};

const accentColor = '#a855f7';
const secondaryTextColor = '#b3b3b3';
const PROGRESS_SAVE_INTERVAL_SECONDS = 5; 
let lastTimeUpdate = 0;

// --- UTILITY FUNCTIONS ---

function setStatus(message, isError = false, isLoading = false) {
    let spinnerHTML = isLoading ? `
        <div class="w-5 h-5 border-4 border-t-4 rounded-full animate-spin mr-2" 
             style="border-color: rgba(255, 255, 255, 0.1); border-top-color: ${accentColor};">
        </div>` : '';
        
    let color = isError ? 'red' : (isLoading ? accentColor : secondaryTextColor);
    
    elements.statusContainer.innerHTML = `
        <div class="scan-status-container flex items-center justify-center min-h-10" style="color:${color};">
            ${spinnerHTML} ${message}
        </div>
    `;
    elements.scanButton.disabled = isLoading;
    elements.settingsButton.disabled = isLoading; 
    
    if (!elements.settingsModal.classList.contains('hidden')) {
        elements.addLibraryButton.disabled = isLoading;
        document.querySelectorAll('.remove-library-button').forEach(btn => btn.disabled = isLoading);
    }
}

function setSelectedShow(showId) {
    const show = appState.shows.find(s => s.id === showId);
    if (!show) return;

    appState.selectedShowId = showId;
    appState.selectedSeasonIndex = 0;
    
    document.querySelectorAll('.show-list-item').forEach(el => {
        el.classList.remove('bg-gray-700', 'font-bold', 'border-accent-purple');
        el.classList.add('border-transparent');
    });
    const selectedEl = document.getElementById(`show-${showId}`);
    if (selectedEl) {
        selectedEl.classList.add('bg-gray-700', 'font-bold', 'border-accent-purple');
        selectedEl.classList.remove('border-transparent');
    }
    
    renderDetailView(show);
}

function setSelectedSeason(seasonIndex) {
    appState.selectedSeasonIndex = parseInt(seasonIndex, 10);
    const show = appState.shows.find(s => s.id === appState.selectedShowId);
    
    if (show && show.seasons[appState.selectedSeasonIndex]) {
        renderEpisodes(show.seasons[appState.selectedSeasonIndex]);
    }
}

// --- PLAYER FUNCTIONS ---

function findEpisodeById(episodeId) {
    const show = appState.shows.find(s => s.id === appState.selectedShowId);
    if (!show) return null;

    for (const season of show.seasons) {
        const episode = season.episodes.find(e => e.id === episodeId);
        if (episode) return episode;
    }
    return null;
}

async function saveProgress(isFinished = false) {
    const { showId, episodeId } = appState.currentPlaying;
    const video = playerInstance; 

    if (!showId || !episodeId || !video || video.readyState() < 2) return; 

    const currentTime = video.currentTime();
    const duration = video.duration() || 0;

    if (!isFinished) {
        const now = Date.now();
        if (now - lastTimeUpdate < PROGRESS_SAVE_INTERVAL_SECONDS * 1000) {
            return;
        }
        lastTimeUpdate = now;
    }
    
    const response = await window.api.savePlaybackProgress(
        showId, 
        episodeId, 
        currentTime, 
        duration, 
        isFinished
    );

    if (response.success) {
        const episode = findEpisodeById(episodeId);
        if (episode) {
            episode.currentTime = currentTime;
            episode.duration = duration;
            if (isFinished || (duration > 0 && currentTime >= duration * 0.95)) {
                episode.isWatched = true;
            } else if (currentTime > 60) {
                episode.isWatched = false;
            } else {
                episode.isWatched = false;
            }
        }
    } else {
        console.error('Failed to save progress:', response.message);
    }
}

function setupPlayerListeners() {
    const video = playerInstance;
    
    video.off('timeupdate', saveProgress);
    video.on('timeupdate', () => saveProgress(false));

    video.off('ended', saveProgress);
    video.on('ended', () => {
        saveProgress(true);
        closePlayerView();
        renderEpisodes(appState.shows.find(s => s.id === appState.selectedShowId).seasons[appState.selectedSeasonIndex]); 
    });

    video.off('pause', saveProgress);
    video.on('pause', () => saveProgress(false));

    video.off('loadedmetadata', setInitialTime);
    video.on('loadedmetadata', setInitialTime);
}

function setInitialTime() {
    const video = playerInstance;
    const episode = findEpisodeById(appState.currentPlaying.episodeId);
    
    const currentTime = video.currentTime();
    const duration = video.duration();

    if (episode && episode.currentTime > 0) {
        video.currentTime(Math.max(0, episode.currentTime - 1)); 
        setStatus(`Resuming playback for ${episode.title} at ${Math.floor(episode.currentTime)}s.`, false, false);
    } else {
        setStatus('Playback started.', false, false);
    }
    window.api.savePlaybackProgress(
        appState.currentPlaying.showId, 
        appState.currentPlaying.episodeId, 
        video.currentTime(), 
        video.duration(), 
        false
    );
}

// 🔥 MODIFIED: Enhance openPlayerView to handle missing video element
async function openPlayerView(showId, episodeId, fullPath) {
    console.log('[PLAYER] openPlayerView called for:', fullPath); // 🔥 NEW: Debug log

    // 1. Set state
    appState.currentPlaying = { showId, episodeId, fullPath };
    
    // 2. Dispose existing player to ensure clean state
    if (playerInstance) {
        try {
            console.log('[PLAYER] Disposing existing player'); // 🔥 NEW: Debug log
            playerInstance.dispose();
            playerInstance = null;
        } catch (error) {
            console.error('[PLAYER] Error disposing player:', error);
        }
    }
    
    // 3. Ensure video element exists
    let videoElement = document.getElementById('otaku-video-player');
    if (!videoElement) {
        console.warn('[PLAYER] Video element missing, recreating it');
        const playerView = document.getElementById('player-view');
        if (playerView) {
            // 🔥 NEW: Recreate video element if missing
            videoElement = document.createElement('video');
            videoElement.id = 'otaku-video-player';
            videoElement.className = 'video-js vjs-default-skin w-full h-full object-contain';
            videoElement.setAttribute('controls', '');
            videoElement.setAttribute('autoplay', '');
            playerView.appendChild(videoElement);
            console.log('[PLAYER] Video element recreated');
        } else {
            console.error('[PLAYER] Player view not found, cannot recreate video element');
            setStatus('Error: Player view not found', true, false);
            return;
        }
    }
    
    // 4. Reset video element
    videoElement.innerHTML = ''; // Clear any existing source elements
    videoElement.removeAttribute('src'); // Remove src attribute
    console.log('[PLAYER] Video element reset'); // 🔥 NEW: Debug log
    
    // 5. Show the player view
    if (elements.playerView && elements.mainContent) {
        elements.playerView.classList.remove('hidden');
        elements.mainContent.classList.add('hidden');
        console.log('[PLAYER] Player view shown'); // 🔥 NEW: Debug log
    } else {
        console.error('[PLAYER] Player view or main content element not found');
        setStatus('Error: UI elements not found', true, false);
        return;
    }
}

function closePlayerView() {
    console.log('[PLAYER] Closing player view'); // Debug log
    
    // Dispose of the player instance
    if (playerInstance) {
        try {
            console.log('[PLAYER] Disposing player instance'); // Debug log
            playerInstance.dispose();
            playerInstance = null;
        } catch (error) {
            console.error('[PLAYER] Error disposing player:', error);
        }
    } else {
        console.log('[PLAYER] No player instance to dispose'); // Debug log
    }
    
    // Reset video element
    let videoElement = document.getElementById('otaku-video-player');
    if (videoElement) {
        videoElement.innerHTML = ''; // Clear source elements
        videoElement.removeAttribute('src'); // Remove src attribute
        // 🔥 NEW: Remove Video.js classes to prevent conflicts
        videoElement.className = 'video-js vjs-default-skin w-full h-full object-contain';
        console.log('[PLAYER] Video element reset'); // Debug log
    } else {
        console.error('[PLAYER] Video element not found during cleanup');
        // 🔥 NEW: Attempt to recreate video element
        const playerView = document.getElementById('player-view');
        if (playerView) {
            videoElement = document.createElement('video');
            videoElement.id = 'otaku-video-player';
            videoElement.className = 'video-js vjs-default-skin w-full h-full object-contain';
            videoElement.setAttribute('controls', '');
            videoElement.setAttribute('autoplay', '');
            playerView.appendChild(videoElement);
            console.log('[PLAYER] Video element recreated during cleanup');
        }
    }
    
    // Update UI
    if (elements.playerView && elements.mainContent) {
        console.log('[PLAYER] Updating UI: hiding player, showing main content'); // Debug log
        elements.playerView.classList.add('hidden');
        elements.mainContent.classList.remove('hidden');
    } else {
        console.error('[PLAYER] Player view or main content element not found during UI update');
        setStatus('Error: UI elements not found', true, false);
    }
    
    // Reset current playing state
    appState.currentPlaying = { showId: null, episodeId: null, fullPath: null };
    
    setStatus('Player closed.', false, false);
}

function renderShows() {
    if (appState.shows.length === 0) {
        elements.sidebar.innerHTML = elements.showListTitle.outerHTML;
        elements.showListTitle.classList.add('hidden');
        
        elements.initialMessage.classList.remove('hidden'); 
        
        if (appState.libraryPaths.length > 0) {
             elements.initialScanInstruction.innerHTML = 'You have set your library paths. Click "**Scan Library**" to load your collection.';
        } else {
             elements.initialScanInstruction.innerHTML = 'Click the <i class="fa-solid fa-gear"></i> icon to add your media library paths, then click "**Scan Library**".';
        }
        return;
    }

    elements.initialMessage.classList.add('hidden');
    elements.showListTitle.classList.remove('hidden');

    let listHTML = ''; 
    
    appState.shows.forEach(show => {
        listHTML += `
            <div class="show-list-item px-6 py-3 cursor-pointer font-medium text-base border-l-4 border-transparent transition duration-150 hover:bg-gray-800" 
                 id="show-${show.id}" 
                 data-id="${show.id}">
                ${show.title}
            </div>
        `;
    });
    
    elements.sidebar.innerHTML = elements.sidebar.querySelector('.sidebar-title').outerHTML + listHTML;
    
    document.querySelectorAll('.show-list-item').forEach(el => {
        el.addEventListener('click', (e) => {
            setSelectedShow(e.currentTarget.dataset.id);
        });
    });

    const initialShowId = appState.selectedShowId || appState.shows[0].id;
    setSelectedShow(initialShowId);
}

function renderLibraryPaths() {
    elements.libraryPathsContainer.innerHTML = appState.libraryPaths.map((path, index) => `
        <div class="flex items-center bg-black p-3 rounded-lg border border-border-dark">
            <span class="truncate text-sm text-text-secondary flex-grow">${path}</span>
            <button class="remove-library-button text-red-500 hover:text-red-400 ml-4 transition duration-150" 
                    data-index="${index}" title="Remove Folder">
                <i class="fa-solid fa-trash-alt"></i>
            </button>
        </div>
    `).join('');

    document.querySelectorAll('.remove-library-button').forEach(button => {
        button.addEventListener('click', (e) => {
            const index = parseInt(e.currentTarget.dataset.index, 10);
            removeLibraryPath(index);
        });
    });
}

function openSettingsModal() {
    elements.settingsModal.classList.remove('hidden');
    elements.settingsModal.classList.add('flex');
    
    renderLibraryPaths();
    renderMetadataSettings();
}

function closeSettingsModal() {
    elements.settingsModal.classList.add('hidden');
    elements.settingsModal.classList.remove('flex');
}

async function fetchAndRenderPaths() {
    const response = await window.api.fetchLibraryPaths();
    if (response.success) {
        appState.libraryPaths = response.paths;
        renderLibraryPaths();
    } else {
        console.error('Failed to fetch library paths:', response.message);
    }
}

async function addLibraryPath() {
    setStatus('Opening directory dialog...', false, true);
    const newPath = await window.api.openDirectoryDialog();
    
    if (newPath) {
        if (!appState.libraryPaths.includes(newPath)) {
            appState.libraryPaths.push(newPath);
            
            const response = await window.api.saveLibraryPaths(appState.libraryPaths);
            
            if (response.success) {
                renderLibraryPaths();
                setStatus(`Added library folder: ${newPath}`, false, false);
            } else {
                setStatus(`Error saving path: ${response.message}`, true, false);
            }
        } else {
            setStatus('Folder already added.', true, false);
        }
    } else {
         setStatus('Ready.', false, false);
    }
}

async function removeLibraryPath(index) {
    if (index >= 0 && index < appState.libraryPaths.length) {
        const removedPath = appState.libraryPaths.splice(index, 1)[0];
        
        const response = await window.api.saveLibraryPaths(appState.libraryPaths);
        
        if (response.success) {
            renderLibraryPaths();
            setStatus(`Removed library folder: ${removedPath}`, false, false);
        } else {
            setStatus(`Error removing path: ${response.message}`, true, false);
        }
    }
}

function handleApiKeyChange(e) {
    appState.metadataSettings.providers.anilist.apiKey = e.target.value.trim();
    saveMetadataSettings();
}

function toggleApiKeySection() {
    const isHidden = elements.anilistApiKeySection.classList.toggle('hidden');
    elements.anilistApiSettingsBtn.querySelector('i').classList.toggle('fa-cog', isHidden);
    elements.anilistApiSettingsBtn.querySelector('i').classList.toggle('fa-times', !isHidden);
}

async function saveMetadataSettings() {
    const settingsToSave = JSON.parse(JSON.stringify(appState.metadataSettings));
    
    const response = await window.api.saveMetadataSettings(settingsToSave);

    if (!response.success) {
        console.error('Failed to save metadata settings:', response.message);
    }
}

function handleAnilistToggle(e) {
    appState.metadataSettings.providers.anilist.enabled = e.target.checked;
    saveMetadataSettings();
}

function renderMetadataSettings() {
    const anilistSettings = appState.metadataSettings.providers.anilist;
    
    elements.anilistToggle.checked = anilistSettings.enabled;
    elements.anilistApiKeyInput.value = anilistSettings.apiKey;
    
    elements.anilistToggle.removeEventListener('change', handleAnilistToggle);
    elements.anilistToggle.addEventListener('change', handleAnilistToggle);
    
    elements.anilistApiKeyInput.removeEventListener('input', handleApiKeyChange);
    elements.anilistApiKeyInput.addEventListener('input', handleApiKeyChange);

    elements.anilistApiSettingsBtn.removeEventListener('click', toggleApiKeySection);
    elements.anilistApiSettingsBtn.addEventListener('click', toggleApiKeySection);
}

async function fetchAndRenderMetadataSettings() {
    const response = await window.api.fetchMetadataSettings();
    if (response.success) {
        Object.assign(appState.metadataSettings.providers.anilist, response.settings.providers.anilist);
        renderMetadataSettings();
    } else {
        console.error('Failed to fetch metadata settings:', response.message);
    }
}

function renderDetailView(show) {
    let detailHTML = `
        <div class="show-header mb-12">
            <h1 class="show-title text-5xl font-extrabold text-white mb-2">${show.title}</h1>
            <p class="show-metadata text-text-secondary text-base mt-1">${show.anilistMetadata?.description || 'No description available.'}: Seasons found: ${show.seasons.length}</p>
            <p class="show-metadata text-text-secondary text-base mt-1">Root Path: ${show.rootPath}</p>
        </div>
        
        <select id="season-select" class="season-selector custom-select-bg bg-gray-700 text-white p-3 lg:px-5 border border-gray-600 rounded-lg text-xl cursor-pointer mb-8 w-full max-w-sm appearance-none">
            ${show.seasons.map((season, index) => `
                <option value="${index}" ${index === appState.selectedSeasonIndex ? 'selected' : ''}>
                    ${season.title} (${season.episodes.length} episodes)
                </option>
            `).join('')}
        </select>
        
        <div id="episode-list-container">
            </div>
    `;
    
    elements.detailView.innerHTML = detailHTML;
    
    const seasonSelect = document.getElementById('season-select');
    if (seasonSelect) {
        seasonSelect.addEventListener('change', (e) => {
            setSelectedSeason(e.target.value);
        });
    }
    
    const initialSeason = show.seasons[appState.selectedSeasonIndex];
    if (initialSeason) {
        renderEpisodes(initialSeason);
    } else {
        document.getElementById('episode-list-container').innerHTML = '<p class="text-text-secondary">No episodes found in this season.</p>';
    }
}

function renderEpisodes(season) {
    const container = document.getElementById('episode-list-container');
    if (!container) return;

    let episodeHTML = '<div class="episode-list grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">';
    
    season.episodes.forEach((episode, index) => {
        const episodeNumber = index + 1; 
        
        const progress = (episode.duration > 0 && episode.currentTime > 0) 
                         ? Math.floor((episode.currentTime / episode.duration) * 100) 
                         : 0;
        const progressDisplay = progress > 5 ? `${progress}%` : '';
        const statusColor = episode.isWatched ? 'border-green-500' : 
                            progress > 5 ? 'border-yellow-500' : 
                            'border-border-dark';
        
        episodeHTML += `
            <div class="episode-card bg-bg-card rounded-xl overflow-hidden flex shadow-2xl border ${statusColor} transition duration-200 hover:transform hover:-translate-y-1 hover:shadow-accent-purple/30 hover:border-accent-purple">
                <div class="episode-template-img w-32 min-h-36 bg-gray-800 flex flex-col items-center justify-center text-xl font-bold text-accent-purple p-2 text-center leading-tight bg-gradient-to-br from-gray-800 to-bg-card flex-shrink-0">
                    S${appState.selectedSeasonIndex + 1} E${episodeNumber}
                </div>
                <div class="episode-info p-4 flex-grow flex flex-col justify-between">
                    <div>
                        <div class="episode-title text-lg font-bold mb-1">${episode.title}</div>
                        <div class="episode-description text-sm text-text-secondary line-clamp-2 mb-3">
                            ${episode.isWatched ? '<i class="fa-solid fa-check text-green-500 mr-1"></i> Watched' : 
                             (progress > 5 ? `<i class="fa-solid fa-sync text-yellow-500 mr-1"></i> Progress: ${progressDisplay}` : 
                              '<i class="fa-solid fa-circle-notch text-text-secondary mr-1"></i> Unwatched')}
                        </div>
                    </div>
                    <button class="play-button bg-accent-purple text-white px-4 py-2 text-sm rounded-md font-semibold transition duration-200 hover:bg-purple-400 self-start mt-1" 
                            data-fullpath="${episode.fullPath}"
                            data-showid="${appState.selectedShowId}"
                            data-episodeid="${episode.id}">
                        <i class="fa-solid fa-play"></i> Play
                    </button>
                </div>
            </div>
        `;
    });
    
    episodeHTML += '</div>';
    container.innerHTML = episodeHTML;
    
    document.querySelectorAll('.play-button').forEach(button => {
        button.addEventListener('click', (e) => {
            const filePath = e.currentTarget.dataset.fullpath;
            const showId = e.currentTarget.dataset.showid;
            const episodeId = e.currentTarget.dataset.episodeid;
            
            openPlayerView(showId, episodeId, filePath);
        });
    });
}

// --- MAIN EVENT HANDLERS ---

document.addEventListener('DOMContentLoaded', async () => {
    // --- INITIAL SETUP ---
    
    // Verify closePlayerButton exists
    if (!elements.closePlayerButton) {
        console.error('[INIT] Close player button not found');
        setStatus('Error: Close player button not found', true, false);
    }
    
    // 🔥 NEW: Verify video element exists at startup
    if (!document.getElementById('otaku-video-player')) {
        console.error('[INIT] Video element not found at startup');
        setStatus('Error: Video player element not found at startup', true, false);
    }
    
    // 1. Fetch library paths first
    await fetchAndRenderPaths();
    // Fetch metadata settings on startup too
    await fetchAndRenderMetadataSettings(); 
    
    // 2. Initial load of cached data (PouchDB)
    window.api.fetchLibraryCache().then(response => {
        if (response.shows && response.shows.length > 0) {
            appState.shows = response.shows;
            setStatus(response.message);
            renderShows();
        } else {
            setStatus('Ready to scan. No local cache found.', false, false);
        }
    });

    // --- NEW PLAYER UI LISTENERS ---
    elements.closePlayerButton.addEventListener('click', () => {
        console.log('[EVENT] Close player button clicked');
        closePlayerView();
    });

    // --- EVENT LISTENERS ---
    elements.scanButton.addEventListener('click', async () => {
        if (appState.libraryPaths.length === 0) {
            setStatus('ERROR: Please add at least one library folder in Settings first.', true, false);
            return;
        }
        
        setStatus(`Scanning ${appState.libraryPaths.length} libraries... This may take a moment.`, false, true);
        
        const scanResponse = await window.api.scanAndCacheLibrary(appState.libraryPaths);
        
        if (scanResponse.success) {
            appState.shows = scanResponse.shows;
            setStatus(`Scan complete! Found ${scanResponse.shows.length} shows across ${appState.libraryPaths.length} libraries.`, false, false);
            renderShows();

            if (appState.metadataSettings.providers.anilist.enabled) {
                setStatus('Starting Anilist metadata refresh for all shows in background...', false, true);
                
                if (appState.shows.length > 0) {
                    for (const show of appState.shows) {
                        if (show.anilistMetadata) {
                            console.log(`Skipping metadata fetch for cached show: ${show.title}`);
                            continue;
                        }

                        setStatus(`Fetching metadata for ${show.title}...`, false, true);
                        try {
                            const metaResponse = await window.api.fetchAndCacheAnilistMetadata(show.title);
                            if (metaResponse.success) {
                                setStatus(`Metadata for ${show.title} updated.`, false, false);
                            } else {
                                setStatus(`Metadata error for ${show.title}: ${metaResponse.message}`, true, false);
                            }
                        } catch (error) {
                            setStatus(`Metadata fetch failed for ${show.title}: ${error.message}`, true, false);
                        }
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                    setStatus('Metadata refresh complete for all shows.', false, false);
                } else {
                    setStatus('Scan complete, but no shows found.', false, false);
                }
            }
        } else {
            setStatus(`Scan Error: ${scanResponse.message}`, true, false);
        }
    });

    elements.settingsButton.addEventListener('click', openSettingsModal);
    
    elements.closeSettingsButton.addEventListener('click', closeSettingsModal);
    elements.settingsModal.addEventListener('click', (e) => {
        if (e.target === elements.settingsModal) {
            closeSettingsModal();
        }
    });

    elements.addLibraryButton.addEventListener('click', addLibraryPath);
});