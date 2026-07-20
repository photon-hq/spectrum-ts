import type { AdvancedIMessage } from "@photon-ai/advanced-imessage/grpc";
import type { Background } from "../content/background";
import { toChatGuid } from "./ids";

/**
 * Apply a `Background` content value to a remote iMessage chat.
 *
 * `set` uploads the photo bytes via `chats.setBackground`; `clear` removes
 * any current background via `chats.removeBackground`. Both surfaces are
 * fire-and-forget — no message id is produced.
 */
export const setBackground = async (
  remote: AdvancedIMessage,
  spaceId: string,
  content: Background
): Promise<void> => {
  const chat = toChatGuid(spaceId);
  if (content.action.kind === "clear") {
    await remote.chats.removeBackground(chat);
    return;
  }
  const buffer = await content.action.read();
  await remote.chats.setBackground(
    chat,
    new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  );
};
