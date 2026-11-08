// WeChat echo bot. First run: scan the QR code with WeChat; credentials, the
// inbound cursor and context tokens are saved to the state file so later runs
// reconnect without scanning.
//
//   bun run examples/wechat-echo/index.ts
//
// Optional: WECHAT_PROBE_TO=<user id> sends one message at startup, to check
// whether the bot can reach that user without a fresh inbound message.
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import qrcode from "qrcode-terminal";
import { Spectrum, text } from "spectrum-ts";
import { WeChatContextTokenError, wechat } from "spectrum-ts/providers/wechat";

// `tmp/` is git-ignored; SPECTRUM_WECHAT_STATE_FILE overrides the location.
const stateFile =
  process.env.SPECTRUM_WECHAT_STATE_FILE ?? "tmp/wechat-state.json";

const ask = async (question: string): Promise<string> => {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
};

const app = await Spectrum({
  providers: [
    wechat.config({
      stateFile,
      login: {
        onQrCode: (url) => {
          console.log("Scan this QR code with WeChat to connect the bot:");
          qrcode.generate(url, { small: true });
          console.log(`(or open ${url})`);
        },
        onVerifyCode: () => ask("Enter the number WeChat shows: "),
      },
    }),
  ],
});
console.log(`Connected. State is saved in ${stateFile}. Message the bot!`);

// Spectrum never installs signal handlers or exits the process itself, so wire
// Ctrl-C / `docker stop` to a graceful stop() here.
const shutdown = async () => {
  await app.stop();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

const probeTo = process.env.WECHAT_PROBE_TO;
if (probeTo) {
  const space = await wechat(app).space.get(probeTo);
  try {
    await space.send(text(`Probe sent at ${new Date().toISOString()}`));
    console.log(`Probe to ${probeTo} accepted by WeChat.`);
  } catch (error) {
    if (error instanceof WeChatContextTokenError) {
      console.log(`Probe to ${probeTo} rejected: ${error.message}`);
    } else {
      console.log("Probe failed:", error);
    }
  }
}

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") {
    continue;
  }
  const { text: body } = message.content;
  console.log(`${message.sender?.id}: ${body}`);
  await space.responding(() => space.send(text(`echo: ${body}`)));
}
