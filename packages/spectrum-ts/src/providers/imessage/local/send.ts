import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { IMessageSDK } from "@photon-ai/imessage-kit";
import type { Content } from "../../../content/types";
import type { ProviderMessageRecord } from "../../../platform/types";
import { toVCard } from "../../../utils/vcard";
import { unsupportedLocalContent } from "../shared/errors";
import { vcardFileName } from "../shared/vcard";
import type { IMessageMessage } from "../types";
import { DEFAULT_ATTACHMENT_NAME } from "./attachments";

// v3 `IMessageSDK.send` resolves to `void`: the chat.db row id only
// surfaces later via the watcher's `onFromMeMessage`. A synthetic id keeps
// the platform contract intact; iMessage local does not implement
// `editMessage`, so the id is never resolved back to a real row.
const synthRecord = (
  spaceId: string,
  content: Content
): ProviderMessageRecord => ({
  id: crypto.randomUUID(),
  content,
  space: { id: spaceId },
  timestamp: new Date(),
});

const sendTempFile = async (
  client: IMessageSDK,
  spaceId: string,
  name: string,
  data: Buffer
): Promise<void> => {
  const safeName = basename(name) || DEFAULT_ATTACHMENT_NAME;
  const dir = await mkdtemp(join(tmpdir(), "spectrum-"));
  const tmp = join(dir, safeName);
  await writeFile(tmp, data);
  try {
    await client.send({ to: spaceId, attachments: [tmp] });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};

export const send = async (
  client: IMessageSDK,
  spaceId: string,
  content: Content
): Promise<ProviderMessageRecord> => {
  switch (content.type) {
    case "text":
      await client.send({ to: spaceId, text: content.text });
      return synthRecord(spaceId, content);
    case "attachment":
      await sendTempFile(client, spaceId, content.name, await content.read());
      return synthRecord(spaceId, content);
    case "contact": {
      const vcf = await toVCard(content);
      await sendTempFile(
        client,
        spaceId,
        vcardFileName(content),
        Buffer.from(vcf, "utf8")
      );
      return synthRecord(spaceId, content);
    }
    case "poll":
      throw unsupportedLocalContent("poll");
    default:
      throw unsupportedLocalContent(content.type);
  }
};

// Local mode has no by-id SDK lookup and does not surface reactions, so it
// has no cache to consult. `space.getMessage(id)` always resolves to
// `undefined` on local: callers with only an id cannot materialize a Message
// here.
export const getMessage = async (
  _client: IMessageSDK,
  _id: string
): Promise<IMessageMessage | undefined> => undefined;
