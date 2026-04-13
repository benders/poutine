// Initializes the New Relic Browser agent when VITE_NEW_RELIC_LICENSE_KEY and
// VITE_NEW_RELIC_APP_ID are set at build time. When either variable is absent
// the agent is not loaded and there is no New Relic overhead.
import { BrowserAgent } from "@newrelic/browser-agent/loaders/browser-agent";

const licenseKey = import.meta.env.VITE_NEW_RELIC_LICENSE_KEY as
  | string
  | undefined;
const applicationID = import.meta.env.VITE_NEW_RELIC_APP_ID as
  | string
  | undefined;

if (licenseKey && applicationID) {
  new BrowserAgent({
    init: {
      distributed_tracing: { enabled: true },
      privacy: { cookies_enabled: true },
      ajax: { deny_list: ["bam.nr-data.net"] },
    },
    info: {
      beacon: "bam.nr-data.net",
      errorBeacon: "bam.nr-data.net",
      licenseKey,
      applicationID,
      sa: 1,
    },
    loader_config: {
      accountID: "49251",
      trustKey: "49251",
      agentID: applicationID,
      licenseKey,
      applicationID,
    },
  });
}
