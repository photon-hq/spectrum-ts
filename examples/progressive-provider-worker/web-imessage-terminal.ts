import { imessage, terminal, webBridge } from "spectrum-ts/providers";
import { runProgressiveAgent, webBridgeServerConfig } from "./agent";

await runProgressiveAgent({
  enabledProviders: ["browser useChat", "iMessage", "terminal"],
  // Add Spectrum providers here. This is the unified-platform demo:
  // webBridge + iMessage + terminal all feed the same app.messages loop.
  providers: [
    webBridge.config({
      server: webBridgeServerConfig(),
    }),
    imessage.config(),
    terminal.config(),
  ],
  requiresCloudCredentials: true,
});
