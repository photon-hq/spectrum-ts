import { Spectrum } from "spectrum-ts";
import { webChat } from "spectrum-ts/providers/web-chat";

const app = await Spectrum({
  providers: [
    webChat.config({
      server: {
        cors: {
          origins: ["http://127.0.0.1:5173", "http://localhost:5173"],
        },
        port: 8787,
      },
    }),
  ],
});

console.log("webChat endpoint: http://127.0.0.1:8787/ai-sdk/chat");

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") {
    continue;
  }

  await space.send(`Spectrum received: ${message.content.text}`);
}
