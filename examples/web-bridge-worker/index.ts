import { Spectrum, text } from "spectrum-ts";
import { terminal, webBridge } from "spectrum-ts/providers";

const app = await Spectrum({
  providers: [
    terminal.config(),
    webBridge.config({
      server: {
        apiKey: process.env.SPECTRUM_WORKER_API_KEY,
        port: Number(process.env.SPECTRUM_WORKER_PORT ?? 8787),
      },
    }),
  ],
});

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") {
    continue;
  }

  await space.send(text(`echo: ${message.content.text}`));
}
