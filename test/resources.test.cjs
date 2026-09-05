const test = require("node:test");
const assert = require("node:assert/strict");

const { createResourceScope } = require("../assets/js/resource-scope.mjs");

class FakeTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, handler, options) {
    const list = this.listeners.get(type) || [];
    list.push({ handler, options });
    this.listeners.set(type, list);
  }
  removeEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    this.listeners.set(type, list.filter(item => item.handler !== handler));
  }
  dispatch(type, event = {}) {
    for (const item of [...(this.listeners.get(type) || [])]) item.handler(event);
  }
  count(type) { return (this.listeners.get(type) || []).length; }
}

function fakeClock() {
  let nextId = 1;
  const timers = new Map();
  const intervals = new Map();
  return {
    setTimeout(fn, delay) { const id = nextId++; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, delay) { const id = nextId++; intervals.set(id, { fn, delay }); return id; },
    clearInterval(id) { intervals.delete(id); },
    runTimeouts() { for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn(); } },
    tickIntervals() { for (const { fn } of intervals.values()) fn(); },
    timeoutCount() { return timers.size; },
    intervalCount() { return intervals.size; }
  };
}

test("scope removes listeners and cancels pending timeout and interval work", () => {
  const clock = fakeClock();
  const target = new FakeTarget();
  const scope = createResourceScope(clock);
  let events = 0;
  scope.listen(target, "change", () => { events += 1; });
  scope.timeout(() => { events += 10; }, 20);
  scope.interval(() => { events += 100; }, 10);
  target.dispatch("change");
  clock.tickIntervals();
  assert.equal(events, 101);
  assert.equal(target.count("change"), 1);
  scope.dispose();
  assert.equal(target.count("change"), 0);
  assert.equal(clock.timeoutCount(), 0);
  assert.equal(clock.intervalCount(), 0);
  target.dispatch("change");
  clock.runTimeouts();
  clock.tickIntervals();
  assert.equal(events, 101);
});

test("disposed scope prevents callbacks even if a clock still invokes them", () => {
  const callbacks = [];
  const clock = {
    setTimeout(fn) { callbacks.push(fn); return callbacks.length; },
    clearTimeout() {},
    setInterval(fn) { callbacks.push(fn); return callbacks.length; },
    clearInterval() {}
  };
  const scope = createResourceScope(clock);
  let calls = 0;
  scope.timeout(() => { calls += 1; }, 1);
  scope.interval(() => { calls += 1; }, 1);
  scope.dispose();
  callbacks.forEach(fn => fn());
  assert.equal(calls, 0);
  assert.equal(scope.disposed, true);
});

test("scope signal aborts on disposal and disposal is idempotent", () => {
  const scope = createResourceScope(fakeClock());
  let aborts = 0;
  scope.signal.addEventListener("abort", () => { aborts += 1; });
  scope.dispose();
  scope.dispose();
  assert.equal(scope.signal.aborted, true);
  assert.equal(aborts, 1);
});

test("a child disposer throwing does not prevent later cleanup", () => {
  const scope = createResourceScope(fakeClock());
  const cleaned = [];
  scope.own(() => { cleaned.push("first"); throw new Error("expected cleanup failure"); });
  scope.own(() => cleaned.push("second"));
  assert.doesNotThrow(() => scope.dispose());
  assert.deepEqual(cleaned, ["first", "second"]);
  assert.doesNotThrow(() => scope.dispose());
});

test("own cleanup invoked after disposal runs immediately", () => {
  const scope = createResourceScope(fakeClock());
  scope.dispose();
  let cleaned = 0;
  const release = scope.own(() => { cleaned += 1; });
  release();
  assert.equal(cleaned, 1);
});
