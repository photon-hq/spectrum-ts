import { imessage, webBridge } from "spectrum-ts/providers";
import { runProgressiveAgent, webBridgeServerConfig } from "./agent";

await runProgressiveAgent({
  enabledProviders: ["browser useChat", "iMessage"],
  // Add Spectrum providers here. Adding iMessage lets the same app logic
  // receive and answer both browser and iMessage messages.
  providers: [
    webBridge.config({
      server: webBridgeServerConfig(),
    }),
    imessage.config(),
  ],
  requiresCloudCredentials: true,
});
