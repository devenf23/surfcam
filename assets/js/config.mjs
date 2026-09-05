const defaults = Object.freeze({
  proxyPrefix: "https://surfcam-alpha.vercel.app/api/proxy?url=",
  stormGlassEndpoint: "https://surfcam-alpha.vercel.app/api/stormglass?date=",
  overlayBaseUrl: "https://devenf23.github.io/surfcam/privates/"
});

const overrides = globalThis.SURFCAM_CONFIG;
export const config = Object.freeze({
  ...defaults,
  ...(overrides && typeof overrides === "object" ? overrides : {})
});

export { defaults as defaultConfig };
