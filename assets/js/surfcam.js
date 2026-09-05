import { attachTideControl } from './tide-panel.mjs';
import { createFullscreenController } from './fullscreen-controller.mjs';
import { IS_MOBILE, IS_SAFARI_MOBILE, spaceHeld, hideBrowserUI, enterNativeFullScreen, exitNativeFullScreen } from './platform.mjs';
import { config } from './config.mjs';
import { createStreamStore, PLAYER_SETTINGS_KEY, STREAM_CONFIGS_KEY } from './stream-store.mjs';
import { parseHlsDateTime, parseHlsProgramDateTimes,
  formatTimestampTime, formatLagBehind, getPreviewCacheKey } from './timestamps.mjs';
import { mountPlayerView } from './player-view.mjs';
import { createResourceScope } from './resource-scope.mjs';
import { getVideoRange } from './media-timeline.mjs';
import { attachHlsPlayback, attachMp4Playback } from './playback-adapter.mjs';

    const PROXY_PREFIX = config.proxyPrefix;
    const TIMESTAMP_REFRESH_MS = 12000;
    const TIMESTAMP_RESYNC_DRIFT_MS = 3000;
    const TIMESTAMP_SCRUB_LINGER_MS = 1000;
    const PREVIEW_FRAME_WIDTH = 160;
    const PREVIEW_FRAME_HEIGHT = 90;
    const PREVIEW_CACHE_MAX_ENTRIES = 180;
    const store = createStreamStore();
    const { loadPlayerSettings, flushPlayerSettings, savePlayerSettings,
      getStreamList, saveStreamList } = store;
    window.addEventListener('pagehide', () => store.flushAll());

    function extractTitle(url) {
      const m = url.match(/wc-([^\/]+)\/playlist/);
      return m ? m[1] : url;
    }
    async function fetchTextWithProxyFallback(url, signal) {
      const proxiedUrl = PROXY_PREFIX + encodeURIComponent(url);
      const response = await fetch(proxiedUrl, { cache: 'no-store', signal });
      if (!response.ok) throw new Error(`Manifest fetch failed: ${response.status}`);
      return response.text();
    }

    async function loadTimestampManifest(url, depth = 0, signal) {
      const text = await fetchTextWithProxyFallback(url, signal);
      const parsed = parseHlsProgramDateTimes(text, url);
      if (!parsed.segments.length && parsed.variants.length && depth < 1) {
        return loadTimestampManifest(parsed.variants[0], depth + 1, signal);
      }
      return parsed;
    }

    function setTimestampAnchor(player, mediaTime, wallTimeMs, source, confidence) {
      if (!player || !Number.isFinite(mediaTime) || !Number.isFinite(wallTimeMs)) return;
      const current = player.timestampAnchor;
      if (current?.confidence === 'exact' && confidence !== 'exact') return;
      if (current) {
        const expectedMs = current.wallTimeMs + (mediaTime - current.mediaTime) * 1000;
        if (Math.abs(expectedMs - wallTimeMs) < TIMESTAMP_RESYNC_DRIFT_MS && current.confidence === confidence) return;
      }
      player.timestampAnchor = {
        mediaTime,
        wallTimeMs,
        source,
        confidence,
        updatedAt: Date.now()
      };
    }

    function setEstimatedLiveTimestampAnchor(player) {
      if (!player || player.timestampAnchor?.confidence === 'exact') return;
      const range = getVideoRange(player.video);
      if (!range || !Number.isFinite(range.end)) return;
      setTimestampAnchor(player, range.end, Date.now(), 'browser-live-edge', 'estimated');
    }

    function applyHlsFragmentTimestamp(player, frag) {
      if (!frag) return;
      const programDateTimeMs = parseHlsDateTime(frag.programDateTime ?? frag.rawProgramDateTime);
      const mediaTime = Number.isFinite(frag.start) ? frag.start : player.video?.currentTime;
      if (programDateTimeMs != null && Number.isFinite(mediaTime)) {
        setTimestampAnchor(player, mediaTime, programDateTimeMs, 'program-date-time', 'exact');
      }
    }

    function getPlayerTimestamp(player, mediaTime = player?.video?.currentTime) {
      const anchor = player?.timestampAnchor;
      if (!anchor || !Number.isFinite(mediaTime)) return null;
      return {
        ms: anchor.wallTimeMs + (mediaTime - anchor.mediaTime) * 1000,
        source: anchor.source,
        confidence: anchor.confidence
      };
    }

    function createTimelinePreviewHud(progressBar) {
      const hud = document.createElement('div');
      hud.className = 'timeline-preview-hud';
      hud.hidden = true;

      const frame = document.createElement('div');
      frame.className = 'timeline-preview-frame is-missing';

      const image = document.createElement('img');
      image.className = 'timeline-preview-image';
      image.alt = '';
      image.draggable = false;

      const missing = document.createElement('div');
      missing.className = 'timeline-preview-missing';
      missing.textContent = 'No frame';

      const label = document.createElement('div');
      label.className = 'timestamp-scrub-bubble';
      label.textContent = '-00:00:00';

      frame.appendChild(image);
      frame.appendChild(missing);
      hud.appendChild(frame);
      hud.appendChild(label);
      progressBar.appendChild(hud);
      return { root: hud, frame, image, missing, label };
    }

    function createCornerTimestampOverlay(parent) {
      const overlay = document.createElement('div');
      overlay.className = 'corner-timestamp-overlay is-estimated';
      overlay.textContent = '--:--:--';
      overlay.hidden = true;
      parent.appendChild(overlay);
      return overlay;
    }

    function getCachedPreviewFrame(player, mediaTime) {
      if (!player?.timelineFrameCache || !Number.isFinite(mediaTime)) return null;
      return player.timelineFrameCache.get(getPreviewCacheKey(mediaTime)) || null;
    }

    function storePreviewFrame(player, mediaTime) {
      if (!player || !Number.isFinite(mediaTime)) return false;
      const video = player.video;
      if (!video || video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) return false;
      try {
        const canvas = player.previewCaptureCanvas || document.createElement('canvas');
        canvas.width = PREVIEW_FRAME_WIDTH;
        canvas.height = PREVIEW_FRAME_HEIGHT;
        const ctx = canvas.getContext('2d');
        if (!ctx) return false;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        player.previewCaptureCanvas = canvas;
        if (!player.timelineFrameCache) player.timelineFrameCache = new Map();
        player.timelineFrameCache.set(getPreviewCacheKey(mediaTime), canvas.toDataURL('image/jpeg', 0.65));
        while (player.timelineFrameCache.size > PREVIEW_CACHE_MAX_ENTRIES) {
          const oldestKey = player.timelineFrameCache.keys().next().value;
          player.timelineFrameCache.delete(oldestKey);
        }
        return true;
      } catch {
        return false;
      }
    }

    function updateCornerTimestampOverlay(player, overlay, mediaTime) {
      if (!overlay) return;
      const timestamp = getPlayerTimestamp(player, mediaTime);
      if (!timestamp) {
        overlay.textContent = '--:--:--';
        overlay.classList.add('is-estimated');
      } else {
        overlay.textContent = formatTimestampTime(timestamp.ms);
        overlay.classList.toggle('is-estimated', timestamp.confidence === 'estimated');
      }
    }

    function updateTimelinePreviewHud(player, hud, mediaTime, percent) {
      if (!hud) return;
      const range = getVideoRange(player?.video);
      const lagSeconds = range && Number.isFinite(range.end) ? Math.max(0, range.end - mediaTime) : 0;
      const cachedFrame = getCachedPreviewFrame(player, mediaTime);
      hud.label.textContent = formatLagBehind(lagSeconds);
      const clampedPercent = Math.max(0, Math.min(100, percent));
      const trackWidth = hud.root.parentElement?.clientWidth || 0;
      const hudWidth = hud.root.offsetWidth || 0;
      if (trackWidth > 0 && hudWidth > 0) {
        const targetX = trackWidth * (clampedPercent / 100);
        const halfHudWidth = hudWidth / 2;
        const clampedX = Math.max(halfHudWidth, Math.min(trackWidth - halfHudWidth, targetX));
        hud.root.style.left = `${clampedX}px`;
      } else {
        hud.root.style.left = `${clampedPercent}%`;
      }
      hud.frame.classList.toggle('is-missing', !cachedFrame);
      if (cachedFrame) hud.image.src = cachedFrame;
    }

    function showTimelinePreview(player, hud, cornerOverlay, mediaTime, percent) {
      if (!player || !hud) return;
      player.timelinePreviewState = { hud, cornerOverlay, mediaTime, percent };
      if (player.cornerTimestampHideTimer) {
        clearTimeout(player.cornerTimestampHideTimer);
        player.cornerTimestampHideTimer = null;
      }
      hud.root.hidden = false;
      if (cornerOverlay) cornerOverlay.hidden = false;
      updateTimelinePreviewHud(player, hud, mediaTime, percent);
      updateCornerTimestampOverlay(player, cornerOverlay, mediaTime);
    }

    function hideTimelinePreview(player, hud) {
      if (!hud) return;
      hud.root.hidden = true;
      if (player?.timelinePreviewState?.hud === hud) player.timelinePreviewState = null;
    }

    function hideCornerTimestampOverlay(player, overlay, linger = false) {
      if (!overlay) return;
      if (player?.cornerTimestampHideTimer) {
        clearTimeout(player.cornerTimestampHideTimer);
        player.cornerTimestampHideTimer = null;
      }
      if (!linger || !player?.trackTimeout) {
        overlay.hidden = true;
        return;
      }
      player.cornerTimestampHideTimer = player.trackTimeout(() => {
        overlay.hidden = true;
        player.cornerTimestampHideTimer = null;
      }, TIMESTAMP_SCRUB_LINGER_MS);
    }

    function refreshTimelinePreview(player) {
      const state = player?.timelinePreviewState;
      if (!state) return;
      updateTimelinePreviewHud(player, state.hud, state.mediaTime, state.percent);
      updateCornerTimestampOverlay(player, state.cornerOverlay, state.mediaTime);
    }

    function captureCurrentPreviewFrame(player) {
      if (!player?.video || !Number.isFinite(player.video.currentTime)) return;
      const key = getPreviewCacheKey(player.video.currentTime);
      if (player.lastPreviewCaptureKey === key) return;
      if (storePreviewFrame(player, player.video.currentTime)) {
        player.lastPreviewCaptureKey = key;
        refreshTimelinePreview(player);
      }
    }

    function startManifestTimestampSync(player, url) {
      if (!player || !url) return;
      const sync = async () => {
        if (player.disposed || player.timestampManifestInFlight) return;
        player.timestampManifestInFlight = true;
        try {
          const parsed = await loadTimestampManifest(url, 0, player.resources.signal);
          if (player.disposed) return;
          const last = parsed.segments[parsed.segments.length - 1];
          const video = player.video;
          const range = getVideoRange(video);
          if (last && range && Number.isFinite(range.end)) {
            setTimestampAnchor(player, range.end, last.endWallTimeMs, 'manifest-live-edge', 'estimated');
          } else {
            setEstimatedLiveTimestampAnchor(player);
          }
        } catch (error) {
          if (player.disposed || error?.name === 'AbortError') return;
          console.warn('Timestamp manifest sync failed:', error);
          setEstimatedLiveTimestampAnchor(player);
        } finally {
          player.timestampManifestInFlight = false;
        }
      };
      sync();
      player.trackInterval(sync, TIMESTAMP_REFRESH_MS);
    }

    // Helper to create safe IDs for elements
    function createSafeId(prefix, url) {
      // Basic encoding + replace characters not allowed in CSS selectors/IDs
      return `${prefix}-${encodeURIComponent(url).replace(/[.%*+?^${}()|[\]\\]/g,'_')}`;
    }
    // Modify clampPan to accept canvas and use its dimensions
    function clampPan(container, canvas) { // Added canvas argument
      const Z = container.zoomScale;
      // Use actual canvas dimensions
      const W = canvas.width;
      const H = canvas.height;
      if (Z <= 1) {
        container.panX = 0;
        container.panY = 0;
        return;
      }
      // Calculate max pan distance based on zoom and current canvas size
      const mx = (W * (Z - 1)) / (2 * Z);
      const my = (H * (Z - 1)) / (2 * Z);
      container.panX = Math.min(mx, Math.max(-mx, container.panX));
      container.panY = Math.min(my, Math.max(-my, container.panY));
    }
    function getTouchDistance(t1, t2) {
      const dx = t1.clientX - t2.clientX;
      const dy = t1.clientY - t2.clientY;
      return Math.hypot(dx, dy);
    }
    function getTouchMidpoint(t1, t2) {
      return { x: (t1.clientX + t2.clientX)/2, y: (t1.clientY + t2.clientY)/2 };
    }

    const sidebar = document.getElementById("sidebar");
    const sidebarToggle = document.getElementById("sidebarToggle");
    const streamListContainer = document.getElementById("streamList");
    const mainContent = document.getElementById("main-content");
    const modalBackdrop = document.getElementById("modalBackdrop");
    const urlModal = document.getElementById("urlModal");
    const urlInput = document.getElementById("urlInput");
    const saveUrlsBtn = document.getElementById("saveUrls");
    const btnAddUrls = document.getElementById("btn-add-urls");
    const btnShowAll = document.getElementById("btn-show-all");
    const btnHideAll = document.getElementById("btn-hide-all");

    let activeSidebarLabels = new Set();
    let sidebarDragStartState = null;
    let isSidebarDragging = false;
    let players = {}; // Store player instances { url: { container, video, hls, animationFrameId, overlays?, offscreenCanvas?, isBuffering?, ... } }
    function createBufferingIndicator() {
      const indicator = document.createElement('div');
      indicator.className = 'buffering-indicator';
      indicator.hidden = true;
      indicator.setAttribute('role', 'status');
      indicator.setAttribute('aria-live', 'polite');
      indicator.innerHTML = `
        <span class="buffering-spinner" aria-hidden="true"></span>
        <span class="buffering-label">Loading video…</span>`;
      return indicator;
    }

    function refreshBufferingIndicators() {
      Object.values(players).forEach(player => {
        if (player.syncBufferingIndicator) player.syncBufferingIndicator();
      });
    }

    function updateStreamSidebar() {
      streamListContainer.innerHTML = "";
      const streams = getStreamList();
      if (!streams.length) {
        const p = document.createElement("p");
        p.className = "no-streams";
        p.textContent = "No streams added. Click 'Add URLs'.";
        streamListContainer.appendChild(p);
      } else {
        streams.forEach(stream => {
          const item = document.createElement("div");
          item.className = "stream-item";
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = stream.enabled;
          checkbox.dataset.url = stream.url;
          // Use createSafeId for checkbox ID
          checkbox.id = createSafeId('cb', stream.url);
          checkbox.addEventListener("change", e => {
            updateStreamEnabled(stream.url, e.target.checked);
          });
          item.appendChild(checkbox);
          const label = document.createElement("label");
          label.textContent = extractTitle(stream.url);
          // Use createSafeId for label's htmlFor
          label.htmlFor = checkbox.id;
          label.dataset.url = stream.url;
          label.addEventListener("mousedown", e => {
            if (e.button === 0) {
              e.preventDefault();
              isSidebarDragging = true;
              sidebarDragStartState = checkbox.checked;
              activeSidebarLabels.clear();
              activeSidebarLabels.add(label);
              item.classList.add('selecting');
            }
          });
          label.addEventListener("mouseenter", e => {
            if (isSidebarDragging && (e.buttons & 1)) {
              activeSidebarLabels.add(label);
              item.classList.add('selecting');
            }
          });
          item.appendChild(label);
          streamListContainer.appendChild(item);
        });
      }
    }
    document.addEventListener("mouseup", e => {
      if (e.button === 0 && isSidebarDragging) {
        isSidebarDragging = false;
        const labelsToToggle = new Set(activeSidebarLabels);
        activeSidebarLabels.clear();
        document.querySelectorAll('.stream-item.selecting').forEach(el => el.classList.remove('selecting'));
        if (labelsToToggle.size) {
          const targetState = !sidebarDragStartState;
          labelsToToggle.forEach(label => {
            const url = label.dataset.url;
            // Use createSafeId to find the checkbox
            const cb = document.getElementById(createSafeId('cb', url));
            if (cb) {
              cb.checked = targetState;
              updateStreamEnabled(url, targetState);
            }
          });
        }
        sidebarDragStartState = null;
      }
    });
    streamListContainer.addEventListener('contextmenu', e => {
      if (isSidebarDragging) e.preventDefault();
    });

    function reorderPlayers() {
      const streams = getStreamList();
      const sorted = Array.from(mainContent.children)
        .filter(el => el.classList.contains('player-container'))
        .sort((a,b) => {
          const iA = streams.findIndex(s => s.url === a.dataset.url);
          const iB = streams.findIndex(s => s.url === b.dataset.url);
          if (iA === -1) return 1;
          if (iB === -1) return -1;
          return iA - iB;
        });
      sorted.forEach(el => mainContent.appendChild(el));
    }
    function updateStreamEnabled(url, enabled) {
      let streams = getStreamList();
      const idx = streams.findIndex(s => s.url === url);
      const existing = players[url];

      // A URL can have just been removed from the saved list. It still needs
      // to be disposed; otherwise its media, timers, and global listeners
      // survive with no way for the sidebar to reach them.
      if (idx === -1) {
        if (existing) disposePlayer(existing, url);
        return;
      }

      streams[idx].enabled = enabled;
      saveStreamList(streams);
      if (enabled) {
        if (!existing) {
          const built = createPlayerContainer(streams[idx]);
          if (built) {
            mainContent.appendChild(built.container);
            players[url] = built; // Store the built player object
          }
        } else {
          if (!existing.container.isConnected) mainContent.appendChild(existing.container);
          existing.container.style.display = "flex";
          if (existing.hls && !existing.hls.media) existing.hls.attachMedia(existing.video);
          if (existing.hls) existing.hls.startLoad();
          else if (existing.video.src && existing.video.paused) existing.video.play().catch(()=>{});
          // Ensure video plays if autoplay is intended or if it was playing before being hidden
          if (existing.video.autoplay || !existing.video.paused) existing.video.play().catch(()=>{});
        }
      } else {
        if (existing) {
          disposePlayer(existing, url);
        }
      }
      fullscreen.refresh();
      reorderPlayers();
      updateStreamSidebar(); // Update sidebar to reflect checkbox state
    }

    function disposePlayer(player, url) {
      if (!player) return;
      fullscreen.remove(player);
      flushPlayerSettings(url);
      if (player.tidesCleanup) {
        player.tidesCleanup();
        player.tidesCleanup = null;
      }
      ["swipeLoaderCleanup", "swipeTitleCleanup", "swipeWarmCleanup"].forEach(key => {
        if (player[key]) {
          player[key]();
          player[key] = null;
        }
      });
      player.swipeWarmReady = false;
      player.swipeWarmError = false;
      if (player.cleanupResources) player.cleanupResources();
      if (player.hls) {
        player.hls.destroy();
        player.hls = null;
      }
      player.video.pause();
      player.video.removeAttribute("src");
      player.video.load();
      if (player.offscreenCanvas) {
        player.offscreenCanvas.width = 0;
        player.offscreenCanvas.height = 0;
        player.offscreenCanvas = null;
        player.offscreenCtx = null;
      }
      if (player.container.classList.contains("player-fullscreen-mobile")) {
        exitPseudoFullscreen(player.container, player.video);
      }
      player.container.remove();
      delete players[url];
    }

    // Function to handle canvas resizing on fullscreen change or window resize
    function resizeCanvas(playerObj) {
        if (!playerObj || !playerObj.canvas || !playerObj.container) return;

        const canvas = playerObj.canvas;
        const wrapper = playerObj.container.querySelector('.canvas-wrapper');
        const isFs = document.fullscreenElement === playerObj.container || document.webkitFullscreenElement === playerObj.container;

        let targetWidth, targetHeight;

        if (isFs) {
            targetWidth = wrapper.clientWidth;
            targetHeight = wrapper.clientHeight;
        } else {
            // Use default non-fullscreen size or calculate based on container?
            // Sticking to fixed size for now when not fullscreen.
            targetWidth = 960;
            targetHeight = 540;
        }

        // Only resize if dimensions actually changed
        if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
            canvas.width = targetWidth;
            canvas.height = targetHeight;

            // Resize offscreen canvas too
            if (playerObj.offscreenCanvas) {
                playerObj.offscreenCanvas.width = targetWidth;
                playerObj.offscreenCanvas.height = targetHeight;
            }
            console.log(`Resized canvas for ${playerObj.container.dataset.url} to ${targetWidth}x${targetHeight}`);

            // The active renderer observes the size on its next frame. Avoid
            // calling the player-local render function from this outer scope.
        }
    }


    function createPlayerContainer(stream) {
      if (!stream || !stream.enabled) return null;
      const url = stream.url;
      const saved = loadPlayerSettings(url);
      const container = document.createElement("div");
      container.className = `player-container ${IS_MOBILE?"mobile":"desktop"}`;
      container.dataset.url = url;
      // Initialize pan/zoom state on the container object
      container.zoomScale = saved.zoomScale;
      container.panX = saved.panX;
      container.panY = saved.panY;

      const video = document.createElement("video");
      video.className = "source-video";
      video.setAttribute("playsinline","");
      video.setAttribute("webkit-playsinline","");
      video.setAttribute("crossorigin","anonymous"); // Needed for canvas drawing
      video.muted = true; // Mute by default, especially for HLS/Canvas
      video.preload = "metadata";
      video.autoplay = true; // Autoplay often needed for live streams

      const isMp4 = url.toLowerCase().endsWith('.mp4');
      const title = extractTitle(url);

      // --- Player object to be returned ---
      // Define it here so we can add properties like overlays, offscreenCanvas later
      const playerObject = {
          container,
          video,
          hls: null,
          animationFrameId: null,
          overlays: null,        // Will hold overlay state if applicable
          offscreenCanvas: null, // Will hold the offscreen canvas for masking
          offscreenCtx: null,    // Context for the offscreen canvas
          isBuffering: false,    // Flag for buffering state
          stallPause: false,     // True when we paused the video ourselves due to a network stall
          wantsToPlay: video.autoplay,
          bufferingIndicator: null,
          suppressBufferingIndicator: false,
          syncBufferingIndicator: null,
          updateTimeline: null,
          timestampAnchor: null,
          timestampManifestInFlight: false,
          timelineFrameCache: new Map(),
          previewCaptureCanvas: null,
          timelinePreviewState: null,
          cornerTimestampHideTimer: null,
          lastPreviewCaptureKey: null,
          canvas: null,          // Reference to the main canvas
          resizeHandler: null,   // Reference to the resize handler function
          fullscreenPreload: null,
          fullscreenPriorityActive: false,
          swipeLoaderCleanup: null,
          swipeLoadError: null,
          swipeTitleCleanup: null,
          swipeWarmCleanup: null,
          swipeWarmReady: false,
          swipeWarmError: false,
          disposed: false
      };

      const resources = createResourceScope();
      playerObject.resources = resources;
      playerObject.addListener = resources.listen;
      playerObject.trackTimeout = resources.timeout;
      playerObject.trackInterval = resources.interval;
      playerObject.cleanupResources = () => {
        if (playerObject.disposed) return;
        playerObject.disposed = true;
        resources.dispose();
        if (playerObject.animationFrameId) cancelAnimationFrame(playerObject.animationFrameId);
        playerObject.animationFrameId = null;
        playerObject.timestampManifestInFlight = false;
        playerObject.timelineFrameCache.clear();
        playerObject.previewCaptureCanvas = null;
        playerObject.timelinePreviewState = null;
        playerObject.lastPreviewCaptureKey = null;
        if (playerObject.cornerTimestampHideTimer) clearTimeout(playerObject.cornerTimestampHideTimer);
        playerObject.cornerTimestampHideTimer = null;
      };


      mountPlayerView(playerObject, {
        url, title, isMp4, isMobile: IS_MOBILE, enterPseudoFullscreen,
        enterNativeFullScreen, exitNativeFullScreen, attachTideControl,
        updateStreamEnabled, savePlayerSettings, resizeCanvas,
        createTimelinePreviewHud, createCornerTimestampOverlay,
        showTimelinePreview, hideTimelinePreview, hideCornerTimestampOverlay,
        createBufferingIndicator, createSafeId, clampPan, isSpaceHeld: () => spaceHeld
      });

      if (isMp4) attachMp4Playback(playerObject, { url, isMobile: IS_MOBILE });
      else attachHlsPlayback(playerObject, {
        url, isMobile: IS_MOBILE, captureCurrentPreviewFrame,
        applyHlsFragmentTimestamp, startManifestTimestampSync
      });

      // Return the fully constructed player object
      return playerObject;
    }

    const fullscreen = createFullscreenController({
      players, getStreamList, refreshBufferingIndicators, extractTitle,
      createTimelinePreviewHud, createCornerTimestampOverlay, showTimelinePreview,
      hideTimelinePreview, hideCornerTimestampOverlay, getTouchDistance, getTouchMidpoint,
      savePlayerSettings, attachTideControl
    });
    const enterPseudoFullscreen = fullscreen.enter;
    const exitPseudoFullscreen = fullscreen.exit;

    /* --- Modal Logic --- */
    function openUrlModal() {
      const streams = getStreamList();
      // Populate textarea with current URLs
      urlInput.value = streams.map(s => s.url).join("\n");
      modalBackdrop.style.display = "block";
      urlModal.style.display = "block";
      document.body.style.overflow = 'hidden'; // Prevent background scroll
    }
    function closeUrlModal() {
      modalBackdrop.style.display = "none";
      urlModal.style.display = "none";
      document.body.style.overflow = ''; // Restore scroll
    }
    function saveUrlsAndClose() {
      // Get URLs from textarea, clean up, and filter valid ones
      const urls = urlInput.value.split("\n")
                      .map(l => l.trim())
                      .filter(l => l && (l.startsWith("http://") || l.startsWith("https://")));
      const existing = getStreamList();
      const newList = [];
      const seen = new Set(); // Track URLs in the new list

      // Build new list, preserving enabled state if URL existed before
      urls.forEach(u => {
        if (!seen.has(u)) { // Avoid duplicates from input
            seen.add(u);
            const ex = existing.find(s => s.url === u);
            newList.push({ url: u, enabled: ex ? ex.enabled : true }); // Default to enabled for new URLs
        }
      });

      saveStreamList(newList); // Save the updated list to localStorage

      // Remove players for URLs no longer in the list
      Object.keys(players).forEach(u => {
        if (!seen.has(u)) {
          updateStreamEnabled(u, false); // This handles removal
        }
      });

      // Add/update players for URLs in the new list
      newList.forEach(cfg => {
        // updateStreamEnabled handles both adding new and ensuring existing are visible if enabled
        updateStreamEnabled(cfg.url, cfg.enabled);
      });

      closeUrlModal();
      updateStreamSidebar(); // Refresh sidebar display
      reorderPlayers(); // Ensure player order matches list order
    }

    function reconcileStoredStreams() {
      const streams = getStreamList();
      const enabled = new Set(streams.filter(stream => stream.enabled).map(stream => stream.url));
      Object.entries(players).forEach(([url, player]) => {
        if (!enabled.has(url)) disposePlayer(player, url);
      });
      streams.forEach(stream => {
        if (stream.enabled && !players[stream.url]) {
          const player = createPlayerContainer(stream);
          if (player) {
            mainContent.appendChild(player.container);
            players[stream.url] = player;
          }
        }
      });
      updateStreamSidebar();
      reorderPlayers();
      fullscreen.refresh();
    }

    window.addEventListener('storage', event => {
      if (event.key !== null && event.key !== PLAYER_SETTINGS_KEY && event.key !== STREAM_CONFIGS_KEY) return;
      store.refreshFromStorage();
      if (event.key === null || event.key === STREAM_CONFIGS_KEY) reconcileStoredStreams();
    });

    /* --- App Initialization --- */
    function initializeApp() {
      updateStreamSidebar(); // Populate sidebar initially

      // Load enabled streams from localStorage
      const streams = getStreamList();
      streams.forEach(stream => {
        if (stream.enabled) {
          const p = createPlayerContainer(stream);
          if (p) {
            mainContent.appendChild(p.container);
            players[stream.url] = p; // Store player instance
          }
        }
      });
      reorderPlayers(); // Initial player order

      // Sidebar button listeners
      btnShowAll.addEventListener("click", () => {
        getStreamList().forEach(s => { if (!s.enabled) updateStreamEnabled(s.url, true); });
      });
      btnHideAll.addEventListener("click", () => {
        getStreamList().forEach(s => { if (s.enabled) updateStreamEnabled(s.url, false); });
      });

      // Modal listeners
      btnAddUrls.addEventListener("click", openUrlModal);
      modalBackdrop.addEventListener("click", closeUrlModal);
      saveUrlsBtn.addEventListener("click", saveUrlsAndClose);

      // Global Escape key listener
      window.addEventListener("keydown", e => {
        if (e.key === "Escape") {
          if (urlModal.style.display === "block") {
            closeUrlModal();
          } else if (document.querySelector('.player-fullscreen-mobile')) {
            // Exit mobile pseudo-fullscreen
            const fs = document.querySelector('.player-fullscreen-mobile');
            if (fs && players[fs.dataset.url]) {
              exitPseudoFullscreen(fs, players[fs.dataset.url].video);
            }
          } else if (document.fullscreenElement || document.webkitFullscreenElement) {
            // Exit native desktop fullscreen
            exitNativeFullScreen();
          }
        }
      });

      // Mobile-specific sidebar toggle logic
      if (IS_MOBILE) {
        sidebar.classList.add("hidden"); // Start hidden on mobile
        sidebarToggle.style.display = "block"; // Show toggle button

        let sidebarTouchStartX = null;
        let sidebarTouchStartY = null;
        let sidebarGestureBlocked = false;
        let mainGestureBlocked = false;
        const swipeThreshold = 50;
        const openMobileSidebar = () => {
          sidebar.classList.remove("hidden");
          sidebarToggle.style.display = "none";
        };
        const closeMobileSidebar = () => {
          sidebar.classList.add("hidden");
          sidebarToggle.style.display = "block";
        };

        // A left swipe on the open sidebar closes it.
        sidebar.addEventListener("touchstart", e => {
          const touch = e.changedTouches[0];
          sidebarTouchStartX = touch.clientX;
          sidebarTouchStartY = touch.clientY;
          sidebarGestureBlocked = e.target.closest('button, input, a') !== null;
        }, { passive: true });
        sidebar.addEventListener("touchend", e => {
          if (sidebarTouchStartX === null) return;
          const touch = e.changedTouches[0];
          const deltaX = touch.clientX - sidebarTouchStartX;
          const deltaY = touch.clientY - sidebarTouchStartY;
          if (!sidebarGestureBlocked && deltaX < -swipeThreshold && Math.abs(deltaX) > Math.abs(deltaY)) {
            closeMobileSidebar();
          }
          sidebarTouchStartX = null;
          sidebarTouchStartY = null;
          sidebarGestureBlocked = false;
        });

        // Toggle button opens sidebar
        sidebarToggle.addEventListener("click", openMobileSidebar);

        // In the default view, a right swipe opens and a left swipe closes.
        let mainTouchStartX = null;
        let mainTouchStartY = null;
        mainContent.addEventListener("touchstart", e => {
          if (document.querySelector('.player-fullscreen-mobile') || urlModal.style.display === "block") return;
          const touch = e.changedTouches[0];
          mainTouchStartX = touch.clientX;
          mainTouchStartY = touch.clientY;
          mainGestureBlocked = e.target.closest('button, input, a, .progress-bar, .controls-container') !== null;
        }, { passive: true }); // Passive listener for performance
        mainContent.addEventListener("touchend", e => {
          if (mainTouchStartX === null || document.querySelector('.player-fullscreen-mobile') || urlModal.style.display === "block") return;
          const touch = e.changedTouches[0];
          const deltaX = touch.clientX - mainTouchStartX;
          const deltaY = touch.clientY - mainTouchStartY;
          if (!mainGestureBlocked && Math.abs(deltaX) > swipeThreshold && Math.abs(deltaX) > Math.abs(deltaY)) {
            if (deltaX > 0 && sidebar.classList.contains("hidden")) openMobileSidebar();
            else if (deltaX < 0 && !sidebar.classList.contains("hidden")) closeMobileSidebar();
          } else if (!sidebar.classList.contains("hidden") &&
                     !e.target.closest('button, input, a, .player-container')) {
            closeMobileSidebar();
          }
          mainTouchStartX = null;
          mainTouchStartY = null;
          mainGestureBlocked = false;
        }, { passive: true });
      }
    }

    // Wait for DOM content to load before initializing
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initializeApp);
    } else {
      initializeApp(); // Initialize immediately if already loaded
    }
  
