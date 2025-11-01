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
      fullPath: null,
      metadata: null
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
  anilistApiSettingsBtn: document.getElementById('anilist-api-settings-btn'),
  // Track selection elements
  audioTrackButton: document.getElementById('audio-track-button'),
  audioTrackMenu: document.getElementById('audio-track-menu'),
  audioTrackList: document.getElementById('audio-track-list'),
  subtitleTrackButton: document.getElementById('subtitle-track-button'),
  subtitleTrackMenu: document.getElementById('subtitle-track-menu'),
  subtitleTrackList: document.getElementById('subtitle-track-list')
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

function setInitialTime() {
    const video = playerInstance;
    const episode = findEpisodeById(appState.currentPlaying.episodeId);
    
    const currentTime = video.currentTime();
    const duration = video.duration();

    console.log(`[PLAYER] Duration detected: ${duration}s, Current time: ${currentTime}s`);

    // If duration is not available, try to get it from metadata
    if (!duration || isNaN(duration) || duration === Infinity) {
        console.log('[PLAYER] Duration not available, trying to get from metadata...');
        
        // Try to get duration from stored metadata
        const metadata = appState.currentPlaying.metadata;
        if (metadata && metadata.duration) {
            console.log(`[PLAYER] Using metadata duration: ${metadata.duration}s`);
            // Video.js doesn't have a direct way to set duration, but we can trigger an event
            video.trigger('durationchange');
        }
        
        // Set up a listener for when duration becomes available
        video.on('durationchange', () => {
            const newDuration = video.duration();
            console.log(`[PLAYER] Duration changed to: ${newDuration}s`);
            if (newDuration && !isNaN(newDuration) && newDuration !== Infinity) {
                setStatus(`Video loaded (${Math.floor(newDuration / 60)}:${String(Math.floor(newDuration % 60)).padStart(2, '0')})`, false, false);
            }
        });
    }

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
        video.duration() || 0, 
        false
    );
}

function setupPlayerListeners() {
    const video = playerInstance;
    
    // Ensure all previous listeners are removed before adding new ones
    video.off('timeupdate', saveProgress);
    video.on('timeupdate', () => saveProgress(false));

    video.off('ended', saveProgress);
    video.on('ended', () => {
        saveProgress(true);
        setStatus('Playback finished. Click the X to return to the library.', false, false);
    });

    video.off('pause', saveProgress);
    video.on('pause', () => saveProgress(false));

    video.off('loadedmetadata', setInitialTime);
    video.on('loadedmetadata', setInitialTime);
    
    // Additional listeners for timeline/duration issues
    video.off('loadeddata');
    video.on('loadeddata', () => {
        console.log('[PLAYER] Video data loaded, duration:', video.duration());
    });
    
    video.off('canplay');
    video.on('canplay', () => {
        console.log('[PLAYER] Video can start playing, duration:', video.duration());
        const duration = video.duration();
        if (duration && !isNaN(duration) && duration !== Infinity) {
            setStatus(`Ready to play (${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, '0')})`, false, false);
        }
    });
    
    video.off('progress');
    video.on('progress', () => {
        // This helps with buffering indication
        const buffered = video.buffered();
        if (buffered.length > 0) {
            const bufferedEnd = buffered.end(buffered.length - 1);
            const duration = video.duration();
            if (duration && !isNaN(duration)) {
                const percentBuffered = (bufferedEnd / duration) * 100;
                console.log(`[PLAYER] Buffered: ${percentBuffered.toFixed(1)}%`);
            }
        }
    });
}

// --- AUTO-HIDE CONTROLS ---
let mouseInactiveTimer = null;
let isMouseOverVideo = false;

function setupAutoHideControls() {
    const playerContainer = elements.playerView;
    const videoElement = elements.videoPlayer;
    
    console.log('[CONTROLS] setupAutoHideControls called', { playerContainer, videoElement });
    
    if (!playerContainer || !videoElement) {
        console.log('[CONTROLS] Missing elements, cannot setup auto-hide');
        return;
    }
    
    // Get custom UI elements
    const customControls = document.getElementById('custom-player-controls');
    const backButton = document.getElementById('close-player-button');
    
    console.log('[CONTROLS] Custom elements found:', { customControls, backButton });
    
    // Show controls when mouse moves
    function showControls() {
        console.log('[CONTROLS] showControls called, playerInstance:', !!playerInstance);
        
        if (playerInstance) {
            playerInstance.userActive(true);
            console.log('[CONTROLS] Set Video.js userActive to true');
        }
        
        // Show custom UI elements
        if (customControls) {
            customControls.style.opacity = '1';
            customControls.style.visibility = 'visible';
            console.log('[CONTROLS] Showed custom controls');
        }
        if (backButton) {
            backButton.style.opacity = '1';
            backButton.style.visibility = 'visible';
            console.log('[CONTROLS] Showed back button');
        }
        
        // Clear existing timer
        if (mouseInactiveTimer) {
            clearTimeout(mouseInactiveTimer);
            mouseInactiveTimer = null;
        }
        
        console.log('[CONTROLS] Mouse active - showing controls');
    }
    
    // Hide controls after inactivity
    function hideControls() {
        console.log('[CONTROLS] hideControls called', { playerInstance: !!playerInstance, isMouseOverVideo });
        
        if (playerInstance && isMouseOverVideo) {
            playerInstance.userActive(false);
            console.log('[CONTROLS] Set Video.js userActive to false');
            
            // Hide custom UI elements
            if (customControls) {
                customControls.style.opacity = '0';
                customControls.style.visibility = 'hidden';
                console.log('[CONTROLS] Hid custom controls');
            }
            if (backButton) {
                backButton.style.opacity = '0';
                backButton.style.visibility = 'hidden';
                console.log('[CONTROLS] Hid back button');
            }
            
            console.log('[CONTROLS] Mouse inactive - hiding controls');
        }
    }
    
    // Mouse move handler
    function onMouseMove() {
        if (!isMouseOverVideo) return;
        
        showControls();
        
        // Set timer to hide controls after 3 seconds of inactivity
        if (mouseInactiveTimer) {
            clearTimeout(mouseInactiveTimer);
        }
        
        mouseInactiveTimer = setTimeout(hideControls, 3000);
    }
    
    // Mouse enter/leave handlers
    function onMouseEnter() {
        isMouseOverVideo = true;
        showControls();
        console.log('[CONTROLS] Mouse entered video area');
    }
    
    function onMouseLeave() {
        isMouseOverVideo = false;
        hideControls();
        console.log('[CONTROLS] Mouse left video area');
        
        if (mouseInactiveTimer) {
            clearTimeout(mouseInactiveTimer);
            mouseInactiveTimer = null;
        }
    }
    
    // Add event listeners
    playerContainer.addEventListener('mousemove', onMouseMove);
    playerContainer.addEventListener('mouseenter', onMouseEnter);
    playerContainer.addEventListener('mouseleave', onMouseLeave);
    
    // Also handle touch events for mobile
    playerContainer.addEventListener('touchstart', showControls);
    playerContainer.addEventListener('touchmove', showControls);
    
    // Show controls initially
    showControls();
    
    // Cleanup function (called when player is disposed)
    if (playerInstance) {
        playerInstance.on('dispose', () => {
            playerContainer.removeEventListener('mousemove', onMouseMove);
            playerContainer.removeEventListener('mouseenter', onMouseEnter);
            playerContainer.removeEventListener('mouseleave', onMouseLeave);
            playerContainer.removeEventListener('touchstart', showControls);
            playerContainer.removeEventListener('touchmove', showControls);
            
            if (mouseInactiveTimer) {
                clearTimeout(mouseInactiveTimer);
                mouseInactiveTimer = null;
            }
        });
    }
}

// --- TRACK MANAGEMENT FUNCTIONS ---

function formatLanguage(langCode) {
    const languageMap = {
        'jpn': 'Japanese',
        'eng': 'English', 
        'spa': 'Spanish',
        'fre': 'French',
        'ger': 'German',
        'kor': 'Korean',
        'chi': 'Chinese',
        'rus': 'Russian',
        'por': 'Portuguese',
        'ita': 'Italian',
        'und': 'Unknown'
    };
    return languageMap[langCode] || langCode.toUpperCase();
}

function populateAudioTracks(audioTracks) {
    const audioList = elements.audioTrackList;
    if (!audioList) return;
    
    audioList.innerHTML = '';
    
    audioTracks.forEach((track, index) => {
        const trackItem = document.createElement('div');
        trackItem.className = 'track-menu-item p-3 flex justify-between items-center border-b border-border-dark last:border-b-0';
        trackItem.setAttribute('data-track-index', index); // Use array index, not track.index
        
        const trackInfo = document.createElement('div');
        trackInfo.innerHTML = `
            <div class="font-medium">${track.title}</div>
            <div class="text-xs text-text-secondary">${track.codec.toUpperCase()} • ${track.channels}ch • ${Math.round(track.sampleRate/1000)}kHz</div>
        `;
        
        const languageTag = document.createElement('span');
        languageTag.className = 'track-language-tag';
        languageTag.textContent = formatLanguage(track.language);
        
        trackItem.appendChild(trackInfo);
        trackItem.appendChild(languageTag);
        
        // Set first track as active by default
        if (index === 0) {
            trackItem.classList.add('active');
        }
        
        trackItem.addEventListener('click', () => selectAudioTrack(index, trackItem)); // Use array index
        audioList.appendChild(trackItem);
    });
}

function populateSubtitleTracks(subtitleTracks) {
    const subtitleList = elements.subtitleTrackList;
    if (!subtitleList) return;
    
    subtitleList.innerHTML = '';
    
    // Add "None" option
    const noneItem = document.createElement('div');
    noneItem.className = 'track-menu-item p-3 flex justify-between items-center border-b border-border-dark active';
    noneItem.setAttribute('data-track-index', '-1');
    noneItem.innerHTML = `
        <div class="font-medium">None</div>
        <span class="track-language-tag">OFF</span>
    `;
    noneItem.addEventListener('click', () => selectSubtitleTrack(-1, noneItem));
    subtitleList.appendChild(noneItem);
    
    subtitleTracks.forEach((track) => {
        const trackItem = document.createElement('div');
        trackItem.className = 'track-menu-item p-3 flex justify-between items-center border-b border-border-dark last:border-b-0';
        trackItem.setAttribute('data-track-index', track.index);
        
        const trackInfo = document.createElement('div');
        const forcedText = track.forced ? ' [FORCED]' : '';
        trackInfo.innerHTML = `
            <div class="font-medium">${track.title}${forcedText}</div>
            <div class="text-xs text-text-secondary">${track.codec.toUpperCase()}</div>
        `;
        
        const languageTag = document.createElement('span');
        languageTag.className = 'track-language-tag';
        languageTag.textContent = formatLanguage(track.language);
        
        trackItem.appendChild(trackInfo);
        trackItem.appendChild(languageTag);
        
        trackItem.addEventListener('click', () => selectSubtitleTrack(track.index, trackItem));
        subtitleList.appendChild(trackItem);
    });
}

async function selectAudioTrack(trackIndex, selectedElement) {
    // Update UI
    document.querySelectorAll('#audio-track-list .track-menu-item').forEach(item => {
        item.classList.remove('active');
    });
    selectedElement.classList.add('active');
    
    // Hide menu
    elements.audioTrackMenu.classList.add('hidden');
    
    if (!playerInstance) {
        console.error('[PLAYER] No player instance available');
        return;
    }
    
    // Save current playback position and playing state
    const currentTime = playerInstance.currentTime();
    const wasPlaying = !playerInstance.paused();
    
    try {
        setStatus('Switching audio track...', false, true);
        
        // First, notify server about the audio track selection
        const switchResponse = await window.api.switchAudioTrack(trackIndex);
        
        if (switchResponse.success) {
            console.log(`[PLAYER] Audio track selected: ${switchResponse.message}`);
            
            // Dispose current player to ensure clean restart
            if (playerInstance) {
                playerInstance.pause();
                playerInstance.dispose();
                playerInstance = null;
            }
            
            // Wait a moment for cleanup
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Restart the player completely with new audio track
            await restartPlayerWithAudioTrack(trackIndex, currentTime, wasPlaying);
            
        } else {
            console.error('[PLAYER] Failed to switch audio track:', switchResponse.message);
            setStatus(`Error switching audio track: ${switchResponse.message}`, true, false);
        }
    } catch (error) {
        console.error('[PLAYER] Error during audio track switch:', error);
        setStatus(`Error switching audio track: ${error.message}`, true, false);
    }
}

async function restartPlayerWithAudioTrack(trackIndex, resumeTime, autoplay) {
    try {
        // Ensure video element exists and is clean
        let videoElement = document.getElementById('otaku-video-player');
        if (videoElement) {
            videoElement.innerHTML = '';
            videoElement.removeAttribute('src');
        } else {
            // Recreate video element if it doesn't exist
            const playerView = document.getElementById('player-view');
            videoElement = document.createElement('video');
            videoElement.id = 'otaku-video-player';
            videoElement.className = 'video-js vjs-default-skin w-full h-full object-contain';
            videoElement.setAttribute('controls', '');
            playerView.appendChild(videoElement);
        }
        
        // Initialize new Video.js player with subtitle support
        playerInstance = videojs(videoElement, {
            controls: true,
            autoplay: autoplay,
            fluid: true,
            responsive: true,
            preload: 'auto',
            html5: {
                vhs: {
                    overrideNative: true
                },
                nativeTextTracks: false
            },
            textTrackDisplay: {
                allowMultipleShowingTracks: false
            }
        });
        
        // Start new stream with selected audio track
        const streamResponse = await window.api.startFFmpegStream(
            appState.currentPlaying.fullPath, 
            { audioTrack: trackIndex }
        );
        
        if (streamResponse.success) {
                // Set the source for the new player
                let videoType = 'video/mp4'; // Default for transcoded content
                if (streamResponse.format && !streamResponse.needsTranscoding) {
                    switch (streamResponse.format) {
                        case '.mp4':
                            videoType = 'video/mp4';
                            break;
                        case '.webm':
                            videoType = 'video/webm';
                            break;
                        default:
                            videoType = 'video/mp4';
                    }
                } else {
                    // All transcoded content is MP4
                    videoType = 'video/mp4';
                }
                
                playerInstance.src({
                    src: streamResponse.url,
                    type: videoType
                });            // Set up event listeners
            setupPlayerListeners();
            
            // Wait for metadata and restore position
            playerInstance.one('loadedmetadata', () => {
                if (resumeTime > 0) {
                    playerInstance.currentTime(resumeTime);
                    console.log(`[PLAYER] Restored playback position to ${resumeTime}s`);
                }
                
                if (autoplay) {
                    playerInstance.play().catch(err => {
                        console.log('[PLAYER] Autoplay prevented:', err);
                    });
                }
            });
            
            const trackName = appState.currentPlaying.metadata.audioTracks[trackIndex]?.title || `Audio Track ${trackIndex + 1}`;
            setStatus(`Switched to ${trackName}`, false, false);
            console.log(`[PLAYER] Successfully switched to audio track ${trackIndex}: ${trackName}`);
            
        } else {
            console.error('[PLAYER] Failed to start new stream:', streamResponse.message);
            setStatus(`Error restarting stream: ${streamResponse.message}`, true, false);
        }
    } catch (error) {
        console.error('[PLAYER] Error restarting player:', error);
        setStatus(`Error restarting player: ${error.message}`, true, false);
    }
}

function selectSubtitleTrack(trackIndex, selectedElement) {
    // Update UI
    document.querySelectorAll('#subtitle-track-list .track-menu-item').forEach(item => {
        item.classList.remove('active');
    });
    selectedElement.classList.add('active');
    
    // Hide menu
    elements.subtitleTrackMenu.classList.add('hidden');
    
    if (trackIndex === -1) {
        // Disable all subtitles
        if (playerInstance && playerInstance.textTracks) {
            const textTracks = playerInstance.textTracks();
            for (let i = 0; i < textTracks.length; i++) {
                textTracks[i].mode = 'disabled';
            }
        }
        console.log('[PLAYER] Disabled subtitles');
        setStatus('Subtitles disabled', false, false);
    } else {
        // Enable selected subtitle track
        const subtitleUrl = `http://localhost:8080/subtitle?track=${trackIndex}`;
        
        if (playerInstance) {
            try {
                // Remove all existing text tracks
                const textTracks = playerInstance.textTracks();
                for (let i = textTracks.length - 1; i >= 0; i--) {
                    const track = textTracks[i];
                    if (track.mode !== undefined) {
                        track.mode = 'disabled';
                    }
                    try {
                        playerInstance.removeRemoteTextTrack(track);
                    } catch (e) {
                        console.log('[SUBTITLE] Could not remove track:', e);
                    }
                }
                
                // Wait a moment for cleanup
                setTimeout(() => {
                    // Add new subtitle track
                    const metadata = appState.currentPlaying.metadata;
                    if (metadata && metadata.subtitleTracks[trackIndex]) {
                        const track = metadata.subtitleTracks[trackIndex];
                        
                        const trackElement = playerInstance.addRemoteTextTrack({
                            kind: 'subtitles',
                            src: subtitleUrl,
                            srclang: track.language || 'en',
                            label: track.title,
                            default: false
                        }, false);
                        
                        // Enable the track after it's added
                        setTimeout(() => {
                            if (trackElement && trackElement.track) {
                                trackElement.track.mode = 'showing';
                                console.log(`[PLAYER] Subtitle track mode set to: ${trackElement.track.mode}`);
                            }
                            
                            // Also try to enable via textTracks array
                            const allTracks = playerInstance.textTracks();
                            for (let i = 0; i < allTracks.length; i++) {
                                if (allTracks[i].label === track.title) {
                                    allTracks[i].mode = 'showing';
                                    console.log(`[PLAYER] Found and enabled subtitle track: ${track.title}`);
                                    break;
                                }
                            }
                        }, 500);
                        
                        console.log(`[PLAYER] Added subtitle track ${trackIndex}: ${track.title} (${subtitleUrl})`);
                        setStatus(`Enabled subtitles: ${track.title}`, false, false);
                    }
                }, 100);
                
            } catch (error) {
                console.error('[PLAYER] Error handling subtitle track:', error);
                setStatus(`Error enabling subtitles: ${error.message}`, true, false);
            }
        }
    }
}

async function openPlayerView(showId, episodeId, fullPath) {
    console.log('[PLAYER] openPlayerView called for:', fullPath);
    console.log('[DEBUG] Code version check - auto-hide and timeline fixes loaded');

    // 1. Get media metadata first
    try {
        setStatus('Loading media information...', false, true);
        const metadataResponse = await window.api.getMediaMetadata(fullPath);
        
        if (!metadataResponse.success) {
            console.error('[PLAYER] Failed to get metadata:', metadataResponse.message);
            setStatus('Error: Failed to read media information', true, false);
            return;
        }
        
        console.log('[PLAYER] Media metadata loaded:', metadataResponse);
        
        // Set state with metadata
        appState.currentPlaying = { 
            showId, 
            episodeId, 
            fullPath, 
            metadata: metadataResponse 
        };
        
        // Populate track selection UI
        populateAudioTracks(metadataResponse.audioTracks);
        populateSubtitleTracks(metadataResponse.subtitleTracks);
        
    } catch (error) {
        console.error('[PLAYER] Error loading metadata:', error);
        setStatus('Error: Failed to load media information', true, false);
        return;
    }
    
    // 2. Dispose existing player to ensure clean state
    if (playerInstance) {
        try {
            console.log('[PLAYER] Disposing existing player');
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
    console.log('[PLAYER] Video element reset');

    // 5. Show the player view
    if (elements.playerView && elements.mainContent) {
        elements.playerView.classList.remove('hidden');
        elements.mainContent.classList.add('hidden');
        console.log('[PLAYER] Player view shown');
    } else {
        console.error('[PLAYER] Player view or main content element not found');
        setStatus('Error: UI elements not found', true, false);
        return;
    }

    // 6. Initialize Video.js player
    try {
        playerInstance = videojs(videoElement, {
            controls: true,
            autoplay: true,
            fluid: true,
            responsive: true,
            preload: 'auto',
            html5: {
                vhs: {
                    overrideNative: true
                },
                nativeTextTracks: false
            },
            textTrackDisplay: {
                allowMultipleShowingTracks: false
            },
            controlBar: { 
                children: [
                    'playToggle',
                    'volumePanel',
                    'progressControl',
                    'currentTimeDisplay',
                    'durationDisplay',
                    'remainingTimeDisplay',
                    'customControlSpacer',
                    'playbackRateMenuButton',
                    'subsCapsButton',
                    'fullscreenToggle'
                ]
            }
        });
        console.log('[PLAYER] Video.js player initialized with subtitle support.');
    } catch (error) {
        console.error('[PLAYER] Error initializing Video.js player:', error);
        setStatus('Error: Failed to initialize video player', true, false);
        return;
    }

    // 7. Fetch streaming URL from main process
    try {
        setStatus('Starting video stream...', false, true);
        const streamResponse = await window.api.startFFmpegStream(fullPath);
        
        if (streamResponse.success) {
            console.log('[PLAYER] Stream URL received:', streamResponse.url);
            
            // 8. Set the source for the Video.js player
            // Determine video type based on response format and transcoding status
            let videoType = 'video/mp4'; // Default for transcoded content
            if (streamResponse.format && !streamResponse.needsTranscoding) {
                switch (streamResponse.format) {
                    case '.mp4':
                        videoType = 'video/mp4';
                        break;
                    case '.webm':
                        videoType = 'video/webm';
                        break;
                    default:
                        videoType = 'video/mp4';
                }
            } else {
                // All transcoded content is MP4
                videoType = 'video/mp4';
            }

            playerInstance.src({
                src: streamResponse.url,
                type: videoType
            });

            // For transcoded videos, manually set duration to enable timeline
            if (streamResponse.needsTranscoding && appState.currentPlaying.metadata && appState.currentPlaying.metadata.duration) {
                const duration = appState.currentPlaying.metadata.duration;
                console.log(`[PLAYER] Setting duration for transcoded video: ${duration}s`);
                
                // Multiple approaches to set duration for timeline
                const setupDuration = () => {
                    console.log(`[PLAYER] setupDuration called, current duration: ${playerInstance.duration()}`);
                    
                    // Monkey patch the duration method to return the correct duration
                    const originalDuration = playerInstance.duration.bind(playerInstance);
                    playerInstance.duration = function(seconds) {
                        if (typeof seconds !== 'undefined') {
                            return originalDuration(seconds);
                        }
                        // Return the known duration from metadata
                        console.log(`[PLAYER] Duration method called, returning: ${duration}`);
                        return duration;
                    };
                    
                    // Set the tech duration directly
                    const tech = playerInstance.tech();
                    if (tech && tech.el_) {
                        console.log(`[PLAYER] Setting tech duration to: ${duration}`);
                        tech.el_.duration = duration;
                    }
                    
                    // Force update the progress control
                    const progressControl = playerInstance.getChild('ControlBar').getChild('ProgressControl');
                    if (progressControl) {
                        console.log(`[PLAYER] Found progress control, updating`);
                        progressControl.updateContent();
                    }
                    
                    // Trigger duration change event to update UI
                    playerInstance.trigger('durationchange');
                    playerInstance.trigger('timeupdate');
                    console.log(`[PLAYER] Duration patched for timeline: ${duration}s, triggered events`);
                };
                
                // Try multiple times to ensure it works
                playerInstance.ready(setupDuration);
                playerInstance.on('loadedmetadata', setupDuration);
                playerInstance.on('canplay', setupDuration);
                playerInstance.on('playing', setupDuration);
                
                // Also try after delays
                setTimeout(setupDuration, 500);
                setTimeout(setupDuration, 1500);
                setTimeout(setupDuration, 3000);
            }

            // 9. Setup player listeners
            setupPlayerListeners();
            
            // 10. Setup auto-hide controls after a delay to ensure DOM is ready
            setTimeout(() => {
                console.log('[PLAYER] Setting up auto-hide controls after delay');
                setupAutoHideControls();
            }, 500);
            
            // 11. Attempt to play the video
            playerInstance.play().catch(error => {
                console.error('[PLAYER] Playback error:', error);
                setStatus(`Error playing video: ${error.message}`, true, false);
            });

            setStatus('Playback started.', false, false);
        } else {
            console.error('[PLAYER] Failed to start stream:', streamResponse.message);
            setStatus(`Error: ${streamResponse.message}`, true, false);
            playerInstance.dispose();
            playerInstance = null;
        }
    } catch (error) {
        console.error('[PLAYER] Error fetching stream URL:', error);
        setStatus(`Error: Failed to start video stream - ${error.message}`, true, false);
        if (playerInstance) {
            playerInstance.dispose();
            playerInstance = null;
        }
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
        // Remove Video.js classes to prevent conflicts
        videoElement.className = 'video-js vjs-default-skin w-full h-full object-contain';
        console.log('[PLAYER] Video element reset'); // Debug log
    } else {
        console.error('[PLAYER] Video element not found during cleanup');
        // Attempt to recreate video element
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
    appState.currentPlaying = { showId: null, episodeId: null, fullPath: null, metadata: null };
    
    // Hide track menus
    if (elements.audioTrackMenu) elements.audioTrackMenu.classList.add('hidden');
    if (elements.subtitleTrackMenu) elements.subtitleTrackMenu.classList.add('hidden');
    
    // MINIMAL CHANGE C (Fix): Refresh the episode list to reflect progress/watched status only when closing the player.
    const show = appState.shows.find(s => s.id === appState.selectedShowId);
    if (show) {
        renderDetailView(show); 
    }

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
    
    // Verify video element exists at startup
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

    // --- TRACK SELECTION EVENT LISTENERS ---
    
    // Audio track button
    elements.audioTrackButton.addEventListener('click', (e) => {
        e.stopPropagation();
        elements.audioTrackMenu.classList.toggle('hidden');
        elements.subtitleTrackMenu.classList.add('hidden'); // Hide subtitle menu
    });

    // Subtitle track button  
    elements.subtitleTrackButton.addEventListener('click', (e) => {
        e.stopPropagation();
        elements.subtitleTrackMenu.classList.toggle('hidden');
        elements.audioTrackMenu.classList.add('hidden'); // Hide audio menu
    });

    // Close menus when clicking outside
    document.addEventListener('click', (e) => {
        if (!elements.audioTrackButton.contains(e.target) && !elements.audioTrackMenu.contains(e.target)) {
            elements.audioTrackMenu.classList.add('hidden');
        }
        if (!elements.subtitleTrackButton.contains(e.target) && !elements.subtitleTrackMenu.contains(e.target)) {
            elements.subtitleTrackMenu.classList.add('hidden');
        }
    });

    // Prevent menu from closing when clicking inside
    elements.audioTrackMenu.addEventListener('click', (e) => {
        e.stopPropagation();
    });
    
    elements.subtitleTrackMenu.addEventListener('click', (e) => {
        e.stopPropagation();
    });
});