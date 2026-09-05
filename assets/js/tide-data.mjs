const NOAA_ENDPOINT = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';

export const TIDE_STATION = '9413450';
export const TIDE_OFFSETS = Object.freeze({
  H: Object.freeze({ timeMin: -6, heightAdd: 0.97 }),
  L: Object.freeze({ timeMin: -11, heightAdd: 0.99 }),
  avgTimeMin: -8.5,
  avgHeightFt: 0.98
});

export function dateKey(value = new Date()) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} /.test(value)) value = value.replace(' ', 'T');
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('Invalid tide date');
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

export function buildNoaaUrl(value, interval = '') {
  const key = dateKey(value).replaceAll('-', '');
  const params = new URLSearchParams({ begin_date: key, end_date: key, station: TIDE_STATION,
    product: 'predictions', datum: 'MLLW', units: 'english', time_zone: 'lst_ldt', format: 'json', application: 'GeminiTideChart' });
  if (interval) params.set('interval', interval);
  return `${NOAA_ENDPOINT}?${params}`;
}

export function buildStormGlassUrl(value, endpoint) {
  return `${endpoint}${encodeURIComponent(dateKey(value))}`;
}

export function normalizeNoaaPredictions(predictions, { offsets = TIDE_OFFSETS, extremes = false } = {}) {
  return (predictions || []).flatMap(point => {
    const value = Number.parseFloat(point.v);
    if (!point.t || !Number.isFinite(value)) return [];
    const offset = extremes ? offsets[point.type] : { timeMin: offsets.avgTimeMin, heightAdd: offsets.avgHeightFt };
    if (!offset) return [];
    return [{ t: new Date(new Date(point.t).getTime() + offset.timeMin * 60000).toISOString(),
      v: value + offset.heightAdd, ...(point.type ? { type: point.type } : {}) }];
  });
}

export function normalizeStormGlass(data) {
  const factor = 3.28084;
  return {
    curve: (data?.hours || []).flatMap(point => Number.isFinite(Number(point.sg)) && point.time ? [{ t: point.time, v: Number(point.sg) * factor }] : []),
    hiLo: (data?.extremes || []).flatMap(point => Number.isFinite(Number(point.height)) && point.time ? [{ t: point.time, v: Number(point.height) * factor, type: point.type === 'high' ? 'H' : 'L' }] : [])
  };
}

export function interpolateTide(target, predictions) {
  if (!predictions?.length) return null;
  const targetMs = new Date(target).getTime();
  if (!Number.isFinite(targetMs)) return null;
  let before = null;
  for (const point of predictions) {
    const time = new Date(point.t).getTime(), value = Number(point.v);
    if (!Number.isFinite(time) || !Number.isFinite(value)) continue;
    if (time === targetMs) return value;
    if (time < targetMs) before = { time, value };
    else if (before) return before.value + (value - before.value) * (targetMs - before.time) / (time - before.time);
    else return value;
  }
  return before?.value ?? null;
}

const noaaCache = new Map();
export function clearNoaaCache() { noaaCache.clear(); }

function abortError() {
  const error = new Error('The tide request was aborted');
  error.name = 'AbortError';
  return error;
}

export function fetchNoaaTides(value, { fetchImpl = globalThis.fetch, signal } = {}) {
  const key = dateKey(value);
  if (typeof fetchImpl !== 'function') return Promise.reject(new TypeError('fetch is unavailable'));
  if (signal?.aborted) return Promise.reject(abortError());

  let entry = noaaCache.get(key);
  if (!entry) {
    const controller = new AbortController();
    const request = Promise.all([
      fetchImpl(buildNoaaUrl(key), { signal: controller.signal }),
      fetchImpl(buildNoaaUrl(key, 'hilo'), { signal: controller.signal })
    ]).then(async ([hourlyResponse, extremesResponse]) => {
      if (!hourlyResponse.ok || !extremesResponse.ok) throw new Error(`NOAA HTTP ${hourlyResponse.status}/${extremesResponse.status}`);
      const [hourly, extremes] = await Promise.all([hourlyResponse.json(), extremesResponse.json()]);
      if (hourly.error || extremes.error || !hourly.predictions?.length) throw new Error(hourly.error?.message || extremes.error?.message || 'No predictions');
      return { dateKey: key, curve: normalizeNoaaPredictions(hourly.predictions), hiLo: normalizeNoaaPredictions(extremes.predictions, { extremes: true }) };
    });
    entry = { request, controller, subscribers: new Set(), settled: false };
    noaaCache.set(key, entry);
    request.then(() => { entry.settled = true; }, () => {
      entry.settled = true;
      if (noaaCache.get(key) === entry) noaaCache.delete(key);
    });
  }
  if (entry.settled) return entry.request;

  return new Promise((resolve, reject) => {
    const subscriber = { resolve, reject };
    entry.subscribers.add(subscriber);
    let done = false;
    const finish = (callback, value) => {
      if (done) return;
      done = true;
      entry.subscribers.delete(subscriber);
      if (signal) signal.removeEventListener('abort', onAbort);
      callback(value);
      if (!entry.settled && entry.subscribers.size === 0) {
        // Evict before aborting so a synchronous follow-up starts a fresh request.
        if (noaaCache.get(key) === entry) noaaCache.delete(key);
        entry.controller.abort();
      }
    };
    const onAbort = () => finish(reject, abortError());
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    entry.request.then(value => finish(resolve, value), error => finish(reject, error));
  });
}
