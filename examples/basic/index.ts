import { Spectrum, text } from "spectrum-ts";
import { terminal } from "spectrum-ts/providers/terminal";

const app = await Spectrum({
  providers: [terminal.config()],
});

for await (const [space, message] of app.messages) {
  if (message.content.type === "text") {
    await space.send(text(`echo: ${message.content.text}`));
  }
}
