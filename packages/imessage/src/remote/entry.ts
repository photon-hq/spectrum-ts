// Low-level remote API — the `@spectrum-ts/imessage/remote` entry.
//
// The building blocks behind the iMessage platform's actions, exported for
// hosts that cannot run the long-lived `Spectrum()` runtime but still need to
// drive iMessage over Photon's remote endpoints from their own scheduler —
// serverless job queues (e.g. the Convex component), workers, and custom
// pipelines. Everything here is Node-flavored (the send path materializes
// `Content` via the Node content builders); pair it with the portable
// `@spectrum-ts/core/webhook` entry, which handles the inbound side.
//
// `createCloudClients` mints and rotates Spectrum Cloud tokens exactly as the
// platform's own lifecycle does; the routing helpers pick the right line in
// shared vs dedicated mode; the verbs mirror `remote/api.ts` one-to-one.

export { createCloudClients, disposeCloudAuth } from "../auth";
export type { IMessageClient, IMessageMessage, RemoteClient } from "../types";
export { SHARED_PHONE } from "../types";
export {
  addParticipants,
  editMessage,
  getDisplayName,
  getIcon,
  getMessage,
  leaveGroup,
  listParticipants,
  markRead,
  messages,
  reactToMessage,
  removeParticipants,
  replyToMessage,
  send,
  sendCustomizedMiniApp,
  sendStreamText,
  setBackground,
  setDisplayName,
  setIcon,
  shareContactCard,
  startTyping,
  stopTyping,
  unsendMessage,
  unsendReaction,
  updateCustomizedMiniApp,
} from "./api";
export {
  downloadPrimaryAttachment,
  downloadPrimaryAttachmentStream,
  getRemoteAttachment,
} from "./attachments";
export {
  availablePhones,
  clientForPhone,
  isSharedMode,
  randomPhone,
} from "./client";
export type { IMessageParticipant } from "./members";
