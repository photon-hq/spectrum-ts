import { describe, expect, it } from "vitest";
import { asContact } from "@/content/contact";
import { fromVCard, toVCard } from "@/utils/vcard";

describe("contact photo vCards", () => {
  it("round-trips embedded photo bytes", async () => {
    const photoBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const vcard = await toVCard(
      asContact({
        name: { first: "Example", last: "Tester" },
        photo: {
          mimeType: "image/jpeg",
          read: async () => photoBytes,
        },
      })
    );

    expect(vcard).toContain("PHOTO;ENCODING=b;TYPE=JPEG:");

    const parsed = fromVCard(vcard);
    expect(parsed.photo?.mimeType).toBe("image/jpeg");
    await expect(parsed.photo?.read()).resolves.toEqual(photoBytes);
  });
});
