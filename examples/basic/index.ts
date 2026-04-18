import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

// import { terminal } from "spectrum-ts/providers/terminal";

const app = await Spectrum({
  projectId: "2df5638a-b51b-47a9-848e-0557368354a0",
  projectSecret: "uguGq3CQCIEZR7BA_NlBxkK-__drGuVtwbO7i0jUEdU",
  providers: [
    imessage.config(),
    // terminal.config({}),
  ],
});

for await (const [space, message] of app.messages) {
  switch (message.content.type) {
    case "text": {
      const incoming = message.content.text;
      console.log(incoming);
      await space.responding(async () => {
        await space.send(`echo: ${incoming}`);
      });
      break;
    }
    case "attachment":
      console.log(`[attachment] ${message.content.name}`);
      message.content.data;
      break;
    case "custom":
      console.log("[custom]", message.content.raw);
      break;
    default:
      break;
  }
}

// const user1 = await imessage(app).user("+13322593374");
// // const user2 = await imessage(app).user("+15103658086");
// const newSpace = await imessage(app).space(user1);
// await newSpace.send(
//   text("hello"),
//   // attachment("/Users/ryanzhu/Downloads/Image.jpeg")
// );
