import { config } from './config.mjs';
import { setupStreamBuffering } from './playback-controller.mjs';

export function attachHlsPlayback(playerObject, {
  url, isMobile: IS_MOBILE, captureCurrentPreviewFrame,
  applyHlsFragmentTimestamp, startManifestTimestampSync, Hls = globalThis.Hls
}) {
  const { video, container } = playerObject;
  const PROXY_PREFIX = config.proxyPrefix;
  let hlsInstance = null;
      /* --- HLS.js Setup (Common for Mobile/Desktop HLS) --- */

        setupStreamBuffering(playerObject, { isMobile: IS_MOBILE });
        ["loadeddata", "playing", "seeked"].forEach(evt => {
          playerObject.addListener(video, evt, () => captureCurrentPreviewFrame(playerObject));
        });
        playerObject.trackInterval(() => captureCurrentPreviewFrame(playerObject), 500);
        // On desktop Safari, prefer native HLS to avoid MSE quirks.
        // On mobile, always try hls.js first: its custom loader routes every request
        // (manifest + segments) through the proxy, and it reports a finite duration for
        // DVR streams. Native HLS on iOS only proxies the manifest — segments are fetched
        // directly and may fail — and reports Infinity duration, breaking the timeline.
        const preferNativeHls = !IS_MOBILE && /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
        const canPlayNativeHls = video.canPlayType("application/vnd.apple.mpegurl");

        if (Hls.isSupported() && !preferNativeHls) {
          // Use HLS.js
          hlsInstance = new Hls({
            enableWorker: true,
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
            liveSyncDurationCount: 3,
            liveMaxLatencyDurationCount: 999,
            maxBufferHole: 0.5,
            startFragPrefetch: true,
            fragLoadingTimeOut: 20000,
            manifestLoadingTimeOut: 20000,
            levelLoadingTimeOut: 20000,
            // Custom loader to conditionally prepend proxy URL
            loader: class extends Hls.DefaultConfig.loader {
              load(context, config, callbacks) {
                let requestUrl = context.url;
                if (IS_MOBILE) {
                    while (requestUrl.startsWith(PROXY_PREFIX)) {
                      requestUrl = decodeURIComponent(requestUrl.slice(PROXY_PREFIX.length));
                    }
                    context.url = PROXY_PREFIX + encodeURIComponent(requestUrl);
                } else {
                     while (requestUrl.startsWith(PROXY_PREFIX)) {
                      requestUrl = decodeURIComponent(requestUrl.slice(PROXY_PREFIX.length));
                    }
                    context.url = requestUrl;
                }
                super.load(context, config, callbacks);
              }
            }
          });
          playerObject.hls = hlsInstance;

          hlsInstance.loadSource(url);
          hlsInstance.attachMedia(video);

          hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
            // The first play attempt lets HLS establish its DVR start position.
            // Subsequent stall recovery still waits for buffered media.
            if (playerObject.wantsToPlay) {
              playerObject.requestPlay({ allowWhileBuffering: true });
            }
          });

          if (Hls.Events.FRAG_CHANGED) {
            hlsInstance.on(Hls.Events.FRAG_CHANGED, (_event, data) => {
              applyHlsFragmentTimestamp(playerObject, data?.frag);
            });
          }
          hlsInstance.on(Hls.Events.FRAG_BUFFERED, (_event, data) => {
            applyHlsFragmentTimestamp(playerObject, data?.frag);
          });
          if (Hls.Events.LEVEL_UPDATED) {
            hlsInstance.on(Hls.Events.LEVEL_UPDATED, (_event, data) => {
              const fragments = data?.details?.fragments || [];
              const currentTime = video.currentTime;
              const currentFrag = fragments.find(frag => currentTime >= frag.start && currentTime < frag.start + frag.duration);
              applyHlsFragmentTimestamp(playerObject, currentFrag || fragments[fragments.length - 1]);
            });
          }
          startManifestTimestampSync(playerObject, url);

          // HLS.js error handling - Enhanced
          hlsInstance.on(Hls.Events.ERROR, (event, data) => {
            console.error(`HLS Error: Type=${data.type}, Details=${data.details}`, data);

            if (data.fatal) {
              const shouldResume = playerObject.wantsToPlay || !video.paused;
              const needsNetworkProgress = data.type === Hls.ErrorTypes.NETWORK_ERROR;
              if (shouldResume) {
                playerObject.showSpinner({ requireNewContent: needsNetworkProgress });
              }
              else video.pause();
              switch(data.type) {
                case Hls.ErrorTypes.NETWORK_ERROR:
                  console.log("Network error, retrying load...");
                  playerObject.trackTimeout(() => {
                    if (hlsInstance) {
                      hlsInstance.startLoad();
                    }
                  }, 2000);
                  break;
                case Hls.ErrorTypes.MEDIA_ERROR:
                  console.log("Fatal media error, attempting recovery...");
                  if (hlsInstance) {
                    hlsInstance.recoverMediaError();
                  }
                  break;
                default:
                  console.log("Unrecoverable HLS error, destroying instance.");
                  if (playerObject.swipeLoadError) playerObject.swipeLoadError();
                  if (hlsInstance) {
                      hlsInstance.destroy();
                      hlsInstance = null;
                      playerObject.hls = null;
                  }
                  break;
              }
            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              switch (data.details) {
                case Hls.ErrorDetails.BUFFER_STALLED_ERROR:
                  console.warn('Buffer stalled — freezing playhead until data loads.');
                  // Delegate to the stall-pause mechanism; don't nudge currentTime forward.
                  if (playerObject.showSpinner) playerObject.showSpinner();
                  break;
                case Hls.ErrorDetails.BUFFER_SEEK_OVER_HOLE:
                  console.warn('Buffer seek-over-hole — nudging past gap.');
                  if (hlsInstance) {
                    hlsInstance.recoverMediaError();
                    const shouldResume = playerObject.wantsToPlay;
                    playerObject.trackTimeout(() => {
                      if (video.currentTime === data.buffer || (shouldResume && video.paused)) {
                        video.currentTime += 0.1;
                        if (shouldResume) playerObject.requestPlay();
                      }
                    }, 500);
                  }
                  break;
                case Hls.ErrorDetails.BUFFER_FULL_ERROR:
                  console.log("Buffer full, HLS.js should handle this.");
                  break;
              }
            } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !data.fatal) {
              // Non-fatal network errors (e.g. fragment load timeout) mean content isn't
              // arriving. Proactively pause so the playhead stops advancing before the
              // buffer fully drains. Resume fires via FRAG_BUFFERED once a fragment lands.
              if (playerObject.wantsToPlay && playerObject.showSpinner) {
                playerObject.showSpinner({ requireNewContent: true });
              }
            }
          });

          // A newly appended fragment may satisfy the recovery threshold.
          hlsInstance.on(Hls.Events.FRAG_BUFFERED, () => {
            if (playerObject.hideSpinner) playerObject.hideSpinner();
          });

        } else if (canPlayNativeHls) {
          // Use native HLS playback
          console.log(`Using native HLS for ${url}`);
          // Conditionally use proxy
          video.src = IS_MOBILE ? PROXY_PREFIX + encodeURIComponent(url) : url;
          startManifestTimestampSync(playerObject, url);
          // Native HLS often requires explicit play action
          if (video.autoplay) {
             playerObject.requestPlay({ allowWhileBuffering: true });
          }
          // Add basic error listener for native playback
          playerObject.addListener(video, 'error', e => {
             console.error(`Native HLS Error for ${url}:`, video.error);
             if (playerObject.swipeLoadError) playerObject.swipeLoadError();
             // Pause the playhead so the timeline only reflects actually loaded video.
             if (playerObject.wantsToPlay || !video.paused) {
               playerObject.showSpinner({ requireNewContent: true });
             } else {
               video.pause();
             }
             // Optionally display error in UI
             const tb = container.querySelector('.title-bar, .video-title-row span');
             if(tb) {
                 tb.textContent = `Error: ${video.error?.message || 'Could not load stream'}`;
                 tb.style.color = 'red';
             }
          });

        } else {
          // HLS not supported at all
          console.warn(`HLS not supported in this browser for ${url}`);
          const em = document.createElement('div');
          em.textContent = 'HLS playback not supported in this browser.';
          em.style.cssText = 'color:red; text-align:center; padding:20px; position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); background:rgba(0,0,0,0.7); border-radius:5px;';
          // Add error message to appropriate place (canvas wrapper or container)
          const target = container.querySelector('.canvas-wrapper') || container;
          target.appendChild(em);
        }
      
}

// MP4 uses native controls but shares deployment routing with HLS playback.
export function attachMp4Playback(player, { url, isMobile }) {
  player.wantsToPlay = false;
  player.video.src = isMobile ? config.proxyPrefix + encodeURIComponent(url) : url;
}
