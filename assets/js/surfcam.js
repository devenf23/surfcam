
    function enterNativeFullScreen(el) {
      if (document.fullscreenElement || document.webkitFullscreenElement) return Promise.resolve();
      const r = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
      if (r) return r.call(el).catch(err => console.error("Native Fullscreen request failed:", err));
      else return Promise.reject("Native Fullscreen not supported");
    }
    function exitNativeFullScreen() {
      if (!document.fullscreenElement && !document.webkitFullscreenElement) return Promise.resolve();
      const e = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
      if (e) return e.call(document).catch(err => console.error("Exit Native Fullscreen failed:", err));
      else return Promise.reject("Exit Native Fullscreen not supported");
    }

    const PROXY_PREFIX = "https://surfcam-alpha.vercel.app/api/proxy?url=";
    const PLAYER_SETTINGS_KEY = "liveDvrPlayerSettings_v1";
    const STREAM_CONFIGS_KEY = "liveDvrStreamConfigs_v1";
    const playerSettingsTimers = new Map();
    const pendingPlayerSettings = new Map();

    function loadPlayerSettings(url) {
      try {
        const all = JSON.parse(localStorage.getItem(PLAYER_SETTINGS_KEY) || "{}");
        const saved = all[url];
        if (!saved || typeof saved !== "object") return { zoomScale: 1, panX: 0, panY: 0 };
        return {
          zoomScale: Number.isFinite(saved.zoomScale) ? Math.max(1, Math.min(5, saved.zoomScale)) : 1,
          panX: Number.isFinite(saved.panX) ? saved.panX : 0,
          panY: Number.isFinite(saved.panY) ? saved.panY : 0
        };
      } catch {
        return { zoomScale: 1, panX: 0, panY: 0 };
      }
    }
    function flushPlayerSettings(url) {
      const data = pendingPlayerSettings.get(url);
      if (!data) return;
      pendingPlayerSettings.delete(url);
      const timer = playerSettingsTimers.get(url);
      if (timer) clearTimeout(timer);
      playerSettingsTimers.delete(url);
      try {
        let all = JSON.parse(localStorage.getItem(PLAYER_SETTINGS_KEY) || "{}");
        all[url] = data;
        localStorage.setItem(PLAYER_SETTINGS_KEY, JSON.stringify(all));
      } catch {}
    }
    function savePlayerSettings(url, data, { immediate = false } = {}) {
      pendingPlayerSettings.set(url, { zoomScale: data.zoomScale, panX: data.panX, panY: data.panY });
      if (immediate) return flushPlayerSettings(url);
      const prior = playerSettingsTimers.get(url);
      if (prior) clearTimeout(prior);
      playerSettingsTimers.set(url, setTimeout(() => flushPlayerSettings(url), 150));
    }
    function getStreamList() {
      try {
        const stored = localStorage.getItem(STREAM_CONFIGS_KEY);
        if (!stored) return [];
        const parsed = JSON.parse(stored);
        if (!Array.isArray(parsed) || !parsed.every(i => typeof i === 'object' && 'url' in i && 'enabled' in i)) {
          localStorage.removeItem(STREAM_CONFIGS_KEY);
          return [];
        }
        return parsed;
      } catch {
        localStorage.removeItem(STREAM_CONFIGS_KEY);
        return [];
      }
    }
    function saveStreamList(list) {
      try {
        if (!Array.isArray(list) || !list.every(i => typeof i === 'object' && 'url' in i && 'enabled' in i)) return;
        localStorage.setItem(STREAM_CONFIGS_KEY, JSON.stringify(list));
      } catch {}
    }

    function extractTitle(url) {
      const m = url.match(/wc-([^\/]+)\/playlist/);
      return m ? m[1] : url;
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
    const SEEK_THROTTLE_MS = 250;          // unbuffered seek — conservative to avoid excess requests
    const SEEK_THROTTLE_BUFFERED_MS = 50;  // buffered seek — fast, no network needed

    function isTimeBuffered(video, t) {
      try {
        for (let i = 0; i < video.buffered.length; i++) {
          if (t >= video.buffered.start(i) && t <= video.buffered.end(i)) return true;
        }
      } catch {}
      return false;
    }

    // Returns {start, end} of the playable window, or null if not yet available.
    // Falls back to video.seekable when duration is Infinity (native HLS on iOS Safari).
    function getVideoRange(video) {
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

    function getBufferedPlaybackInfo(video) {
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

    function setupStreamBuffering(player) {
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

    /* --- Fullscreen tide display (uses the same NOAA source and offsets as tides.html) --- */
    const FULLSCREEN_TIDE_STATION = '9413450';
    const FULLSCREEN_TIDE_OFFSETS = {
      H: { timeMin: -6, heightAdd: 0.97 },
      L: { timeMin: -11, heightAdd: 0.99 },
      avgTimeMin: -8.5,
      avgHeightFt: 0.98
    };
    const fullscreenTideCache = new Map();

    function getTideDateKey(date) {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }

    function buildFullscreenNoaaUrl(dateKey, interval = '') {
      const intervalPart = interval ? `&interval=${interval}` : '';
      return `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` +
        `?begin_date=${dateKey.replaceAll('-', '')}&end_date=${dateKey.replaceAll('-', '')}` +
        `&station=${FULLSCREEN_TIDE_STATION}&product=predictions` +
        `&datum=MLLW&units=english&time_zone=lst_ldt${intervalPart}` +
        `&format=json&application=GeminiTideChart`;
    }

    async function loadFullscreenTides(date = new Date()) {
      const dateKey = getTideDateKey(date);
      if (fullscreenTideCache.has(dateKey)) return fullscreenTideCache.get(dateKey);

      const request = Promise.all([
        fetch(buildFullscreenNoaaUrl(dateKey)),
        fetch(buildFullscreenNoaaUrl(dateKey, 'hilo'))
      ]).then(async ([hourlyResponse, extremesResponse]) => {
        if (!hourlyResponse.ok || !extremesResponse.ok) {
          throw new Error('NOAA tide data is unavailable');
        }
        const hourly = await hourlyResponse.json();
        const extremes = await extremesResponse.json();
        if (hourly.error || extremes.error || !hourly.predictions?.length) {
          throw new Error(hourly.error?.message || extremes.error?.message || 'No tide data available');
        }

        return {
          dateKey,
          curve: hourly.predictions.map(point => ({
            t: new Date(new Date(point.t).getTime() + FULLSCREEN_TIDE_OFFSETS.avgTimeMin * 60000).toISOString(),
            v: parseFloat(point.v) + FULLSCREEN_TIDE_OFFSETS.avgHeightFt
          })),
          extremes: (extremes.predictions || []).map(point => {
            const offset = FULLSCREEN_TIDE_OFFSETS[point.type] || FULLSCREEN_TIDE_OFFSETS.H;
            return {
              t: new Date(new Date(point.t).getTime() + offset.timeMin * 60000).toISOString(),
              v: parseFloat(point.v) + offset.heightAdd,
              type: point.type === 'H' ? 'H' : 'L'
            };
          })
        };
      }).catch(error => {
        fullscreenTideCache.delete(dateKey);
        throw error;
      });

      fullscreenTideCache.set(dateKey, request);
      return request;
    }

    function interpolateFullscreenTide(target, curve) {
      if (!curve?.length) return null;
      const targetMs = new Date(target).getTime();
      let before = null;
      let after = null;
      for (const point of curve) {
        const pointMs = new Date(point.t).getTime();
        if (pointMs === targetMs) return point.v;
        if (pointMs < targetMs) before = { t: pointMs, v: point.v };
        if (pointMs > targetMs) { after = { t: pointMs, v: point.v }; break; }
      }
      if (before && after) {
        return before.v + (after.v - before.v) * (targetMs - before.t) / (after.t - before.t);
      }
      return before?.v ?? after?.v ?? null;
    }

    function formatFullscreenTideTime(value) {
      return new Date(value).toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit'
      });
    }

    function getFullscreenTideSnapshot(data, now = new Date()) {
      const current = getTideDateKey(now) === data.dateKey
        ? now
        : new Date(`${data.dateKey}T12:00:00`);
      const value = interpolateFullscreenTide(current, data.curve);
      const later = interpolateFullscreenTide(new Date(current.getTime() + 10 * 60000), data.curve);
      const earlier = interpolateFullscreenTide(new Date(current.getTime() - 10 * 60000), data.curve);
      const rising = value != null && later != null
        ? later >= value
        : value != null && earlier != null ? value >= earlier : true;
      const currentMs = current.getTime();
      const next = data.extremes
        .filter(point => new Date(point.t).getTime() > currentMs)
        .sort((a, b) => new Date(a.t) - new Date(b.t))[0] || null;
      return { current, value, rising, next };
    }

    function renderTidePreview(preview, data, error = null) {
      if (error) {
        preview.innerHTML = '<div class="tide-preview-label">Tides</div><div class="tide-preview-error">Tide data could not be loaded right now.</div>';
        return;
      }
      if (!data) {
        preview.innerHTML = '<div class="tide-preview-label">Tides</div><div class="tide-preview-error">Loading tide data…</div>';
        return;
      }
      const snapshot = getFullscreenTideSnapshot(data);
      if (snapshot.value == null) {
        preview.innerHTML = '<div class="tide-preview-label">Tides</div><div class="tide-preview-error">No current tide value available.</div>';
        return;
      }
      const direction = snapshot.rising ? '↑ Rising' : '↓ Dropping';
      const directionClass = snapshot.rising ? '' : ' dropping';
      const nextText = snapshot.next
        ? `Next ${snapshot.next.type === 'H' ? 'high' : 'low'} · ${formatFullscreenTideTime(snapshot.next.t)} · ${snapshot.next.v.toFixed(2)} ft`
        : 'No later extreme in this forecast';
      preview.innerHTML = `
        <div class="tide-preview-label">Current tide</div>
        <div class="tide-preview-current"><span class="tide-preview-value">${snapshot.value.toFixed(2)} ft</span><span class="tide-preview-time">${formatFullscreenTideTime(snapshot.current)}</span><span class="tide-preview-direction${directionClass}">${direction}</span></div>
        <div class="tide-preview-next">${nextText}</div>`;
    }

    function createFullscreenTidePanel() {
      const root = document.createElement('div');
      root.className = 'tide-panel';
      root.hidden = true;
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-label', 'Today’s tide chart');
      root.innerHTML = `
        <button class="tide-close" type="button" aria-label="Close tide chart">×</button>
        <div class="tide-panel-header">
          <div><div class="tide-panel-kicker">Tide forecast</div><h2 class="tide-panel-title"></h2></div>
          <div class="tide-panel-location">Santa Cruz, CA<br>NOAA / Monterey + offsets</div>
        </div>
        <div class="tide-panel-status" aria-live="polite"></div>
        <div class="tide-graph-wrap">
          <svg class="tide-graph" viewBox="0 0 900 400" role="img" aria-label="Tide height by time"></svg>
          <div class="tide-chart-tooltip" hidden></div>
        </div>
        <div class="tide-extremes"></div>
        <div class="tide-panel-foot">Predictions are informational and not for navigation.</div>`;
      return {
        root,
        close: root.querySelector('.tide-close'),
        title: root.querySelector('.tide-panel-title'),
        status: root.querySelector('.tide-panel-status'),
        graphWrap: root.querySelector('.tide-graph-wrap'),
        graph: root.querySelector('.tide-graph'),
        tooltip: root.querySelector('.tide-chart-tooltip'),
        extremes: root.querySelector('.tide-extremes')
      };
    }

    function renderFullscreenTideGraph(panel, data) {
      const VIEW_WIDTH = 900;
      const VIEW_HEIGHT = 400;
      const plot = { left: 62, right: 20, top: 24, bottom: 58 };
      plot.width = VIEW_WIDTH - plot.left - plot.right;
      plot.height = VIEW_HEIGHT - plot.top - plot.bottom;
      const startMs = new Date(`${data.dateKey}T00:00:00`).getTime();
      const endMs = startMs + 24 * 60 * 60 * 1000;
      const curve = data.curve
        .map(point => ({ ms: new Date(point.t).getTime(), v: point.v }))
        .filter(point => point.ms >= startMs && point.ms <= endMs);
      if (!curve.length) throw new Error('No tide curve available');

      const values = curve.map(point => point.v).concat(data.extremes.map(point => point.v));
      const minValue = Math.min(...values);
      const maxValue = Math.max(...values);
      const padding = Math.max(.18, (maxValue - minValue) * .14);
      const yMin = minValue - padding;
      const yMax = maxValue + padding;
      const xFor = ms => plot.left + ((ms - startMs) / (endMs - startMs)) * plot.width;
      const yFor = value => plot.top + (1 - (value - yMin) / (yMax - yMin)) * plot.height;
      const axisLabel = value => `${value.toFixed(1)} ft`;
      const timeLabel = hour => new Date(startMs + hour * 3600000).toLocaleTimeString('en-US', { hour: 'numeric' });

      const yTicks = Array.from({ length: 5 }, (_, index) => yMin + (yMax - yMin) * index / 4);
      const xTicks = Array.from({ length: 9 }, (_, index) => index * 3);
      const grid = yTicks.map(value => {
        const y = yFor(value).toFixed(2);
        return `<line x1="${plot.left}" y1="${y}" x2="${VIEW_WIDTH - plot.right}" y2="${y}" class="tide-grid-line"/><text x="${plot.left - 9}" y="${Number(y) + 4}" class="tide-axis-label tide-y-label" text-anchor="end">${axisLabel(value)}</text>`;
      }).join('');
      const xAxis = xTicks.map(hour => {
        const x = xFor(startMs + hour * 3600000).toFixed(2);
        return `<line x1="${x}" y1="${plot.top + plot.height}" x2="${x}" y2="${plot.top + plot.height + 5}" class="tide-axis-tick"/><text x="${x}" y="${VIEW_HEIGHT - 25}" class="tide-axis-label" text-anchor="middle">${timeLabel(hour)}</text>`;
      }).join('');
      const curvePoints = curve.map(point => `${xFor(point.ms).toFixed(2)},${yFor(point.v).toFixed(2)}`).join(' L ');
      const areaPath = `M ${xFor(curve[0].ms).toFixed(2)} ${plot.top + plot.height} L ${curvePoints} L ${xFor(curve[curve.length - 1].ms).toFixed(2)} ${plot.top + plot.height} Z`;
      const linePath = `M ${curvePoints}`;
      const extremeMarks = data.extremes.filter(point => {
        const ms = new Date(point.t).getTime();
        return ms >= startMs && ms <= endMs;
      }).map(point => {
        const x = xFor(new Date(point.t).getTime()).toFixed(2);
        const y = yFor(point.v).toFixed(2);
        const isHigh = point.type === 'H';
        const color = isHigh ? '#ff8e8e' : '#ffd078';
        const labelY = Math.max(plot.top + 12, Math.min(plot.top + plot.height - 7, Number(y) + (isHigh ? -14 : 20)));
        return `<circle cx="${x}" cy="${y}" r="6" fill="${color}" stroke="#082126" stroke-width="2"/><text x="${x}" y="${labelY}" class="tide-extreme-label" fill="${color}" text-anchor="middle">${isHigh ? 'H' : 'L'} ${point.v.toFixed(2)}</text>`;
      }).join('');
      const snapshot = getFullscreenTideSnapshot(data);
      const currentMs = snapshot.current.getTime();
      let currentMark = '';
      if (snapshot.value != null && currentMs >= startMs && currentMs <= endMs) {
        const currentX = xFor(currentMs);
        const currentY = yFor(snapshot.value);
        const labelOnRight = currentX < VIEW_WIDTH - 155;
        const labelX = labelOnRight ? currentX + 9 : currentX - 9;
        const labelAnchor = labelOnRight ? 'start' : 'end';
        const labelY = Math.max(plot.top + 14, currentY - 11);
        currentMark = `<line x1="${currentX.toFixed(2)}" y1="${plot.top}" x2="${currentX.toFixed(2)}" y2="${plot.top + plot.height}" class="tide-current-line"/><circle cx="${currentX.toFixed(2)}" cy="${currentY.toFixed(2)}" r="6" class="tide-current-dot"/><text x="${labelX.toFixed(2)}" y="${labelY.toFixed(2)}" class="tide-current-label" text-anchor="${labelAnchor}">Now ${snapshot.value.toFixed(2)} ft</text>`;
      }

      panel.graph.innerHTML = `
        <defs><linearGradient id="tideAreaGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#43cbd3" stop-opacity=".35"/><stop offset="1" stop-color="#43cbd3" stop-opacity=".03"/></linearGradient></defs>
        <rect x="0" y="0" width="900" height="400" fill="transparent"/>
        <g>${grid}${xAxis}</g>
        <line x1="${plot.left}" y1="${plot.top}" x2="${plot.left}" y2="${plot.top + plot.height}" class="tide-axis-line"/>
        <line x1="${plot.left}" y1="${plot.top + plot.height}" x2="${VIEW_WIDTH - plot.right}" y2="${plot.top + plot.height}" class="tide-axis-line"/>
        <path d="${areaPath}" class="tide-area"/>
        <path d="${linePath}" class="tide-line"/>
        <g>${extremeMarks}</g>
        <g>${currentMark}</g>
        <line class="tide-hover-line" x1="0" y1="${plot.top}" x2="0" y2="${plot.top + plot.height}" visibility="hidden"/>
        <circle class="tide-hover-dot" cx="0" cy="0" r="6" visibility="hidden"/>`;

      const hoverLine = panel.graph.querySelector('.tide-hover-line');
      const hoverDot = panel.graph.querySelector('.tide-hover-dot');
      const updateHover = clientX => {
        const rect = panel.graph.getBoundingClientRect();
        if (!rect.width) return;
        // The SVG preserves its viewBox aspect ratio, which can leave side
        // gutters on wide screens. Account for those gutters before mapping
        // the pointer into chart coordinates.
        const scale = Math.min(rect.width / VIEW_WIDTH, rect.height / VIEW_HEIGHT);
        const renderedWidth = VIEW_WIDTH * scale;
        const renderedHeight = VIEW_HEIGHT * scale;
        const svgOffsetX = (rect.width - renderedWidth) / 2;
        const svgOffsetY = (rect.height - renderedHeight) / 2;
        const leftPx = rect.left + svgOffsetX + plot.left * scale;
        const rightPx = rect.left + svgOffsetX + (plot.left + plot.width) * scale;
        const cursorPx = Math.max(leftPx, Math.min(rightPx, clientX));
        const ratio = (cursorPx - leftPx) / (rightPx - leftPx);
        const ms = startMs + ratio * (endMs - startMs);
        const value = interpolateFullscreenTide(new Date(ms), data.curve);
        if (value == null) return;
        const x = plot.left + ratio * plot.width;
        const y = yFor(value);
        hoverLine.setAttribute('x1', x.toFixed(2));
        hoverLine.setAttribute('x2', x.toFixed(2));
        hoverLine.setAttribute('visibility', 'visible');
        hoverDot.setAttribute('cx', x.toFixed(2));
        hoverDot.setAttribute('cy', y.toFixed(2));
        hoverDot.setAttribute('visibility', 'visible');
        panel.tooltip.innerHTML = `<strong>${formatFullscreenTideTime(ms)}</strong><br>${value.toFixed(2)} ft`;
        const wrapRect = panel.graphWrap.getBoundingClientRect();
        let tooltipLeft = cursorPx - wrapRect.left + 11;
        if (tooltipLeft + panel.tooltip.offsetWidth > wrapRect.width - 5) tooltipLeft -= panel.tooltip.offsetWidth + 22;
        panel.tooltip.style.left = `${Math.max(5, tooltipLeft)}px`;
        panel.tooltip.style.top = `${Math.max(33, rect.top - wrapRect.top + svgOffsetY + y * scale - 9)}px`;
        panel.tooltip.hidden = false;
      };
      panel.graph.onpointermove = event => updateHover(event.clientX);
      panel.graph.onpointerleave = () => {
        hoverLine.setAttribute('visibility', 'hidden');
        hoverDot.setAttribute('visibility', 'hidden');
        panel.tooltip.hidden = true;
      };
    }

    function renderFullscreenTidePanel(panel, data) {
      panel.title.textContent = new Date(`${data.dateKey}T12:00:00`).toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric'
      });
      const snapshot = getFullscreenTideSnapshot(data);
      panel.status.textContent = snapshot.value == null
        ? 'Current tide value unavailable'
        : `${snapshot.rising ? '↑ Rising' : '↓ Dropping'} now · ${snapshot.value.toFixed(2)} ft`;
      panel.extremes.innerHTML = data.extremes.slice(0, 4).map(point => `
        <div class="tide-extreme ${point.type === 'H' ? 'high' : 'low'}">
          <strong>${point.type === 'H' ? 'High tide' : 'Low tide'}</strong>
          ${formatFullscreenTideTime(point.t)} · ${point.v.toFixed(2)} ft
        </div>`).join('');
      renderFullscreenTideGraph(panel, data);
    }

    function attachTideControl(container, button, options = {}) {
      const wrapper = button.parentElement;
      const preview = document.createElement('div');
      preview.className = 'tide-preview';
      preview.setAttribute('aria-live', 'polite');
      renderTidePreview(preview);
      wrapper.appendChild(preview);

      const panel = createFullscreenTidePanel();
      container.appendChild(panel.root);
      let dataPromise = null;
      let tideData = null;
      let refreshId = null;
      let disposed = false;

      const updateCurrent = () => {
        if (!tideData || disposed) return;
        renderTidePreview(preview, tideData);
        const snapshot = getFullscreenTideSnapshot(tideData);
        if (!panel.root.hidden && snapshot.value != null) {
          panel.status.textContent = `${snapshot.rising ? '↑ Rising' : '↓ Dropping'} now · ${snapshot.value.toFixed(2)} ft`;
        }
      };
      const load = () => {
        if (dataPromise) return dataPromise;
        renderTidePreview(preview);
        dataPromise = loadFullscreenTides().then(data => {
          if (disposed) return data;
          tideData = data;
          renderTidePreview(preview, data);
          if (!panel.root.hidden) renderFullscreenTidePanel(panel, data);
          refreshId = setInterval(updateCurrent, 60000);
          return data;
        }).catch(error => {
          if (!disposed) renderTidePreview(preview, null, error);
          throw error;
        });
        return dataPromise;
      };
      const closePanel = () => {
        panel.root.hidden = true;
        panel.root.setAttribute('aria-hidden', 'true');
        container.classList.remove('tide-panel-open');
      };
      const openPanel = event => {
        event?.stopPropagation();
        panel.root.hidden = false;
        panel.root.removeAttribute('aria-hidden');
        container.classList.add('tide-panel-open');
        if (options.onOpen) options.onOpen();
        if (tideData) renderFullscreenTidePanel(panel, tideData);
        else {
          panel.title.textContent = 'Today’s tides';
          panel.status.textContent = 'Loading tide data…';
          panel.extremes.innerHTML = '';
        }
        load().catch(() => {
          if (!disposed) panel.status.textContent = 'Tide data could not be loaded right now.';
        });
      };
      const preload = () => { load().catch(() => {}); };
      const handleClose = event => {
        event.stopPropagation();
        closePanel();
      };
      const handleFullscreenChange = () => {
        if (!document.fullscreenElement && !document.webkitFullscreenElement && !container.classList.contains('player-fullscreen-mobile')) {
          closePanel();
        }
      };
      const cleanup = () => {
        disposed = true;
        clearInterval(refreshId);
        button.removeEventListener('mouseenter', preload);
        button.removeEventListener('focus', preload);
        button.removeEventListener('click', openPanel);
        panel.close.removeEventListener('click', handleClose);
        panel.root.removeEventListener('click', stopPanelClick);
        document.removeEventListener('fullscreenchange', handleFullscreenChange);
        document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
        panel.root.remove();
        preview.remove();
      };
      const stopPanelClick = event => event.stopPropagation();
      button.addEventListener('mouseenter', preload);
      button.addEventListener('focus', preload);
      button.addEventListener('click', openPanel);
      panel.close.addEventListener('click', handleClose);
      panel.root.addEventListener('click', stopPanelClick);
      document.addEventListener('fullscreenchange', handleFullscreenChange);
      document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
      return cleanup;
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
      if (fullscreenSwipeWarm) {
        updateFullscreenSwipeWarm(fullscreenSwipeWarm.activeUrl);
      }
      reorderPlayers();
      updateStreamSidebar(); // Update sidebar to reflect checkbox state
    }

    function disposePlayer(player, url) {
      if (!player) return;
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

      let hlsInstance = null;
      let animationFrameId = null;
      const isMp4 = url.toLowerCase().endsWith('.mp4');
      const title = extractTitle(url);

      // --- Player object to be returned ---
      // Define it here so we can add properties like overlays, offscreenCanvas later
      const playerObject = {
          container,
          video,
          hls: hlsInstance,
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
          listeners: [],
          timers: new Set(),
          disposed: false
      };

      playerObject.addListener = (target, type, handler, options) => {
        target.addEventListener(type, handler, options);
        playerObject.listeners.push({ target, type, handler, options });
        return handler;
      };
      playerObject.trackTimeout = (callback, delay) => {
        const id = setTimeout(() => {
          playerObject.timers.delete(id);
          callback();
        }, delay);
        playerObject.timers.add(id);
        return id;
      };
      playerObject.trackInterval = (callback, delay) => {
        const id = setInterval(callback, delay);
        playerObject.timers.add(id);
        return id;
      };
      playerObject.cleanupResources = () => {
        if (playerObject.disposed) return;
        playerObject.disposed = true;
        playerObject.listeners.forEach(({ target, type, handler, options }) => {
          target.removeEventListener(type, handler, options);
        });
        playerObject.listeners.length = 0;
        playerObject.timers.forEach(id => {
          clearTimeout(id);
          clearInterval(id);
        });
        playerObject.timers.clear();
        if (playerObject.animationFrameId) cancelAnimationFrame(playerObject.animationFrameId);
        playerObject.animationFrameId = null;
      };


      if (isMp4) {
        // --- MP4 Player Setup (Desktop & Mobile) ---
        container.classList.add('mp4-player');
        video.controls = true; // Use native controls for MP4
        video.muted = false; // Allow sound for MP4
        video.autoplay = false; // Don't autoplay MP4 typically
        // Conditionally use proxy
        video.src = IS_MOBILE ? PROXY_PREFIX + encodeURIComponent(url) : url;
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
        video.addEventListener('error', e => {
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
          container.addEventListener("click", e => {
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
          container.addEventListener("click", e => {
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
        ["timeupdate","progress","loadedmetadata","durationchange","seeking","seeked","play","pause","canplay","playing","loadeddata"].forEach(ev => video.addEventListener(ev, updateMPb));
        // Polling fallback: iOS native HLS can be slow to populate video.seekable.
        // Poll every 500ms so the bar updates as soon as the range becomes available.
        const mPbPollId = playerObject.trackInterval(updateMPb, 500);
        video.addEventListener('emptied', () => clearInterval(mPbPollId), { once: true });

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
              const now = performance.now();
              const throttle = isTimeBuffered(video, st) ? SEEK_THROTTLE_BUFFERED_MS : SEEK_THROTTLE_MS;
              if (now - mLastThrottle >= throttle) { mLastThrottle = now; video.currentTime = st; }
            }
          }
        }

        function applyMSeek() {
          if (mPendingSeek >= 0) {
            video.currentTime = mPendingSeek; mPendingSeek = -1;
            if (mWasPlaying) video.addEventListener('seeked', () => video.play().catch(() => {}), { once: true });
            else video.pause();
          }
        }

        const onMMove = e => { if (!mIsSeeking) return; e.preventDefault(); const t = e.touches[0] || e.changedTouches[0]; if (t) mSeek(t.clientX); };
        const onMEnd  = () => { if (!mIsSeeking) return; mIsSeeking = false; mPb.classList.remove('seeking'); window.removeEventListener('touchmove', onMMove); window.removeEventListener('touchend', onMEnd); applyMSeek(); };

        mPb.addEventListener('touchstart', e => {
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
        container.addEventListener("click", e => {
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
        ppM.addEventListener("click", e => {
          e.stopPropagation(); // Prevent container click handler
          playerObject.togglePlayback();
        });

        // Fullscreen button action
        fsBtnMobile.addEventListener("click", e => {
          e.stopPropagation(); // Prevent container click handler
          enterPseudoFullscreen(container, video);
        });

        // Update Play/Pause button text based on video state
        const updateMobilePlayButton = () => {
          ppM.textContent = (!video.paused || (playerObject.isBuffering && playerObject.wantsToPlay)) ? "⏸" : "▶";
        };
        video.addEventListener("play", updateMobilePlayButton);
        video.addEventListener("pause", updateMobilePlayButton);
        video.addEventListener("ended", () => ppM.textContent = "▶");
        container.addEventListener('bufferingchange', updateMobilePlayButton);

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

        // Create offscreen canvas for masking operations
        playerObject.offscreenCanvas = document.createElement('canvas');
        playerObject.offscreenCanvas.width = canvas.width;
        playerObject.offscreenCanvas.height = canvas.height;
        playerObject.offscreenCtx = playerObject.offscreenCanvas.getContext('2d');

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
          const BASE_OVERLAY_URL = "https://devenf23.github.io/surfcam/privates/";
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
          overlayIcon.addEventListener('click', e => {
            e.stopPropagation();
            rightSidebar.classList.toggle('visible');
          });

          // --- Hook the checkboxes ---
          const setupCheckboxListener = (spotPrefix) => {
              // Use the data-spot attribute to find the checkbox
              const checkbox = rightSidebar.querySelector(`input[data-spot="${spotPrefix}"]`);
              if (checkbox) {
                  checkbox.addEventListener('change', e => {
                      const on = e.target.checked;
                      if (currentOverlays) {
                          // Use the spotPrefix directly to update state properties
                          currentOverlays[`${spotPrefix}_mask`] = on;
                          currentOverlays[`${spotPrefix}_minor`] = on;
                          currentOverlays[`${spotPrefix}_text`] = on;
                          if (typeof renderCanvas === 'function') renderCanvas(currentOverlays);
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
          container.addEventListener('click', e => {
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

// ... inside the desktop HLS else block ...

const mainCtx = canvas.getContext("2d"); // Context for visible canvas
        const offscreenCtx = playerObject.offscreenCtx; // Context for offscreen canvas

        function scheduleCanvasFrame() {
          if (!container.isConnected || playerObject.disposed || video.paused) {
            playerObject.animationFrameId = null;
            return;
          }
          playerObject.animationFrameId = requestAnimationFrame(() => {
            playerObject.animationFrameId = null;
            renderCanvas(currentOverlays);
          });
        }

        function redrawCanvas() {
          if (!playerObject.animationFrameId && container.isConnected) renderCanvas(currentOverlays);
        }

        // --- Canvas Rendering Loop ---
        function renderCanvas(overlayState) {
            // ... (Existing renderCanvas logic remains the same) ...
             // Check if the container is still connected to the DOM
            if (!container.isConnected) {
                if (playerObject.animationFrameId) {
                    cancelAnimationFrame(playerObject.animationFrameId);
                    playerObject.animationFrameId = null;
                }
                return; // Stop rendering if disconnected
            }

            // Use the player object's buffering flag
            const isBuffering = playerObject.isBuffering;

            // Apply pan limits using the current canvas dimensions
            clampPan(container, canvas); // Ensure canvas is passed

            let drawWidth, drawHeight, offsetX, offsetY;
            // Use the canvas's current drawing surface size
            let actualCanvasWidth = canvas.width;
            let actualCanvasHeight = canvas.height;

            if (video.videoWidth > 0 && video.videoHeight > 0) {
                // Calculate drawing dimensions based on *canvas drawing surface size*
                const canvasAspect = actualCanvasWidth / actualCanvasHeight;
                const videoAspect = video.videoWidth / video.videoHeight;
                if (canvasAspect > videoAspect) { // Canvas wider than video -> pillarbox
                    drawHeight = actualCanvasHeight;
                    drawWidth = drawHeight * videoAspect;
                    offsetX = (actualCanvasWidth - drawWidth) / 2;
                    offsetY = 0;
                } else { // Canvas taller than video (or same aspect) -> letterbox
                    drawWidth = actualCanvasWidth;
                    drawHeight = drawWidth / videoAspect;
                    offsetX = 0;
                    offsetY = (actualCanvasHeight - drawHeight) / 2;
                }
            } else {
                // The shared buffering indicator owns loading UI. Keep the
                // canvas neutral here so startup cannot show a second loader.
                mainCtx.save();
                mainCtx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform
                mainCtx.fillStyle = '#000';
                mainCtx.fillRect(0, 0, actualCanvasWidth, actualCanvasHeight); // Clear with loading background
                mainCtx.restore();
                scheduleCanvasFrame();
                return;
            }

            mainCtx.save();
            // Clear the main canvas only if not buffering (to keep last frame)
            if (!isBuffering) {
                mainCtx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform before clearing
                mainCtx.fillStyle = '#000';
                mainCtx.fillRect(0, 0, actualCanvasWidth, actualCanvasHeight);
            }

            // Apply pan/zoom transformations centered on the *actual* canvas size
            const centerX = actualCanvasWidth / 2;
            const centerY = actualCanvasHeight / 2;
            mainCtx.translate(centerX, centerY);
            mainCtx.scale(container.zoomScale, container.zoomScale);
            mainCtx.translate(container.panX, container.panY);
            mainCtx.translate(-centerX, -centerY);

            try {
                // 1. Draw the video frame *only if not buffering*
                if (!isBuffering) {
                    mainCtx.drawImage(video, offsetX, offsetY, drawWidth, drawHeight);
                }
                // Else: the previous frame remains on the canvas

                // 2. Check if any mask needs to be applied
                const activeMasks = [];
                if (overlayState) {
                    const isMaskReady = (prefix) => overlayState[`${prefix}_mask`] && overlayState[`img${prefix.charAt(0).toUpperCase() + prefix.slice(1)}Mask`]?.complete && overlayState[`img${prefix.charAt(0).toUpperCase() + prefix.slice(1)}Mask`].naturalWidth > 0;
                    if (isMaskReady('jacks')) activeMasks.push(overlayState.imgJacksMask);
                    if (isMaskReady('pp')) activeMasks.push(overlayState.imgPpMask);
                    if (isMaskReady('hook')) activeMasks.push(overlayState.imgHookMask);
                    if (isMaskReady('sharks')) activeMasks.push(overlayState.imgSharksMask);
                    if (isMaskReady('ib')) activeMasks.push(overlayState.imgIbMask);
                    if (isMaskReady('privates')) activeMasks.push(overlayState.imgPrivatesMask);
                }


                if (activeMasks.length > 0 && offscreenCtx) {
                    // --- Prepare masked video on offscreen canvas (only if not buffering) ---
                    if (!isBuffering) {
                        // Ensure offscreen canvas matches main canvas size if it changed (e.g., fullscreen)
                        if (playerObject.offscreenCanvas.width !== actualCanvasWidth || playerObject.offscreenCanvas.height !== actualCanvasHeight) {
                            playerObject.offscreenCanvas.width = actualCanvasWidth;
                            playerObject.offscreenCanvas.height = actualCanvasHeight;
                        }
                        offscreenCtx.save();
                        offscreenCtx.clearRect(0, 0, actualCanvasWidth, actualCanvasHeight);
                        offscreenCtx.globalCompositeOperation = 'source-over';
                        activeMasks.forEach((maskImg, index) => {
                            if (index > 0) offscreenCtx.globalCompositeOperation = 'lighter';
                            // Draw mask using calculated dimensions
                            offscreenCtx.drawImage(maskImg, offsetX, offsetY, drawWidth, drawHeight);
                        });
                        offscreenCtx.globalCompositeOperation = 'source-in';
                        // Draw video using calculated dimensions
                        offscreenCtx.drawImage(video, offsetX, offsetY, drawWidth, drawHeight);
                        offscreenCtx.restore();
                    }
                    // --- Draw onto main canvas ---
                    // Always draw darkening layer if mask is active
                    mainCtx.fillStyle = 'rgba(0,0,0,0.4)';
                    mainCtx.fillRect(offsetX, offsetY, drawWidth, drawHeight);
                    // Draw the clipped video from offscreen canvas over the darkening layer
                    // Use the actual canvas dimensions for the destination draw
                    mainCtx.drawImage(playerObject.offscreenCanvas, 0, 0, actualCanvasWidth, actualCanvasHeight, 0, 0, actualCanvasWidth, actualCanvasHeight);
                }

                // 3. Draw minor/text overlays on top (if enabled) - on main canvas
                if (overlayState) {
                    const drawOverlay = (prefix) => {
                        const minorFlag = overlayState[`${prefix}_minor`];
                        const textFlag = overlayState[`${prefix}_text`];
                        const minorImg = overlayState[`img${prefix.charAt(0).toUpperCase() + prefix.slice(1)}Minor`];
                        const textImg = overlayState[`img${prefix.charAt(0).toUpperCase() + prefix.slice(1)}Text`];
                        if (minorFlag && minorImg?.complete && minorImg.naturalWidth > 0) {
                            mainCtx.drawImage(minorImg, offsetX, offsetY, drawWidth, drawHeight);
                        }
                        if (textFlag && textImg?.complete && textImg.naturalWidth > 0) {
                            mainCtx.drawImage(textImg, offsetX, offsetY, drawWidth, drawHeight);
                        }
                    };
                    drawOverlay('jacks');
                    drawOverlay('pp');
                    drawOverlay('hook');
                    drawOverlay('sharks');
                    drawOverlay('ib');
                    drawOverlay('privates');
                }

            } catch (e) {
                console.error("Canvas Draw Error:", e);
                // Draw error message without transforms
                mainCtx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform
                mainCtx.fillStyle = 'red';
                mainCtx.textAlign = 'center';
                mainCtx.fillText('Render Error', actualCanvasWidth / 2, actualCanvasHeight / 2);
            }

            mainCtx.restore(); // Restore main canvas context (removes pan/zoom)

            // Continue animation loop
            scheduleCanvasFrame();
        }


        // Start rendering when video can play
        video.addEventListener("canplay", () => {
          // Check if already rendering and container is connected
          if (!playerObject.animationFrameId && container.isConnected) {
             renderCanvas(currentOverlays); // Start the loop, passing initial overlay state
          }
        });
        video.addEventListener("play", () => {
          if (!playerObject.animationFrameId) scheduleCanvasFrame();
        });
        video.addEventListener("pause", () => {
          if (playerObject.animationFrameId) cancelAnimationFrame(playerObject.animationFrameId);
          playerObject.animationFrameId = null;
          redrawCanvas();
        });

        // Stop rendering if video becomes empty or errors
        video.addEventListener('emptied', () => {
          if (playerObject.animationFrameId) cancelAnimationFrame(playerObject.animationFrameId);
          playerObject.animationFrameId = null;
        });
        video.addEventListener('error', () => {
          if (playerObject.animationFrameId) cancelAnimationFrame(playerObject.animationFrameId);
          playerObject.animationFrameId = null;
          // Optionally clear canvas or show error state
           const ctx = mainCtx; // Use main context
           ctx.save();
           // Clear transforms before drawing error message
           ctx.setTransform(1, 0, 0, 1, 0, 0);
           ctx.fillStyle = '#333';
           ctx.fillRect(0, 0, canvas.width, canvas.height);
           ctx.fillStyle = 'red';
           ctx.textAlign = 'center';
           ctx.font = '16px Arial';
           ctx.fillText('Video Error', canvas.width/2, canvas.height/2);
           ctx.restore();
        });

        /* --- Desktop interactions: Pan/Zoom/Click (No changes needed here) --- */
        // ... (Pan/Zoom/Click handlers remain the same, ensuring clampPan(container, canvas) is called) ...
        let startX, startY, isDragging = false, panPixelRatio = 1;
        // Mousedown: Initiate drag panning (if space held or fullscreen)
        canvasWrapper.addEventListener("mousedown", e => {
          const isFs = document.fullscreenElement === container || document.webkitFullscreenElement === container;
          // Only pan if spacebar is held OR if in fullscreen mode
          if (e.button === 0 && (spaceHeld || isFs)) {
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
          if ((e.buttons & 1) && (spaceHeld || isFs) && typeof startX === 'number') {
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
              redrawCanvas();
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
            setTimeout(() => isDragging = false, 0);
          }
        });

        // Wheel: Perform zooming (if space held or fullscreen)
        canvasWrapper.addEventListener("wheel", e => {
          const isFs = document.fullscreenElement === container || document.webkitFullscreenElement === container;
          // Only zoom if spacebar is held OR if in fullscreen mode
          if (spaceHeld || isFs) {
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
              redrawCanvas();
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
            clickTimeout = setTimeout(() => {
              // Toggle play/pause if click was within container
               playerObject.togglePlayback();
            }, 300); // Wait for potential double-click
          }
          lastClickTime = now; // Record click time
        };
        // Use bubbling phase for the main click handler
        container.addEventListener("click", handleDesktopClick, false);


        /* --- Desktop Controls Bar --- */
        const controlBar = document.createElement("div");
        controlBar.className = "control-bar";
        controlsContainer.appendChild(controlBar);

        // Play/Pause Button
        const playPauseBtn = document.createElement("button");
        playPauseBtn.className = "play-pause-btn";
        playPauseBtn.textContent = video.paused ? "▶" : "⏸";
        playPauseBtn.setAttribute("aria-label","Play/Pause");
        playPauseBtn.addEventListener("click", e => {
          e.stopPropagation();
          playerObject.togglePlayback();
        });
        const updateDesktopPlayButton = () => {
          playPauseBtn.textContent = (!video.paused || (playerObject.isBuffering && playerObject.wantsToPlay)) ? "⏸" : "▶";
        };
        video.addEventListener("play", updateDesktopPlayButton);
        video.addEventListener("pause", updateDesktopPlayButton);
        video.addEventListener("ended", () => playPauseBtn.textContent = "▶");
        container.addEventListener('bufferingchange', updateDesktopPlayButton);
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

          const d = video.duration;
          // Check if duration is valid number
          if (!isNaN(d) && d > 0 && isFinite(d)) {
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
            const pp = (ct / d) * 100; // Played percentage
            const bp = (bEnd / d) * 100; // Buffered percentage
            playedBar.style.width = `${Math.min(100, pp)}%`;
            thumb.style.left = `${Math.min(100, pp)}%`;
            bufferedBar.style.width = `${Math.min(100, bp)}%`;

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
          video.addEventListener(evt, updateProgressBar);
        });
        // Also update on play/pause to immediately reflect state change if needed
        video.addEventListener("play", updateProgressBar);
        video.addEventListener("pause", updateProgressBar);
        updateProgressBar(); // Initial update

        function seek(event) {
          const d = video.duration;
          if (!isNaN(d) && d > 0 && isFinite(d)) {
            const pr = progressBar.getBoundingClientRect();
            let cX = event.clientX;
            if (event.type.startsWith('touch')) {
              if (event.touches.length > 0) cX = event.touches[0].clientX;
              else if (event.changedTouches.length > 0) cX = event.changedTouches[0].clientX;
            }
            const sp = Math.max(0, Math.min(1, (cX - pr.left) / pr.width));
            const st = sp * d;

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
              const pp = Math.min(100, (st / d) * 100);
              playedBar.style.width = `${pp}%`;
              thumb.style.left = `${pp}%`;
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
        function applyPendingSeek() {
          if (pendingSeekTime >= 0) {
            video.currentTime = pendingSeekTime;
            pendingSeekTime = -1;
            if (wasPlayingBeforeScrub) {
              video.addEventListener('seeked', () => video.play().catch(() => {}), { once: true });
            } else {
              video.pause();
            }
          }
        }
        function finishSeek() {
          if (!isSeeking) return;
          isSeeking = false;
          progressBar.classList.remove('seeking');
          progressBar.style.cursor = 'pointer';
          document.body.style.userSelect = '';
          applyPendingSeek();
        }
        // Mouse down on progress bar starts seeking
        progressBar.addEventListener("mousedown", e => {
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
        progressBar.addEventListener("touchstart", e => {
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
          if (e.button === 0) finishSeek();
        });
        playerObject.addListener(window, "blur", finishSeek);
        // Touch end — apply the single deferred seek
        playerObject.addListener(document, "touchend", e => {
          if (isSeeking) {
            isSeeking = false;
            progressBar.classList.remove('seeking');
            document.body.style.webkitUserSelect = '';
            applyPendingSeek();
          }
        });

        // Fullscreen Button (Desktop Native)
        const fsBtnDesktop = document.createElement("button");
        fsBtnDesktop.innerHTML = "&#x26F6;"; // Fullscreen symbol
        fsBtnDesktop.setAttribute("aria-label","Enter/Exit Fullscreen");
        fsBtnDesktop.addEventListener("click", e => {
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
        resetBtn.addEventListener("click", e => {
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
        disableBtn.addEventListener("click", e => {
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
            hideControlsTimeout = setTimeout(() => {
              controlsContainer.style.opacity = '0';
              controlsContainer.style.pointerEvents = 'none';
            }, 3000); // Hide after 3 seconds of inactivity
          }
        }
        // Show controls on mouse move/enter in fullscreen
        container.addEventListener('mousemove', showControlsTemporarily);
        container.addEventListener('mouseenter', showControlsTemporarily);
        // Keep controls visible when paused or waiting
        video.addEventListener('pause', showControlsTemporarily);
        video.addEventListener('waiting', showControlsTemporarily);
        // Start hide timer when playing (and not buffering)
        video.addEventListener('play', showControlsTemporarily);

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

      /* --- HLS.js Setup (Common for Mobile/Desktop HLS) --- */
      if (!isMp4) {
        setupStreamBuffering(playerObject);
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
          // Native HLS often requires explicit play action
          if (video.autoplay) {
             playerObject.requestPlay({ allowWhileBuffering: true });
          }
          // Add basic error listener for native playback
          video.addEventListener('error', e => {
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

      // Return the fully constructed player object
      return playerObject;
    }

    /* --- Mobile Pseudo-Fullscreen Logic --- */
    let pseudoFsCleanup = null; // Store cleanup function for current fullscreen instance
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
      // Run cleanup for controls/gestures belonging to this fullscreen player.
      if (pseudoFsCleanup) { pseudoFsCleanup(); pseudoFsCleanup = null; }
      clearFullscreenPlayerPriority(players[container.dataset.url]);
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

      const player = players[container.dataset.url];
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
      pseudoFsCleanup = () => {
        if (controlsCleanup) controlsCleanup();
        if (gestureCleanup) gestureCleanup();
        // Remove control API from player object
        if (players[container.dataset.url]) delete players[container.dataset.url].controlsApi;
      };

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
        fsProgressBar.style.cursor = 'pointer';
        applyFsPendingSeek();
      };
      addListener(fsProgressBar, "mousedown", e => {
        if (e.button === 0) {
          e.preventDefault();
          isFsSeeking = true;
          fsWasPlayingBeforeScrub = !video.paused;
          fsSeek(e);
          fsProgressBar.style.cursor = 'grabbing';
        }
      });
      addListener(fsProgressBar, "touchstart", e => {
        e.preventDefault(); // Must prevent default before browser commits to scroll
        isFsSeeking = true;
        fsWasPlayingBeforeScrub = !video.paused;
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
  
