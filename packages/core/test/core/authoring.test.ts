import {
  createFusorTokenProvider,
  type FusorTokenProvider,
} from "@spectrum-ts/core/authoring";
import { describe, expect, expectTypeOf, it } from "vitest";

describe("core authoring exports", () => {
  it("exposes the Fusor token provider factory and contract", () => {
    expect(createFusorTokenProvider).toBeTypeOf("function");
    expectTypeOf(createFusorTokenProvider).toEqualTypeOf<
      (projectId: string, projectSecret: string) => Promise<FusorTokenProvider>
    >();
  });
});
