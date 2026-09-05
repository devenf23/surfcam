import { getBufferedPlaybackInfo } from './media-timeline.mjs';
const BUFFER_RESUME_SECONDS = 1.5;

    export function setupStreamBuffering(player, { isMobile: IS_MOBILE }) {
      const { video, container, bufferingIndicator } = player;
      if (!bufferingIndicator) return;

      let internalPauseEvents = 0;
      let baselineBufferedEnd = 0;
      let waitForNewContent = false;
      let resumeAttemptInFlight = false;

      const notifyStateChange = () => {
        container.dispatchEvent(new CustomEvent('bufferingchange', {
          detail: { buffering: player.isBuffering, wantsToPlay: player.wantsToPlay }
        }));
      };

      const setIndicatorVisible = visible => {
        bufferingIndicator.hidden = !visible;
        bufferingIndicator.classList.toggle('visible', visible);
        container.classList.toggle('is-buffering', visible);
        if (visible) container.setAttribute('aria-busy', 'true');
        else container.removeAttribute('aria-busy');
      };

      const canShowIndicator = () => {
        if (!player.isBuffering) return false;

        // A stale buffering flag must not cover a frame that is already being
        // played. `playing` normally clears the flag; this guard also handles
        // browsers that omit or delay that event during HLS recovery.
        const isActuallyPlaying = !video.paused &&
          video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
        if (isActuallyPlaying) return false;

        // While mobile pseudo-fullscreen is active, only the active player may
        // own the shared buffering surface. A staged swipe target has its own
        // opaque transition loader, so it is suppressed here as well.
        if (IS_MOBILE && document.documentElement.classList.contains('pseudo-fullscreen-mobile')) {
          if (!container.classList.contains('player-fullscreen-mobile') || player.suppressBufferingIndicator) {
            return false;
          }
        }
        return true;
      };

      const syncBufferingIndicator = () => setIndicatorVisible(canShowIndicator());
      player.syncBufferingIndicator = syncBufferingIndicator;

      const clearBuffering = () => {
        if (!player.isBuffering && bufferingIndicator.hidden) return;
        player.isBuffering = false;
        player.stallPause = false;
        waitForNewContent = false;
        resumeAttemptInFlight = false;
        setIndicatorVisible(false);
        if (player.updateTimeline) player.updateTimeline();
        notifyStateChange();
      };

      const beginBuffering = ({ requireNewContent = false } = {}) => {
        // A paused player has no playback intent to preserve. Network activity
        // can continue in the background without presenting it as a playback stall.
        if (!player.wantsToPlay && video.paused) return;

        const info = getBufferedPlaybackInfo(video);
        if (!player.isBuffering) baselineBufferedEnd = info.latestEnd;
        waitForNewContent = waitForNewContent || requireNewContent;
        player.isBuffering = true;
        player.stallPause = player.wantsToPlay;
        resumeAttemptInFlight = false;

        // pause() changes video.paused immediately but queues the pause event.
        // Count that event instead of using a synchronous boolean guard, or the
        // queued event is mistaken for a user pause and automatic recovery is lost.
        if (!video.paused) {
          internalPauseEvents += 1;
          video.pause();
        }
        syncBufferingIndicator();
        notifyStateChange();
      };

      const hasRecovered = () => {
        const info = getBufferedPlaybackInfo(video);
        if (waitForNewContent && info.latestEnd <= baselineBufferedEnd + 0.05) return false;
        if (info.ahead >= BUFFER_RESUME_SECONDS) return true;
        return info.ahead > 0.25 && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
      };

      const tryResume = () => {
        if (!player.isBuffering || resumeAttemptInFlight) return;
        if (!player.wantsToPlay) {
          clearBuffering();
          return;
        }
        if (!hasRecovered()) return;

        resumeAttemptInFlight = true;
        video.play().catch(() => {
          // A later progress/canplay event or the recovery poll will retry.
          resumeAttemptInFlight = false;
        });
      };

      const cancelAutoResume = () => {
        player.wantsToPlay = false;
        clearBuffering();
      };

      player.showSpinner = beginBuffering;
      player.hideSpinner = tryResume;
      player.cancelBufferingResume = cancelAutoResume;
      player.requestPlay = ({ allowWhileBuffering = false } = {}) => {
        player.wantsToPlay = true;
        if (player.isBuffering && !allowWhileBuffering) tryResume();
        else video.play().catch(() => {});
        notifyStateChange();
      };
      player.togglePlayback = () => {
        if (player.isBuffering) {
          if (player.wantsToPlay) cancelAutoResume();
          else player.requestPlay();
        } else if (video.paused) {
          player.requestPlay();
        } else {
          video.pause();
        }
      };

      player.addListener(video, 'loadstart', () => {
        if (player.wantsToPlay) beginBuffering();
      });
      player.addListener(video, 'waiting', () => beginBuffering());
      player.addListener(video, 'stalled', () => beginBuffering({ requireNewContent: true }));
      player.addListener(video, 'pause', () => {
        if (internalPauseEvents > 0) {
          internalPauseEvents -= 1;
          return;
        }
        player.wantsToPlay = false;
        if (player.isBuffering) clearBuffering();
        else notifyStateChange();
      });
      player.addListener(video, 'play', () => {
        player.wantsToPlay = true;
        syncBufferingIndicator();
        notifyStateChange();
      });
      player.addListener(video, 'playing', clearBuffering);
      player.addListener(video, 'ended', () => {
        player.wantsToPlay = false;
        clearBuffering();
      });
      ['progress', 'loadeddata', 'canplay', 'durationchange'].forEach(eventName => {
        player.addListener(video, eventName, tryResume);
      });
      player.trackInterval(tryResume, 500);
    }

