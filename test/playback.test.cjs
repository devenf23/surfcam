const test = require("node:test");
const assert = require("node:assert/strict");

const controllerPromise = import("../assets/js/playback-controller.mjs");
const adapterPromise = import("../assets/js/playback-adapter.mjs");

class FakeTarget extends EventTarget {
  constructor() {
    super();
    this.classList = new FakeClassList();
    this.attributes = new Map();
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  querySelector() { return null; }
}

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  toggle(value, force) {
    const next = force === undefined ? !this.values.has(value) : force;
    if (next) this.values.add(value); else this.values.delete(value);
    return next;
  }
  contains(value) { return this.values.has(value); }
}

class FakeVideo extends FakeTarget {
  constructor() {
    super();
    this.paused = false;
    this.readyState = 3;
    this.currentTime = 0;
    this.duration = 120;
    this.buffered = new TimeRangesMock([[0, 8]]);
    this.seekable = new TimeRangesMock([[0, 120]]);
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.playResult = Promise.resolve();
    this.autoplay = false;
    this.error = null;
  }
  play() {
    this.playCalls += 1;
    this.paused = false;
    return this.playResult;
  }
  pause() {
    this.pauseCalls += 1;
    this.paused = true;
  }
  canPlayType() { return ''; }
}

class TimeRangesMock {
  constructor(ranges) { this.ranges = ranges; }
  get length() { return this.ranges.length; }
  start(index) { return this.ranges[index][0]; }
  end(index) { return this.ranges[index][1]; }
}

function makePlayer() {
  const video = new FakeVideo();
  const container = new FakeTarget();
  const bufferingIndicator = new FakeTarget();
  bufferingIndicator.hidden = true;
  const intervals = [];
  const player = {
    video, container, bufferingIndicator,
    wantsToPlay: true, isBuffering: false, stallPause: false,
    addListener(target, event, handler) { target.addEventListener(event, handler); },
    trackInterval(handler) { intervals.push(handler); },
    intervals,
    updateTimeline() {}
  };
  return player;
}

function installDomGlobals() {
  const previous = {
    CustomEvent: globalThis.CustomEvent,
    HTMLMediaElement: globalThis.HTMLMediaElement,
    document: globalThis.document,
    navigator: globalThis.navigator
  };
  globalThis.CustomEvent = class extends Event {
    constructor(type, init = {}) { super(type); this.detail = init.detail; }
  };
  globalThis.HTMLMediaElement = { HAVE_CURRENT_DATA: 2, HAVE_FUTURE_DATA: 3 };
  globalThis.document = { documentElement: new FakeTarget(), createElement: () => new FakeTarget() };
  globalThis.navigator = { userAgent: 'Chrome' };
  return () => Object.entries(previous).forEach(([key, value]) => {
    if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  });
}

test("internal buffering pause preserves playback intent and resumes after enough buffer", async () => {
  const restore = installDomGlobals();
  try {
    const { setupStreamBuffering } = await controllerPromise;
    const player = makePlayer();
    setupStreamBuffering(player, { isMobile: false });

    player.video.dispatchEvent(new Event('waiting'));
    assert.equal(player.video.pauseCalls, 1);
    assert.equal(player.wantsToPlay, true);
    assert.equal(player.stallPause, true);
    player.video.dispatchEvent(new Event('pause'));
    assert.equal(player.wantsToPlay, true);

    player.video.buffered = new TimeRangesMock([[0, 2]]);
    player.video.dispatchEvent(new Event('progress'));
    await Promise.resolve();
    assert.equal(player.video.playCalls, 1);
  } finally { restore(); }
});

test("a user pause during buffering cancels automatic resume", async () => {
  const restore = installDomGlobals();
  try {
    const { setupStreamBuffering } = await controllerPromise;
    const player = makePlayer();
    setupStreamBuffering(player, { isMobile: false });

    player.video.dispatchEvent(new Event('waiting'));
    player.video.dispatchEvent(new Event('pause')); // consume the internal pause event
    player.video.dispatchEvent(new Event('pause')); // actual user pause
    player.video.buffered = new TimeRangesMock([[0, 8]]);
    player.video.dispatchEvent(new Event('progress'));
    await Promise.resolve();

    assert.equal(player.wantsToPlay, false);
    assert.equal(player.isBuffering, false);
    assert.equal(player.video.playCalls, 0);
  } finally { restore(); }
});

test("stalled recovery waits for new content as well as the playback threshold", async () => {
  const restore = installDomGlobals();
  try {
    const { setupStreamBuffering } = await controllerPromise;
    const player = makePlayer();
    player.video.buffered = new TimeRangesMock([[0, 5]]);
    setupStreamBuffering(player, { isMobile: false });

    player.video.dispatchEvent(new Event('stalled'));
    player.video.dispatchEvent(new Event('pause'));
    player.video.dispatchEvent(new Event('progress'));
    await Promise.resolve();
    assert.equal(player.video.playCalls, 0);

    player.video.buffered = new TimeRangesMock([[0, 6.6]]);
    player.video.dispatchEvent(new Event('progress'));
    await Promise.resolve();
    assert.equal(player.video.playCalls, 1);
  } finally { restore(); }
});

test("buffer recovery works with an infinite duration and seekable window", async () => {
  const restore = installDomGlobals();
  try {
    const { setupStreamBuffering } = await controllerPromise;
    const player = makePlayer();
    player.video.duration = Infinity;
    player.video.seekable = new TimeRangesMock([[100, 200]]);
    player.video.currentTime = 100;
    player.video.buffered = new TimeRangesMock([[100, 101]]);
    setupStreamBuffering(player, { isMobile: false });
    player.video.dispatchEvent(new Event('waiting'));
    player.video.dispatchEvent(new Event('pause'));
    player.video.buffered = new TimeRangesMock([[100, 103]]);
    player.video.dispatchEvent(new Event('canplay'));
    await Promise.resolve();
    assert.equal(player.video.playCalls, 1);
  } finally { restore(); }
});

function makeHlsHarness() {
  const events = new Map();
  const calls = { loadSource: [], attachMedia: [], starts: 0, recoveries: 0, destroys: 0 };
  class Hls {
    static isSupported() { return true; }
    static Events = { MANIFEST_PARSED: 'manifest', FRAG_CHANGED: 'fragchanged', FRAG_BUFFERED: 'fragbuffered', LEVEL_UPDATED: 'level', ERROR: 'error' };
    static ErrorTypes = { NETWORK_ERROR: 'network', MEDIA_ERROR: 'media', OTHER_ERROR: 'other' };
    static ErrorDetails = { BUFFER_STALLED_ERROR: 'stalled', BUFFER_SEEK_OVER_HOLE: 'hole', BUFFER_FULL_ERROR: 'full' };
    static DefaultConfig = { loader: class { load(context, config, callbacks) { calls.loadedContext = context; callbacks?.onSuccess?.(); } } };
    constructor(config) { this.config = config; this.loaders = config; }
    loadSource(url) { calls.loadSource.push(url); }
    attachMedia(video) { calls.attachMedia.push(video); }
    on(event, handler) { events.set(event, handler); }
    startLoad() { calls.starts += 1; }
    recoverMediaError() { calls.recoveries += 1; }
    destroy() { calls.destroys += 1; }
  }
  return { Hls, events, calls };
}

function makeAdapterPlayer() {
  const player = makePlayer();
  player.video.paused = true;
  player.trackTimeout = (fn) => { player.timeout = fn; };
  player.swipeLoadError = () => { player.swipeErrors = (player.swipeErrors || 0) + 1; };
  return player;
}

test("HLS adapter proxies mobile requests and unwraps desktop requests", async () => {
  const restore = installDomGlobals();
  try {
    const { attachHlsPlayback } = await adapterPromise;
    for (const isMobile of [true, false]) {
      const { Hls, calls } = makeHlsHarness();
      const player = makeAdapterPlayer();
      attachHlsPlayback(player, { url: 'https://origin.test/live.m3u8', isMobile, Hls,
        captureCurrentPreviewFrame() {}, applyHlsFragmentTimestamp() {}, startManifestTimestampSync() {} });
      const Loader = player.hls.config.loader;
      const loader = new Loader();
      const context = { url: 'https://surfcam-alpha.vercel.app/api/proxy?url=https%3A%2F%2Forigin.test%2Fseg.ts' };
      loader.load(context, {}, {});
      const expected = isMobile
        ? 'https://surfcam-alpha.vercel.app/api/proxy?url=https%3A%2F%2Forigin.test%2Fseg.ts'
        : 'https://origin.test/seg.ts';
      assert.equal(calls.loadedContext.url, expected);
    }
  } finally { restore(); }
});

test("fatal HLS errors request recovery and destroy unrecoverable streams", async () => {
  const restore = installDomGlobals();
  try {
    const { attachHlsPlayback } = await adapterPromise;
    const { Hls, events, calls } = makeHlsHarness();
    const player = makeAdapterPlayer();
    player.wantsToPlay = true;
    attachHlsPlayback(player, { url: 'https://origin.test/live.m3u8', isMobile: false, Hls,
      captureCurrentPreviewFrame() {}, applyHlsFragmentTimestamp() {}, startManifestTimestampSync() {} });
    events.get(Hls.Events.ERROR)('error', { fatal: true, type: Hls.ErrorTypes.NETWORK_ERROR, details: 'timeout' });
    assert.equal(player.isBuffering, true);
    assert.equal(player.timeout !== undefined, true);
    player.timeout();
    assert.equal(calls.starts, 1);

    events.get(Hls.Events.ERROR)('error', { fatal: true, type: Hls.ErrorTypes.MEDIA_ERROR, details: 'decode' });
    assert.equal(calls.recoveries, 1);
    events.get(Hls.Events.ERROR)('error', { fatal: true, type: Hls.ErrorTypes.OTHER_ERROR, details: 'fatal' });
    assert.equal(calls.destroys, 1);
    assert.equal(player.swipeErrors, 1);
    assert.equal(player.hls, null);
  } finally { restore(); }
});
