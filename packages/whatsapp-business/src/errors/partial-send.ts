import type { ProviderMessageRecord } from "@spectrum-ts/core/authoring";

// WhatsApp cannot retract delivered messages, so a sequential group send
// that fails midway leaves earlier parts delivered. This error carries their
// records so callers can reconcile instead of blindly re-sending the group.
// It deliberately is NOT an UnsupportedError: core's fallback layer re-sends
// the whole content on UnsupportedError (e.g. the markdown downgrade), which
// after a partial delivery would duplicate the already-sent parts.
export class WhatsAppPartialSendError extends Error {
  readonly sent: ProviderMessageRecord[];
  readonly failedIndex: number;

  constructor(input: {
    sent: ProviderMessageRecord[];
    failedIndex: number;
    total: number;
    cause: unknown;
  }) {
    super(
      `WhatsApp group send failed at part ${input.failedIndex + 1}/${input.total}; ` +
        `${input.sent.length} earlier part(s) were already delivered and cannot be retracted`,
      { cause: input.cause }
    );
    this.name = "WhatsAppPartialSendError";
    this.sent = input.sent;
    this.failedIndex = input.failedIndex;
  }
}
