import { IS_MOBILE, IS_SAFARI_MOBILE, hideBrowserUI } from './platform.mjs';
import { getVideoRange, isTimeBuffered } from './media-timeline.mjs';
const SEEK_THROTTLE_MS = 250;
const SEEK_THROTTLE_BUFFERED_MS = 50;

export function createFullscreenController({
  players, getStreamList, refreshBufferingIndicators, extractTitle,
  createTimelinePreviewHud, createCornerTimestampOverlay, showTimelinePreview,
  hideTimelinePreview, hideCornerTimestampOverlay, getTouchDistance, getTouchMidpoint,
  savePlayerSettings, attachTideControl
}) {
    /* --- Mobile Pseudo-Fullscreen Logic --- */
    // Keep the owner with the cleanup. During a swipe handoff there can be two
    // fullscreen-classed containers briefly, so a later exit must not invoke
    // the other player's controls cleanup.
    let pseudoFsSession = null;
    let fullscreenPriorityPlayer = null;

    function prioritizeFullscreenPlayer(player) {
      if (!IS_MOBILE || !player || player.disposed) return;

      const video = player.video;
      fullscreenPriorityPlayer = player;
      if (player.fullscreenPreload === null) {
        player.fullscreenPreload = video.preload || '';
      }
      player.fullscreenPriorityActive = true;
      video.preload = 'auto';

      // Promote only the visible fullscreen stream. Background players remain
      // alive, including the adjacent streams prepared for swipe transitions.
      if (player.hls && typeof player.hls.startLoad === 'function') {
        try { player.hls.startLoad(); } catch {}
      }

      // Native HLS and MP4 rely on the media element's preload policy.
      if (!player.hls && video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        try { video.load(); } catch {}
      }

      if (video.paused) {
        if (player.requestPlay) player.requestPlay({ allowWhileBuffering: true });
        else video.play().catch(() => {});
      }
    }

    function clearFullscreenPlayerPriority(player) {
      if (!player || fullscreenPriorityPlayer !== player) return;

      if (player.fullscreenPreload !== null) {
        player.video.preload = player.fullscreenPreload;
      }
      player.fullscreenPreload = null;
      player.fullscreenPriorityActive = false;
      fullscreenPriorityPlayer = null;
    }

    function nextAnimationFrame() {
      return new Promise(resolve => requestAnimationFrame(() => resolve()));
    }

    /* --- Compositor-safe mobile swipe deck ---
       These implementations never move a video element between parents. */
    let activeFullscreenSwipe = null;
    const SWIPE_START_PX = 20;
    const SWIPE_COMMIT_PX = 50;
    const SWIPE_SETTLE_MS = 200;
    const SWIPE_SETTLE_FALLBACK_MS = 350;
    const SWIPE_TITLE_VISIBLE_MS = 1000;
    const SWIPE_TITLE_FADE_MS = 180;

    function clampSwipeOffset(direction, dx, width) {
      if (direction > 0) return Math.max(0, Math.min(width, dx));
      return Math.min(0, Math.max(-width, dx));
    }

    function makeSwipeTitle(overlay, text) {
      const title = document.createElement('div');
      title.className = 'fs-swipe-title';
      title.textContent = text;
      title.style.transform = 'translate3d(0, 0, 0) translateX(-50%)';
      overlay.appendChild(title);
      return title;
    }

    function isSwipeVideoRenderable(video) {
      return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        video.videoWidth > 0 && video.videoHeight > 0;
    }

    // A decoded frame is a stronger signal than readyState alone. The latter
    // can be populated before the compositor has presented anything, which is
    // exactly when a fullscreen swipe can expose a black destination frame.
    function watchSwipeVideoFrame(player, { onReady, onError } = {}) {
      const video = player.video;
      const eventNames = ['loadeddata', 'canplay', 'playing', 'seeked'];
      let disposed = false;
      let resolved = false;
      let frameRequestId = null;
      let rafId = null;

      function clearFrameWatch() {
        if (frameRequestId !== null && typeof video.cancelVideoFrameCallback === 'function') {
          try { video.cancelVideoFrameCallback(frameRequestId); } catch {}
        }
        frameRequestId = null;
        if (rafId !== null) cancelAnimationFrame(rafId);
        rafId = null;
        eventNames.forEach(event => video.removeEventListener(event, checkFrame));
        video.removeEventListener('error', handleError);
      }

      function finishReady() {
        if (disposed || resolved) return;
        resolved = true;
        clearFrameWatch();
        if (onReady) onReady();
      }

      function fallbackFrameCheck() {
        if (disposed || resolved || !isSwipeVideoRenderable(video) || rafId !== null) return;
        let frames = 0;
        const tick = () => {
          if (disposed || resolved) return;
          if (++frames >= 2) finishReady();
          else rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
      }

      function handleError() {
        if (disposed || resolved) return;
        if (onError) onError();
      }

      function checkFrame() {
        if (disposed || resolved) return;
        if (video.error) {
          handleError();
          return;
        }
        if (!isSwipeVideoRenderable(video)) return;

        fallbackFrameCheck();
        if (typeof video.requestVideoFrameCallback === 'function' && frameRequestId === null) {
          try {
            frameRequestId = video.requestVideoFrameCallback(() => {
              frameRequestId = null;
              finishReady();
            });
          } catch {
            frameRequestId = null;
          }
        }
      }

      eventNames.forEach(event => video.addEventListener(event, checkFrame));
      video.addEventListener('error', handleError);
      checkFrame();

      return () => {
        if (disposed) return;
        disposed = true;
        clearFrameWatch();
      };
    }

    function createSwipeLoader(player) {
      if (player.swipeLoaderCleanup) player.swipeLoaderCleanup();

      const loader = document.createElement('div');
      loader.className = 'fs-swipe-loader';
      loader.setAttribute('role', 'status');
      loader.setAttribute('aria-live', 'polite');
      loader.setAttribute('aria-busy', 'true');
      loader.innerHTML = `
        <div class="fs-swipe-loader-content">
          <div class="fs-swipe-loader-spinner" aria-hidden="true"></div>
          <div class="fs-swipe-loader-message">Loading ${extractTitle(player.container.dataset.url)}…</div>
        </div>`;
      player.container.appendChild(loader);
      player.suppressBufferingIndicator = true;
      if (player.syncBufferingIndicator) player.syncBufferingIndicator();

      const message = loader.querySelector('.fs-swipe-loader-message');
      const spinner = loader.querySelector('.fs-swipe-loader-spinner');
      let disposed = false;
      let resolved = false;
      let fadeTimer = null;
      let frameCleanup = null;

      const removeLoader = () => {
        if (disposed) return;
        disposed = true;
        if (frameCleanup) frameCleanup();
        if (fadeTimer) clearTimeout(fadeTimer);
        if (player.swipeLoadError === showError) player.swipeLoadError = null;
        if (player.swipeLoaderCleanup === cleanup) player.swipeLoaderCleanup = null;
        player.suppressBufferingIndicator = false;
        if (player.syncBufferingIndicator) player.syncBufferingIndicator();
        loader.remove();
      };

      const finishReady = () => {
        if (disposed || resolved) return;
        resolved = true;
        loader.setAttribute('aria-busy', 'false');
        loader.classList.add('fade-out');
        fadeTimer = setTimeout(removeLoader, 180);
      };

      const showError = () => {
        if (disposed || resolved) return;
        loader.classList.remove('fade-out');
        loader.setAttribute('aria-busy', 'false');
        if (spinner) spinner.style.display = 'none';
        if (message) message.textContent = `Unable to load ${extractTitle(player.container.dataset.url)}.`;
      };

      const cleanup = () => {
        if (disposed) return;
        removeLoader();
      };

      player.swipeLoadError = showError;
      player.swipeLoaderCleanup = cleanup;
      frameCleanup = watchSwipeVideoFrame(player, {
        onReady: finishReady,
        onError: showError
      });

      return { loader, cleanup, showError };
    }

    let fullscreenSwipeWarm = null;

    function getAdjacentSwipePlayers(activeUrl) {
      const enabledUrls = getStreamList()
        .filter(stream => stream.enabled)
        .map(stream => stream.url);
      const currentIndex = enabledUrls.indexOf(activeUrl);
      if (enabledUrls.length < 2 || currentIndex === -1) return [];

      const indexes = new Set([
        (currentIndex - 1 + enabledUrls.length) % enabledUrls.length,
        (currentIndex + 1) % enabledUrls.length
      ]);
      return Array.from(indexes)
        .map(index => players[enabledUrls[index]])
        .filter(Boolean);
    }

    function ensureSwipePlayerPlaying(player) {
      const video = player.video;

      // HLS.js can stop loading after a stall or visibility change. Restart
      // its loader while the player is part of the warm neighbor set.
      if (player.hls && typeof player.hls.startLoad === 'function') {
        try { player.hls.startLoad(); } catch {}
      }

      // Keep the app's existing autoplay policy. HLS players are muted and
      // autoplay-enabled; audio-capable MP4 players are intentionally not
      // started just to prepare a swipe destination.
      if ((video.muted || video.autoplay) && video.paused) {
        if (player.requestPlay) player.requestPlay();
        else video.play().catch(() => {});
      }
    }

    function warmSwipePlayer(player) {
      if (!player || player.swipeWarmCleanup) return;

      player.swipeWarmReady = false;
      player.swipeWarmError = false;
      player.swipeWarmCleanup = watchSwipeVideoFrame(player, {
        onReady: () => {
          player.swipeWarmReady = true;
          player.swipeWarmError = false;
        },
        onError: () => {
          player.swipeWarmError = true;
        }
      });
      ensureSwipePlayerPlaying(player);
    }

    function updateFullscreenSwipeWarm(activeUrl) {
      if (!activeUrl) return;
      const desired = new Set(getAdjacentSwipePlayers(activeUrl));

      if (!fullscreenSwipeWarm) {
        fullscreenSwipeWarm = { activeUrl, players: new Set() };
      }
      fullscreenSwipeWarm.activeUrl = activeUrl;

      for (const player of fullscreenSwipeWarm.players) {
        if (desired.has(player)) continue;
        if (player.swipeWarmCleanup) player.swipeWarmCleanup();
        player.swipeWarmCleanup = null;
        player.swipeWarmReady = false;
        player.swipeWarmError = false;
      }

      desired.forEach(warmSwipePlayer);
      fullscreenSwipeWarm.players = desired;
    }

    function clearFullscreenSwipeWarm() {
      if (!fullscreenSwipeWarm) return;
      for (const player of fullscreenSwipeWarm.players) {
        if (player.swipeWarmCleanup) player.swipeWarmCleanup();
        player.swipeWarmCleanup = null;
        player.swipeWarmReady = false;
        player.swipeWarmError = false;
      }
      fullscreenSwipeWarm = null;
    }

    function updateSwipePosition(drag, rawDx) {
      const dx = clampSwipeOffset(drag.direction, rawDx, drag.viewportWidth);
      const targetX = dx - drag.direction * drag.viewportWidth;
      drag.currentOffset = dx;
      drag.targetOffset = targetX;
      drag.current.style.setProperty('--fs-swipe-x', `${dx}px`);
      drag.target.style.setProperty('--fs-swipe-x', `${targetX}px`);
      if (drag.currentTitle) {
        drag.currentTitle.style.transform = `translate3d(${dx}px, 0, 0) translateX(-50%)`;
      }
      drag.targetTitle.style.transform = `translate3d(${targetX}px, 0, 0) translateX(-50%)`;
      return dx;
    }

    function promoteSwipeTitle(drag) {
      const title = drag.targetTitle;
      const player = drag.targetPlayer;
      if (!title || !player) return;

      if (player.swipeTitleCleanup) player.swipeTitleCleanup();
      title.style.transform = 'translate3d(0, 0, 0) translateX(-50%)';
      title.style.opacity = '1';
      title.style.zIndex = '2060';
      title.style.transition = `opacity ${SWIPE_TITLE_FADE_MS}ms ease`;
      drag.target.appendChild(title);

      let disposed = false;
      let hideTimer = null;
      let removeTimer = null;
      const cleanup = () => {
        if (disposed) return;
        disposed = true;
        if (hideTimer) clearTimeout(hideTimer);
        if (removeTimer) clearTimeout(removeTimer);
        title.remove();
        if (player.swipeTitleCleanup === cleanup) player.swipeTitleCleanup = null;
        if (drag.titleCleanup === cleanup) drag.titleCleanup = null;
      };
      const dismiss = () => {
        if (disposed) return;
        title.style.opacity = '0';
        removeTimer = setTimeout(cleanup, SWIPE_TITLE_FADE_MS);
      };

      player.swipeTitleCleanup = cleanup;
      drag.titleCleanup = cleanup;
      hideTimer = setTimeout(dismiss, SWIPE_TITLE_VISIBLE_MS);
    }

    function stageSwipeTarget(drag) {
      const target = drag.target;
      const targetVideo = drag.targetPlayer.video;
      target.classList.add('player-swipe-mobile');
      target.style.setProperty('z-index', '2001', 'important');
      target.style.transition = 'none';

      if (target.classList.contains('mp4-player')) {
        drag.targetOriginalControls = targetVideo.controls;
        targetVideo.controls = false;
      }

      const targetIsWarm = drag.targetPlayer.swipeWarmReady && !drag.targetPlayer.swipeWarmError;
      drag.loaderState = targetIsWarm ? null : createSwipeLoader(drag.targetPlayer);
      refreshBufferingIndicators();
      updateSwipePosition(drag, 0);

      // HLS players are already configured for muted autoplay. Do not start an
      // unmuted MP4 solely for the preview, since that can create audio overlap.
      if ((targetVideo.muted || targetVideo.autoplay) && targetVideo.paused) {
        if (drag.targetPlayer.requestPlay) drag.targetPlayer.requestPlay();
        else targetVideo.play().catch(() => {});
      }
    }

    function startSwipeDrag(direction) {
      const current = document.querySelector('.player-fullscreen-mobile');
      if (!current || current._swipeTransition || activeFullscreenSwipe) return null;

      const enabledUrls = getStreamList().filter(stream => stream.enabled).map(stream => stream.url);
      const currentIndex = enabledUrls.indexOf(current.dataset.url);
      if (enabledUrls.length < 2 || currentIndex === -1) return null;

      const nextIndex = (currentIndex + direction + enabledUrls.length) % enabledUrls.length;
      const targetPlayer = players[enabledUrls[nextIndex]];
      const currentPlayer = players[current.dataset.url];
      if (!targetPlayer || !currentPlayer || targetPlayer.container === current) return null;

      // The warm coordinator normally starts on fullscreen entry. Refresh it
      // here as well so a newly enabled/reordered neighbor is prepared before
      // the first finger-follow update.
      updateFullscreenSwipeWarm(current.dataset.url);

      const overlay = document.createElement('div');
      overlay.id = 'fsSwipeOverlay';
      document.body.appendChild(overlay);

      const viewportWidth = Math.max(1, window.innerWidth);
      const drag = {
        token: Symbol('fullscreen-swipe'),
        current,
        target: targetPlayer.container,
        currentPlayer,
        targetPlayer,
        currentVideo: currentPlayer.video,
        targetVideo: targetPlayer.video,
        direction,
        viewportWidth,
        currentOffset: 0,
        targetOffset: -direction * viewportWidth,
        phase: 'dragging',
        overlay,
        currentTitle: null,
        targetTitle: makeSwipeTitle(overlay, extractTitle(targetPlayer.container.dataset.url)),
        loaderState: null,
        targetOriginalControls: null,
        transitionCleanup: null,
        titleCleanup: null
      };

      current._swipeTransition = true;
      targetPlayer.container._swipeTransition = true;
      activeFullscreenSwipe = drag;
      stageSwipeTarget(drag);

      // Commit the offscreen destination style before the first finger-follow
      // update. No media element changes parent here.
      void drag.target.offsetWidth;
      return drag;
    }

    function updateSwipeDrag(drag, rawDx) {
      if (!drag || drag.phase !== 'dragging') return;
      updateSwipePosition(drag, rawDx);
    }

    function finishSwipeCleanup(drag, { committed = false, immediate = false } = {}) {
      if (!drag || drag.phase === 'done') return;
      drag.phase = 'done';
      if (drag.transitionCleanup) {
        drag.transitionCleanup();
        drag.transitionCleanup = null;
      }

      if (drag.loaderState && !committed) drag.loaderState.cleanup();
      if (!committed && drag.target.classList.contains('mp4-player') && drag.targetOriginalControls !== null) {
        drag.targetVideo.controls = drag.targetOriginalControls;
      }

      drag.current.style.transition = immediate ? 'none' : '';
      drag.target.style.transition = immediate ? 'none' : '';
      drag.current.style.setProperty('--fs-swipe-x', '0px');
      drag.target.style.removeProperty('--fs-swipe-x');
      drag.target.classList.remove('player-swipe-mobile');
      drag.target.style.removeProperty('z-index');
      refreshBufferingIndicators();
      if (drag.titleCleanup) drag.titleCleanup();
      drag.current._swipeTransition = false;
      drag.target._swipeTransition = false;
      if (drag.overlay) drag.overlay.remove();
      if (activeFullscreenSwipe === drag) activeFullscreenSwipe = null;
    }

    function commitSwipeHandoff(drag) {
      if (!drag || drag.phase === 'done') return;
      drag.phase = 'committing';

      const current = drag.current;
      const target = drag.target;
      const currentVideo = drag.currentVideo;
      const targetVideo = drag.targetVideo;

      // The destination is already at zero offset and already has fullscreen
      // geometry. Promote it before removing the outgoing fullscreen class.
      cleanupPseudoFullscreenInstance(current, currentVideo, { keepFullscreenClass: true });
      target.classList.add('player-fullscreen-mobile');
      target.style.setProperty('z-index', '2002', 'important');
      activatePseudoFullscreen(target, targetVideo);
      refreshBufferingIndicators();
      updateFullscreenSwipeWarm(target.dataset.url);

      nextAnimationFrame().then(() => {
        if (drag.phase === 'done') return;
        current.classList.remove('player-fullscreen-mobile', 'controls-open', 'tide-panel-open');
        if (drag.currentPlayer.swipeLoaderCleanup) {
          drag.currentPlayer.swipeLoaderCleanup();
          drag.currentPlayer.swipeLoaderCleanup = null;
        }
        current.style.transition = 'none';
        current.style.removeProperty('--fs-swipe-x');
        target.classList.remove('player-swipe-mobile');
        target.style.transition = '';
        target.style.removeProperty('--fs-swipe-x');
        target.style.removeProperty('z-index');
        refreshBufferingIndicators();
        current._swipeTransition = false;
        target._swipeTransition = false;
        drag.phase = 'done';
        promoteSwipeTitle(drag);
        if (drag.overlay) drag.overlay.remove();
        if (activeFullscreenSwipe === drag) activeFullscreenSwipe = null;
      });
    }

    function endSwipeDrag(drag, rawDx) {
      if (!drag || drag.phase !== 'dragging') return;
      const dx = clampSwipeOffset(drag.direction, rawDx, drag.viewportWidth);
      const commit = Math.abs(dx) > SWIPE_COMMIT_PX && dx * drag.direction > 0;
      drag.phase = commit ? 'settling-commit' : 'settling-cancel';

      const ease = 'cubic-bezier(0.22, 0.61, 0.36, 1)';
      const transition = `transform ${SWIPE_SETTLE_MS}ms ${ease}`;
      drag.current.style.transition = transition;
      drag.target.style.transition = transition;
      if (drag.currentTitle) {
        drag.currentTitle.style.transition = `transform ${SWIPE_SETTLE_MS}ms ${ease}, opacity 0.15s ease`;
      }
      drag.targetTitle.style.transition = `transform ${SWIPE_SETTLE_MS}ms ${ease}, opacity 0.15s ease`;

      const finalDx = commit ? drag.direction * drag.viewportWidth : 0;
      updateSwipePosition(drag, finalDx);

      let done = false;
      let seenCurrent = false;
      let seenTarget = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (drag.transitionCleanup) drag.transitionCleanup();
        drag.transitionCleanup = null;
        if (drag.currentTitle) drag.currentTitle.style.opacity = '0';
        if (commit) {
          drag.targetTitle.style.opacity = '1';
          commitSwipeHandoff(drag);
        } else {
          drag.targetTitle.style.opacity = '0';
          finishSwipeCleanup(drag);
        }
      };
      const onTransitionEnd = event => {
        if (event.propertyName !== 'transform') return;
        if (event.target === drag.current) seenCurrent = true;
        if (event.target === drag.target) seenTarget = true;
        if (seenCurrent && seenTarget) finish();
      };
      const fallback = setTimeout(finish, SWIPE_SETTLE_FALLBACK_MS);
      drag.current.addEventListener('transitionend', onTransitionEnd);
      drag.target.addEventListener('transitionend', onTransitionEnd);
      drag.transitionCleanup = () => {
        clearTimeout(fallback);
        drag.current.removeEventListener('transitionend', onTransitionEnd);
        drag.target.removeEventListener('transitionend', onTransitionEnd);
      };
    }

    function cancelActiveFullscreenSwipe(immediate = true) {
      const drag = activeFullscreenSwipe;
      if (!drag || drag.phase === 'done') return;
      if (drag.transitionCleanup) drag.transitionCleanup();
      drag.transitionCleanup = null;
      // A commit promotes the destination before its final animation frame.
      // If fullscreen is exited during that frame, tear down the promoted
      // destination as well so two fullscreen containers cannot remain.
      if (drag.phase === 'committing' && drag.target.classList.contains('player-fullscreen-mobile')) {
        cleanupPseudoFullscreenInstance(drag.target, drag.targetVideo);
      }
      finishSwipeCleanup(drag, { immediate });
    }

    function cleanupPseudoFullscreenInstance(container, video, { keepFullscreenClass = false } = {}) {
      // Run cleanup only for controls/gestures belonging to this player.
      const player = players[container.dataset.url];
      if (pseudoFsSession && pseudoFsSession.player === player) {
        pseudoFsSession.cleanup();
        pseudoFsSession = null;
      }
      clearFullscreenPlayerPriority(player);
      const tidePanel = container.querySelector('.tide-panel');
      if (tidePanel) tidePanel.hidden = true;
      container.classList.remove('tide-panel-open', 'controls-open');

      if (!keepFullscreenClass) {
        container.classList.remove('player-fullscreen-mobile');
      }
      refreshBufferingIndicators();

      if (container.classList.contains('mp4-player')) {
        video.controls = true;
      } else {
        video.style.transform = 'scale(1) translate(0px, 0px)';
        video.style.transformOrigin = 'center center';
      }

      const fsControls = container.querySelector('.fullscreen-controls');
      if (fsControls) fsControls.remove();
      const fsCornerTimestamp = container.querySelector('.corner-timestamp-overlay.pseudo-fullscreen-corner');
      if (fsCornerTimestamp) fsCornerTimestamp.remove();

      if (player && player.swipeTitleCleanup) {
        player.swipeTitleCleanup();
        player.swipeTitleCleanup = null;
      }
      if (player && player.swipeLoaderCleanup && !keepFullscreenClass) {
        player.swipeLoaderCleanup();
        player.swipeLoaderCleanup = null;
      }
    }

    function activatePseudoFullscreen(container, video) {
      const isMp4 = container.classList.contains('mp4-player');
      const player = players[container.dataset.url];

      container.classList.add("player-fullscreen-mobile");

      prioritizeFullscreenPlayer(player);

      // Attempt to play video when entering fullscreen
      if (video.paused) {
        if (!isMp4 && player?.requestPlay) player.requestPlay();
        else video.play().catch(()=>{});
      }

      let controlsCleanup = null;
      let gestureCleanup = null;

      if (!isMp4) {
        // Setup custom controls and gestures for HLS streams
        const controls = setupMobileFullscreenControls(container, video);
        // Pass control show/hide functions to gesture setup
        const gestures = setupPseudoFullscreenGestures(container, video, controls.showFsControls, controls.hideFsControls);
        controlsCleanup = controls.cleanup;
        gestureCleanup = gestures.cleanup;
        // Store control API on the player object if it exists
        if (players[container.dataset.url]) {
          players[container.dataset.url].controlsApi = {
            showFsControls: controls.showFsControls,
            hideFsControls: controls.hideFsControls
          };
        }
      } else {
        // For MP4, ensure native controls are visible and attach fullscreen swipe gestures
        video.controls = true;
        const gestures = setupPseudoFullscreenGestures(container, video, () => {}, () => {});
        gestureCleanup = gestures.cleanup;
      }

      // Store the combined cleanup function
      const cleanup = () => {
        if (controlsCleanup) controlsCleanup();
        if (gestureCleanup) gestureCleanup();
        // Remove control API from player object
        if (players[container.dataset.url]) delete players[container.dataset.url].controlsApi;
      };
      pseudoFsSession = { player, cleanup };

      // Attempt to hide browser UI elements (address bar) on non-Safari
      if (!IS_SAFARI_MOBILE) hideBrowserUI();
    }

    function enterPseudoFullscreen(container, video) {
      // Prevent entering if already in fullscreen
      if (document.querySelector('.player-fullscreen-mobile')) return;

      const htmlEl = document.documentElement;

      // Add classes to lock body scroll and style fullscreen
      htmlEl.classList.add("pseudo-fullscreen-mobile");
      if (!IS_SAFARI_MOBILE) htmlEl.classList.add("non-safari"); // Specific style tweaks if needed
      activatePseudoFullscreen(container, video);
      updateFullscreenSwipeWarm(container.dataset.url);
      refreshBufferingIndicators();
    }

    function exitPseudoFullscreen(container, video) {
      if (!container || !container.classList.contains('player-fullscreen-mobile')) return;

      if (activeFullscreenSwipe) cancelActiveFullscreenSwipe(true);

      const htmlEl = document.documentElement;

      cleanupPseudoFullscreenInstance(container, video);
      clearFullscreenSwipeWarm();

      // Remove fullscreen classes
      htmlEl.classList.remove("pseudo-fullscreen-mobile", "non-safari");

      // Reset body/html styles potentially modified for fullscreen
      document.body.style.height = '';
      document.body.style.overflow = '';
      document.body.style.position = '';
      htmlEl.style.height = '';
      htmlEl.style.overflow = '';
      htmlEl.style.minHeight = '';
      refreshBufferingIndicators();
    }


    /* --- Mobile Fullscreen Controls Setup --- */
    function setupMobileFullscreenControls(container, video) {
      let fsControls = container.querySelector('.fullscreen-controls');
      let controlsTimeout_fs;
      let isFsSeeking = false;
      let listeners = []; // Store added listeners for cleanup
      let tidesCleanup = null;

      // Helper to add listeners and track them
      function addListener(el, type, fn, opts) {
        el.addEventListener(type, fn, opts);
        listeners.push({ el, type, fn, opts });
      }

      // Function to show controls
      function showFsControls() {
        if (!fsControls || !container.classList.contains('player-fullscreen-mobile')) return;
        // Animate controls into view
        fsControls.style.bottom = `env(safe-area-inset-bottom, 10px)`; // Account for safe area
        container.classList.add("controls-open");
        clearTimeout(controlsTimeout_fs); // Cancel any pending hide timer
      }

      // Function to hide controls
      function hideFsControls() {
        if (!fsControls || !container.classList.contains('player-fullscreen-mobile')) return;
        // Don't hide if currently seeking
        if (!isFsSeeking) {
          fsControls.style.bottom = '-120px'; // Animate controls out of view
          container.classList.remove("controls-open");
        }
      }

      // If controls already exist (e.g., re-entering fullscreen quickly), just return API
      if (fsControls) {
        container.classList.remove("controls-open"); // Ensure starts hidden
        hideFsControls();
        // Return existing cleanup function if available
        return { cleanup: fsControls.cleanupFsListeners || (() => {}), showFsControls, hideFsControls };
      }

      // Create controls HTML
      fsControls = document.createElement("div");
      fsControls.className = "controls-container fullscreen-controls";
      const fsCornerTimestamp = createCornerTimestampOverlay(container);
      fsCornerTimestamp.classList.add('pseudo-fullscreen-corner');

      const fsControlBar = document.createElement("div");
      fsControlBar.className = "control-bar";

      const fsPlayPauseBtn = document.createElement("button");
      fsPlayPauseBtn.className = "play-pause-btn";
      fsPlayPauseBtn.textContent = video.paused ? "▶" : "⏸";
      fsControlBar.appendChild(fsPlayPauseBtn);

      const fsProgressBar = document.createElement("div");
      fsProgressBar.className = "progress-bar";
      const fsBufferedBar = document.createElement("div");
      fsBufferedBar.className = "buffered";
      const fsPlayedBar = document.createElement("div");
      fsPlayedBar.className = "played";
      const fsThumb = document.createElement("div");
      fsThumb.className = "thumb";
      fsThumb.draggable = false;
      fsProgressBar.appendChild(fsBufferedBar);
      fsProgressBar.appendChild(fsPlayedBar);
      fsProgressBar.appendChild(fsThumb);
      const fsTimelinePreview = createTimelinePreviewHud(fsProgressBar);
      fsControlBar.appendChild(fsProgressBar);

      const fsTidesControl = document.createElement('div');
      fsTidesControl.className = 'tides-control';
      const fsTidesBtn = document.createElement('button');
      fsTidesBtn.type = 'button';
      fsTidesBtn.textContent = 'Tides';
      fsTidesBtn.setAttribute('aria-label', 'Open tide forecast');
      fsTidesControl.appendChild(fsTidesBtn);
      fsControlBar.appendChild(fsTidesControl);

      const fsExitBtn = document.createElement("button");
      fsExitBtn.innerHTML = "&#x2921;"; // Exit fullscreen symbol
      fsControlBar.appendChild(fsExitBtn);

      fsControls.appendChild(fsControlBar);

      const fsTitleBar = document.createElement("div");
      fsTitleBar.className = "title-bar";
      fsTitleBar.textContent = extractTitle(container.dataset.url);
      fsControls.appendChild(fsTitleBar);

      container.appendChild(fsControls);
      tidesCleanup = attachTideControl(container, fsTidesBtn, { onOpen: showFsControls });

      // --- Add Event Listeners ---

      // Update Play/Pause button symbol
      const updateFsPlayBtn = () => {
        const player = players[container.dataset.url];
        const intendedToPlay = player?.isBuffering && player.wantsToPlay;
        fsPlayPauseBtn.textContent = (!video.paused || intendedToPlay) ? "⏸" : "▶";
      };
      addListener(video, "play", updateFsPlayBtn);
      addListener(video, "pause", updateFsPlayBtn);
      addListener(video, "ended", updateFsPlayBtn);
      addListener(container, "bufferingchange", updateFsPlayBtn);

      fsProgressBar.style.touchAction = 'none';

      // Update Progress Bar display
      const updateFsProgressBar = () => {
        if (players[container.dataset.url]?.isBuffering) return;
        const range = getVideoRange(video);
        if (range && range.end > range.start) {
          const span = range.end - range.start;
          const ct = video.currentTime;
          const b = video.buffered;
          let bEnd = range.start;
          try {
            for (let i = 0; i < b.length; i++) {
              if (b.start(i) <= ct && b.end(i) >= ct) { bEnd = b.end(i); break; }
              bEnd = Math.max(bEnd, b.end(i));
            }
          } catch {}
          const pp = Math.min(100, ((ct - range.start) / span) * 100);
          const bp = Math.min(100, ((bEnd - range.start) / span) * 100);
          fsPlayedBar.style.width = `${pp}%`;
          fsThumb.style.left = `${pp}%`;
          fsBufferedBar.style.width = `${bp}%`;
        } else {
          fsPlayedBar.style.width = '0%';
          fsThumb.style.left = '0%';
          fsBufferedBar.style.width = '0%';
        }
      };
      ["timeupdate", "progress", "loadedmetadata", "durationchange", "canplay", "playing", "seeked"].forEach(evt => {
        addListener(video, evt, updateFsProgressBar);
      });
      const fsPollId = setInterval(updateFsProgressBar, 500);
      // Clean up polling when fullscreen exits (video emptied or cleanup called)
      updateFsProgressBar(); // Initial update

      // Progress Bar Seeking
      let fsPendingSeekTime = -1;
      let fsLastThrottledSeek = 0;
      let fsWasPlayingBeforeScrub = false;
      const fsSeek = event => {
        const range = getVideoRange(video);
        if (range && range.end > range.start) {
          const span = range.end - range.start;
          const pr = fsProgressBar.getBoundingClientRect();
          let cX = event.clientX;
          if (event.type.startsWith('touch')) {
            if (event.touches.length > 0) cX = event.touches[0].clientX;
            else if (event.changedTouches.length > 0) cX = event.changedTouches[0].clientX;
          }
          const st = range.start + Math.max(0, Math.min(1, (cX - pr.left) / pr.width)) * span;
          let seekable = false;
          try {
            for (let i = 0; i < video.seekable.length; i++) {
              if (st >= video.seekable.start(i) && st <= video.seekable.end(i)) {
                seekable = true; break;
              }
            }
          } catch { seekable = true; }
          if (seekable) {
            fsPendingSeekTime = st;
            const pp = Math.min(100, ((st - range.start) / span) * 100);
            fsPlayedBar.style.width = `${pp}%`;
            fsThumb.style.left = `${pp}%`;
            showTimelinePreview(players[container.dataset.url], fsTimelinePreview, fsCornerTimestamp, st, pp);
            const now = performance.now();
            const throttle = isTimeBuffered(video, st) ? SEEK_THROTTLE_BUFFERED_MS : SEEK_THROTTLE_MS;
            if (now - fsLastThrottledSeek >= throttle) {
              fsLastThrottledSeek = now;
              video.currentTime = st;
            }
          }
        }
      };
      const applyFsPendingSeek = () => {
        if (fsPendingSeekTime >= 0) {
          video.currentTime = fsPendingSeekTime;
          fsPendingSeekTime = -1;
          if (fsWasPlayingBeforeScrub) {
            video.addEventListener('seeked', () => video.play().catch(() => {}), { once: true });
          } else {
            video.pause();
          }
        }
      };
      const finishFsSeek = () => {
        if (!isFsSeeking) return;
        isFsSeeking = false;
        fsProgressBar.classList.remove('seeking');
        hideTimelinePreview(players[container.dataset.url], fsTimelinePreview);
        hideCornerTimestampOverlay(players[container.dataset.url], fsCornerTimestamp, true);
        fsProgressBar.style.cursor = 'pointer';
        applyFsPendingSeek();
      };
      addListener(fsProgressBar, "mousedown", e => {
        if (e.button === 0) {
          e.preventDefault();
          isFsSeeking = true;
          fsWasPlayingBeforeScrub = !video.paused;
          fsProgressBar.classList.add('seeking');
          fsSeek(e);
          fsProgressBar.style.cursor = 'grabbing';
        }
      });
      addListener(fsProgressBar, "touchstart", e => {
        e.preventDefault(); // Must prevent default before browser commits to scroll
        isFsSeeking = true;
        fsWasPlayingBeforeScrub = !video.paused;
        fsProgressBar.classList.add('seeking');
        fsSeek(e);
      }, { passive: false });
      // Use window listeners for move/end to catch events outside the bar
      const handleFsMouseMove = e => {
        if (!isFsSeeking) return;
        if (!(e.buttons & 1)) { finishFsSeek(); return; }
        fsSeek(e);
      };
      const handleFsTouchMove = e => { if (isFsSeeking) { e.preventDefault(); fsSeek(e); } };
      const handleFsMouseUp = e => { if (e.button === 0) finishFsSeek(); };
      const handleFsTouchEnd = () => finishFsSeek();
      const handleFsBlur = () => finishFsSeek();
      addListener(window, "mousemove", handleFsMouseMove);
      addListener(window, "touchmove", handleFsTouchMove, { passive: false });
      addListener(window, "mouseup", handleFsMouseUp);
      addListener(window, "touchend", handleFsTouchEnd);
      addListener(window, "blur", handleFsBlur);

      // Button Actions
      addListener(fsPlayPauseBtn, "click", e => {
        e.stopPropagation();
        const player = players[container.dataset.url];
        if (player?.togglePlayback) player.togglePlayback();
        else if (video.paused) video.play().catch(()=>{});
        else video.pause();
      });
      addListener(fsExitBtn, "click", e => {
        e.stopPropagation();
        exitPseudoFullscreen(container, video);
      });

      // Prevent taps on controls from triggering gestures/play/pause on container
      const handleControlsInteraction = e => {
        e.stopPropagation();
      };
      addListener(fsControls, 'click', handleControlsInteraction);
      addListener(fsControls, 'touchstart', handleControlsInteraction, { passive: true }); // Allow scroll within controls if needed

      // Cleanup function to remove all listeners
      const cleanup = () => {
        listeners.forEach(({ el, type, fn, opts }) => {
          el.removeEventListener(type, fn, opts);
        });
        listeners = []; // Clear the array
        if (tidesCleanup) {
          tidesCleanup();
          tidesCleanup = null;
        }
        clearTimeout(controlsTimeout_fs); // Clear any pending hide timer
        clearInterval(fsPollId);
      };
      fsControls.cleanupFsListeners = cleanup; // Attach cleanup to the element itself

      // Store API on the player object
      if (players[container.dataset.url]) {
         players[container.dataset.url].controlsApi = { showFsControls, hideFsControls };
      }

      return { cleanup, showFsControls, hideFsControls };
    }


    /* --- Mobile Pinch/Swipe Gestures Setup --- */
    function setupPseudoFullscreenGestures(container, video, showFsControls, hideFsControls) {
      // State variables for gestures
      let initialDistance = null;   // For pinch zoom
      let initialScale = 1;         // Initial scale before pinch
      let currentScale = 1;         // Current applied scale
      let initialMidpoint = null;   // Midpoint between fingers (screen coords)
      let initialLocalMid = null;   // Midpoint relative to video center
      let gestureRect = null;       // Video bounding rect at gesture start
      let currentTranslateX = 0;    // Current applied X translation
      let currentTranslateY = 0;    // Current applied Y translation
      let gestureStartX = 0;        // Translation X at gesture start
      let gestureStartY = 0;        // Translation Y at gesture start
      let touchStartX = null;       // X position for swipe detection
      let touchStartY = null;       // Y position for swipe detection
      let touchStartTime = null;    // Time for swipe detection
      let isSwipingY = false;       // Flag if vertical swipe detected
      let isGesturing = false;      // Flag if any touch interaction is active
      let isPanning = false;        // Flag if single-finger pan is active
      let panStartX = 0;            // Finger X at pan start
      let panStartY = 0;            // Finger Y at pan start
      let panStartTranslateX = 0;   // Translation X at pan start
      let panStartTranslateY = 0;   // Translation Y at pan start
      let swipeDrag = null;         // Active finger-follow stream-swap drag
      let pointerSwipe = null;      // Mouse-pointer fallback for desktop testing
      let suppressPointerClick = false;

      const listeners = []; // Store listeners for cleanup
      function addListener(el, type, fn, opts) {
        el.addEventListener(type, fn, opts);
        listeners.push({ el, type, fn, opts });
      }
      // Get controls API, default to passed functions if player object not ready
      const controlsApi = players[container.dataset.url]?.controlsApi || { showFsControls, hideFsControls };

      // Apply calculated transform (scale and translate) to the video element
      function applyTransform() {
        // Clamp scale between 1x and 5x
        currentScale = Math.max(1, Math.min(currentScale, 5));
        // Use container bounds, NOT video.getBoundingClientRect().
        // getBoundingClientRect() on a transformed element returns the visual (post-transform)
        // box — at scale 2 that's 2× the actual container size, making maxX/maxY 2× too large
        // and letting the video be dragged completely off screen.
        const cRect = container.getBoundingClientRect();
        const videoAspect = (video.videoWidth > 0 && video.videoHeight > 0)
          ? video.videoWidth / video.videoHeight
          : cRect.width / cRect.height;
        const containerAspect = cRect.width / cRect.height;
        let visualW, visualH;
        if (containerAspect > videoAspect) { // Pillarboxed
            visualH = cRect.height;
            visualW = visualH * videoAspect;
        } else { // Letterboxed
            visualW = cRect.width;
            visualH = visualW / videoAspect;
        }
        const maxX = Math.max(0, (visualW * currentScale - cRect.width) / 2);
        const maxY = Math.max(0, (visualH * currentScale - cRect.height) / 2);
        currentTranslateX = Math.max(-maxX, Math.min(maxX, currentTranslateX));
        currentTranslateY = Math.max(-maxY, Math.min(maxY, currentTranslateY));
        video.style.transform = `translate(${currentTranslateX}px, ${currentTranslateY}px) scale(${currentScale})`;
      }

      // Touch Start Handler
      const handleTouchStart = e => {
        // Ignore touches starting on controls
        if (e.target.closest('.fullscreen-controls')) return;
        // Only handle gestures on the fullscreen player (or the body-level swipe overlay).
        if (!e.target.closest('.player-fullscreen-mobile, .player-swipe-mobile, #fsSwipeOverlay')) return;
        isGesturing = true; // Mark gesture active

        if (e.touches.length === 1) {
          if (currentScale > 1) {
            // Zoomed in — single finger pans
            isPanning = true;
            panStartX = e.touches[0].clientX;
            panStartY = e.touches[0].clientY;
            panStartTranslateX = currentTranslateX;
            panStartTranslateY = currentTranslateY;
            video.style.transition = 'none';
          } else {
            // Not zoomed — prepare for swipe gesture
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            touchStartTime = Date.now();
            isSwipingY = false;
            swipeDrag = null;
          }
        } else if (e.touches.length === 2) {
          // Start pinch-zoom/pan gesture
          // Cancel any in-progress stream-swap drag before the pinch takes over.
          if (swipeDrag) {
            cancelActiveFullscreenSwipe(true);
            swipeDrag = null;
          }
          isPanning = false; // Cancel any single-finger pan
          isSwipingY = false;
           touchStartX = null;
           touchStartY = null;
          const [t1, t2] = e.touches;
          initialDistance = getTouchDistance(t1, t2); // Store initial finger distance
          initialScale = currentScale; // Store scale at gesture start
          initialMidpoint = getTouchMidpoint(t1, t2); // Store midpoint (screen coords)
          gestureRect = video.getBoundingClientRect(); // Store video bounds
          // Calculate midpoint relative to video center for panning adjustment during zoom
          const center = {
            x: gestureRect.left + gestureRect.width / 2,
            y: gestureRect.top + gestureRect.height / 2
          };
          initialLocalMid = {
            x: initialMidpoint.x - center.x,
            y: initialMidpoint.y - center.y
          };
          // Store translation at gesture start
          gestureStartX = currentTranslateX;
          gestureStartY = currentTranslateY;
          // Disable transitions during gesture for smoother updates
          video.style.transition = 'none';
        }
      };

      // Touch Move Handler
      const handleTouchMove = e => {
        if (!isGesturing || e.target.closest('.fullscreen-controls')) return;

        if (e.touches.length === 1 && isPanning) {
          // Single-finger pan (only when zoomed in)
          e.preventDefault();
          currentTranslateX = panStartTranslateX + (e.touches[0].clientX - panStartX);
          currentTranslateY = panStartTranslateY + (e.touches[0].clientY - panStartY);
          applyTransform();
        } else if (e.touches.length === 1 && touchStartY !== null) {
          // Check for vertical or horizontal swipe gesture (only at 1x zoom)
          const dx = e.touches[0].clientX - touchStartX;
          const dy = e.touches[0].clientY - touchStartY;
          const dt = Date.now() - touchStartTime;
          if (!isSwipingY && (Math.abs(dy) > 10 || dt > 100) && Math.abs(dy) > Math.abs(dx)) {
            isSwipingY = true;
          }
          // Finger-follow drag: once horizontal movement dominates, snap the
          // videos to the finger and keep them tracking until release.
          if (!swipeDrag && Math.abs(dx) > SWIPE_START_PX && Math.abs(dx) > Math.abs(dy)) {
            swipeDrag = startSwipeDrag(dx > 0 ? 1 : -1);
          }
          if (swipeDrag) {
            e.preventDefault();
            updateSwipeDrag(swipeDrag, dx);
          } else if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
            e.preventDefault();
          }
        } else if (e.touches.length === 2 && initialDistance !== null) {
          // Handle pinch-zoom/pan
          e.preventDefault(); // Prevent page scroll/zoom during gesture
          const [t1, t2] = e.touches;
          const curDist = getTouchDistance(t1, t2); // Current finger distance
          // Calculate new scale based on distance change
          currentScale = initialScale * (curDist / initialDistance);
          const curMid = getTouchMidpoint(t1, t2); // Current midpoint
          // Calculate change in midpoint position
          const deltaX = curMid.x - initialMidpoint.x;
          const deltaY = curMid.y - initialMidpoint.y;
          // Adjust translation: start + midpoint delta - zoom adjustment
          const scaleFactor = currentScale / initialScale;
          currentTranslateX = gestureStartX + deltaX - (initialLocalMid.x * (scaleFactor - 1));
          currentTranslateY = gestureStartY + deltaY - (initialLocalMid.y * (scaleFactor - 1));
          // Apply the new transform
          applyTransform();
        }
      };

      // Touch End Handler
      const handleTouchEnd = e => {
        if (!isGesturing) return;

        // Single-finger pan ended
        if (isPanning && e.touches.length === 0) {
          isPanning = false;
          gestureStartX = currentTranslateX;
          gestureStartY = currentTranslateY;
          applyTransform();
        }

        // If less than 2 touches remain, pinch gesture ends
        if (e.touches.length < 2) {
          initialDistance = null;
          initialLocalMid = null;
          gestureRect = null;
          if (currentScale <= 1) {
            currentScale = 1;
            currentTranslateX = 0;
            currentTranslateY = 0;
            gestureStartX = 0;
            gestureStartY = 0;
            video.style.transition = 'transform 0.2s ease-out';
          } else {
            gestureStartX = currentTranslateX;
            gestureStartY = currentTranslateY;
            video.style.transition = '';
          }
          applyTransform();
        }

        // Horizontal finger-follow drags switch streams; vertical swipes control fullscreen UI.
        if (e.touches.length === 0 && touchStartX !== null && touchStartY !== null) {
          const touch = e.changedTouches[0];
          const dx = touch ? touch.clientX - touchStartX : 0;
          const dy = touch ? touch.clientY - touchStartY : 0;
          const dt = Date.now() - touchStartTime;
          if (swipeDrag) {
            endSwipeDrag(swipeDrag, dx);
            swipeDrag = null;
          } else if (isSwipingY && Math.abs(dy) > 50 && dt < 500) {
            const open = container.classList.contains('controls-open');
            if (dy < 0) { // Swipe up -> Show controls
              controlsApi.showFsControls && controlsApi.showFsControls();
            } else { // Swipe down
              if (open) controlsApi.hideFsControls && controlsApi.hideFsControls(); // Hide controls if open
              else exitPseudoFullscreen(container, video); // Exit fullscreen if controls hidden
            }
          }
        }

        // If last touch ended, reset gesture state
        if (e.touches.length === 0) {
          isPanning = false;
          touchStartX = null;
          touchStartY = null;
          touchStartTime = null;
          isSwipingY = false;
          isGesturing = false;
          swipeDrag = null;
        }
      };

      // Device emulation in a desktop browser can expose a mouse pointer even
      // though the page is running with a mobile user agent. Keep this path
      // separate from touch events so real pinch/zoom gestures are unchanged.
      const handlePointerDown = e => {
        if (e.pointerType !== 'mouse' || e.button !== 0) return;
        if (e.target.closest('.fullscreen-controls')) return;
        if (!e.target.closest('.player-fullscreen-mobile, .player-swipe-mobile, #fsSwipeOverlay')) return;
        e.preventDefault();
        pointerSwipe = {
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          startTime: Date.now(),
          drag: null,
          moved: false
        };
        try { e.target.setPointerCapture(e.pointerId); } catch {}
      };

      const handlePointerMove = e => {
        if (!pointerSwipe || e.pointerType !== 'mouse' || e.pointerId !== pointerSwipe.pointerId) return;
        if (!(e.buttons & 1)) {
          handlePointerUp(e);
          return;
        }

        const dx = e.clientX - pointerSwipe.startX;
        const dy = e.clientY - pointerSwipe.startY;
        if (!pointerSwipe.drag && Math.abs(dx) > SWIPE_START_PX && Math.abs(dx) > Math.abs(dy)) {
          pointerSwipe.drag = startSwipeDrag(dx > 0 ? 1 : -1);
          pointerSwipe.moved = !!pointerSwipe.drag;
        }
        if (pointerSwipe.drag) {
          e.preventDefault();
          updateSwipeDrag(pointerSwipe.drag, dx);
        }
      };

      const handlePointerUp = e => {
        if (!pointerSwipe || e.pointerType !== 'mouse' || e.pointerId !== pointerSwipe.pointerId) return;
        const state = pointerSwipe;
        pointerSwipe = null;
        const dx = e.clientX - state.startX;
        if (state.drag) {
          e.preventDefault();
          endSwipeDrag(state.drag, dx);
          suppressPointerClick = true;
        }
        try { e.target.releasePointerCapture(e.pointerId); } catch {}
      };

      const handlePointerClick = e => {
        if (!suppressPointerClick) return;
        suppressPointerClick = false;
        e.preventDefault();
        e.stopPropagation();
      };

      const handleResize = () => {
        if (activeFullscreenSwipe && activeFullscreenSwipe.current === container) {
          cancelActiveFullscreenSwipe(true);
        }
        applyTransform();
      };

      // Listen on the document so gestures continue to work while the staged
      // player is fixed outside its normal card position.
      addListener(document, 'touchstart', handleTouchStart, { passive: false }); // Need active for preventDefault
      addListener(document, 'touchmove', handleTouchMove, { passive: false }); // Need active for preventDefault
      addListener(document, 'touchend', handleTouchEnd);
      addListener(document, 'touchcancel', e => {
        if (swipeDrag) cancelActiveFullscreenSwipe(true);
        swipeDrag = null;
        handleTouchEnd(e);
      }); // Handle cancellation
      addListener(document, 'pointerdown', handlePointerDown, { passive: false });
      addListener(document, 'pointermove', handlePointerMove, { passive: false });
      addListener(document, 'pointerup', handlePointerUp, { passive: false });
      addListener(document, 'pointercancel', handlePointerUp, { passive: false });
      addListener(document, 'click', handlePointerClick, true);
      addListener(window, 'resize', handleResize);

      // Apply initial transform state (in case loaded with zoom/pan)
      applyTransform();

      // Return cleanup function
      return {
        cleanup: () => {
          listeners.forEach(({ el, type, fn, opts }) => el.removeEventListener(type, fn, opts));
          listeners.length = 0; // Clear array
          // Reset video style explicitly on cleanup
          video.style.transform = 'scale(1) translate(0,0)';
          video.style.transformOrigin = 'center center';
          video.style.transition = '';
        }
      };
    }



  return {
    enter: enterPseudoFullscreen,
    exit: exitPseudoFullscreen,
    refresh() {
      if (fullscreenSwipeWarm) updateFullscreenSwipeWarm(fullscreenSwipeWarm.activeUrl);
    },
    remove(player) {
      // Cancel a staged/committing handoff before either participating player
      // is disposed, so the session never retains a removed destination.
      if (activeFullscreenSwipe &&
          (activeFullscreenSwipe.current === player.container || activeFullscreenSwipe.target === player.container)) {
        cancelActiveFullscreenSwipe(true);
      }
      if (player.container.classList.contains('player-fullscreen-mobile')) {
        exitPseudoFullscreen(player.container, player.video);
      }
    }
  };
}
