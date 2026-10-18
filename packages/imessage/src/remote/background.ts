import type { AdvancedIMessage } from "@photon-ai/advanced-imessage/http";
import type { Background } from "../content/background";
import { toChatGuid } from "./ids";

/**
 * Apply a `Background` content value to a remote iMessage chat.
 *
 * `set` uploads the photo bytes and `preset` applies a built-in background,
 * both via `chats.setBackground`; `clear` removes any current background via
 * `chats.removeBackground`. All are fire-and-forget — no message id is
 * produced.
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
  if (content.action.kind === "preset") {
    await remote.chats.setBackground(chat, content.action.preset);
    return;
  }
  const buffer = await content.action.read();
  await remote.chats.setBackground(
    chat,
    new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  );
};
