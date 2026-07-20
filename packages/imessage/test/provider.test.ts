import { describe, expect, it } from "vitest";
import { imessage } from "@/index";

describe("iMessage provider transport", () => {
  it("declares the Fusor definition as stream-only", () => {
    expect(imessage.config().__definition.fusor?.streamOnly).toBe(true);
  });
});
