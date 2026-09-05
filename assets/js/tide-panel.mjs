import { dateKey as getTideDateKey, fetchNoaaTides, interpolateTide as interpolateFullscreenTide } from './tide-data.mjs';
import { createResourceScope } from './resource-scope.mjs';
async function loadFullscreenTides(date = new Date(), signal) {
  const data = await fetchNoaaTides(date, { signal });
  return { ...data, extremes: data.hiLo };
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
      const clearHover = () => {
        hoverLine.setAttribute('visibility', 'hidden');
        hoverDot.setAttribute('visibility', 'hidden');
        panel.tooltip.hidden = true;
      };
      const handleGraphPointer = event => {
        event.preventDefault();
        event.stopPropagation();
        updateHover(event.clientX);
      };
      const releaseGraphPointer = event => {
        event.stopPropagation();
        try { panel.graph.releasePointerCapture(event.pointerId); } catch {}
      };
      const handleGraphTouch = event => {
        const touch = event.touches[0] || event.changedTouches[0];
        if (!touch) return;
        event.preventDefault();
        event.stopPropagation();
        updateHover(touch.clientX);
      };
      panel.graph.onpointerdown = event => {
        handleGraphPointer(event);
        try { panel.graph.setPointerCapture(event.pointerId); } catch {}
      };
      panel.graph.onpointermove = handleGraphPointer;
      panel.graph.onpointerup = releaseGraphPointer;
      panel.graph.onpointercancel = releaseGraphPointer;
      panel.graph.onpointerleave = clearHover;
      panel.graph.ontouchstart = handleGraphTouch;
      panel.graph.ontouchmove = handleGraphTouch;
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

    export function attachTideControl(container, button, options = {}) {
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
      let disposed = false;
      const scope = createResourceScope();

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
        dataPromise = loadFullscreenTides(new Date(), scope.signal).then(data => {
          if (disposed) return data;
          tideData = data;
          renderTidePreview(preview, data);
          if (!panel.root.hidden) renderFullscreenTidePanel(panel, data);
          scope.interval(updateCurrent, 60000);
          return data;
        }).catch(error => {
          dataPromise = null;
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
      const panelInteractionEvents = [
        'touchstart', 'touchmove', 'touchend', 'touchcancel',
        'pointerdown', 'pointermove', 'pointerup', 'pointercancel',
        'mousedown', 'mousemove', 'mouseup'
      ];
      const cleanup = () => {
        disposed = true;
        scope.dispose();
        panel.root.remove();
        preview.remove();
      };
      const stopPanelClick = event => event.stopPropagation();
      const stopPanelInteraction = event => event.stopPropagation();
      scope.listen(button, 'mouseenter', preload);
      scope.listen(button, 'focus', preload);
      scope.listen(button, 'click', openPanel);
      scope.listen(panel.close, 'click', handleClose);
      scope.listen(panel.root, 'click', stopPanelClick);
      panelInteractionEvents.forEach(type => {
        scope.listen(panel.root, type, stopPanelInteraction);
      });
      scope.listen(document, 'fullscreenchange', handleFullscreenChange);
      scope.listen(document, 'webkitfullscreenchange', handleFullscreenChange);
      return cleanup;
    }
