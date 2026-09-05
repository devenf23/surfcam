const test = require("node:test");
const assert = require("node:assert/strict");

const helpersPromise = import("../assets/js/timestamps.mjs");

test("frontend timestamp parser maps program date times to segments", async () => {
  const { parseHlsProgramDateTimes } = await helpersPromise;
  const manifest = [
    "#EXTM3U", "#EXT-X-MEDIA-SEQUENCE:42",
    "#EXT-X-PROGRAM-DATE-TIME:2026-08-25T12:00:00.000Z",
    "#EXTINF:4.0,", "seg-42.ts", "#EXTINF:6.5,", "seg-43.ts"
  ].join("\n");
  const result = parseHlsProgramDateTimes(manifest, "https://cdn.example.com/live/playlist.m3u8");

  assert.equal(result.segments.length, 2);
  assert.equal(result.segments[0].mediaSequence, 42);
  assert.equal(result.segments[0].uri, "https://cdn.example.com/live/seg-42.ts");
  assert.equal(result.segments[0].startWallTimeMs, Date.parse("2026-08-25T12:00:00.000Z"));
  assert.equal(result.segments[1].startWallTimeMs, Date.parse("2026-08-25T12:00:04.000Z"));
  assert.equal(result.segments[1].endWallTimeMs, Date.parse("2026-08-25T12:00:10.500Z"));
});

test("frontend timestamp parser reports master playlist variants", async () => {
  const { parseHlsProgramDateTimes } = await helpersPromise;
  const manifest = ["#EXTM3U", "#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720", "variant/high.m3u8"].join("\n");
  const result = parseHlsProgramDateTimes(manifest, "https://cdn.example.com/master.m3u8");

  assert.deepEqual(result.variants, ["https://cdn.example.com/variant/high.m3u8"]);
  assert.equal(result.segments.length, 0);
});

test("frontend timestamp parser skips segments without valid wall times", async () => {
  const { parseHlsProgramDateTimes } = await helpersPromise;
  const manifest = [
    "#EXTM3U", "#EXT-X-MEDIA-SEQUENCE:7", "#EXT-X-PROGRAM-DATE-TIME:not-a-date",
    "#EXTINF:2,", "invalid.ts", "#EXT-X-PROGRAM-DATE-TIME:2026-08-25T12:00:00.000Z",
    "#EXTINF:3,", "valid.ts"
  ].join("\n");
  const result = parseHlsProgramDateTimes(manifest, "https://cdn.example.com/live/playlist.m3u8");

  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].mediaSequence, 8);
  assert.equal(result.segments[0].uri, "https://cdn.example.com/live/valid.ts");
});

test("frontend timestamp parser tracks discontinuities and clears inherited dates", async () => {
  const { parseHlsProgramDateTimes } = await helpersPromise;
  const manifest = [
    "#EXTM3U", "#EXT-X-MEDIA-SEQUENCE:20", "#EXT-X-PROGRAM-DATE-TIME:2026-08-25T12:00:00.000Z",
    "#EXTINF:4,", "before.ts", "#EXT-X-DISCONTINUITY", "#EXTINF:5,", "without-date.ts",
    "#EXT-X-PROGRAM-DATE-TIME:2026-08-25T13:00:00.000Z", "#EXTINF:6,", "after.ts"
  ].join("\n");
  const result = parseHlsProgramDateTimes(manifest, "https://cdn.example.com/live/playlist.m3u8");

  assert.equal(result.segments.length, 2);
  assert.equal(result.segments[0].mediaSequence, 20);
  assert.equal(result.segments[0].discontinuity, 0);
  assert.equal(result.segments[1].mediaSequence, 22);
  assert.equal(result.segments[1].discontinuity, 1);
  assert.equal(result.segments[1].startWallTimeMs, Date.parse("2026-08-25T13:00:00.000Z"));
});

test("frontend timestamp date parser handles null, numbers, and invalid values", async () => {
  const { parseHlsDateTime, resolvePlaylistUrl } = await helpersPromise;

  assert.equal(parseHlsDateTime(null), null);
  assert.equal(parseHlsDateTime("not-a-date"), null);
  assert.equal(parseHlsDateTime(1234), 1234);
  assert.equal(resolvePlaylistUrl("segment.ts", "https://cdn.example.com/live/list.m3u8"), "https://cdn.example.com/live/segment.ts");
  assert.equal(resolvePlaylistUrl("%invalid", "not a URL"), "%invalid");
});

test("frontend timestamp formatters use 24 hour clock and lag format", async () => {
  const { formatTimestampTime, formatLagBehind } = await helpersPromise;
  const sample = new Date("2026-08-25T17:04:09Z");
  const pad = value => String(value).padStart(2, "0");

  assert.equal(formatTimestampTime(sample.getTime()), `${pad(sample.getHours())}:${pad(sample.getMinutes())}:${pad(sample.getSeconds())}`);
  assert.equal(formatLagBehind(0), "-00:00:00");
  assert.equal(formatLagBehind(3661), "-01:01:01");
});

test("frontend preview cache buckets round to half seconds", async () => {
  const { getPreviewCacheKey } = await helpersPromise;

  assert.equal(getPreviewCacheKey(12.24), "12.0");
  assert.equal(getPreviewCacheKey(12.26), "12.5");
  assert.equal(getPreviewCacheKey(12.74), "12.5");
});
