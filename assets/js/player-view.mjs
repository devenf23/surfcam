import { config } from './config.mjs';
import { getVideoRange, isTimeBuffered } from './media-timeline.mjs';
import { createCanvasRenderer } from './canvas-renderer.mjs';
const SEEK_THROTTLE_MS = 250;
const SEEK_THROTTLE_BUFFERED_MS = 50;

export function mountPlayerView(playerObject, { url, title, isMp4,
  isMobile: IS_MOBILE, enterPseudoFullscreen, enterNativeFullScreen,
  exitNativeFullScreen, attachTideControl, updateStreamEnabled, savePlayerSettings,
  resizeCanvas, createTimelinePreviewHud, createCornerTimestampOverlay,
  showTimelinePreview, hideTimelinePreview, hideCornerTimestampOverlay,
  createBufferingIndicator, createSafeId, clampPan, isSpaceHeld
}) {
  const { container, video } = playerObject;
      if (isMp4) {
        // --- MP4 Player Setup (Desktop & Mobile) ---
        container.classList.add('mp4-player');
        video.controls = true; // Use native controls for MP4
        video.muted = false; // Allow sound for MP4
        video.autoplay = false; // Don't autoplay MP4 typically
        container.appendChild(video);

        // Add a simple title bar below the video
        const ctr = document.createElement("div");
        ctr.className = "controls-container"; // Reuse styling if needed
        const tb = document.createElement("div");
        tb.className = "title-bar";
        tb.textContent = title;
         ctr.appendChild(tb);
         container.appendChild(ctr);

         // Native MP4 controls cannot be extended, so place the tide control
         // alongside them while this player is fullscreen.
         const mp4TidesControl = document.createElement('div');
         mp4TidesControl.className = 'tides-control mp4-tides-control';
         const mp4TidesBtn = document.createElement('button');
         mp4TidesBtn.type = 'button';
         mp4TidesBtn.textContent = 'Tides';
         mp4TidesBtn.setAttribute('aria-label', 'Open tide forecast');
         mp4TidesControl.appendChild(mp4TidesBtn);
         container.appendChild(mp4TidesControl);
         playerObject.tidesCleanup = attachTideControl(container, mp4TidesBtn);

         // Basic error handling
        playerObject.addListener(video, 'error', e => {
          console.error(`Error loading MP4: ${url}`, video.error);
          video.pause();
          tb.textContent = `Error: ${video.error?.message || 'Could not load video'}`;
          tb.style.color = 'red';
          if (playerObject.swipeLoadError) playerObject.swipeLoadError();
        });

        // Fullscreen handling (different for mobile/desktop)
        if (IS_MOBILE) {
          // Mobile: Double-tap for pseudo-fullscreen
          let lastTap = 0;
          playerObject.addListener(container, "click", e => {
            // Ignore clicks on controls
            if (e.target.closest('video[controls]')) return;
            const now = Date.now();
            if (now - lastTap < 350) { // Double tap threshold
              enterPseudoFullscreen(container, video);
              lastTap = 0; // Reset tap timer
            } else {
              lastTap = now;
            }
          });
        } else {
          // Desktop: Double-tap for native fullscreen
          let lastTap = 0;
          playerObject.addListener(container, "click", e => {
            // Ignore clicks on controls
            if (e.target.closest('video[controls]')) return;
            const now = Date.now();
            if (now - lastTap < 300) { // Double tap threshold
              if (!document.fullscreenElement && !document.webkitFullscreenElement) {
                enterNativeFullScreen(container);
              } else {
                exitNativeFullScreen();
              }
              lastTap = 0; // Reset tap timer
            } else {
              lastTap = now;
            }
          });
        }
      } else if (IS_MOBILE) {
        // --- Mobile HLS Player Setup (Native Video Element) ---
        // Title row with fullscreen button
        const titleRow = document.createElement("div");
        titleRow.className = "video-title-row";
        const titleSpan = document.createElement("span");
        titleSpan.textContent = title;
        const fsBtnMobile = document.createElement("button");
        fsBtnMobile.className = "fs-btn-mobile";
        fsBtnMobile.innerHTML = "&#x26F6;"; // Fullscreen symbol
        fsBtnMobile.setAttribute("aria-label","Enter Fullscreen");
        titleRow.appendChild(titleSpan);
        titleRow.appendChild(fsBtnMobile);
        container.appendChild(titleRow);

        // Video element itself
        container.appendChild(video);
        const mobileBufferingIndicator = createBufferingIndicator();
        container.appendChild(mobileBufferingIndicator);
        playerObject.bufferingIndicator = mobileBufferingIndicator;
        const mobileCornerTimestamp = createCornerTimestampOverlay(container);

        // Simple controls (Play/Pause + scrub bar) below the video
        const ctrM = document.createElement("div");
        ctrM.className = "controls-container";
        const cbM = document.createElement("div");
        cbM.className = "control-bar";

        const ppM = document.createElement("button");
        ppM.className = "play-pause-btn";
        ppM.textContent = "▶";
        ppM.setAttribute("aria-label","Play/Pause");
        cbM.appendChild(ppM);

        // Mobile scrub bar
        const mPb = document.createElement("div");
        mPb.className = "progress-bar";
        // Prevent iOS from treating touches on the bar as scroll gestures
        mPb.style.touchAction = 'none';
        mPb.style.height = '28px'; // Larger touch target (visual stays thin via inner elements)
        const mBuf = document.createElement("div"); mBuf.className = "buffered";
        const mPlayed = document.createElement("div"); mPlayed.className = "played";
        const mThumb = document.createElement("div"); mThumb.className = "thumb";
        mPb.appendChild(mBuf); mPb.appendChild(mPlayed); mPb.appendChild(mThumb);
        const mTimelinePreview = createTimelinePreviewHud(mPb);
        cbM.appendChild(mPb);

        let mIsSeeking = false, mPendingSeek = -1, mLastThrottle = 0, mWasPlaying = false;

        function updateMPb() {
          if (mIsSeeking || playerObject.isBuffering) return;
          const range = getVideoRange(video);
          if (range && range.end > range.start) {
            const span = range.end - range.start;
            const ct = video.currentTime;
            let bEnd = range.start;
            try {
              for (let i = 0; i < video.buffered.length; i++) {
                if (video.buffered.start(i) <= ct && video.buffered.end(i) >= ct) { bEnd = video.buffered.end(i); break; }
                bEnd = Math.max(bEnd, video.buffered.end(i));
              }
            } catch {}
            const pp = Math.min(100, ((ct - range.start) / span) * 100);
            const bp = Math.min(100, ((bEnd - range.start) / span) * 100);
            mPlayed.style.width = `${pp}%`;
            mThumb.style.left   = `${pp}%`;
            mBuf.style.width    = `${bp}%`;
          } else {
            mPlayed.style.width = mThumb.style.left = mBuf.style.width = '0%';
          }
        }
        playerObject.updateTimeline = updateMPb;
        ["timeupdate","progress","loadedmetadata","durationchange","seeking","seeked","play","pause","canplay","playing","loadeddata"].forEach(ev => playerObject.addListener(video, ev, updateMPb));
        // Polling fallback: iOS native HLS can be slow to populate video.seekable.
        // Poll every 500ms so the bar updates as soon as the range becomes available.
        const mPbPollId = playerObject.trackInterval(updateMPb, 500);
        playerObject.addListener(video, 'emptied', () => clearInterval(mPbPollId), { once: true });

        function mSeek(clientX) {
          const range = getVideoRange(video);
          if (range && range.end > range.start) {
            const span = range.end - range.start;
            const pr = mPb.getBoundingClientRect();
            const st = range.start + Math.max(0, Math.min(1, (clientX - pr.left) / pr.width)) * span;
            let seekable = false;
            try { for (let i = 0; i < video.seekable.length; i++) { if (st >= video.seekable.start(i) && st <= video.seekable.end(i)) { seekable = true; break; } } } catch { seekable = true; }
            if (seekable) {
              mPendingSeek = st;
              const pp = Math.min(100, ((st - range.start) / span) * 100);
              mPlayed.style.width = `${pp}%`; mThumb.style.left = `${pp}%`;
              showTimelinePreview(playerObject, mTimelinePreview, mobileCornerTimestamp, st, pp);
              const now = performance.now();
              const throttle = isTimeBuffered(video, st) ? SEEK_THROTTLE_BUFFERED_MS : SEEK_THROTTLE_MS;
              if (now - mLastThrottle >= throttle) { mLastThrottle = now; video.currentTime = st; }
            }
          }
        }

        function applyMSeek() {
          if (mPendingSeek >= 0) {
            video.currentTime = mPendingSeek; mPendingSeek = -1;
            if (mWasPlaying) playerObject.addListener(video, 'seeked', () => video.play().catch(() => {}), { once: true });
            else video.pause();
          }
        }

        const onMMove = e => { if (!mIsSeeking) return; e.preventDefault(); const t = e.touches[0] || e.changedTouches[0]; if (t) mSeek(t.clientX); };
        const onMEnd  = () => { if (!mIsSeeking) return; mIsSeeking = false; mPb.classList.remove('seeking'); hideTimelinePreview(playerObject, mTimelinePreview); hideCornerTimestampOverlay(playerObject, mobileCornerTimestamp, true); window.removeEventListener('touchmove', onMMove); window.removeEventListener('touchend', onMEnd); applyMSeek(); };

        playerObject.addListener(mPb, 'touchstart', e => {
          e.preventDefault(); // Must prevent default before browser commits to scroll
          e.stopPropagation();
          mIsSeeking = true; mWasPlaying = !video.paused;
          mPb.classList.add('seeking');
          const t = e.touches[0]; if (t) mSeek(t.clientX);
          playerObject.addListener(window, 'touchmove', onMMove, { passive: false });
          playerObject.addListener(window, 'touchend', onMEnd);
        }, { passive: false });

        ctrM.appendChild(cbM);
        container.appendChild(ctrM);

        // Mobile interaction: Tap to play/pause, Double-tap for fullscreen
        let lastTap = 0;
        playerObject.addListener(container, "click", e => {
          // Ignore clicks on controls
          if (e.target.closest('.controls-container') || e.target.closest('.video-title-row')) return;
          const now = Date.now();
          const dt = now - lastTap;
          if (dt < 350) { // Double tap
            enterPseudoFullscreen(container, video);
            lastTap = 0;
          } else { // Single tap
            playerObject.togglePlayback();
            lastTap = now;
          }
        });

        // Play/Pause button action
        playerObject.addListener(ppM, "click", e => {
          e.stopPropagation(); // Prevent container click handler
          playerObject.togglePlayback();
        });

        // Fullscreen button action
        playerObject.addListener(fsBtnMobile, "click", e => {
          e.stopPropagation(); // Prevent container click handler
          enterPseudoFullscreen(container, video);
        });

        // Update Play/Pause button text based on video state
        const updateMobilePlayButton = () => {
          ppM.textContent = (!video.paused || (playerObject.isBuffering && playerObject.wantsToPlay)) ? "⏸" : "▶";
        };
        playerObject.addListener(video, "play", updateMobilePlayButton);
        playerObject.addListener(video, "pause", updateMobilePlayButton);
        playerObject.addListener(video, "ended", () => ppM.textContent = "▶");
        playerObject.addListener(container, 'bufferingchange', updateMobilePlayButton);

      } else {
        // --- Desktop HLS Player Setup (Canvas Rendering) ---
        const canvasWrapper = document.createElement("div");
        canvasWrapper.className = "canvas-wrapper";
        container.appendChild(canvasWrapper);

        const canvas = document.createElement("canvas");
        canvas.className = "display-canvas";
        canvas.width = 960; // Initial base resolution
        canvas.height = 540;
        canvasWrapper.appendChild(canvas);
        playerObject.canvas = canvas; // Store canvas reference

        const desktopBufferingIndicator = createBufferingIndicator();
        canvasWrapper.appendChild(desktopBufferingIndicator);
        playerObject.bufferingIndicator = desktopBufferingIndicator;
        const desktopCornerTimestamp = createCornerTimestampOverlay(canvasWrapper);

        // Create offscreen canvas for masking operations
        playerObject.offscreenCanvas = document.createElement('canvas');
        playerObject.offscreenCanvas.width = canvas.width;
        playerObject.offscreenCanvas.height = canvas.height;
        playerObject.offscreenCtx = playerObject.offscreenCanvas.getContext('2d');
        let canvasRenderer;

        const controlsContainer = document.createElement("div");
        controlsContainer.className = "controls-container";
        container.appendChild(controlsContainer);

        // Initialize overlays state for this player instance
        let currentOverlays = null; // Use a different name to avoid confusion
        let rightSidebar = null; // Define here for access in click handler

        /* --- Privates Overlays Setup (Canvas-based) --- */
        // ... (overlay setup code remains the same) ...
        if (title === 'privates') {
          const overlayIcon = document.createElement('button');
          overlayIcon.className = 'overlay-icon';
          overlayIcon.innerHTML = '⚙️'; // Gear icon
          overlayIcon.title = 'Spot Overlays';
          canvasWrapper.appendChild(overlayIcon); // Add icon to canvas wrapper

          // Assign to the outer scope variable
          rightSidebar = document.createElement('div');
          rightSidebar.className = 'right-sidebar';
          // Use createSafeId for unique IDs within this player
          rightSidebar.innerHTML = `
            <h4>Spot Features</h4>
            <ul>
              <li><input type="checkbox" id="${createSafeId('cb-pp', url)}" data-spot="pp"><label for="${createSafeId('cb-pp', url)}">Pleasure Point</label></li>
              <li><input type="checkbox" id="${createSafeId('cb-jacks', url)}" data-spot="jacks"><label for="${createSafeId('cb-jacks', url)}">Jack's</label></li>
              <li><input type="checkbox" id="${createSafeId('cb-hook', url)}" data-spot="hook"><label for="${createSafeId('cb-hook', url)}">The Hook</label></li>
              <li><input type="checkbox" id="${createSafeId('cb-sharks', url)}" data-spot="sharks"><label for="${createSafeId('cb-sharks', url)}">Sharks</label></li>
              <li><input type="checkbox" id="${createSafeId('cb-ib', url)}" data-spot="ib"><label for="${createSafeId('cb-ib', url)}">In-betweens</label></li>
              <li><input type="checkbox" id="${createSafeId('cb-privates', url)}" data-spot="privates"><label for="${createSafeId('cb-privates', url)}">Privates</label></li>
            </ul>`;
          container.appendChild(rightSidebar); // Add sidebar to main container

          // --- Preload images for canvas ---
          const BASE_OVERLAY_URL = config.overlayBaseUrl;
          // Jack's
          const jacksMinorImg = new Image(); jacksMinorImg.src = `${BASE_OVERLAY_URL}Jack's/Jack's_minor.png`;
          const jacksTextImg = new Image(); jacksTextImg.src = `${BASE_OVERLAY_URL}Jack's/Jack's_text.png`;
          const jacksMaskImg = new Image(); jacksMaskImg.src = `${BASE_OVERLAY_URL}Jack's/Jack's_major.png`;
          // Pleasure Point
          const ppMinorImg = new Image(); ppMinorImg.src = `${BASE_OVERLAY_URL}pp/pp_minor.png`;
          const ppTextImg = new Image(); ppTextImg.src = `${BASE_OVERLAY_URL}pp/pp_text.png`;
          const ppMaskImg = new Image(); ppMaskImg.src = `${BASE_OVERLAY_URL}pp/pp_major.png`;
          // Hook
          const hookMinorImg = new Image(); hookMinorImg.src = `${BASE_OVERLAY_URL}hook/hook_minor.png`;
          const hookTextImg = new Image(); hookTextImg.src = `${BASE_OVERLAY_URL}hook/hook_text.png`;
          const hookMaskImg = new Image(); hookMaskImg.src = `${BASE_OVERLAY_URL}hook/hook_major.png`;
          // Sharks
          const sharksMinorImg = new Image(); sharksMinorImg.src = `${BASE_OVERLAY_URL}sharks/sharks_minor.png`;
          const sharksTextImg = new Image(); sharksTextImg.src = `${BASE_OVERLAY_URL}sharks/sharks_text.png`;
          const sharksMaskImg = new Image(); sharksMaskImg.src = `${BASE_OVERLAY_URL}sharks/sharks_major.png`;
          // In-betweens (ib)
          const ibMinorImg = new Image(); ibMinorImg.src = `${BASE_OVERLAY_URL}ib/ib_minor.png`;
          const ibTextImg = new Image(); ibTextImg.src = `${BASE_OVERLAY_URL}ib/ib_text.png`;
          const ibMaskImg = new Image(); ibMaskImg.src = `${BASE_OVERLAY_URL}ib/ib_major.png`;
          // Privates (spot)
          const privatesMinorImg = new Image(); privatesMinorImg.src = `${BASE_OVERLAY_URL}privates/privates_minor.png`;
          const privatesTextImg = new Image(); privatesTextImg.src = `${BASE_OVERLAY_URL}privates/privates_text.png`;
          const privatesMaskImg = new Image(); privatesMaskImg.src = `${BASE_OVERLAY_URL}privates/privates_major.png`;


          // --- Track which overlays to draw ---
          currentOverlays = {
            // Jack's
            jacks_mask: false, jacks_minor: false, jacks_text: false,
            imgJacksMask: jacksMaskImg, imgJacksMinor: jacksMinorImg, imgJacksText: jacksTextImg,
            // Pleasure Point
            pp_mask: false, pp_minor: false, pp_text: false,
            imgPpMask: ppMaskImg, imgPpMinor: ppMinorImg, imgPpText: ppTextImg,
            // Hook
            hook_mask: false, hook_minor: false, hook_text: false,
            imgHookMask: hookMaskImg, imgHookMinor: hookMinorImg, imgHookText: hookTextImg,
            // Sharks
            sharks_mask: false, sharks_minor: false, sharks_text: false,
            imgSharksMask: sharksMaskImg, imgSharksMinor: sharksMinorImg, imgSharksText: sharksTextImg,
            // In-betweens
            ib_mask: false, ib_minor: false, ib_text: false,
            imgIbMask: ibMaskImg, imgIbMinor: ibMinorImg, imgIbText: ibTextImg,
            // Privates (spot)
            privates_mask: false, privates_minor: false, privates_text: false,
            imgPrivatesMask: privatesMaskImg, imgPrivatesMinor: privatesMinorImg, imgPrivatesText: privatesTextImg,
          };
          playerObject.overlays = currentOverlays; // Add state to the player object

          // --- Toggle the sidebar ---
          playerObject.addListener(overlayIcon, 'click', e => {
            e.stopPropagation();
            rightSidebar.classList.toggle('visible');
          });

          // --- Hook the checkboxes ---
          const setupCheckboxListener = (spotPrefix) => {
              // Use the data-spot attribute to find the checkbox
              const checkbox = rightSidebar.querySelector(`input[data-spot="${spotPrefix}"]`);
              if (checkbox) {
                  playerObject.addListener(checkbox, 'change', e => {
                      const on = e.target.checked;
                      if (currentOverlays) {
                          // Use the spotPrefix directly to update state properties
                          currentOverlays[`${spotPrefix}_mask`] = on;
                          currentOverlays[`${spotPrefix}_minor`] = on;
                          currentOverlays[`${spotPrefix}_text`] = on;
                          if (canvasRenderer) canvasRenderer.renderCanvas(currentOverlays);
                      }
                  });
              } else {
                  console.error(`Could not find ${spotPrefix} checkbox`);
              }
          };

          setupCheckboxListener('pp');
          setupCheckboxListener('jacks');
          setupCheckboxListener('hook');
          setupCheckboxListener('sharks');
          setupCheckboxListener('ib');
          setupCheckboxListener('privates');


          // Close sidebar if clicking outside
          playerObject.addListener(container, 'click', e => {
            // Check if the sidebar exists and is visible
            if (rightSidebar && rightSidebar.classList.contains('visible')) {
              // Check if the click was outside the sidebar and not on the toggle icon
              if (!rightSidebar.contains(e.target) && e.target !== overlayIcon) {
                rightSidebar.classList.remove('visible');
                // Prevent the click from bubbling up and potentially pausing video
                e.preventDefault(); // Prevent default action (like text selection)
                e.stopPropagation(); // Stop the event from reaching the main click handler
              }
            }
          }, true); // Use capture phase to catch the click early

        }
        /* --- end privates overlays setup --- */

        // Append video element (hidden by CSS, used as source for canvas)
        container.appendChild(video);

        canvasRenderer = createCanvasRenderer(playerObject, {
          canvas,
          offscreenCanvas: playerObject.offscreenCanvas,
          getOverlays: () => currentOverlays,
          clampPan
        });
        playerObject.renderCanvas = canvasRenderer.renderCanvas;
        playerObject.redrawCanvas = canvasRenderer.redrawCanvas;


        /* --- Desktop interactions: Pan/Zoom/Click (No changes needed here) --- */
        // ... (Pan/Zoom/Click handlers remain the same, ensuring clampPan(container, canvas) is called) ...
        let startX, startY, isDragging = false, panPixelRatio = 1;
        // Mousedown: Initiate drag panning (if space held or fullscreen)
        playerObject.addListener(canvasWrapper, "mousedown", e => {
          const isFs = document.fullscreenElement === container || document.webkitFullscreenElement === container;
          // Only pan if spacebar is held OR if in fullscreen mode
          if (e.button === 0 && (isSpaceHeld() || isFs)) {
            startX = e.clientX;
            startY = e.clientY;
            isDragging = false; // Reset dragging flag
            container.style.cursor = 'grabbing'; // Indicate panning possible
            // Ratio of canvas intrinsic pixels to displayed CSS pixels — needed so
            // dragging 1 screen pixel moves the image exactly 1 screen pixel.
            const displayW = canvas.getBoundingClientRect().width;
            panPixelRatio = displayW > 0 ? canvas.width / displayW : 1;
            e.preventDefault(); // Prevent text selection, etc.
          }
        });

        // Mousemove: Perform panning if dragging
        playerObject.addListener(document, "mousemove", e => {
          const isFs = document.fullscreenElement === container || document.webkitFullscreenElement === container;
          // Check if left button is down, pan condition met, and drag initiated
          if ((e.buttons & 1) && (isSpaceHeld() || isFs) && typeof startX === 'number') {
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            // Start dragging only after moving a few pixels
            if (!isDragging && Math.hypot(dx, dy) > 5) {
              isDragging = true;
            }
            if (isDragging) {
              // panPixelRatio converts CSS pixels → canvas pixels so the image
              // tracks the cursor 1:1 regardless of how the canvas is scaled by CSS.
              container.panX += dx * panPixelRatio / container.zoomScale;
              container.panY += dy * panPixelRatio / container.zoomScale;
              // Pass canvas to clampPan
              clampPan(container, canvas);
              savePlayerSettings(url, { zoomScale: container.zoomScale, panX: container.panX, panY: container.panY });
              canvasRenderer.redrawCanvas();
              // Update start position for next move delta
              startX = e.clientX;
              startY = e.clientY;
            }
          }
        });

        // Mouseup: End panning
        playerObject.addListener(document, "mouseup", e => {
          if (e.button === 0 && typeof startX === 'number') {
            container.style.cursor = ''; // Reset cursor
            startX = null; // Clear start position
            startY = null;
            // Reset dragging flag slightly later to prevent click event firing immediately
            playerObject.trackTimeout(() => isDragging = false, 0);
          }
        });

        // Wheel: Perform zooming (if space held or fullscreen)
        playerObject.addListener(canvasWrapper, "wheel", e => {
          const isFs = document.fullscreenElement === container || document.webkitFullscreenElement === container;
          // Only zoom if spacebar is held OR if in fullscreen mode
          if (isSpaceHeld() || isFs) {
            e.preventDefault(); // Prevent page scroll
            const rect = canvasWrapper.getBoundingClientRect();
            // Calculate mouse position relative to the canvas wrapper
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            // Normalize mouse coordinates (0 to 1)
            const normX = mouseX / rect.width;
            const normY = mouseY / rect.height;
            // Convert normalized coords to canvas coords (based on canvas drawing surface size)
            const canvasX = normX * canvas.width;
            const canvasY = normY * canvas.height;

            const oldZoom = container.zoomScale;
            const zoomAmount = 0.15; // Zoom sensitivity
            // Calculate new zoom level
            let newZoom = oldZoom * (e.deltaY < 0 ? (1 + zoomAmount) : (1 / (1 + zoomAmount)));
            newZoom = Math.max(1, Math.min(5, newZoom)); // Clamp zoom between 1x and 5x

            if (newZoom !== oldZoom) {
              // Adjust pan to keep the point under the mouse stationary
              // Use canvas center for calculation
              const canvasCenterX = canvas.width / 2;
              const canvasCenterY = canvas.height / 2;
              container.panX += (canvasX - canvasCenterX) * (1/newZoom - 1/oldZoom);
              container.panY += (canvasY - canvasCenterY) * (1/newZoom - 1/oldZoom);
              container.zoomScale = newZoom; // Apply new zoom
              // Pass canvas to clampPan
              clampPan(container, canvas);
              savePlayerSettings(url, { zoomScale: container.zoomScale, panX: container.panX, panY: container.panY });
              canvasRenderer.redrawCanvas();
            }
          }
        }, { passive: false }); // Need passive:false to preventDefault

        // Click/Double-Click: Play/Pause or Fullscreen
        let clickTimeout = null;
        let lastClickTime = 0;
        const handleDesktopClick = e => {
          // If the click was handled by the sidebar closing logic (capture phase), do nothing here.
          if (e.defaultPrevented) {
              return;
          }

          const isFs = document.fullscreenElement === container || document.webkitFullscreenElement === container;
          // Ignore clicks on overlay controls or player controls
          if (e.target.closest('.overlay-icon') || e.target.closest('.right-sidebar') || e.target.closest('.controls-container')) return;
          // Ignore clicks outside the container (covers canvas and black bars in FS)
          if (!container.contains(e.target)) return;
          // Ignore right-clicks or if currently dragging
          if (e.button !== 0 || isDragging) return;

          const now = Date.now();
          if (now - lastClickTime < 300) { // Double-click detected
            clearTimeout(clickTimeout); // Cancel single-click action
            lastClickTime = 0; // Reset timer
            // Toggle fullscreen
            if (!isFs) enterNativeFullScreen(container);
            else exitNativeFullScreen();
          } else { // Potential single-click
            clickTimeout = playerObject.trackTimeout(() => {
              // Toggle play/pause if click was within container
               playerObject.togglePlayback();
            }, 300); // Wait for potential double-click
          }
          lastClickTime = now; // Record click time
        };
        // Use bubbling phase for the main click handler
        playerObject.addListener(container, "click", handleDesktopClick, false);


        /* --- Desktop Controls Bar --- */
        const controlBar = document.createElement("div");
        controlBar.className = "control-bar";
        controlsContainer.appendChild(controlBar);

        // Play/Pause Button
        const playPauseBtn = document.createElement("button");
        playPauseBtn.className = "play-pause-btn";
        playPauseBtn.textContent = video.paused ? "▶" : "⏸";
        playPauseBtn.setAttribute("aria-label","Play/Pause");
        playerObject.addListener(playPauseBtn, "click", e => {
          e.stopPropagation();
          playerObject.togglePlayback();
        });
        const updateDesktopPlayButton = () => {
          playPauseBtn.textContent = (!video.paused || (playerObject.isBuffering && playerObject.wantsToPlay)) ? "⏸" : "▶";
        };
        playerObject.addListener(video, "play", updateDesktopPlayButton);
        playerObject.addListener(video, "pause", updateDesktopPlayButton);
        playerObject.addListener(video, "ended", () => playPauseBtn.textContent = "▶");
        playerObject.addListener(container, 'bufferingchange', updateDesktopPlayButton);
        controlBar.appendChild(playPauseBtn);

        // Progress Bar
        const progressBar = document.createElement("div");
        progressBar.className = "progress-bar";
        const bufferedBar = document.createElement("div");
        bufferedBar.className = "buffered";
        const playedBar = document.createElement("div");
        playedBar.className = "played";
        const thumb = document.createElement("div");
        thumb.className = "thumb";
        thumb.draggable = false;
        progressBar.appendChild(bufferedBar);
        progressBar.appendChild(playedBar);
        progressBar.appendChild(thumb);
        const timelinePreview = createTimelinePreviewHud(progressBar);
        controlBar.appendChild(progressBar);

        // Progress Bar Seeking Logic — declared here so updateProgressBar can reference them
        let isSeeking = false;
        let pendingSeekTime = -1;
        let lastThrottledSeek = 0;
        let wasPlayingBeforeScrub = false;

        // Update progress bar display
        function updateProgressBar() {
          if (isSeeking) return; // drag in progress — visual updated by seek()
          if (playerObject.isBuffering) return;

          const range = getVideoRange(video);
          if (range && range.end > range.start) {
            const d = range.end - range.start;
            const ct = video.currentTime;
            const b = video.buffered;
            let bEnd = 0;
            // Find buffered end time relevant to current time
            try { // Add try-catch for robustness
              for (let i = 0; i < b.length; i++) {
                if (b.start(i) <= ct && b.end(i) >= ct) {
                  bEnd = b.end(i);
                  break;
                }
                // Fallback: use the latest buffered end time if none contain current time
                bEnd = Math.max(bEnd, b.end(i));
              }
            } catch {} // Ignore potential errors accessing buffered ranges
            const pp = ((ct - range.start) / d) * 100; // Played percentage
            const bp = ((bEnd - range.start) / d) * 100; // Buffered percentage
            playedBar.style.width = `${Math.max(0, Math.min(100, pp))}%`;
            thumb.style.left = `${Math.max(0, Math.min(100, pp))}%`;
            bufferedBar.style.width = `${Math.max(0, Math.min(100, bp))}%`;

          } else {
            // Reset if duration is invalid (e.g., live stream with no duration)
            playedBar.style.width = '0%';
            thumb.style.left = '0%';
            bufferedBar.style.width = '0%';
          }
        }
        playerObject.updateTimeline = updateProgressBar;
        // Update on relevant video events
        ["timeupdate", "progress", "loadedmetadata", "durationchange", "seeking", "seeked"].forEach(evt => {
          playerObject.addListener(video, evt, updateProgressBar);
        });
        // Also update on play/pause to immediately reflect state change if needed
        playerObject.addListener(video, "play", updateProgressBar);
        playerObject.addListener(video, "pause", updateProgressBar);
        updateProgressBar(); // Initial update

        function seek(event) {
          const range = getVideoRange(video);
          if (range && range.end > range.start) {
            const d = range.end - range.start;
            const pr = progressBar.getBoundingClientRect();
            let cX = event.clientX;
            if (event.type.startsWith('touch')) {
              if (event.touches.length > 0) cX = event.touches[0].clientX;
              else if (event.changedTouches.length > 0) cX = event.changedTouches[0].clientX;
            }
            const sp = Math.max(0, Math.min(1, (cX - pr.left) / pr.width));
            const st = range.start + sp * d;

            let seekable = false;
            try {
              for (let i = 0; i < video.seekable.length; i++) {
                if (st >= video.seekable.start(i) && st <= video.seekable.end(i)) {
                  seekable = true; break;
                }
              }
            } catch { seekable = true; }

            if (seekable) {
              pendingSeekTime = st;
              // Update visual immediately
              const pp = Math.min(100, ((st - range.start) / d) * 100);
              playedBar.style.width = `${pp}%`;
              thumb.style.left = `${pp}%`;
              showTimelinePreview(playerObject, timelinePreview, desktopCornerTimestamp, st, pp);
              // Throttled seek so canvas shows the frame at the scrub position;
              // use a short interval when already buffered, longer when a fetch is needed
              const now = performance.now();
              const throttle = isTimeBuffered(video, st) ? SEEK_THROTTLE_BUFFERED_MS : SEEK_THROTTLE_MS;
              if (now - lastThrottledSeek >= throttle) {
                lastThrottledSeek = now;
                video.currentTime = st;
              }
            }
          }
        }
        function showHoverTimestamp(event) {
          if (IS_MOBILE || isSeeking) return;
          const range = getVideoRange(video);
          if (!range || range.end <= range.start) return;
          const pr = progressBar.getBoundingClientRect();
          const sp = Math.max(0, Math.min(1, (event.clientX - pr.left) / pr.width));
          showTimelinePreview(playerObject, timelinePreview, desktopCornerTimestamp, range.start + sp * (range.end - range.start), sp * 100);
        }
        function hideHoverTimestamp() {
          if (isSeeking) return;
          hideTimelinePreview(playerObject, timelinePreview);
          hideCornerTimestampOverlay(playerObject, desktopCornerTimestamp);
        }
        function applyPendingSeek() {
          if (pendingSeekTime >= 0) {
            video.currentTime = pendingSeekTime;
            pendingSeekTime = -1;
            if (wasPlayingBeforeScrub) {
              playerObject.addListener(video, 'seeked', () => video.play().catch(() => {}), { once: true });
            } else {
              video.pause();
            }
          }
        }
        function finishSeek() {
          if (!isSeeking) return;
          isSeeking = false;
          progressBar.classList.remove('seeking');
          hideTimelinePreview(playerObject, timelinePreview);
          hideCornerTimestampOverlay(playerObject, desktopCornerTimestamp, true);
          progressBar.style.cursor = 'pointer';
          document.body.style.userSelect = '';
          applyPendingSeek();
        }
        // Mouse down on progress bar starts seeking
        playerObject.addListener(progressBar, "mousedown", e => {
          if (e.button === 0) {
            e.preventDefault();
            isSeeking = true;
            wasPlayingBeforeScrub = !video.paused;
            progressBar.classList.add('seeking');
            document.body.style.userSelect = 'none';
            seek(e);
            progressBar.style.cursor = 'grabbing';
          }
        });
        // Touch start
        playerObject.addListener(progressBar, "touchstart", e => {
          isSeeking = true;
          wasPlayingBeforeScrub = !video.paused;
          progressBar.classList.add('seeking');
          document.body.style.webkitUserSelect = 'none';
          seek(e);
        }, { passive: true });
        // Mouse move updates visual position only
        playerObject.addListener(document, "mousemove", e => {
          if (!isSeeking) return;
          if (!(e.buttons & 1)) { finishSeek(); return; }
          seek(e);
        });
        // Touch move updates visual position only
        playerObject.addListener(document, "touchmove", e => {
          if (isSeeking) {
            e.preventDefault();
            seek(e);
          }
        }, { passive: false });
        // Mouse up — apply the single deferred seek
        playerObject.addListener(document, "mouseup", e => {
          if (e.button !== 0) return;
          const wasSeeking = isSeeking;
          finishSeek();
          if (wasSeeking && progressBar.matches(':hover')) showHoverTimestamp(e);
        });
        playerObject.addListener(window, "blur", finishSeek);
        // Touch end — apply the single deferred seek
        playerObject.addListener(document, "touchend", e => {
          if (isSeeking) {
            isSeeking = false;
            progressBar.classList.remove('seeking');
            hideTimelinePreview(playerObject, timelinePreview);
            hideCornerTimestampOverlay(playerObject, desktopCornerTimestamp, true);
            document.body.style.webkitUserSelect = '';
            applyPendingSeek();
          }
        });
        playerObject.addListener(progressBar, "mouseenter", showHoverTimestamp);
        playerObject.addListener(progressBar, "mousemove", showHoverTimestamp);
        playerObject.addListener(progressBar, "mouseleave", hideHoverTimestamp);

        // Fullscreen Button (Desktop Native)
        const fsBtnDesktop = document.createElement("button");
        fsBtnDesktop.innerHTML = "&#x26F6;"; // Fullscreen symbol
        fsBtnDesktop.setAttribute("aria-label","Enter/Exit Fullscreen");
        playerObject.addListener(fsBtnDesktop, "click", e => {
          e.stopPropagation(); // Prevent container click
          if (!document.fullscreenElement && !document.webkitFullscreenElement) {
            enterNativeFullScreen(container);
          } else {
            exitNativeFullScreen();
          }
        });
        controlBar.appendChild(fsBtnDesktop);

        // Tide forecast is available from the fullscreen timeline controls.
        const tidesControl = document.createElement('div');
        tidesControl.className = 'tides-control';
        const tidesBtn = document.createElement('button');
        tidesBtn.type = 'button';
        tidesBtn.textContent = 'Tides';
        tidesBtn.setAttribute('aria-label', 'Open tide forecast');
        tidesControl.appendChild(tidesBtn);
        controlBar.appendChild(tidesControl);

        // Update fullscreen button icon based on state
        function updateFsBtn() {
          const isFs = document.fullscreenElement === container || document.webkitFullscreenElement === container;
          fsBtnDesktop.innerHTML = isFs ? "&#x2921;" : "&#x26F6;"; // Exit/Enter symbols
          // Trigger canvas resize when FS state changes
          resizeCanvas(playerObject);
        }
        playerObject.addListener(document, "fullscreenchange", updateFsBtn);
        playerObject.addListener(document, "webkitfullscreenchange", updateFsBtn);

        // Reset Pan/Zoom Button
        const resetBtn = document.createElement("button");
        resetBtn.textContent = "Reset";
        resetBtn.className = "reset-btn"; // Add class if specific styling needed
        resetBtn.setAttribute("aria-label","Reset Pan & Zoom");
        playerObject.addListener(resetBtn, "click", e => {
          e.stopPropagation(); // Prevent container click
          container.zoomScale = 1;
          container.panX = 0;
          container.panY = 0;
          savePlayerSettings(url, { zoomScale: 1, panX: 0, panY: 0 }, { immediate: true });
          // No need to manually redraw, renderCanvas loop handles it
        });
        controlBar.appendChild(resetBtn);

        // Disable/Hide Stream Button
        const disableBtn = document.createElement("button");
        disableBtn.className = "disable-btn";
        disableBtn.textContent = "✕"; // Close symbol
        disableBtn.setAttribute("aria-label","Hide this stream");
        playerObject.addListener(disableBtn, "click", e => {
          e.stopPropagation(); // Prevent container click
          updateStreamEnabled(url, false); // Call main function to hide/remove
        });
        controlBar.appendChild(disableBtn);

        // Title Bar below controls
        const tb = document.createElement("div");
        tb.className = "title-bar";
        tb.textContent = title;
        controlsContainer.appendChild(tb);

        /* --- Auto-hide controls in fullscreen --- */
        let hideControlsTimeout = null;
        function showControlsTemporarily() {
          const isFs = document.fullscreenElement === container || document.webkitFullscreenElement === container;
          if (!isFs) return; // Only applies in fullscreen
          controlsContainer.style.opacity = '1';
          controlsContainer.style.pointerEvents = 'auto';
          clearTimeout(hideControlsTimeout);
          // Don't auto-hide if paused or buffering
          if (!video.paused && !playerObject.isBuffering) {
            hideControlsTimeout = playerObject.trackTimeout(() => {
              controlsContainer.style.opacity = '0';
              controlsContainer.style.pointerEvents = 'none';
            }, 3000); // Hide after 3 seconds of inactivity
          }
        }
        // Show controls on mouse move/enter in fullscreen
        playerObject.addListener(container, 'mousemove', showControlsTemporarily);
        playerObject.addListener(container, 'mouseenter', showControlsTemporarily);
        // Keep controls visible when paused or waiting
        playerObject.addListener(video, 'pause', showControlsTemporarily);
        playerObject.addListener(video, 'waiting', showControlsTemporarily);
        // Start hide timer when playing (and not buffering)
        playerObject.addListener(video, 'play', showControlsTemporarily);

        // Set initial controls visibility based on fullscreen state
        function setInitialControlsVisibility() {
          const isFs = document.fullscreenElement === container || document.webkitFullscreenElement === container;
          if (isFs) {
            showControlsTemporarily(); // Start hidden timer if playing
          } else {
            // Ensure controls are visible when not fullscreen
            controlsContainer.style.opacity = '1';
            controlsContainer.style.pointerEvents = 'auto';
            clearTimeout(hideControlsTimeout); // Cancel any hide timer
          }
        }
        playerObject.addListener(document, "fullscreenchange", setInitialControlsVisibility);
        playerObject.addListener(document, "webkitfullscreenchange", setInitialControlsVisibility);

        playerObject.tidesCleanup = attachTideControl(container, tidesBtn, { onOpen: showControlsTemporarily });

        // Add resize listener for canvas adjustments
        playerObject.resizeHandler = () => resizeCanvas(playerObject);
        playerObject.addListener(window, "resize", playerObject.resizeHandler); // Handle window resize too

      }


}
