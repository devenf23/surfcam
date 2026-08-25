const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadTimestampHelpers() {
  const sourcePath = path.join(__dirname, "..", "assets", "js", "surfcam.js");
  const source = fs.readFileSync(sourcePath, "utf8");
  const end = source.indexOf("    const sidebar = document.getElementById");
  assert.ok(end > 0, "frontend helper boundary should exist");
  const sandbox = {
    module: { exports: {} },
    exports: {},
    console,
    URL,
    Date,
    fetch: async () => { throw new Error("fetch not expected"); },
    setInterval,
    clearInterval
  };
  vm.runInNewContext(source.slice(0, end), sandbox, { filename: sourcePath });
  return sandbox.module.exports._test;
}

test("frontend timestamp parser maps program date times to segments", () => {
  const { parseHlsProgramDateTimes } = loadTimestampHelpers();
  const manifest = [
    "#EXTM3U",
    "#EXT-X-MEDIA-SEQUENCE:42",
    "#EXT-X-PROGRAM-DATE-TIME:2026-08-25T12:00:00.000Z",
    "#EXTINF:4.0,",
    "seg-42.ts",
    "#EXTINF:6.5,",
    "seg-43.ts"
  ].join("\n");

  const result = parseHlsProgramDateTimes(manifest, "https://cdn.example.com/live/playlist.m3u8");

  assert.equal(result.segments.length, 2);
  assert.equal(result.segments[0].mediaSequence, 42);
  assert.equal(result.segments[0].uri, "https://cdn.example.com/live/seg-42.ts");
  assert.equal(result.segments[0].startWallTimeMs, Date.parse("2026-08-25T12:00:00.000Z"));
  assert.equal(result.segments[1].startWallTimeMs, Date.parse("2026-08-25T12:00:04.000Z"));
  assert.equal(result.segments[1].endWallTimeMs, Date.parse("2026-08-25T12:00:10.500Z"));
});

test("frontend timestamp parser reports master playlist variants", () => {
  const { parseHlsProgramDateTimes } = loadTimestampHelpers();
  const manifest = [
    "#EXTM3U",
    "#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720",
    "variant/high.m3u8"
  ].join("\n");

  const result = parseHlsProgramDateTimes(manifest, "https://cdn.example.com/master.m3u8");

  assert.equal(result.variants.length, 1);
  assert.equal(result.variants[0], "https://cdn.example.com/variant/high.m3u8");
  assert.equal(result.segments.length, 0);
});

test("frontend timestamp formatters use 24 hour clock and lag format", () => {
  const { formatTimestampTime, formatLagBehind } = loadTimestampHelpers();
  const sample = new Date("2026-08-25T17:04:09Z");
  const pad = value => String(value).padStart(2, "0");

  assert.equal(formatTimestampTime(sample.getTime()), `${pad(sample.getHours())}:${pad(sample.getMinutes())}:${pad(sample.getSeconds())}`);
  assert.equal(formatLagBehind(0), "-00:00:00");
  assert.equal(formatLagBehind(3661), "-01:01:01");
});

test("frontend preview cache buckets round to half seconds", () => {
  const { getPreviewCacheKey } = loadTimestampHelpers();

  assert.equal(getPreviewCacheKey(12.24), "12.0");
  assert.equal(getPreviewCacheKey(12.26), "12.5");
  assert.equal(getPreviewCacheKey(12.74), "12.5");
});
