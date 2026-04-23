import { Spectrum, text } from "spectrum-ts";
import { terminal } from "spectrum-ts/providers/terminal";

const app = await Spectrum({
  providers: [terminal.config()],
});

for await (const [space, message] of app.messages) {
  // `message` is InboundMessage — has `reply`/`react`, but not `edit`.
  // The next line would be a type error if uncommented:
  //
  //   await message.edit("nope");
  //   // @ts-expect-error — edit does not exist on InboundMessage

  if (message.content.type !== "text") {
    continue;
  }

  // space.send returns the OutboundMessage we just sent, so we can chain.
  const sent = await space.send(text(`echo: ${message.content.text}`));
  if (!sent) {
    continue;
  }
  console.log(`sent id=${sent.id} direction=${sent.direction}`);

  // `sent` is OutboundMessage — edit typechecks. Terminal provider throws
  // at runtime; iMessage remote will actually update the message. Wrap so
  // the loop keeps running on providers that don't support edit.
  try {
    await sent.edit(`echo (edited): ${message.content.text}`);
  } catch (err) {
    console.log(`edit not supported: ${(err as Error).message}`);
  }
}
