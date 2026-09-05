const test = require("node:test");
const assert = require("node:assert/strict");

async function modules() {
  return {
    store: await import("../assets/js/stream-store.mjs"),
    config: await import("../assets/js/config.mjs")
  };
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    raw: key => values.get(key)
  };
}

test("store preserves legacy keys and debounced player settings", async () => {
  const { store: api } = await modules();
  const storage = memoryStorage();
  const timers = [];
  const store = api.createStreamStore({ storage, setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length), clearTimeout: () => {} });
  store.savePlayerSettings("cam", { zoomScale: 2, panX: 3, panY: -4 });
  assert.equal(storage.raw(api.PLAYER_SETTINGS_KEY), undefined);
  assert.deepEqual(store.loadPlayerSettings("cam"), { zoomScale: 2, panX: 3, panY: -4 });
  assert.equal(timers[0].ms, 150);
  timers[0].fn();
  assert.deepEqual(JSON.parse(storage.raw(api.PLAYER_SETTINGS_KEY)).cam, { zoomScale: 2, panX: 3, panY: -4 });
});

test("stream lists persist and callers receive copies", async () => {
  const { store: api } = await modules();
  const storage = memoryStorage();
  const store = api.createStreamStore({ storage });
  const list = [{ url: "https://example.test/live.m3u8", enabled: true }];
  assert.equal(store.saveStreamList(list), true);
  const loaded = store.getStreamList();
  loaded[0].enabled = false;
  assert.equal(store.getStreamList()[0].enabled, true);
});

test("corrupt and unavailable storage fail safely", async () => {
  const { store: api } = await modules();
  const storage = memoryStorage({ [api.STREAM_CONFIGS_KEY]: "not json", [api.PLAYER_SETTINGS_KEY]: "[]" });
  const store = api.createStreamStore({ storage });
  assert.deepEqual(store.getStreamList(), []);
  assert.deepEqual(store.loadPlayerSettings("cam"), { zoomScale: 1, panX: 0, panY: 0 });
  const unavailable = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  const safe = api.createStreamStore({ storage: unavailable, setTimeout: fn => (fn(), 1), clearTimeout() {} });
  assert.doesNotThrow(() => safe.savePlayerSettings("cam", { zoomScale: 2 }));
  assert.doesNotThrow(() => safe.flushAll());
});

test("writes remain available in memory when storage fails", async () => {
  const { store: api } = await modules();
  let blocked = false;
  const storage = memoryStorage();
  const originalSet = storage.setItem;
  storage.setItem = (key, value) => { if (blocked) throw new Error("blocked"); originalSet(key, value); };
  const timers = [];
  const store = api.createStreamStore({ storage, setTimeout: fn => (timers.push(fn), timers.length), clearTimeout() {} });
  blocked = true;
  const list = [{ url: "https://example.test/cam.m3u8", enabled: true }];
  assert.equal(store.saveStreamList(list), false);
  store.savePlayerSettings("cam", { zoomScale: 4, panX: 2, panY: 1 });
  assert.deepEqual(store.getStreamList(), list);
  assert.deepEqual(store.loadPlayerSettings("cam"), { zoomScale: 4, panX: 2, panY: 1 });
  storage.setItem = originalSet;
  timers.forEach(fn => fn());
  store.flushAll();
  assert.deepEqual(JSON.parse(storage.raw(api.PLAYER_SETTINGS_KEY)).cam, { zoomScale: 4, panX: 2, panY: 1 });
  assert.equal(storage.raw(api.STREAM_CONFIGS_KEY), undefined);
});

test("refreshFromStorage explicitly picks up external changes", async () => {
  const { store: api } = await modules();
  const storage = memoryStorage();
  const store = api.createStreamStore({ storage });
  storage.setItem(api.STREAM_CONFIGS_KEY, JSON.stringify([{ url: "https://example.test/external.m3u8", enabled: false }]));
  assert.deepEqual(store.getStreamList(), []);
  store.refreshFromStorage();
  assert.equal(store.getStreamList()[0].enabled, false);
});

test("refresh preserves pending local settings while importing external settings", async () => {
  const { store: api } = await modules();
  const storage = memoryStorage({
    [api.PLAYER_SETTINGS_KEY]: JSON.stringify({ external: { zoomScale: 2, panX: 1, panY: 0 } })
  });
  const timers = [];
  const store = api.createStreamStore({
    storage,
    setTimeout: fn => (timers.push(fn), timers.length),
    clearTimeout() {}
  });
  store.savePlayerSettings("local", { zoomScale: 4, panX: 3, panY: -2 });
  storage.setItem(api.PLAYER_SETTINGS_KEY, JSON.stringify({ external: { zoomScale: 3, panX: 9, panY: 8 } }));
  store.refreshFromStorage();
  assert.deepEqual(store.loadPlayerSettings("local"), { zoomScale: 4, panX: 3, panY: -2 });
  assert.deepEqual(store.loadPlayerSettings("external"), { zoomScale: 3, panX: 9, panY: 8 });
  timers[0]();
  const saved = JSON.parse(storage.raw(api.PLAYER_SETTINGS_KEY));
  assert.deepEqual(saved.local, { zoomScale: 4, panX: 3, panY: -2 });
  assert.deepEqual(saved.external, { zoomScale: 3, panX: 9, panY: 8 });
});
