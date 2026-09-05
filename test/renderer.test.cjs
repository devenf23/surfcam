const test = require("node:test");
const assert = require("node:assert/strict");

const rendererPromise = import("../assets/js/canvas-renderer.mjs");

class FakeTarget extends EventTarget {}

class FakeContext {
  constructor() { this.calls = []; }
  save() { this.calls.push("save"); }
  restore() { this.calls.push("restore"); }
  setTransform(...args) { this.calls.push(["setTransform", ...args]); }
  fillRect(...args) { this.calls.push(["fillRect", ...args]); }
  drawImage(...args) { this.calls.push(["drawImage", ...args]); }
  clearRect(...args) { this.calls.push(["clearRect", ...args]); }
  translate(...args) { this.calls.push(["translate", ...args]); }
  scale(...args) { this.calls.push(["scale", ...args]); }
}

class FakeCanvas extends FakeTarget {
  constructor(context = new FakeContext()) {
    super();
    this.width = 960;
    this.height = 540;
    this.context = context;
  }
  getContext() { return this.context; }
}

function makePlayer() {
  const video = new FakeTarget();
  Object.assign(video, { paused: false, videoWidth: 1280, videoHeight: 720 });
  const container = new FakeTarget();
  Object.assign(container, { isConnected: true, zoomScale: 1, panX: 0, panY: 0 });
  const cleanups = [];
  const player = {
    video,
    container,
    isBuffering: false,
    disposed: false,
    addListener(target, type, handler, options) {
      target.addEventListener(type, handler, options);
      cleanups.push(() => target.removeEventListener(type, handler, options));
    },
    resources: {
      own(cleanup) { cleanups.push(cleanup); },
      dispose() { while (cleanups.length) cleanups.pop()(); }
    }
  };
  return player;
}

function installRaf() {
  const previous = {
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame
  };
  let nextId = 1;
  const callbacks = new Map();
  globalThis.requestAnimationFrame = callback => {
    const id = nextId++;
    callbacks.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = id => callbacks.delete(id);
  return {
    callbacks,
    flush() {
      const pending = [...callbacks.entries()];
      callbacks.clear();
      pending.forEach(([, callback]) => callback());
    },
    restore() {
      if (previous.requestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
      else globalThis.requestAnimationFrame = previous.requestAnimationFrame;
      if (previous.cancelAnimationFrame === undefined) delete globalThis.cancelAnimationFrame;
      else globalThis.cancelAnimationFrame = previous.cancelAnimationFrame;
    }
  };
}

test("renderer schedules at most one animation frame and continues after it runs", async () => {
  const raf = installRaf();
  try {
    const { createCanvasRenderer } = await rendererPromise;
    const player = makePlayer();
    const canvas = new FakeCanvas();
    const renderer = createCanvasRenderer(player, { canvas, offscreenCanvas: new FakeCanvas(), getOverlays: () => null, clampPan() {} });

    player.video.dispatchEvent(new Event("play"));
    player.video.dispatchEvent(new Event("play"));
    assert.equal(raf.callbacks.size, 1);
    raf.flush();
    assert.equal(raf.callbacks.size, 1);
    assert.ok(canvas.context.calls.some(call => Array.isArray(call) && call[0] === "drawImage"));
    player.disposed = true;
    player.resources.dispose();
  } finally { raf.restore(); }
});

test("pause cancels a pending frame and redraws the current frame once", async () => {
  const raf = installRaf();
  try {
    const { createCanvasRenderer } = await rendererPromise;
    const player = makePlayer();
    const canvas = new FakeCanvas();
    const renderer = createCanvasRenderer(player, { canvas, offscreenCanvas: new FakeCanvas(), getOverlays: () => null, clampPan() {} });
    player.video.dispatchEvent(new Event("play"));
    assert.equal(raf.callbacks.size, 1);
    const before = canvas.context.calls.length;
    player.video.paused = true;
    player.video.dispatchEvent(new Event("pause"));
    assert.equal(raf.callbacks.size, 0);
    assert.ok(canvas.context.calls.length > before);
    player.disposed = true;
    player.resources.dispose();
  } finally { raf.restore(); }
});

test("disposing the renderer cancels queued callbacks and removes listeners", async () => {
  const raf = installRaf();
  try {
    const { createCanvasRenderer } = await rendererPromise;
    const player = makePlayer();
    const canvas = new FakeCanvas();
    const renderer = createCanvasRenderer(player, { canvas, offscreenCanvas: new FakeCanvas(), getOverlays: () => null, clampPan() {} });
    player.video.dispatchEvent(new Event("play"));
    const before = canvas.context.calls.length;
    player.resources.dispose();
    raf.flush();
    assert.equal(canvas.context.calls.length, before);
    renderer.renderCanvas();
    renderer.redrawCanvas();
    renderer.scheduleCanvasFrame();
    assert.equal(canvas.context.calls.length, before);
    player.video.dispatchEvent(new Event("play"));
    assert.equal(raf.callbacks.size, 0);
  } finally { raf.restore(); }
});

test("renderer composites ready masks before drawing minor and text overlays", async () => {
  const raf = installRaf();
  try {
    const { createCanvasRenderer } = await rendererPromise;
    const player = makePlayer();
    const canvas = new FakeCanvas();
    const offscreen = new FakeCanvas();
    const mask = { complete: true, naturalWidth: 10 };
    const minor = { complete: true, naturalWidth: 10 };
    const text = { complete: true, naturalWidth: 10 };
    const renderer = createCanvasRenderer(player, {
      canvas,
      offscreenCanvas: offscreen,
      getOverlays: () => ({ jacks_mask: true, jacks_minor: true, jacks_text: true, imgJacksMask: mask, imgJacksMinor: minor, imgJacksText: text }),
      clampPan() {}
    });
    renderer.renderCanvas({ jacks_mask: true, jacks_minor: true, jacks_text: true, imgJacksMask: mask, imgJacksMinor: minor, imgJacksText: text });

    const mainDraws = canvas.context.calls.filter(call => Array.isArray(call) && call[0] === "drawImage");
    const offscreenDraws = offscreen.context.calls.filter(call => Array.isArray(call) && call[0] === "drawImage");
    assert.equal(offscreenDraws.length, 2);
    assert.equal(mainDraws.length, 4);
    assert.equal(mainDraws[1][1], offscreen);
    assert.equal(mainDraws[2][1], minor);
    assert.equal(mainDraws[3][1], text);
    renderer.dispose();
  } finally { raf.restore(); }
});
