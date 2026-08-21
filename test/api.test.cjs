const test = require("node:test");
const assert = require("node:assert/strict");

const proxy = require("../api/proxy")._test;
const stormglass = require("../api/stormglass")._test;

test("proxy accepts public HTTP(S) URLs and rejects unsafe targets", () => {
  assert.equal(proxy.parseTarget("https://example.com/live/index.m3u8").protocol, "https:");
  assert.throws(() => proxy.parseTarget("file:///etc/passwd"), /Only HTTP/);
  assert.throws(() => proxy.parseTarget("https://user:pass@example.com/live"), /Credentialed/);
  assert.equal(proxy.isPublicAddress("127.0.0.1"), false);
  assert.equal(proxy.isPublicAddress("192.168.1.10"), false);
  assert.equal(proxy.isPublicAddress("::1"), false);
  assert.equal(proxy.isPublicAddress("8.8.8.8"), true);
});

test("proxy rewrites playlist lines and quoted URI attributes", () => {
  const source = [
    "#EXTM3U",
    "#EXT-X-KEY:METHOD=AES-128,URI=\"keys/key.bin\"",
    "#EXT-X-MAP:URI='init.mp4'",
    "segment-001.ts"
  ].join("\n");
  const result = proxy.rewriteManifest(source, "https://cdn.example.com/path/master.m3u8");
  assert.match(result, /URI="https:\/\/cdn\.example\.com\/path\/keys\/key\.bin"/);
  assert.match(result, /URI='https:\/\/cdn\.example\.com\/path\/init\.mp4'/);
  assert.match(result, /https:\/\/cdn\.example\.com\/path\/segment-001\.ts/);
});

test("proxy pinned DNS lookup supports single and all-address callback shapes", async () => {
  const lookup = proxy.createPinnedLookup({ address: "203.0.113.10", family: 4 });

  const single = await new Promise((resolve, reject) => {
    lookup("cdn.example.com", {}, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
  assert.deepEqual(single, { address: "203.0.113.10", family: 4 });

  const all = await new Promise((resolve, reject) => {
    lookup("cdn.example.com", { all: true }, (error, records) => {
      if (error) reject(error);
      else resolve(records);
    });
  });
  assert.deepEqual(all, [{ address: "203.0.113.10", family: 4 }]);
});

test("Storm Glass date validation matches the tide UI range", () => {
  assert.equal(stormglass.parseDate("2026-08-21").toISOString(), "2026-08-21T00:00:00.000Z");
  assert.equal(stormglass.parseDate("2026-02-30"), null);
  assert.equal(stormglass.parseDate("2026-8-1"), null);
  const now = new Date("2026-08-21T12:00:00Z");
  assert.equal(stormglass.isWithinSupportedRange(new Date("2026-07-22T00:00:00Z"), now), true);
  assert.equal(stormglass.isWithinSupportedRange(new Date("2026-07-21T00:00:00Z"), now), false);
  assert.equal(stormglass.isWithinSupportedRange(new Date("2026-08-28T00:00:00Z"), now), true);
  assert.equal(stormglass.isWithinSupportedRange(new Date("2026-08-29T00:00:00Z"), now), false);
});
