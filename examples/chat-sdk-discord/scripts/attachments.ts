// Attachments — inbound and outbound.
//
// Inbound: file/image messages arrive as `attachment` (or `voice`) content with
// a lazy `read()`. Outbound: `attachment(...)` uploads a file (the wrapper maps
// it to the adapter's file upload).
//
// Run: bun run attachments.ts  (then send the bot a file, or any text)

import { attachment, Spectrum } from "spectrum-ts";
import { chatSDK } from "spectrum-ts/providers/chat-sdk";
import { createBot } from "./bot";

const app = await Spectrum({
  providers: [chatSDK(createBot())],
});

for await (const [space, message] of app.messages) {
  // Inbound file → report what we received (and pull the bytes).
  if (message.content.type === "attachment") {
    const bytes = await message.content.read();
    await space.send(
      `Got "${message.content.name}" (${message.content.mimeType}, ${bytes.byteLength} bytes)`
    );
    continue;
  }

  // Outbound file → upload a generated text file.
  if (message.content.type === "text") {
    await space.send(
      attachment(Buffer.from(`You said: ${message.content.text}\n`), {
        name: "echo.txt",
        mimeType: "text/plain",
      })
    );
  }
}
