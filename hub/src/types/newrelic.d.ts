/**
 * Minimal ambient types for the `newrelic` agent API (#277).
 *
 * The package ships no declarations, and `@types/newrelic` lags the agent by
 * major versions. `services/telemetry.ts` uses three calls, all behind
 * optional-chaining, so declaring just those is both sufficient and honest
 * about what we depend on. Widen only when telemetry.ts actually needs more.
 */
declare module "newrelic" {
  interface NewRelicAgentApi {
    noticeError(error: Error, attributes?: Record<string, unknown>): void;
    recordCustomEvent(
      eventType: string,
      attributes: Record<string, unknown>,
    ): void;
    recordMetric(name: string, value: number): void;
  }

  const api: NewRelicAgentApi;
  export default api;
}
