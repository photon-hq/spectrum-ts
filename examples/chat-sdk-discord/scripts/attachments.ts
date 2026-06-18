// Attachments, in and out. Inbound files arrive as `attachment` content with a
// lazy `read()`; `attachment(...)` uploads one back.
//
// Run: bun attachments  (then send the bot a file, or any text)

import { createDiscordAdapter } from "@chat-adapter/discord";
import { attachment, Spectrum } from "spectrum-ts";
import { chatSDK } from "spectrum-ts/providers/chat-sdk";

const app = await Spectrum({
  providers: [
    chatSDK(createDiscordAdapter()).config({ userName: "spectrum-bot" }),
  ],
});

for await (const [space, message] of app.messages) {
  // Inbound file → report it and pull the bytes.
  if (message.content.type === "attachment") {
    const bytes = await message.content.read();
    await space.send(
      `Got "${message.content.name}" (${message.content.mimeType}, ${bytes.byteLength} bytes)`
    );
    continue;
  }

  // Text → upload a generated file back.
  if (message.content.type === "text") {
    await space.send(
      attachment(Buffer.from(`You said: ${message.content.text}\n`), {
        name: "echo.txt",
        mimeType: "text/plain",
      })
    );
  }
}
