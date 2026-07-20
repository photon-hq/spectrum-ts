import { describe, expect, it, vi } from "vitest";
import { whatsappBusiness } from "@/index";
import type { WhatsAppClients } from "@/types";

const def = whatsappBusiness.config({}).__definition;

// Minimal stand-in for the SDK's `events.subscribe()` result: an immediately
// completed async iterable that also satisfies the `.filter()` / `.close()`
// calls `clientStream` makes on it.
const fakeEventStream = () => {
  const stream = {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ done: true, value: undefined }),
    }),
    filter: () => stream,
    close: () => Promise.resolve(),
  };
  return stream;
};

const drain = async (source: AsyncIterable<unknown>): Promise<unknown[]> => {
  const out: unknown[] = [];
  for await (const value of source) {
    out.push(value);
  }
  return out;
};

const messagesCtx = (config: unknown, subscribe: () => unknown) => ({
  client: [{ events: { subscribe } }] as unknown as WhatsAppClients,
  config,
  projectConfig: undefined,
  store: undefined as never,
});

describe("whatsapp direct-mode message subscription", () => {
  it("never opens an inbound subscribe in outbound-only mode", async () => {
    const subscribe = vi.fn(fakeEventStream);
    const source = def.messages(
      messagesCtx(
        { mode: "outbound-only", accessToken: "t", phoneNumberId: "p" },
        subscribe
      )
    );

    await expect(drain(source)).resolves.toEqual([]);
    // No appSecret to authenticate a stream, so it must not even try.
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("opens the inbound subscribe in inbound mode", async () => {
    const subscribe = vi.fn(fakeEventStream);
    const source = def.messages(
      messagesCtx(
        {
          mode: "inbound",
          accessToken: "t",
          phoneNumberId: "p",
          appSecret: "s",
        },
        subscribe
      )
    );

    await drain(source);
    expect(subscribe).toHaveBeenCalled();
  });
});
