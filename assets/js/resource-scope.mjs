// Every mounted player/feature owns a scope. Disposal is safe to repeat and
// prevents pending callbacks and requests from reviving an unmounted player.
export function createResourceScope(clock = globalThis) {
  let disposed = false;
  const cleanups = new Set();
  const controller = new AbortController();
  function own(cleanup) {
    if (disposed) { cleanup(); return () => {}; }
    cleanups.add(cleanup);
    return () => { if (cleanups.delete(cleanup)) cleanup(); };
  }
  function listen(target, type, handler, options) {
    if (disposed) return handler;
    target.addEventListener(type, handler, options);
    own(() => target.removeEventListener(type, handler, options));
    return handler;
  }
  function timeout(callback, delay) {
    if (disposed) return null;
    const cleanup = () => clock.clearTimeout(id);
    const id = clock.setTimeout(() => {
      cleanups.delete(cleanup);
      if (!disposed) callback();
    }, delay);
    own(cleanup);
    return id;
  }
  function interval(callback, delay) {
    if (disposed) return null;
    const id = clock.setInterval(() => { if (!disposed) callback(); }, delay);
    own(() => clock.clearInterval(id));
    return id;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    controller.abort();
    const errors = [];
    for (const cleanup of cleanups) {
      try { cleanup(); } catch (error) { errors.push(error); }
    }
    cleanups.clear();
    if (errors.length) console.error('Resource cleanup failed', errors);
  }
  return { own, listen, timeout, interval, dispose, signal: controller.signal,
    get disposed() { return disposed; } };
}
