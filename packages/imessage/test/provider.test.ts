import { describe, expect, it } from "vitest";
import { imessage } from "@/index";

describe("iMessage provider transport", () => {
  it("accepts synthetic Fusor envelopes only from the authenticated stream", () => {
    expect(imessage.config().__definition.fusor?.streamOnly).toBe(true);
  });
});
