import { webBridge } from "spectrum-ts/providers";
import { runProgressiveAgent, webBridgeServerConfig } from "./agent";

await runProgressiveAgent({
  enabledProviders: ["browser useChat"],
  // Add Spectrum providers here. This web-only version exposes browser
  // useChat messages to the unified app.messages loop through webBridge.
  providers: [
    webBridge.config({
      server: webBridgeServerConfig(),
    }),
  ],
});
