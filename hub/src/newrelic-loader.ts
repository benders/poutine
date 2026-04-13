// Loaded via `node --import ./hub/dist/newrelic-loader.js` before the main
// server module. Only activates the New Relic APM agent when
// NEW_RELIC_LICENSE_KEY is set; otherwise exits immediately so there is zero
// New Relic overhead in environments without instrumentation configured.
if (process.env.NEW_RELIC_LICENSE_KEY) {
  // @ts-ignore – newrelic/register.mjs ships no TypeScript bindings
  await import("newrelic/register.mjs");
}
