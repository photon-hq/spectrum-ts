import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LocalAttachment, localAttachmentContent } from "./attachments";

describe("local iMessage attachments", () => {
  test("falls back to attachment content when vCard parsing fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spectrum-imessage-test-"));
    try {
      const path = join(dir, "broken.vcf");
      await writeFile(path, "");

      const content = await localAttachmentContent({
        fileName: "broken.vcf",
        id: "attachment-id",
        localPath: path,
        mimeType: "text/vcard",
        sizeBytes: 0,
      } as unknown as LocalAttachment);

      expect(content.type).toBe("attachment");
      if (content.type === "attachment") {
        expect(content.name).toBe("broken.vcf");
        expect(await content.read()).toEqual(Buffer.alloc(0));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
