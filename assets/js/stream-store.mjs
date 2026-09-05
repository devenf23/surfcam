export const PLAYER_SETTINGS_KEY = "liveDvrPlayerSettings_v1";
export const STREAM_CONFIGS_KEY = "liveDvrStreamConfigs_v1";
export const PLAYER_SETTINGS_DEBOUNCE_MS = 150;

const DEFAULT_PLAYER_SETTINGS = Object.freeze({ zoomScale: 1, panX: 0, panY: 0 });

function copy(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function playerSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_PLAYER_SETTINGS };
  return {
    zoomScale: Number.isFinite(value.zoomScale) ? Math.max(1, Math.min(5, value.zoomScale)) : 1,
    panX: Number.isFinite(value.panX) ? value.panX : 0,
    panY: Number.isFinite(value.panY) ? value.panY : 0
  };
}

function validStreamList(value) {
  return Array.isArray(value) && value.every(item =>
    item && typeof item === "object" && !Array.isArray(item) && "url" in item && "enabled" in item
  );
}

export function createStreamStore(options = {}) {
  const storage = options.storage === undefined
    ? (() => { try { return globalThis.localStorage; } catch { return null; } })()
    : options.storage;
  const timerSource = options.timers || {};
  const schedule = options.setTimeout || timerSource.setTimeout || globalThis.setTimeout;
  const cancel = options.clearTimeout || timerSource.clearTimeout || globalThis.clearTimeout;
  const debounceMs = options.debounceMs ?? PLAYER_SETTINGS_DEBOUNCE_MS;
  const pending = new Map();
  const timers = new Map();
  const settings = new Map();
  let streams = [];

  const read = key => {
    if (!storage || typeof storage.getItem !== "function") return null;
    try { return storage.getItem(key); } catch { return null; }
  };
  const write = (key, value) => {
    if (!storage || typeof storage.setItem !== "function") return false;
    try { storage.setItem(key, value); return true; } catch { return false; }
  };
  const remove = key => {
    if (!storage || typeof storage.removeItem !== "function") return;
    try { storage.removeItem(key); } catch { /* unavailable storage is harmless */ }
  };

  function refreshFromStorage() {
    const queued = new Map(pending);
    settings.clear();
    try {
      const parsed = JSON.parse(read(PLAYER_SETTINGS_KEY) || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [url, value] of Object.entries(parsed)) settings.set(url, playerSettings(value));
      }
    } catch { /* retain an empty in-memory cache for corrupt storage */ }
    // A local debounced write is newer than the storage snapshot. Keep it in
    // the in-memory view and let its normal flush merge it into storage.
    for (const [url, value] of queued) settings.set(url, playerSettings(value));
    try {
      const parsed = JSON.parse(read(STREAM_CONFIGS_KEY) || "null");
      if (parsed == null) streams = [];
      else if (validStreamList(parsed)) streams = copy(parsed);
      else { streams = []; remove(STREAM_CONFIGS_KEY); }
    } catch {
      streams = [];
      remove(STREAM_CONFIGS_KEY);
    }
    return { playerSettings: settings.size, streamCount: streams.length };
  }

  refreshFromStorage();

  function loadPlayerSettings(url) {
    const queued = pending.get(url);
    if (queued) return copy(playerSettings(queued));
    return copy(settings.get(url) || DEFAULT_PLAYER_SETTINGS);
  }

  function flushPlayerSettings(url) {
    const value = pending.get(url);
    if (!value) return;
    const timer = timers.get(url);
    if (timer !== undefined) {
      try { cancel(timer); } catch { /* injected timer may be unavailable */ }
      timers.delete(url);
    }
    if (write(PLAYER_SETTINGS_KEY, JSON.stringify(Object.fromEntries(settings)))) pending.delete(url);
  }

  function savePlayerSettings(url, data, { immediate = false } = {}) {
    const value = playerSettings(data);
    settings.set(url, value);
    pending.set(url, value);
    const prior = timers.get(url);
    if (prior !== undefined) {
      try { cancel(prior); } catch { /* unavailable timer is harmless */ }
      timers.delete(url);
    }
    if (immediate) return flushPlayerSettings(url);
    if (typeof schedule === "function") {
      const timer = schedule(() => flushPlayerSettings(url), debounceMs);
      timers.set(url, timer);
    }
  }

  function getStreamList() {
    return copy(streams);
  }

  function saveStreamList(list) {
    if (!validStreamList(list)) return false;
    streams = copy(list);
    return write(STREAM_CONFIGS_KEY, JSON.stringify(streams));
  }

  function flushAll() {
    for (const url of [...pending.keys()]) flushPlayerSettings(url);
  }

  return { loadPlayerSettings, flushPlayerSettings, savePlayerSettings, getStreamList, saveStreamList, flushAll, refreshFromStorage };
}

export default createStreamStore;
