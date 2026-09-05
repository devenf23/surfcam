const PREVIEW_CACHE_BUCKET_SECONDS = 0.5;

export function resolvePlaylistUrl(value, base) {
  try {
    return new URL(value, base).toString();
  } catch {
    return value;
  }
}

export function parseHlsDateTime(value) {
  if (value == null) return null;
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

export function parseHlsProgramDateTimes(text, baseUrl = '') {
  const lines = String(text || '').split(/\r?\n/);
  const variants = [];
  const segments = [];
  let nextDuration = null;
  let nextProgramDateTimeMs = null;
  let mediaSequence = 0;
  let sequence = 0;
  let discontinuity = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      const parsed = Number(line.slice(line.indexOf(':') + 1));
      if (Number.isFinite(parsed)) {
        mediaSequence = parsed;
        sequence = parsed;
      }
    } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      nextProgramDateTimeMs = parseHlsDateTime(line.slice(line.indexOf(':') + 1));
    } else if (line.startsWith('#EXTINF:')) {
      const durationText = line.slice(line.indexOf(':') + 1).split(',')[0];
      const parsed = Number(durationText);
      nextDuration = Number.isFinite(parsed) ? parsed : null;
    } else if (line.startsWith('#EXT-X-DISCONTINUITY')) {
      discontinuity += 1;
      nextProgramDateTimeMs = null;
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const nextLine = lines[index + 1]?.trim();
      if (nextLine && !nextLine.startsWith('#')) {
        variants.push(resolvePlaylistUrl(nextLine, baseUrl));
        index += 1;
      }
    } else if (!line.startsWith('#')) {
      if (nextDuration != null && nextProgramDateTimeMs != null) {
        segments.push({
          uri: resolvePlaylistUrl(line, baseUrl),
          duration: nextDuration,
          mediaSequence: sequence,
          discontinuity,
          startWallTimeMs: nextProgramDateTimeMs,
          endWallTimeMs: nextProgramDateTimeMs + nextDuration * 1000
        });
        nextProgramDateTimeMs += nextDuration * 1000;
      } else if (nextDuration != null && nextProgramDateTimeMs == null) {
        sequence += 1;
        nextDuration = null;
        continue;
      }
      sequence += 1;
      nextDuration = null;
    }
  }

  return { mediaSequence, variants, segments };
}

export function formatTimestampTime(ms) {
  const date = new Date(ms);
  const pad = value => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatLagBehind(seconds) {
  const totalSeconds = Math.max(0, Math.round(seconds));
  const pad = value => String(value).padStart(2, '0');
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return `-${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
}

export function getPreviewCacheKey(mediaTime) {
  const bucketed = Math.round(mediaTime / PREVIEW_CACHE_BUCKET_SECONDS) * PREVIEW_CACHE_BUCKET_SECONDS;
  return bucketed.toFixed(1);
}
