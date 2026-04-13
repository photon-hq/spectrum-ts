import { Spectrum, text } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

// import { terminal } from "spectrum-ts/providers/terminal";

const app = await Spectrum(
  "7ad396a0-c94b-4bd5-9764-8f867a5c9421",
  "fxO-MUFIXHKVhcwIqhvC9mbVAPFQa4Pbyuxr6JMZSn0",
  {
    providers: [
      imessage.config({
        // local: true,
      }),
      // terminal.config({}),
    ],
  }
);

for await (const [space, message] of app.messages) {
  const incoming = message.content
    .filter((c) => c.type === "plain_text")
    .map((c) => c.text)
    .join(" ");

  console.log(imessage(space));

  await space.responding(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1000));

    await message.react(imessage.tapbacks.laugh);
    await message.reply(text(`echo: ${incoming}`), text("111"));

    // await space.send(text(`echo: ${incoming}`));
  });
}

// const user1 = await imessage(app).user("+13322593374");
// // const user2 = await imessage(app).user("+15103658086");
// const newSpace = await imessage(app).space(user1);
// await newSpace.send(
//   text("hello"),
//   // attachment("/Users/ryanzhu/Downloads/Image.jpeg")
// );
