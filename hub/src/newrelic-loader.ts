// Loaded via `node --import ./hub/dist/newrelic-loader.js` before the main
// server module. Only activates the New Relic APM agent when
// NEW_RELIC_LICENSE_KEY is set; otherwise exits immediately so there is zero
// New Relic overhead in environments without instrumentation configured.
if (process.env.NEW_RELIC_LICENSE_KEY) {
  const { register } = await import("node:module");
  // Register the ESM instrumentation hooks. newrelic/esm-loader.mjs resolves
  // import-in-the-middle from the pnpm store via its own symlink-resolved path.
  register("newrelic/esm-loader.mjs", import.meta.url);
  // Initialise the New Relic agent (reads licence key and app name from env).
  // @ts-ignore – newrelic ships no ESM TypeScript bindings
  await import("newrelic");
}
