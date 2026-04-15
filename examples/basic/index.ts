import { Spectrum, text } from "spectrum-ts";
import { whatsappBusiness } from "spectrum-ts/providers/whatsapp-business";

// import { terminal } from "spectrum-ts/providers/terminal";

const app = await Spectrum({
  projectId: "project-id",
  projectSecret: "project-secret",
  providers: [
    // imessage.config(),
    whatsappBusiness.config({
      phoneNumberId: "992752977264292",
      accessToken:
        "EAAMaxentpjkBRMZBIft4NT6Fh4yY6Wz78ZBvyDWepruHmDphuTvcHhb5aGYN8d0ZAxUacwxsBu5zrfIfxebRaBeDtWVfPcPdvlHQ6p2l61PjPxooUXZAZBXr9TlKbZBHj5m19yy5b2TByvzudcH1KYNB29gbrQZCf8Se2ABCpGwNYEEBQ2vDYhyESQcyMZA5HPdau3kwtDzSzVQDU0xPATl6X1TJTZAq5foH2lzBS6lQ2L3P8Uv10hCyOkZCaZCyBTPdO7Hh2wecIJlaFhXNE1zhS4SzcoZD",
      appSecret: "c4fe7015331dbccc92363d15f5bb8531",
    }),
    // terminal.config({}),
  ],
});

for await (const [space, message] of app.messages) {
  const incoming = message.content
    .filter((c) => c.type === "plain_text")
    .map((c) => c.text)
    .join(" ");

  console.log(incoming);

  // console.log(imessage(space));

  await space.responding(async () => {
    // await new Promise((resolve) => setTimeout(resolve, 1000));

    // await message.react(imessage.tapbacks.laugh);
    await message.reply(text(`echo: ${incoming}`));

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
