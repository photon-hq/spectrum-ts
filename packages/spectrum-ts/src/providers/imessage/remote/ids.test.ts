import { describe, expect, test } from "bun:test";
import { formatChildId, parseChildId, parseTapbackTarget } from "./ids";

describe("remote iMessage ids", () => {
  test("formats and parses child ids", () => {
    const parentGuid = "parent-guid";
    const childId = formatChildId(2, parentGuid);

    expect(childId).toBe("p:2/parent-guid");
    expect(parseChildId(childId)).toEqual({ parentGuid, partIndex: 2 });
    expect(parseChildId(parentGuid)).toBeNull();
  });

  test("parses tapback targets with and without part prefixes", () => {
    expect(parseTapbackTarget("parent-guid")).toEqual({
      guid: "parent-guid",
      partIndex: 0,
    });
    expect(parseTapbackTarget("p:12/parent-guid")).toEqual({
      guid: "parent-guid",
      partIndex: 12,
    });
  });
});
