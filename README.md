# Surfcam

Surfcam is a build-free static live-stream dashboard. Serve the repository
over HTTP for local development; the frontend remains deployable to static
hosting and uses the Vercel functions under `api/` for cross-origin playback
and Storm Glass tide data.

## Local checks

```sh
npm ci
npm test
npm run check
```

For the mobile WebKit workflow, put one public HTTP(S) stream URL per line in
an ignored `.env` file and run `scripts/mobile-webkit.sh`.

## Vercel configuration

Set `STORMGLASS_API_KEY` as a Vercel environment variable before deploying.
The browser never receives this value. The proxy accepts public HTTP(S)
targets and forwards range requests for stream playback.
