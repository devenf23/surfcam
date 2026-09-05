const test = require('node:test');
const assert = require('node:assert/strict');

let tide;
test('tide data helpers', async () => {
  tide ||= await import('../assets/js/tide-data.mjs');
  assert.match(tide.buildNoaaUrl('2026-08-21'), /begin_date=20260821/);
  assert.match(tide.buildNoaaUrl('2026-08-21', 'hilo'), /interval=hilo/);
  assert.equal(tide.dateKey(new Date('2026-08-21T23:00:00Z')), '2026-08-21');
  const normalized = tide.normalizeNoaaPredictions([
    { t: '2026-08-21T12:00:00Z', v: '2.00' },
    { t: '2026-08-21T13:00:00Z', v: '3.00', type: 'H' }
  ]);
  assert.equal(normalized[0].v, 2.98);
  assert.equal(normalized[0].t, '2026-08-21T11:51:30.000Z');
  const extremes = tide.normalizeNoaaPredictions([
    { t: '2026-08-21T13:00:00Z', v: '3.00', type: 'H' },
    { t: '2026-08-21T14:00:00Z', v: '1.00', type: 'L' }
  ], { extremes: true });
  assert.ok(Math.abs(extremes[0].v - 3.97) < 1e-9);
  assert.ok(Math.abs(extremes[1].v - 1.99) < 1e-9);
  assert.equal(tide.interpolateTide('2026-08-21T12:21:30Z', normalized), 3.48);
  assert.ok(Math.abs(tide.normalizeStormGlass({ hours: [{ time: '2026-08-21T12:00:00Z', sg: 1 }] }).curve[0].v - 3.28084) < 1e-9);
});

test('NOAA requests are cached and deduplicated by date', async () => {
  tide ||= await import('../assets/js/tide-data.mjs');
  tide.clearNoaaCache();
  let calls = 0;
  const response = payload => ({ ok: true, status: 200, json: async () => payload });
  const fetchImpl = async url => {
    calls++;
    return url.includes('interval=hilo')
      ? response({ predictions: [{ t: '2026-08-21T13:00:00Z', v: '3', type: 'H' }] })
      : response({ predictions: [{ t: '2026-08-21T12:00:00Z', v: '2' }] });
  };
  const [first, second] = await Promise.all([
    tide.fetchNoaaTides('2026-08-21', { fetchImpl }),
    tide.fetchNoaaTides('2026-08-21', { fetchImpl })
  ]);
  assert.deepStrictEqual(first, second);
  assert.equal(calls, 2);
  assert.equal(first.hiLo[0].type, 'H');
});

test('NOAA subscribers can cancel without cancelling remaining subscribers', async () => {
  tide.clearNoaaCache();
  const resolvers = [];
  const fetchImpl = async () => new Promise(resolve => { resolvers.push(() => resolve({ ok: true, status: 200, json: async () => ({ predictions: [{ t: '2026-08-21T12:00:00Z', v: '2' }] }) })); });
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = tide.fetchNoaaTides('2026-08-21', { fetchImpl, signal: firstController.signal });
  const second = tide.fetchNoaaTides('2026-08-21', { fetchImpl, signal: secondController.signal });
  firstController.abort();
  await assert.rejects(first, { name: 'AbortError' });
  secondController.abort();
  await assert.rejects(second, { name: 'AbortError' });
  const fresh = tide.fetchNoaaTides('2026-08-21', { fetchImpl });
  assert.equal(resolvers.length, 4);
  resolvers.forEach(resolve => resolve());
  await assert.doesNotReject(fresh);
});

test('space-separated NOAA dates retain browser-local date semantics', async () => {
  tide.clearNoaaCache();
  assert.equal(tide.dateKey('2026-08-21 12:00:00'), '2026-08-21');
});

test('failed NOAA requests are evicted for retry', async () => {
  tide.clearNoaaCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls <= 2) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ predictions: [{ t: '2026-08-21T12:00:00Z', v: '2' }] }) };
  };
  await assert.rejects(tide.fetchNoaaTides('2026-08-21', { fetchImpl }));
  await assert.doesNotReject(tide.fetchNoaaTides('2026-08-21', { fetchImpl }));
  assert.equal(calls, 4);
});
