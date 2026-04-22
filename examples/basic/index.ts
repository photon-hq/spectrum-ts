import { Spectrum, text } from "spectrum-ts";
import { terminal } from "spectrum-ts/providers/terminal";

const app = await Spectrum({
  providers: [terminal.config()],
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") {
    continue;
  }
  const incoming = message.content.text;
  await space.responding(async () => {
    await sleep(600);
    await space.send(text(`echo: ${incoming}`));
  });
}
