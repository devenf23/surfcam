    export function isTimeBuffered(video, t) {
      try {
        for (let i = 0; i < video.buffered.length; i++) {
          if (t >= video.buffered.start(i) && t <= video.buffered.end(i)) return true;
        }
      } catch {}
      return false;
    }

    // Returns {start, end} of the playable window, or null if not yet available.
    // Falls back to video.seekable when duration is Infinity (native HLS on iOS Safari).
    export function getVideoRange(video) {
      const d = video.duration;
      if (isFinite(d) && d > 0) return { start: 0, end: d };
      try {
        if (video.seekable.length > 0) {
          return { start: video.seekable.start(0), end: video.seekable.end(video.seekable.length - 1) };
        }
      } catch {}
      return null;
    }

    const BUFFER_RESUME_SECONDS = 1.5;

    export function getBufferedPlaybackInfo(video) {
      const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      let currentRangeEnd = currentTime;
      let latestEnd = currentTime;
      try {
        for (let i = 0; i < video.buffered.length; i++) {
          const start = video.buffered.start(i);
          const end = video.buffered.end(i);
          latestEnd = Math.max(latestEnd, end);
          // A small tolerance handles adjacent HLS fragments whose timestamps do
          // not join perfectly even though the browser can play through the gap.
          if (start <= currentTime + 0.25 && end > currentTime) {
            currentRangeEnd = Math.max(currentRangeEnd, end);
          }
        }
      } catch {}
      return {
        ahead: Math.max(0, currentRangeEnd - currentTime),
        latestEnd
      };
    }

