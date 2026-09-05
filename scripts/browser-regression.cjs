// Deterministic UI integration checks. Media decoding and external services are
// simulated; use the mobile WebKit workflow for a real provider playback check.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
function loadPlaywright() {
  if (process.env.PLAYWRIGHT_MODULE) return require(process.env.PLAYWRIGHT_MODULE);
  try { return require('playwright'); } catch {}
  const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  return require(require.resolve('playwright', { paths: [path.join(globalRoot, '@playwright/cli')] }));
}
const root = path.resolve(__dirname, '..');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname;
  if (!/^\/(index\.html|tides\.html|favicon\.svg|assets\/(js|css)\/[a-z0-9.-]+)$/.test(name)) { res.writeHead(404).end(); return; }
  fs.readFile(path.join(root, name), (error, data) => {
    if (error) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': mime[path.extname(name)] || 'text/plain' }).end(data);
  });
});
function installMediaFixture() {
  const states = new WeakMap();
  const state = video => {
    if (!states.has(video)) states.set(video, { paused: true, currentTime: 60, duration: 120, readyState: 4, end: 120, src: '' });
    return states.get(video);
  };
  window.__mediaState = state;
  const proto = HTMLMediaElement.prototype;
  for (const key of ['paused', 'currentTime', 'duration', 'readyState', 'src']) {
    Object.defineProperty(proto, key, { configurable: true, get() { return state(this)[key]; }, set(value) {
      state(this)[key] = value;
      if (key === 'src' && String(value).endsWith('.m3u8')) state(this).duration = Infinity;
      if (key === 'currentTime') { this.dispatchEvent(new Event('seeking')); queueMicrotask(() => this.dispatchEvent(new Event('seeked'))); }
    } });
  }
  Object.defineProperty(proto, 'buffered', { configurable: true, get() { return { length: 1, start: () => 0, end: () => state(this).end }; } });
  Object.defineProperty(proto, 'seekable', { configurable: true, get() { return { length: 1, start: () => 10, end: () => 120 }; } });
  for (const [key, value] of [['videoWidth', 640], ['videoHeight', 360]]) Object.defineProperty(HTMLVideoElement.prototype, key, { configurable: true, get: () => value });
  proto.play = function() {
    const changed = state(this).paused; state(this).paused = false;
    if (changed) queueMicrotask(() => { this.dispatchEvent(new Event('play')); this.dispatchEvent(new Event('playing')); });
    return Promise.resolve();
  };
  proto.pause = function() { if (!state(this).paused) { state(this).paused = true; queueMicrotask(() => this.dispatchEvent(new Event('pause'))); } };
  proto.load = function() { this.dispatchEvent(new Event('emptied')); };
  proto.canPlayType = () => 'probably';
  HTMLVideoElement.prototype.getVideoPlaybackQuality = () => ({ totalVideoFrames: 10 });
  HTMLVideoElement.prototype.requestVideoFrameCallback = function(callback) { return requestAnimationFrame(() => callback(performance.now(), { presentedFrames: 1 })); };
  HTMLVideoElement.prototype.cancelVideoFrameCallback = cancelAnimationFrame;
  const draw = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function(source, ...args) {
    if (source instanceof HTMLVideoElement) { this.fillStyle = '#27566c'; this.fillRect(0, 0, this.canvas.width, this.canvas.height); return; }
    return draw.call(this, source, ...args);
  };
}
const hlsFixture = `
window.__hlsInstances = [];
window.Hls = class Hls {
 static isSupported() { return true; }
 static Events = { MANIFEST_PARSED:'manifest', FRAG_CHANGED:'changed', FRAG_BUFFERED:'buffered', LEVEL_UPDATED:'level', ERROR:'error' };
 static ErrorTypes = { NETWORK_ERROR:'network', MEDIA_ERROR:'media' };
 static ErrorDetails = {};
 static DefaultConfig = { loader: class { load() {} } };
 constructor(config) { this.config = config; this.events = new Map(); window.__hlsInstances.push(this); }
 loadSource(url) { this.url = url; }
 attachMedia(media) { this.media = media; queueMicrotask(() => { this.emit('manifest'); this.emit('buffered', {frag:{start:0,duration:120,programDateTime:Date.parse('2026-08-25T12:00:00Z')}}); media.dispatchEvent(new Event('canplay')); }); }
 on(event, callback) { const list=this.events.get(event)||[]; list.push(callback); this.events.set(event,list); }
 emit(event, data={}) { for (const cb of this.events.get(event)||[]) cb(event,data); }
 startLoad() {} recoverMediaError() {} destroy() { this.destroyed=true; this.media=null; this.events.clear(); }
};`;
const chartFixture = `window.Chart = class Chart { static register() {} constructor(ctx, config) { this.data=config.data; this.options=config.options; window.__chart=this; } destroy() { this.destroyed=true; } update() {} };`;
function noaaFixture(url) {
  const key = url.searchParams.get('begin_date');
  const date = `${key.slice(0,4)}-${key.slice(4,6)}-${key.slice(6,8)}`;
  if (url.searchParams.get('interval') === 'hilo') return { predictions: [{ t:`${date} 06:00`, v:'4', type:'H' }, { t:`${date} 18:00`, v:'0.5', type:'L' }] };
  return { predictions: Array.from({length:24},(_,hour)=>({ t:`${date} ${String(hour).padStart(2,'0')}:00`, v:String(2+Math.sin(hour/4)) })) };
}
async function fixtures(page) {
  await page.addInitScript(installMediaFixture);
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') return route.continue();
    const fulfill = (body, contentType='application/json') => route.fulfill({ status:200, contentType, body: typeof body === 'string' ? body : JSON.stringify(body) });
    if (url.pathname.includes('hls.min.js')) return fulfill(hlsFixture, 'text/javascript');
    if (url.pathname.includes('chart.umd.min.js')) return fulfill(chartFixture, 'text/javascript');
    if (url.pathname.endsWith('.js')) return fulfill('', 'text/javascript');
    if (url.hostname === 'api.tidesandcurrents.noaa.gov') return fulfill(noaaFixture(url));
    if (url.hostname === 'api.sunrise-sunset.org') return fulfill({status:'OK',results:{sunrise:'2026-08-25T13:00:00Z',sunset:'2026-08-26T03:00:00Z',astronomical_twilight_begin:'2026-08-25T12:00:00Z',astronomical_twilight_end:'2026-08-26T04:00:00Z'}});
    if (url.pathname === '/api/stormglass') { const date=url.searchParams.get('date'); return fulfill({ hours: [{ time:date+'T00:00:00Z',sg:1 },{ time:date+'T12:00:00Z',sg:2 }],extremes:[] }); }
    if (url.pathname === '/api/proxy') return fulfill('#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:2026-08-25T12:00:00Z\n#EXTINF:120,\nsegment.ts', 'application/vnd.apple.mpegurl');
    if (url.pathname.endsWith('.png')) return route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6ioAAAAASUVORK5CYII=','base64')});
    return fulfill('', 'text/css');
  });
}
async function editUrls(page, mobile, urls) {
  if (mobile && (await page.locator('#sidebar').evaluate(el=>el.classList.contains('hidden')))) await page.locator('#sidebarToggle').click();
  await page.locator('#btn-add-urls').click();
  await page.locator('#urlInput').fill(urls.join('\n'));
  await page.locator('#saveUrls').click();
  if (mobile) {
    await page.locator('#main-content').dispatchEvent('touchstart',{touches:[{clientX:350,clientY:250}],changedTouches:[{clientX:350,clientY:250}]});
    await page.locator('#main-content').dispatchEvent('touchend',{touches:[],changedTouches:[{clientX:350,clientY:250}]});
  }
}
async function swipe(page, dx) {
  const target=page.locator('.player-fullscreen-mobile video');
  await target.dispatchEvent('pointerdown',{pointerType:'mouse',button:0,pointerId:1,clientX:200,clientY:300});
  await target.dispatchEvent('pointermove',{pointerType:'mouse',buttons:1,pointerId:1,clientX:200+dx,clientY:300});
  await page.locator('body').dispatchEvent('pointerup',{pointerType:'mouse',button:0,pointerId:1,clientX:200+dx,clientY:300});
  // Browsers emit a compatibility click after pointerup; the app suppresses it.
  await page.locator('body').dispatchEvent('click');
}
async function runCase(browser, options, base, name) {
  const context=await browser.newContext({...options, timezoneId:'America/Los_Angeles'});
  try {
    const page=await context.newPage(); page.setDefaultTimeout(6000);
    const errors=[]; page.on('pageerror',e=>{ errors.push(e.message); console.error(name+': '+e.message); });
    await fixtures(page);
    await page.goto(base+'/index.html');
    const mobile=!!options.isMobile;
    const urls=['https://example.com/wc-privates/playlist.m3u8','https://example.com/wc-second/playlist.m3u8','https://example.com/movie.mp4'];
    await editUrls(page,mobile,urls);
    await page.waitForFunction(()=>document.querySelectorAll('.player-container').length===3);
    assert.deepEqual(errors,[],name+' initialization');
    assert.equal(await page.locator('.mp4-player video').evaluate(v=>v.controls&&!v.autoplay&&!v.muted),true);
    // User controls operate on shared playback intent; a stall must not override a user pause.
    const first=page.locator('.player-container').first();
    await first.locator('.play-pause-btn').dispatchEvent('click');
    assert.equal(await first.locator('video').evaluate(v=>v.paused),true);
    await first.locator('.play-pause-btn').dispatchEvent('click');
    await page.waitForFunction(()=>!document.querySelector('video').paused);
    await first.locator('video').evaluate(v=>{ window.__mediaState(v).end=60; v.dispatchEvent(new Event('stalled')); });
    await page.waitForFunction(()=>document.querySelector('.player-container').classList.contains('is-buffering'));
    await first.locator('.play-pause-btn').dispatchEvent('click');
    await first.locator('video').evaluate(v=>{ window.__mediaState(v).end=120; v.dispatchEvent(new Event('progress')); });
    assert.equal(await first.locator('video').evaluate(v=>v.paused),true,'pause cancels recovery');
    // Seek via the real control event path and check the timestamp HUD.
    const bar = first.locator('.progress-bar');
    if (mobile) {
      const box = await bar.boundingBox();
      const touch = { clientX:box.x+box.width*.25,clientY:box.y+box.height/2 };
      await bar.dispatchEvent('touchstart',{touches:[touch],changedTouches:[touch]});
      await page.locator('body').dispatchEvent('touchend',{touches:[],changedTouches:[touch]});
    } else {
      await bar.evaluate(el=>{ const r=el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:r.left+r.width*.25,button:0})); });
      await page.locator('body').dispatchEvent('mouseup');
    }
    assert.equal(await first.locator('video').evaluate(v=>Math.abs(v.currentTime-(v.duration===Infinity?37.5:30))<1),true,'DVR seeking');
    assert.ok(await first.locator('.corner-timestamp-overlay').textContent(),'timestamp HUD');
    if (!mobile) {
      await first.locator('.overlay-icon').click();
      await first.locator('input[data-spot="pp"]').check();
      await first.locator('.canvas-wrapper').click({position:{x:10,y:10}});
      const canvas=first.locator('.canvas-wrapper');
      await page.evaluate(()=>document.activeElement.blur());
      await page.keyboard.down('Space');
      await canvas.dispatchEvent('wheel',{deltaY:-100,clientX:300,clientY:200});
      await page.keyboard.up('Space');
      assert.ok(await first.evaluate(el=>el.zoomScale>1),'zoom');
      await first.locator('.reset-btn').click();
      assert.equal(await first.evaluate(el=>el.zoomScale),1);
      await first.locator('[aria-label="Enter/Exit Fullscreen"]').click();
      await page.waitForFunction(()=>!!(document.fullscreenElement||document.webkitFullscreenElement));
    } else {
      await first.locator('.fs-btn-mobile').dispatchEvent('click');
      await page.waitForFunction(()=>!!document.querySelector('.player-fullscreen-mobile'));
      await swipe(page,100);
      await page.waitForFunction(url=>document.querySelector('.player-fullscreen-mobile')?.dataset.url===url,urls[1]);
      // A short swipe cancels without changing the selected stream.
      await swipe(page,-30);
      await page.waitForFunction(()=>!document.querySelector('#fsSwipeOverlay'));
      assert.equal(await page.locator('.player-fullscreen-mobile').getAttribute('data-url'),urls[1]);
    }
    const active=mobile?page.locator('.player-fullscreen-mobile'):first;
    await active.locator('button').filter({hasText:'Tides'}).first().dispatchEvent('click');
    await active.locator('.tide-graph .tide-line').waitFor({state:'attached'});
    await active.locator('.tide-close').click();
    if (mobile) await page.keyboard.press('Escape');
    else await page.evaluate(()=>document.exitFullscreen());
    // Hide/recreate, remove URLs, and reload retain persisted behavior.
    await page.locator('#btn-hide-all').dispatchEvent('click');
    assert.equal(await page.locator('.player-container').count(),0);
    assert.equal(await page.evaluate(()=>window.__hlsInstances.every(h=>h.destroyed)),true);
    await page.locator('#btn-show-all').dispatchEvent('click');
    assert.equal(await page.locator('.player-container').count(),3);
    await editUrls(page,mobile,[urls[1]]);
    assert.equal(await page.locator('.player-container').count(),1);
    await page.reload();
    await page.waitForFunction(()=>document.querySelectorAll('.player-container').length===1);
    assert.equal(await page.locator('.player-container').getAttribute('data-url'),urls[1]);
    await page.goto(base+'/tides.html');
    await page.waitForFunction(()=>!!window.__chart);
    assert.ok(await page.evaluate(()=>window.__chart.data.datasets[0].data.length>0));
    await page.locator('#nextDayBtn').click();
    await page.locator('input[value="stormglass"]').check();
    await page.waitForFunction(()=>window.__chart.data.datasets[0].data.length===2);
    assert.equal(await page.evaluate(()=>window.__chart.data.datasets[0].data[0]),3.28084);
    assert.deepEqual(errors,[],name+' browser errors');
    console.log(`PASS ${name}: controls, stall/pause, fullscreen, tides, persistence, removal${mobile?', swipe commit/cancel':''}`);
  } finally { await context.close(); }
}
(async()=>{
  const { chromium,webkit,devices }=loadPlaywright();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    for (const [name,engine,options] of [['Chromium desktop',chromium,{}],['WebKit mobile',webkit,devices['iPhone 15']],['WebKit desktop/native HLS',webkit,{}]]) {
      const browser=await engine.launch({headless:true});
      try { await runCase(browser,options,base,name); } finally { await browser.close(); }
    }
  } finally { server.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
