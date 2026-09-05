# Surfcam

Surfcam is a build-free static live-stream dashboard. Serve the repository
over HTTP for local development; the frontend remains deployable to static
hosting and uses the Vercel functions under `api/` for cross-origin playback
and Storm Glass tide data.

## Frontend architecture

The browser code is build-free native ES modules. `surfcam.js` coordinates the
dashboard, while `player-view`, playback/controller modules, `stream-store`,
`resource-scope`, and `tide-panel` keep player state, media resources, cleanup,
and tide UI behavior separate. `tide-data.mjs` owns NOAA URL construction,
offset normalization, interpolation, and cached requests. Serve the repository
through an HTTP server when developing; opening module files directly is not
supported.

Runtime endpoints can be overridden before the module script loads. Defaults
remain in `assets/js/config.mjs`:

```html
<script>
  window.SURFCAM_CONFIG = {
    proxyPrefix: 'https://example.test/api/proxy?url=',
    stormGlassEndpoint: 'https://example.test/api/stormglass?date=',
    overlayBaseUrl: 'https://example.test/privates/'
  };
</script>
<script type="module" src="assets/js/surfcam.js"></script>
```

The API key setup is unchanged: keep `STORMGLASS_API_KEY` in the Vercel
environment and do not put it in browser configuration.

## Local checks

Start the static server, then open the printed `http://` URL. Do not open
`index.html` or `tides.html` directly from the filesystem; browsers block the
native module imports on `file://` pages.

```sh
npm run dev
```

```sh
npm ci
npm test
npm run check
```

Browser regression checks use deterministic mocked media and service responses:

```sh
npm run test:browser
```

That command requires Playwright (or a globally installed `playwright-cli`).
These checks cover browser behavior with fixtures and do not establish that a
live provider is currently available or reliable.

After deploying to GitHub Pages, do a hard refresh once if an older cached
asset was previously loaded. The module entry has a version query so future
deployments invalidate the stale script automatically.

For the mobile WebKit workflow, put one public HTTP(S) stream URL per line in
an ignored `.env` file and run `scripts/mobile-webkit.sh`.

## Vercel configuration

Set `STORMGLASS_API_KEY` as a Vercel environment variable before deploying.
The browser never receives this value. The proxy accepts public HTTP(S)
targets and forwards range requests for stream playback.
